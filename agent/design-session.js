// design-session.js — converge on ONE character by drawing it many ways and throwing most away.
//
// A single generation is a roll of dice. A character is what survives being drawn twenty
// different ways and still being recognisably the same person. This runs that process:
// explore a spread of designs, judge them against the canon yam already wrote, sharpen the
// brief from what the judging found, and only then commit to a canonical sheet and produce
// the pose and outfit variations.
//
// Model choice is empirical, not a preference, and it has now been wrong twice.
// wai-Illustrious is an anime checkpoint that renders franchise tropes by default: asked
// for a black-ink model sheet of an original figure it returned a figure in an orange gi.
// recraft-v4 with the Line Art preset fixed the originality and lost everything else — it
// returns a scratchy contour sketch, a stick figure with a good silhouette. Originality was
// never the only bar. A design has to be FINISHED enough to draw from, and the preset made
// that impossible no matter how the brief was written. See DESIGN_MODEL for what replaced it.
//
// Every step is budget-guarded and nothing throws: an overnight run that dies at 3am having
// spent the cap and produced nothing would be the worst possible outcome.

import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { getState, setState, imageBudgetRemaining, recordSpend, saveNote } from './memory.js';
import { generateImage, sniffImage } from './venice.js';
import { mergeCast, recordReference, normaliseName } from './cast.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JUDGE_MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';
// Second bake-off, same brief across seven models at 50 steps. recraft-v4 with the Line
// Art preset — the previous choice — returns a scratchy crude sketch: the preset IS the
// crudeness, and no amount of prompt work gets past it. nano-banana-pro returned an actual
// professional model sheet: two full views plus detail callouts for the head and the boots,
// screentone, drawn costume construction. hunyuan-image-v3 (3-view turnaround) and
// seedream-v5-pro (ink wash) were the runners-up and are the cheaper fallbacks.
export const DESIGN_MODEL = process.env.VENICE_DESIGN_MODEL || 'nano-banana-pro';
// No style preset. 'Line Art' was doing the damage — it renders a rough ink doodle whatever
// the prompt asks for. The style now comes from the brief, where it can be argued with.
export const DESIGN_PRESET = process.env.VENICE_DESIGN_PRESET || '';
// Exported for the same reason the model is: the per-cycle path renders with this model
// and would otherwise bill the budget at the generic default, under-reporting every
// character generation yam makes from a cycle by the difference between the two.
export const IMAGE_COST = Number(process.env.VENICE_DESIGN_COST || 0.18);
// Was 0.60, to leave room for the hourly cycles. Cognition now has its own ceiling and
// cannot reach the image reserve, so holding money back from designing is money that
// simply goes unspent — the floor stays configurable but defaults to nothing held back.
const FLOOR = Number(process.env.DESIGN_BUDGET_FLOOR || 0);

// Written for a renderer. Every clause is a decision the judge can check against.
// Exported because the per-cycle venice_generate path needs exactly the same guard rails:
// the same model asked for a character without these clauses returns the orange gi.
//
// The first half of this list is new and is the half that matters. The old negative
// defended only against genericness and colour, and said nothing at all against CRUDENESS —
// so a scratchy unfinished doodle satisfied every clause in it and got published.
export const NEGATIVE = 'crude sketch, scribble, rough doodle, unfinished, stick figure, childlike drawing, '
  + 'messy scratchy linework, amateur, low detail, sloppy proportions, '
  + 'colour, color, coloured, painted, photo, 3d render, background scenery, gradient, '
  + 'spiky anime hair, martial arts uniform, orange gi, superhero costume, armour, cape, bodybuilder, '
  + 'existing anime character, recognisable franchise character, logo, emblem, watermark, signature, text, '
  + 'multiple unrelated characters, cute chibi, generic handsome man, t-shirt and jeans';

