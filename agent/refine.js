// refine.js — improve a character by improving the prompt that renders it.
//
// The design session was a blast: twelve images in one run, judged once, and whatever won
// became canon. That converges fast and learns nothing. It cannot tell you WHY the winner
// won, so the next session starts from the same place and rolls the dice again.
//
// This is the slow version, and it is the one that actually compounds. One image per run.
// Score it. Name the single weakest thing about it. Rewrite the prompt to fix that one
// thing. Keep the prompt that scored best, and keep the whole history so the next run can
// see what has already been tried and what it did to the score.
//
// The prompt is the artefact being improved here, not the picture. A picture is one sample
// from a prompt; a prompt that reliably scores 90 is a character design yam can draw from
// for months. Every prompt and every score is written to the creations row, so both are
// public under the image on the site rather than living in a log nobody reads.

import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import {
  getState, setState, imageBudgetRemaining, scoreCreation, saveNote, CREDITS_PER_USD,
} from './memory.js';
import { generateImage, sniffImage, veniceBalance } from './venice.js';
import { recordReference, normaliseName, mergeCast } from './cast.js';
import { DESIGN_MODEL, DESIGN_PRESET, NEGATIVE, IMAGE_COST } from './design-session.js';
import { readFileSync } from 'fs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JUDGE_MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';

// How many attempts one run makes. One by default: the point is to move slowly, spend
// little, and let the improvement accumulate across many runs rather than inside one.
const ATTEMPTS = Number(process.env.REFINE_ATTEMPTS || 1);

// A score this high means the prompt is working and there is nothing cheap left to gain.
// Kept below 100 on purpose — chasing the last few points burns credits on noise.
const GOOD_ENOUGH = Number(process.env.REFINE_GOOD_ENOUGH || 92);

function localImage(rel) {
  const buf = readFileSync(`${process.env.AGENT_HOME || '.'}/workspace/site/${rel}`);
  return { b64: buf.toString('base64'), mediaType: sniffImage(buf).mediaType };
}

// The design log: what has been tried, what it scored, and why. Separate from the cast
// because the cast is who a character IS and this is the record of learning to draw them.
async function readLog() {
  return (await getState('design_log').catch(() => null))?.value ?? { characters: {} };
}

function entryFor(log, key) {
  return log.characters?.[key] ?? { best: null, bestScore: -1, history: [], prompt: null };
}

// The starting prompt when a character has never been refined. Deliberately plain: the
// loop's job is to improve it, and seeding it with a paragraph of clever art direction
// would hide whether the loop is improving anything at all.
function seedPrompt(entry) {
  const look = String(entry?.appearance || entry?.canon || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return `Full-body character design sheet of ONE original character, front view and three-quarter view, `
    + `plain white background. ${look} `
    + `Finished professional manga and comic character design, publication quality: confident `
    + `varied-weight linework, deep solid spot blacks, controlled screentone, ink wash describing form. `
    + `No text, no lettering, no watermark, no colour.`;
}

// Judge ONE image against the canon, and — the part that matters — return the next prompt.
// Asking for a revised prompt rather than advice is what makes this a loop instead of a
// critique: the output feeds straight back into the next generation.
export async function judgeAndRevise({ character, canon, prompt, history, b64, mediaType }) {
  const tried = history.slice(-6).map(h =>
    `- scored ${h.score}: ${h.critique}`).join('\n') || '(this is the first attempt)';

  const msg = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1600,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text:
            `You are yam, judging your own character design for ${character} and rewriting the prompt `
            + `that produced it.\n\nTHE CANON:\n${canon}\n\nTHE PROMPT THAT MADE THIS IMAGE:\n${prompt}\n\n`
            + `WHAT PREVIOUS ATTEMPTS SCORED AND WHY:\n${tried}\n\n`
            + `Score this image 0-100 on two things weighted equally: is it a person nobody else has `
            + `drawn, and is it finished enough to draw a comic from. A generic anime lead is a failure `
            + `however well rendered; so is an original silhouette that is only a scratchy sketch.\n\n`
            + `Then name the SINGLE weakest thing about it — one specific fixable fault, not a list — `
            + `and rewrite the prompt to fix that one thing while keeping everything that is working. `
            + `Change one thing at a time. A rewrite that changes everything teaches you nothing about `
            + `what the change did.\n\n`
            + `Return ONLY JSON: {"score":0,"critique":"the one weakest thing","revised_prompt":"...","what_changed":"one line"}` },
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/png', data: b64 } },
      ],
    }],
  });
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { parsed: JSON.parse(text.replace(/```json|```/g, '').trim()), usage: msg.usage };
}

