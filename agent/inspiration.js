// inspiration.js — where poses, garments and accessories come from when they stop being
// twelve strings somebody typed once.
//
// The design loop had a fixed vocabulary: twelve AXES and twelve POSES, hardcoded. Every
// character yam will ever design was going to be assembled out of that same list, so the
// cast could only ever vary within it. Meanwhile its whole diet was comics criticism —
// writing ABOUT drawings — and it had no source of costume, no source of how a real body
// stands, no source of what people are actually wearing.
//
// This harvests that. Film stills and fashion editorial carry exactly what the design loop
// was missing: how weight sits in a held pose, how a garment is constructed and falls, what
// an accessory does to a silhouette. One image is studied per run and turned into
// vocabulary the renderer can use.
//
// THE BOUNDARY, which is the same one curriculum.js draws and is structural here too:
// what gets extracted is a transferable DECISION — "coat held closed at the throat by one
// hand, hem lifting behind", "belt worn high over the ribs, not the waist" — never a person,
// never a character, never a brand, never "in the style of". yam's public promise is that
// every design is its own. A reference that could be traced back to one photograph is a
// costume copy, and the extraction prompt refuses it explicitly.
//
// These feeds are deliberately NOT in memory_state.diet. The diet is yam's own and it
// rewrites it every cycle — a documented way this project has lost feeds before. Reference
// sources are infrastructure, so they live in code where a cycle cannot drop them.

import Anthropic from '@anthropic-ai/sdk';
import { getState, setState, cognitionBudgetRemaining, recordSpend } from './memory.js';
import { extractImages } from './images.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';
const EST_COST = Number(process.env.INSPIRATION_COST || 0.02);

// Probed 2026-08-04: each returns items AND images large enough to study from. Feeds that
// answered 404/403/503, or carried no usable imagery, were dropped rather than left in to
// fail quietly every run.
export const INSPIRATION_FEEDS = [
  { url: 'https://www.criterion.com/feeds/current', kind: 'film' },
  { url: 'https://nofilmschool.com/rss.xml', kind: 'film' },
  { url: 'https://www.artofthetitle.com/feed/', kind: 'film' },
  { url: 'https://www.vogue.com/feed/rss', kind: 'fashion' },
  { url: 'https://www.dazeddigital.com/rss', kind: 'fashion' },
  { url: 'https://i-d.co/feed/', kind: 'fashion' },
];

const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) yam.garden art-study bot (contact: repo)' };

export async function readLibrary() {
  return (await getState('inspiration').catch(() => null))?.value ?? { items: [], seen: [] };
}

// One image from one source. Rotating by kind rather than taking whatever is first means a
// run of fashion posts cannot starve the film side of the library, or the reverse.
export async function harvestCandidates({ kind = null } = {}) {
  const feeds = kind ? INSPIRATION_FEEDS.filter(f => f.kind === kind) : INSPIRATION_FEEDS;
  const out = [];
  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, { headers: UA, signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const body = await res.text();
      for (const img of extractImages(body, feed.url, { limit: 8 })) {
        out.push({ url: img.url ?? img, from: feed.url, kind: feed.kind });
      }
    } catch { /* a dead feed is not a failed run */ }
  }
  return out;
}