// The axes a character can differ along. Exploring along named axes beats asking for
// "another version", which returns the same drawing with the noise reshuffled.
const AXES = [
  'proportion: very tall and narrow, small head, long shins',
  'proportion: compact and dense, heavy through the hips, short neck',
  'garment: a long coat too big for them, hem in tatters, sleeves past the hands',
  'garment: wrapped and bound cloth, strapping across the torso, nothing loose',
  'garment: almost nothing — working clothes, rolled sleeves, bare forearms',
  'head: hair as a solid black mass with no interior detail',
  'head: head wrapped or hooded so the face is a dark void',
  'head: face fully visible, gaunt, heavy brow, mouth a single line',
  'burden: something carried on the high shoulder, roped in place',
  'burden: the high shoulder is empty — the body kept the shape after the load went',
  'age: young, unfinished, limbs too long for the torso',
  'age: old, compressed, the asymmetry now permanent in the spine',
];

// The brief asks for a FINISHED character design, not for ink line art. The old one asked
// for "ink line art, black ink only" and got exactly that: a bare contour drawing. Naming
// the level of finish — rendered form, costume construction, considered anatomy — is what
// separates a design somebody could work from and a sketch of one.
function briefFor(base, axis) {
  return `Full-body character design sheet of ONE original character, front view and three-quarter view, `
    + `plain white background. ${base} ${axis} `
    + `Finished professional manga and comic character design, publication quality: confident varied-weight `
    + `linework, deep solid spot blacks, controlled screentone, ink wash describing form and volume. `
    + `Detailed costume construction — visible seams, fabric weight and drape, wear at the hems and cuffs. `
    + `Strong readable silhouette, considered anatomy, expressive posture. `
    + `No text, no lettering, no watermark, no colour.`;
}

// The silhouette brief comes from the CHARACTER, not from a constant. This was
// THRESHOLD's raised shoulder hardcoded into the function, which was harmless while
// THRESHOLD was the only character a session ever ran for and becomes a way of rendering
// THRESHOLD's body under somebody else's name the moment the run rotates across the cast.
function baseFor(entry) {
  const from = String(entry?.appearance || entry?.canon || '').replace(/\s+/g, ' ').trim();
  return from
    ? from.slice(0, 320)
    : 'an original figure with a silhouette nobody else has drawn, standing at a boundary.';
}

// Read the bytes off disk, not off yam.garden. A freshly generated study exists locally
// but its public URL 404s until the next commit, push and deploy — judging over HTTP would
// mean paying for images and then failing to look at them.
function localImage(rel) {
  const buf = readFileSync(`${process.env.AGENT_HOME || '.'}/workspace/site/${rel}`);
  return { b64: buf.toString('base64'), mediaType: sniffImage(buf).mediaType };
}

// Judged in one call rather than one call per image, because the question is comparative:
// "which of these is most itself" cannot be answered by looking at them one at a time.
export async function judge({ canon, candidates }) {
  const content = [{
    type: 'text',
    text: `You are yam, judging your own character designs for ONE character you will draw for months.\n\n`
      + `THE CANON YOU WROTE:\n${canon}\n\n`
      + `Below are ${candidates.length} candidate sheets, numbered. Judge them against the canon and against `
      + `two standards. FIRST, originality: is this a person nobody else has drawn? Reject anything that `
      + `reads as a generic anime figure, a stock handsome face, an anatomy mannequin, or anything `
      + `resembling an existing franchise character — those are failures however well drawn. SECOND, `
      + `finish: is this a design somebody could actually draw a comic from? Reject a crude sketch, a bare `
      + `contour with no rendering, or anything that leaves the costume construction and the anatomy `
      + `unresolved — an original silhouette that is only a scribble is also a failure.\n\n`
      + `For each: score 0-100 and one sentence naming the single thing that is right or wrong with it.\n`
      + `Then choose ONE winner and write a sharpened appearance paragraph for it: a fixed physical `
      + `description for a renderer, incorporating what the winning image actually did well.\n\n`
      + `Return ONLY JSON: {"scores":[{"n":1,"score":0,"note":"..."}],"winner":1,"appearance":"...","why":"..."}`,
  }];
  for (const [i, c] of candidates.entries()) {
    content.push({ type: 'text', text: `Candidate ${i + 1} (${c.axis}):` });
    content.push({ type: 'image', source: { type: 'base64', media_type: c.mediaType || 'image/png', data: c.b64 } });
  }
  const msg = await anthropic.messages.create({
    model: JUDGE_MODEL, max_tokens: 2000, messages: [{ role: 'user', content }],
  });
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  return { parsed: JSON.parse(clean), usage: msg.usage };
}

