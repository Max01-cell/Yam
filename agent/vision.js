// vision.js — yam looks at an image and describes what it sees.
// Uses Claude's vision via the same Anthropic SDK. Fetches an image URL,
// sends it as a base64 image block, returns yam's structured observation.
import Anthropic from '@anthropic-ai/sdk';
import { recordSpend, budgetRemaining } from './memory.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-4-6';
const VISION_EST_COST = 0.01;

// Commons search: the durable answer to fabricated filenames. yam does not have
// to remember an identifier correctly — it names a subject and gets real files.
// MediaWiki Action API: list=search over namespace 6 (File:).
const WIKI_UA = {
  'user-agent': 'yam.garden art-study bot (autonomous art project; contact in repo)',
  'accept': 'application/json',
};

// Only formats the vision API can actually read.
const VIEWABLE = /^File:.+\.(jpe?g|png|webp|gif)$/i;

async function searchOnce(query, limit) {
  // Ask for more than we need: scans are often stored as PDF/DjVu/TIFF and get
  // filtered out below, so a raw page of hits can reduce to nothing viewable.
  const raw = Math.min(20, Math.max(limit * 4, 10));
  const api = `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&srnamespace=6&srlimit=${raw}&format=json&origin=*`;
  const res = await fetch(api, { headers: WIKI_UA });
  if (!res.ok) throw new Error(`commons search failed: HTTP ${res.status}`);
  const j = await res.json();
  const hits = j?.query?.search;
  if (!Array.isArray(hits)) {
    throw new Error(`commons search returned an unexpected shape: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return hits
    .map(h => String(h.title || ''))
    .filter(t => VIEWABLE.test(t))
    .slice(0, limit)
    .map(t => {
      const name = t.replace(/^File:/, '');
      return { title: t, name, url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=1600` };
    });
}

// Commons search matches every word, so a descriptive phrase finds nothing, and
// a query that does hit often returns only PDF/DjVu scans. Widen in two steps:
// bias to raster images, then drop back to the first few words.
export async function searchCommons(query, limit = 5) {
  const words = String(query || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const attempts = [query, `${query} filetype:bitmap`];
  if (words.length > 3) attempts.push(`${words.slice(0, 3).join(' ')} filetype:bitmap`);
  for (const q of attempts) {
    const hits = await searchOnce(q, limit);
    if (hits.length) return hits;
  }
  return [];
}

export async function look(cycleId, imageUrl, question, searchQuery) {
  if ((await budgetRemaining()) < VISION_EST_COST) throw new Error('budget exhausted for vision');
  // Resolution chain. yam may name a subject instead of a URL; and a URL that
  // 404s is recovered by filename, then by search — because the usual failure
  // is not a wrong hash but an invented filename.
  const UA = {
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) yam.garden art-study bot (contact: repo)',
    'accept': 'image/*,*/*;q=0.8',
  };
  const filePath = (name) =>
    `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(decodeURIComponent(name))}?width=1600`;
  const wordsFrom = (u) => {
    const base = (u.match(/([^/?#]+)\.(?:jpe?g|png|webp|gif|svg)/i) || [, ''])[1];
    return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  };

  let target = imageUrl;
  let substituted = null;
  let imgRes = null;

  if (!target && searchQuery) {
    const hits = await searchCommons(searchQuery);
    if (!hits.length) throw new Error(`commons search found no image files for "${searchQuery}" — every word must match, so use two or three broad keywords like "Hokusai manga", not a descriptive phrase`);
    target = hits[0].url;
    substituted = `searched commons for "${searchQuery}" and studied ${hits[0].name}`;
  }
  if (!target) throw new Error('look needs either image_url or search');

  // /wiki/File:Name description pages resolve straight to the file
  const wikiPage = target.match(/\.(?:wikimedia|wikipedia)\.org\/wiki\/File:(.+)$/i);
  if (wikiPage) target = filePath(wikiPage[1]);

  imgRes = await fetch(target, { headers: UA });

  // 1st recovery: right filename, wrong hash path
  if (!imgRes.ok && /upload\.wikimedia\.org/i.test(imageUrl || '')) {
    const base = (imageUrl.match(/([^/?#]+\.(?:jpe?g|png|webp|gif|svg))/i) || [])[1];
    if (base) {
      const retry = filePath(base);
      const second = await fetch(retry, { headers: UA });
      if (second.ok) { imgRes = second; target = retry; substituted = `recovered by filename via Special:FilePath`; }
    }
  }

  // 2nd recovery: an invented WIKIMEDIA filename can be recovered by subject search.
  // This must NEVER apply to other hosts. Substituting an unrelated image for a
  // requested one is worse than failing: it produces confident analysis of the
  // wrong artwork. Own-work URLs in particular must fail loudly.
  const isWikimedia = /(?:wikimedia|wikipedia)\.org/i.test(imageUrl || '');
  if (!imgRes.ok && isWikimedia) {
    const q = searchQuery || wordsFrom(imageUrl || '');
    if (q) {
      try {
        const hits = await searchCommons(q);
        if (hits.length) {
          const third = await fetch(hits[0].url, { headers: UA });
          if (third.ok) {
            imgRes = third; target = hits[0].url;
            substituted = `"${imageUrl}" does not exist on commons; searched "${q}" and studied ${hits[0].name} instead — verify this is what you meant before drawing conclusions`;
          }
        }
      } catch (e) { /* fall through to the error below */ }
    }
  }

  if (!imgRes.ok) {
    const ownWork = /yam\.garden/i.test(imageUrl || '');
    throw new Error(ownWork
      ? `${imageUrl} does not exist. Do not guess the filenames of your own work — the exact urls of everything you have made are listed in YOUR WORK SO FAR each cycle. Copy one from there.`
      : `could not resolve an image for ${imageUrl || searchQuery} (HTTP ${imgRes.status}). Do not recall filenames; they are usually invented. Propose look with payload {search: "subject you want to see", question} and a real file will be found for you.`);
  }

  const ctype = imgRes.headers.get('content-type') || 'image/jpeg';
  if (!ctype.startsWith('image/')) throw new Error(`not an image (got ${ctype.split(';')[0]}) — this URL is a webpage, not a file; use a direct .jpg/.png, or a Wikimedia File: page (auto-converted)`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  if (buf.length > 4.5 * 1024 * 1024) throw new Error(`image too large (${(buf.length/1048576).toFixed(1)}MB, limit ~4.5MB) — use a scaled version, e.g. Wikimedia Special:FilePath/<File>?width=1600`);
  const b64 = buf.toString('base64');
  const msg = await anthropic.messages.create({
    model: VISION_MODEL, max_tokens: 1500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: ctype.split(';')[0], data: b64 } },
      { type: 'text', text: question || 'You are yam, studying to become a mangaka. Look at this image as a student of the craft. Describe what you actually see: line weight, paneling, composition, use of blacks and negative space, how the drawing controls the eye. Be specific about technique, not vibes.' },
    ]}],
  });
  let text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  if (substituted) text = `[${substituted}]\n\n${text}`;
  const cost = ((msg.usage?.input_tokens ?? 0)/1e6)*3 + ((msg.usage?.output_tokens ?? 0)/1e6)*15;
  // imageUrl is undefined on the search-only path; this runs after the paid call,
  // so throwing here would lose both the observation and the ledger row.
  await recordSpend(cycleId, 'anthropic-vision', Number(cost.toFixed(4)), `look: ${String(imageUrl || searchQuery || target || '').slice(0,60)}`);
  return { text, url: target, substituted };
}