// Study one real image and return vocabulary, not a description. The distinction is the
// whole point: "a woman in a red Valentino gown on a staircase" is unusable and also not
// ours to use. "weight dropped onto the back foot, the front knee soft, one hand gathering
// the skirt at the hip so the fabric breaks diagonally" is a decision yam can draw.
export async function extractVocabulary(imageUrl, kind) {
  const res = await fetch(imageUrl, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`could not fetch ${imageUrl} (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = (res.headers.get('content-type') || '').split(';')[0];
  if (!/^image\//.test(ctype)) throw new Error(`not an image: ${ctype}`);
  if (buf.length > 4_000_000) throw new Error('image too large to study');

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 900,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text:
            `You are yam, a mangaka in training, studying a ${kind} image for transferable design ideas.\n\n`
            + `Extract DECISIONS a draughtsman could reuse, not a description of this picture. For each `
            + `field write one concrete clause naming what the body or the cloth is actually doing.\n\n`
            + `HARD RULE: never name or identify a person, character, film, brand or designer, and never `
            + `write "in the style of". If an idea cannot be separated from the specific person or garment `
            + `it came from, it is a costume copy and you must return something more abstract instead. `
            + `Every design yam publishes is its own.\n\n`
            + `pose: how the weight is distributed and what the limbs are doing — the thing that makes it `
            + `read as a held moment rather than a mannequin.\n`
            + `garment: how a piece is constructed and how it falls — closure, volume, where it breaks.\n`
            + `accessory: one carried or worn object and what it does to the silhouette.\n`
            + `silhouette: the overall shape as a black shape, in one clause.\n`
            + `why: one line on what this would teach a character design.\n\n`
            + `If the image contains no usable figure or clothing at all, return {"usable":false}.\n`
            + `Otherwise return ONLY JSON: {"usable":true,"pose":"...","garment":"...","accessory":"...","silhouette":"...","why":"..."}` },
        { type: 'image', source: { type: 'base64', media_type: ctype, data: buf.toString('base64') } },
      ],
    }],
  });
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { parsed: JSON.parse(text.replace(/```json|```/g, '').trim()), usage: msg.usage };
}

export async function runHarvest({ want = 2 } = {}) {
  const log = (m) => console.log(`[inspiration] ${m}`);
  if ((await cognitionBudgetRemaining()) < EST_COST * want) {
    return { ran: false, reason: 'thinking budget too low to study references' };
  }

  const library = await readLibrary();
  const seen = new Set(library.seen ?? []);

  // Alternate which side of the library gets fed, so film and fashion stay balanced.
  const filmCount = (library.items ?? []).filter(i => i.kind === 'film').length;
  const fashionCount = (library.items ?? []).filter(i => i.kind === 'fashion').length;
  const kind = filmCount <= fashionCount ? 'film' : 'fashion';

  const candidates = (await harvestCandidates({ kind })).filter(c => !seen.has(c.url));
  if (!candidates.length) return { ran: false, reason: `no unseen ${kind} images in the feeds` };
  log(`${candidates.length} unseen ${kind} images available`);

  const added = [];
  for (const c of candidates.slice(0, want * 3)) {
    if (added.length >= want) break;
    if ((await cognitionBudgetRemaining()) < EST_COST) { log('thinking budget reached'); break; }
    try {
      const { parsed, usage } = await extractVocabulary(c.url, c.kind);
      seen.add(c.url);
      const cost = ((usage?.input_tokens ?? 0) / 1e6) * 3.0 + ((usage?.output_tokens ?? 0) / 1e6) * 15.0;
      await recordSpend(null, 'anthropic-inspiration', Number(cost.toFixed(4)), `studied a ${c.kind} reference`).catch(() => {});
      if (!parsed?.usable) { log(`no usable figure in one ${c.kind} image — skipped`); continue; }
      added.push({
        at: new Date().toISOString(), kind: c.kind, source: c.from,
        pose: String(parsed.pose ?? '').slice(0, 240),
        garment: String(parsed.garment ?? '').slice(0, 240),
        accessory: String(parsed.accessory ?? '').slice(0, 240),
        silhouette: String(parsed.silhouette ?? '').slice(0, 240),
        why: String(parsed.why ?? '').slice(0, 200),
        used: 0,
      });
      log(`learned from ${c.kind}: ${String(parsed.pose ?? '').slice(0, 80)}`);
    } catch (e) {
      seen.add(c.url);
      log(`skipped one image: ${String(e.message).slice(0, 90)}`);
    }
  }

  if (!added.length) return { ran: false, reason: 'nothing usable found this run' };

  const items = [...added, ...(library.items ?? [])].slice(0, 120);
  await setState('inspiration', { items, seen: [...seen].slice(-400) });
  return { ran: true, added: added.length, library: items.length, kind };
}

// The least-used entry, so the library circulates instead of the newest thing winning
// forever. Returns null when nothing has been harvested yet, and the caller carries on
// without it — an empty library must never block a design run.
export function pickInspiration(library) {
  const items = library?.items ?? [];
  if (!items.length) return null;
  return [...items].sort((a, b) => (a.used ?? 0) - (b.used ?? 0))[0];
}

export async function markUsed(item) {
  if (!item) return;
  const library = await readLibrary();
  const items = (library.items ?? []).map(i =>
    i.at === item.at && i.pose === item.pose ? { ...i, used: (i.used ?? 0) + 1 } : i);
  await setState('inspiration', { ...library, items });
}

// The clause that actually reaches the renderer. One idea per run, not all four at once:
// a prompt carrying a borrowed pose AND garment AND accessory changes three things at
// once, and then the score cannot tell you which of them did it.
export function inspirationClause(item, rotation = 0) {
  if (!item) return '';
  const fields = ['pose', 'garment', 'accessory', 'silhouette'].filter(f => item[f]);
  if (!fields.length) return '';
  const field = fields[rotation % fields.length];
  return ` ${field === 'pose' ? 'Pose' : field === 'garment' ? 'Garment' : field === 'accessory' ? 'Accessory' : 'Silhouette'}: ${item[field]}`;
}