export async function runDesignSession({ character = 'THRESHOLD', explore = 6, variations = 8, tag = null } = {}) {
  const log = (m) => console.log(`[design] ${m}`);
  // A study filename is date + label, so two sessions on the same day wrote the same
  // names and the second silently overwrote the first — a round's work destroyed on disk
  // while its urls stayed in the ledger pointing at somebody else's bytes. The tag makes
  // each session's output its own set of files.
  const stamp = tag ?? new Date().toISOString().slice(11, 16).replace(':', '');
  // A session is a cycle for accounting purposes. It passed null and every creations row
  // was rejected by a NOT NULL constraint, so the whole session's output stayed off the site.
  const sessionId = randomUUID();
  const castState = (await getState('cast').catch(() => null))?.value ?? null;
  const key = Object.keys(castState?.characters ?? {}).find(k => k.toLowerCase() === normaliseName(character).toLowerCase());
  const entry = key ? castState.characters[key] : null;
  if (!entry) return { ran: false, reason: `no character named ${character} in the cast` };

  const canon = `${entry.canon}\n\nOpen questions the design should answer: ${(entry.open_questions ?? []).join(' | ')}`;
  const base = baseFor(entry);

  // ---- explore -------------------------------------------------------------
  const candidates = [];
  let outOfFunds = false;
  for (let i = 0; i < explore; i++) {
    if ((await imageBudgetRemaining()) < FLOOR + IMAGE_COST) { log('budget floor reached during exploration'); break; }
    const axis = AXES[i % AXES.length];
    try {
      const out = await generateImage(sessionId, briefFor(base, axis), {
        model: DESIGN_MODEL, negativePrompt: NEGATIVE, stylePreset: DESIGN_PRESET,
        width: 1024, height: 1024, cost: IMAGE_COST, label: `${character}-${stamp}-explore-${i + 1}`,
      });
      candidates.push({ axis, url: out.publicUrl, rel: out.rel, ...localImage(out.rel) });
      log(`explored ${i + 1}/${explore}: ${axis.slice(0, 44)}`);
    } catch (e) {
      log(`explore ${i + 1} failed: ${String(e.message).slice(0, 120)}`);
      // The account is refusing everything until the next epoch. Continuing walks the rest
      // of the axes into the identical error and reports "no candidates were generated",
      // which reads as a design failure rather than an empty wallet.
      if (e.veniceOutOfFunds) { outOfFunds = true; break; }
    }
  }
  if (!candidates.length) {
    return { ran: false, reason: outOfFunds ? 'venice account out of funds' : 'no candidates were generated', outOfFunds };
  }

  // ---- judge ---------------------------------------------------------------
  let verdict = null;
  try {
    const { parsed, usage } = await judge({ canon, candidates });
    verdict = parsed;
    // A dozen images fed to a vision model is the most expensive single call in the
    // session and it was never written to the ledger, so the budget the whole thing is
    // guarded by was quietly wrong by the cost of the one step that decides anything.
    const cost = ((usage?.input_tokens ?? 0) / 1e6) * 3.0 + ((usage?.output_tokens ?? 0) / 1e6) * 15.0;
    await recordSpend(null, 'anthropic-judge', Number(cost.toFixed(4)),
      `judged ${candidates.length} designs for ${character}`).catch(() => {});
    log(`winner: candidate ${verdict.winner} — ${String(verdict.why ?? '').slice(0, 120)}`);
  } catch (e) {
    log(`judging failed (${String(e.message).slice(0, 100)}) — keeping the first candidate`);
    verdict = { winner: 1, appearance: entry.appearance || base, why: 'judging unavailable' };
  }
  const win = candidates[Math.max(0, Math.min(candidates.length - 1, Number(verdict.winner ?? 1) - 1))];
  const appearance = String(verdict.appearance || entry.appearance || base).slice(0, 600);

  // The sharpened appearance is what every future generation prepends, so the character
  // stops depending on yam redescribing it and starts depending on a stored fact.
  await setState('cast', mergeCast((await getState('cast')).value, {
    characters: { [key]: { appearance } },
  }));
  await setState('cast', recordReference((await getState('cast')).value, key, win.url));
  log(`canonical sheet: ${win.url}`);

  // ---- variations ----------------------------------------------------------
  // Edited FROM the winning sheet, never regenerated: the likeness lives in the pixels.
  const POSES = [
    'the same figure, three-quarter turn, looking back over one shoulder',
    'the same figure seen from behind, walking away, weight on the back foot',
    'the same figure crouched low, forearms on the knees',
    'the same figure mid-stride, crossing the dashed line',
    'the same figure seated on the ground, one shoulder against a wall',
    'the same figure reaching upward, body fully extended',
    'the same figure in a heavy hooded cloak, hem to the ground',
    'the same figure in stripped-down working clothes, sleeves rolled, forearms bare',
    'close study of the head and shoulders only, three-quarter view',
    'the same figure lying down, seen from above',
    'the same figure carrying a wrapped bundle roped across the back',
    'the same figure standing in heavy rain, cloth soaked and clinging',
  ];
  const made = [];
  for (let i = 0; i < Math.min(variations, POSES.length); i++) {
    if ((await imageBudgetRemaining()) < FLOOR + IMAGE_COST) { log('budget floor reached during variations'); break; }
    try {
      // Generated with the character's permanent seed rather than edited from the sheet.
      // /image/edit has no strength control and no selectable model, so it reinterprets:
      // asked for a three-quarter turn it returned a skeleton. Holding the seed and the
      // appearance text constant and changing only the pose clause drifts far less.
      const out = await generateImage(sessionId,
        `ONE figure only, plain white background. ${appearance} ${POSES[i]}. `
        + `Finished professional manga and comic illustration, publication quality: confident varied-weight `
        + `linework, deep solid spot blacks, controlled screentone, ink wash describing form and volume. `
        + `Costume construction with visible seams, fabric weight and drape. Considered anatomy, `
        + `strong readable silhouette. No text, no lettering, no watermark, no colour.`,
        { model: DESIGN_MODEL, negativePrompt: NEGATIVE, stylePreset: DESIGN_PRESET,
          seed: entry.seed, width: 1024, height: 1024, cost: IMAGE_COST, label: `${character}-${stamp}-pose-${i + 1}` });
      made.push({ pose: POSES[i], url: out.publicUrl });
      log(`variation ${i + 1}: ${POSES[i].slice(0, 50)}`);
    } catch (e) {
      log(`variation ${i + 1} failed: ${String(e.message).slice(0, 120)}`);
      if (e.veniceOutOfFunds) { outOfFunds = true; log('venice account out of funds — keeping the sheet already made'); break; }
    }
  }

  // Publish once, at the end. Committing per image would put twenty commits in a public
  // history for one design session.
  try {
    execSync(`cd ${JSON.stringify(process.env.AGENT_HOME || '.')} && git add -A && `
      + `git commit -q -m ${JSON.stringify(`design: ${character} session — ${candidates.length} explored, ${made.length} variations`)} && `
      + `git push -q origin main`, { stdio: 'pipe', timeout: 120000 });
    const { triggerDeploy } = await import('./deploy.js');
    await triggerDeploy(`design session: ${character}`);
    log('published');
  } catch (e) { log(`publish failed: ${String(e.message).slice(0, 140)}`); }

  try {
    await saveNote('character-design', character,
      `Design session: ${candidates.length} explored, winner ${win.url} (${String(verdict.why ?? '').slice(0, 200)}). `
      + `${made.length} pose and outfit variations produced from the canonical sheet.`);
  } catch { /* a note failure must not fail the session */ }

  return { ran: true, explored: candidates.length, winner: win.url, variations: made.length, outOfFunds, remaining: await imageBudgetRemaining() };
}
