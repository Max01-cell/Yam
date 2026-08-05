// design-run.js — what the design timer actually runs, several times a day.
//
// Two different jobs, and the difference is whether the character exists yet as a picture.
// A character with no reference sheet has never been rendered at all, and one slow
// refinement step on nothing is a waste of a run — that case needs the converge session
// that explores a spread and picks a direction. Everything after that is refinement:
// one image, one score, one improved prompt, and stop.
//
// It runs often and spends little, because the instruction was to move slowly.

import { imageBudgetRemaining, getState, CREDITS_PER_USD } from './memory.js';
import { runDesignSession } from './design-session.js';
import { runRefinement, PLATEAU_AFTER } from './refine.js';
import { inventCharacter, TARGET_CAST } from './invent.js';
import { runHarvest, readLibrary } from './inspiration.js';
import { veniceBalance } from './venice.js';

const CHARACTER = process.env.DESIGN_CHARACTER || null;

const credits = async () => Math.round((await imageBudgetRemaining()) * CREDITS_PER_USD);

try {
  const bal = await veniceBalance();
  console.log(`[design-run] venice USD ${bal.usd}, permitted ${bal.permitted}`);
  if (!bal.permitted) {
    console.log(`[design-run] venice refuses until ${bal.nextEpoch ?? 'the next epoch'} — stopping`);
    process.exit(0);
  }
} catch (e) {
  console.log(`[design-run] balance unreadable (${String(e.message).slice(0, 90)}) — continuing`);
}

console.log(`[design-run] ${await credits()} of today's credits left`);

// Look at the world before drawing. Costs no Venice credits — it is a vision call against
// the thinking budget — and it is what stops the design vocabulary being the same twelve
// hardcoded strings forever.
try {
  const h = await runHarvest({ want: 2 });
  const lib = await readLibrary();
  console.log(`[design-run] inspiration: ${JSON.stringify(h)} · library holds ${lib.items?.length ?? 0}`);
} catch (e) {
  console.log(`[design-run] harvest skipped: ${String(e.message).slice(0, 120)}`);
}

const cast = (await getState('cast').catch(() => null))?.value ?? null;
const entries = Object.entries(cast?.characters ?? {});
if (!entries.length) {
  console.log('[design-run] the cast is empty — nothing to design');
  process.exit(0);
}

// Is anyone still moving? A character whose best score has not improved in PLATEAU_AFTER
// attempts is not going to be rescued by one more render — that is how nine consecutive
// runs went into one figure's shoulder. When everyone has stalled and the cast is small,
// the honest use of a run is a NEW character rather than a tenth pass at the same one.
const designLog = (await getState('design_log').catch(() => null))?.value ?? { characters: {} };
const stalled = entries.every(([n]) => (designLog.characters?.[n]?.sinceBest ?? 0) >= PLATEAU_AFTER);
const undesigned = entries.filter(([, c]) => !c?.reference).map(([n]) => n);

for (const [n] of entries) {
  const r = designLog.characters?.[n];
  console.log(`[design-run]   ${n}: best ${r?.bestScore ?? '—'}, ${r?.sinceBest ?? 0} attempts since`);
}

// Below MIN_CAST, invent regardless of whether anything has stalled. Waiting for a plateau
// keeps a cast of one at one indefinitely — a design that is still improving never triggers
// it, and the whole complaint is that every drawing is the same person. Past MIN_CAST,
// stalling is the trigger and refinement gets the runs.
const MIN_CAST = Number(process.env.MIN_CAST || 3);
if (!CHARACTER && entries.length < TARGET_CAST && (stalled || entries.length < MIN_CAST)) {
  const why = entries.length < MIN_CAST
    ? `the cast holds ${entries.length}, which is not yet a cast`
    : 'every character has stalled';
  console.log(`[design-run] ${why} — inventing`);
  const inv = await inventCharacter({ reason: why });
  console.log(`[design-run] ${JSON.stringify(inv)}`);
  if (inv.ran) {
    // Give the newcomer a first look immediately, so a run that invents still produces a
    // drawing rather than only a paragraph.
    const r = await runDesignSession({ character: inv.name, explore: 3, variations: 0 });
    console.log(`[design-run] first sheets for ${inv.name}: ${JSON.stringify(r)}`);
  }
} else if (undesigned.length && !CHARACTER) {
  const target = undesigned[0];
  console.log(`[design-run] ${target} has no reference sheet yet — running a converge session`);
  // Deliberately small. The old session spent twelve renders in one go; four explorations
  // is enough to pick a direction the refinement loop can then improve one step at a time.
  const r = await runDesignSession({ character: target, explore: 4, variations: 0 });
  console.log(`[design-run] ${JSON.stringify(r)}`);
} else {
  const r = await runRefinement({ character: CHARACTER });
  console.log(`[design-run] ${JSON.stringify(r)}`);
}

console.log(`[design-run] done, ${await credits()} credits remaining today`);
