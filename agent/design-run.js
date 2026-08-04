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
import { runRefinement } from './refine.js';
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

const cast = (await getState('cast').catch(() => null))?.value ?? null;
const entries = Object.entries(cast?.characters ?? {});
if (!entries.length) {
  console.log('[design-run] the cast is empty — nothing to design');
  process.exit(0);
}

// A character that has never been rendered gets the spread; everyone else gets refined.
const undesigned = entries.filter(([, c]) => !c?.reference).map(([n]) => n);
const target = CHARACTER || undesigned[0] || null;

if (undesigned.length && !CHARACTER) {
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
