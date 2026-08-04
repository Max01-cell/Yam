// design-session.js — converge on ONE character by drawing it many ways and throwing most away.
//
// A single generation is a roll of dice. A character is what survives being drawn twenty
// different ways and still being recognisably the same person. This runs that process:
// explore a spread of designs, judge them against the canon yam already wrote, sharpen the
// brief from what the judging found, and only then commit to a canonical sheet and produce
// the pose and outfit variations.
//
// Model choice is empirical, not a preference. wai-Illustrious — the model the project used
// until now — is an anime checkpoint that renders franchise tropes by default: asked for a
// black-ink model sheet of an original figure it returned a colour image containing a figure
// in an orange gi. recraft-v4 with the Line Art preset returns black ink on white and a body
// nobody else has drawn. For a project whose whole claim is originality that difference is
// the difference between usable and disqualifying.
//
// Every step is budget-guarded and nothing throws: an overnight run that dies at 3am having
// spent the cap and produced nothing would be the worst possible outcome.

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { getState, setState, budgetRemaining, saveNote } from './memory.js';
import { generateImage, editImage, sniffImage } from './venice.js';
import { mergeCast, recordReference, normaliseName } from './cast.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JUDGE_MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';
const DESIGN_MODEL = process.env.VENICE_DESIGN_MODEL || 'recraft-v4';
const IMAGE_COST = Number(process.env.VENICE_DESIGN_COST || 0.05);
const FLOOR = Number(process.env.DESIGN_BUDGET_FLOOR || 0.60); // leave room for the hourly cycles

// Written for a renderer. Every clause is a decision the judge can check against.
const NEGATIVE = 'colour, color, coloured, painted, grayscale photo, background scenery, gradient, '
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

function briefFor(base, axis) {
  return `ink line art character model sheet on plain white paper, black ink only. `
    + `ONE original figure drawn twice: full-body front view and full-body three-quarter view. `
    + `${base} ${axis}. `
    + `heavy committed black contour on the spine and the raised shoulder, terminating without tapering. `
    + `fine hatching inside the torso. solid black shapes in the negative spaces under the raised shoulder. `
    + `a dashed horizontal ground line at the feet. no background, no colour, no text.`;
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
      + `one standard above all: is this a person nobody else has drawn? Reject anything that reads as a `
      + `generic anime figure, a stock handsome face, an anatomy mannequin, or anything resembling an `
      + `existing franchise character — those are failures however well drawn.\n\n`
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

export async function runDesignSession({ character = 'THRESHOLD', explore = 6, variations = 8 } = {}) {
  const log = (m) => console.log(`[design] ${m}`);
  const castState = (await getState('cast').catch(() => null))?.value ?? null;
  const key = Object.keys(castState?.characters ?? {}).find(k => k.toLowerCase() === normaliseName(character).toLowerCase());
  const entry = key ? castState.characters[key] : null;
  if (!entry) return { ran: false, reason: `no character named ${character} in the cast` };

  const canon = `${entry.canon}\n\nOpen questions the design should answer: ${(entry.open_questions ?? []).join(' | ')}`;
  const base = 'a tall lean figure whose LEFT SHOULDER SITS CLEARLY HIGHER than the right, standing at a boundary.';

  // ---- explore -------------------------------------------------------------
  const candidates = [];
  for (let i = 0; i < explore; i++) {
    if ((await budgetRemaining()) < FLOOR + IMAGE_COST) { log('budget floor reached during exploration'); break; }
    const axis = AXES[i % AXES.length];
    try {
      const out = await generateImage(null, briefFor(base, axis), {
        model: DESIGN_MODEL, negativePrompt: NEGATIVE, stylePreset: 'Line Art',
        width: 1024, height: 1024, label: `${character}-explore-${i + 1}`,
      });
      candidates.push({ axis, url: out.publicUrl, rel: out.rel, ...localImage(out.rel) });
      log(`explored ${i + 1}/${explore}: ${axis.slice(0, 44)}`);
    } catch (e) { log(`explore ${i + 1} failed: ${String(e.message).slice(0, 120)}`); }
  }
  if (!candidates.length) return { ran: false, reason: 'no candidates were generated' };

  // ---- judge ---------------------------------------------------------------
  let verdict = null;
  try {
    const { parsed } = await judge({ canon, candidates });
    verdict = parsed;
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
    'the same figure, three-quarter turn, looking back over the high shoulder',
    'the same figure seen from behind, walking away, weight on the back foot',
    'the same figure crouched low, forearms on the knees',
    'the same figure mid-stride, crossing the dashed line',
    'the same figure seated on the ground, the high shoulder against a wall',
    'the same figure reaching upward with the long arm, body extended',
    'the same figure in a heavy hooded cloak, hem to the ground',
    'the same figure in stripped-down working clothes, sleeves rolled, forearms bare',
    'close study of the head and shoulders only, three-quarter view',
    'the same figure lying down, seen from above',
    'the same figure carrying a wrapped bundle roped to the high shoulder',
    'the same figure standing in heavy rain, cloth soaked and clinging',
  ];
  const made = [];
  for (let i = 0; i < Math.min(variations, POSES.length); i++) {
    if ((await budgetRemaining()) < FLOOR + IMAGE_COST) { log('budget floor reached during variations'); break; }
    try {
      const out = await editImage(null, win.rel, `${appearance}. ${POSES[i]}. black ink line art only, no colour, plain white background.`,
        { label: `${character}-pose-${i + 1}` });
      made.push({ pose: POSES[i], url: out.publicUrl });
      log(`variation ${i + 1}: ${POSES[i].slice(0, 50)}`);
    } catch (e) { log(`variation ${i + 1} failed: ${String(e.message).slice(0, 120)}`); }
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

  return { ran: true, explored: candidates.length, winner: win.url, variations: made.length, remaining: await budgetRemaining() };
}