export async function runRefinement({ character = null, attempts = ATTEMPTS } = {}) {
  const log = (m) => console.log(`[refine] ${m}`);

  // What Venice will actually honour, before spending anything finding out.
  try {
    const bal = await veniceBalance();
    if (!bal.permitted) {
      log(`venice will refuse every request until ${bal.nextEpoch ?? 'the next epoch'} — not starting`);
      return { ran: false, reason: 'venice out of funds' };
    }
  } catch (e) { log(`balance unreadable (${String(e.message).slice(0, 80)}) — continuing`); }

  const castState = (await getState('cast').catch(() => null))?.value ?? null;
  const chars = Object.entries(castState?.characters ?? {});
  if (!chars.length) return { ran: false, reason: 'the cast is empty' };

  const designLog = await readLog();
  // Whoever is furthest from done: lowest best-score first, so attention goes where the
  // design is weakest rather than to whoever happens to be first in the object.
  const wanted = character ? normaliseName(character).toLowerCase() : null;
  const pool = wanted ? chars.filter(([n]) => n.toLowerCase() === wanted) : chars;
  if (!pool.length) return { ran: false, reason: `no character named ${character}` };
  pool.sort((a, b) => entryFor(designLog, a[0]).bestScore - entryFor(designLog, b[0]).bestScore);
  const [key, entry] = pool[0];

  const rec = entryFor(designLog, key);
  if (rec.bestScore >= GOOD_ENOUGH && !character) {
    log(`${key} already scores ${rec.bestScore} — nothing cheap left to gain, skipping`);
    return { ran: false, reason: 'good enough', character: key, bestScore: rec.bestScore };
  }

  const canon = `${entry.canon}\n\nOpen questions: ${(entry.open_questions ?? []).join(' | ')}`;
  let prompt = rec.prompt || seedPrompt(entry);
  const history = [...(rec.history ?? [])];
  const made = [];

  for (let i = 0; i < attempts; i++) {
    const creditsLeft = Math.round((await imageBudgetRemaining()) * CREDITS_PER_USD);
    const creditsNeeded = Math.round(IMAGE_COST * CREDITS_PER_USD);
    if (creditsLeft < creditsNeeded) {
      log(`stopping: ${creditsLeft} credits left, an attempt costs ${creditsNeeded}`);
      break;
    }

    const sessionId = randomUUID();
    const stamp = new Date().toISOString().slice(11, 16).replace(':', '');
    let out;
    try {
      out = await generateImage(sessionId, prompt, {
        model: DESIGN_MODEL, stylePreset: DESIGN_PRESET, negativePrompt: NEGATIVE,
        seed: entry.seed, width: 1024, height: 1024, cost: IMAGE_COST,
        label: `${key}-refine-${stamp}`,
      });
    } catch (e) {
      log(`generation failed: ${String(e.message).slice(0, 140)}`);
      if (e.veniceOutOfFunds) break;
      break;
    }

    let verdict;
    try {
      const { parsed } = await judgeAndRevise({
        character: key, canon, prompt, history, ...localImage(out.rel),
      });
      verdict = parsed;
    } catch (e) {
      log(`judging failed (${String(e.message).slice(0, 90)}) — keeping the image, not the lesson`);
      break;
    }

    const score = Math.max(0, Math.min(100, Number(verdict.score) || 0));
    // The score goes onto the picture, so the site shows what yam thought of it.
    try { await scoreCreation(out.publicUrl, score); }
    catch (e) { log(`score not written: ${String(e.message).slice(0, 90)}`); }

    history.push({ at: new Date().toISOString(), prompt, score, critique: String(verdict.critique ?? '').slice(0, 300), url: out.publicUrl });
    made.push({ url: out.publicUrl, score });
    log(`attempt scored ${score} — ${String(verdict.critique ?? '').slice(0, 100)}`);

    if (score > (rec.bestScore ?? -1)) {
      rec.bestScore = score;
      rec.best = out.publicUrl;
      log(`new best for ${key}: ${score}`);
      // The best-scoring render becomes what the character is drawn toward.
      try {
        const fresh = (await getState('cast')).value;
        await setState('cast', recordReference(fresh, key, out.publicUrl));
      } catch (e) { log(`reference not updated: ${String(e.message).slice(0, 90)}`); }
    }

    // The revised prompt is the actual product of this run.
    if (verdict.revised_prompt && String(verdict.revised_prompt).length > 40) {
      prompt = String(verdict.revised_prompt).slice(0, 2000);
      log(`prompt revised: ${String(verdict.what_changed ?? '').slice(0, 90)}`);
    }
    if (score >= GOOD_ENOUGH) { log(`${key} reached ${score} — stopping while ahead`); break; }
  }

  if (!made.length) return { ran: false, reason: 'no attempt completed', character: key };

  rec.prompt = prompt;
  rec.history = history.slice(-40);
  designLog.characters = { ...(designLog.characters ?? {}), [key]: rec };
  await setState('design_log', designLog);

  // The appearance the rest of the system renders from tracks the best prompt, so a cycle's
  // own venice_generate benefits from everything the refinement loop has learned.
  try {
    const fresh = (await getState('cast')).value;
    await setState('cast', mergeCast(fresh, { characters: { [key]: { appearance: prompt.slice(0, 600) } } }));
  } catch { /* the log is the source of truth; the cast copy is a convenience */ }

  try {
    execSync(`cd ${JSON.stringify(process.env.AGENT_HOME || '.')} && git add -A && `
      + `git commit -q -m ${JSON.stringify(`refine: ${key} — scored ${made.map(m => m.score).join(', ')}`)} && `
      + `git push -q origin main`, { stdio: 'pipe', timeout: 120000 });
    const { triggerDeploy } = await import('./deploy.js');
    await triggerDeploy(`refine: ${key}`);
    log('published');
  } catch (e) { log(`publish skipped: ${String(e.message).slice(0, 120)}`); }

  try {
    await saveNote('character-refinement', key,
      `Refinement run: ${made.map(m => m.score).join(', ')}. Best so far ${rec.bestScore}. `
      + `Latest critique: ${history[history.length - 1]?.critique ?? ''}`);
  } catch { /* a note failure must not fail the run */ }

  return {
    ran: true, character: key, attempts: made.length, scores: made.map(m => m.score),
    bestScore: rec.bestScore, best: rec.best,
    creditsLeft: Math.round((await imageBudgetRemaining()) * CREDITS_PER_USD),
  };
}
