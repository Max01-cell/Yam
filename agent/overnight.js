// overnight.js — run design rounds until the budget floor, then stop.
//
// One round is a complete convergence: explore a spread, judge it, commit to a winner,
// draw that winner in poses and outfits. Running several rounds is how a design stops
// being the best of six rolls and starts being a decision that survived being remade.
//
// It stops on budget, never on a clock, and it stops itself rather than being killed —
// a run that has to be killed leaves a half-published git tree behind.

import { budgetRemaining } from './memory.js';
import { runDesignSession } from './design-session.js';

const FLOOR = Number(process.env.OVERNIGHT_FLOOR || 0.60);
const ROUND_COST = Number(process.env.OVERNIGHT_ROUND_COST || 0.70);
const CHARACTER = process.env.OVERNIGHT_CHARACTER || 'THRESHOLD';

let round = 0;
while (true) {
  const left = await budgetRemaining();
  if (left < FLOOR + ROUND_COST) {
    console.log(`[overnight] stopping after ${round} round(s): $${left.toFixed(2)} left, a round needs $${ROUND_COST}`);
    break;
  }
  round += 1;
  console.log(`\n[overnight] === round ${round} — $${left.toFixed(2)} available ===`);
  try {
    const r = await runDesignSession({ character: CHARACTER, explore: 6, variations: 6 });
    console.log(`[overnight] round ${round}: ${JSON.stringify(r)}`);
    if (!r.ran) { console.log('[overnight] round produced nothing; stopping rather than burning the cap'); break; }
  } catch (e) {
    console.log(`[overnight] round ${round} threw: ${String(e.message).slice(0, 200)}`);
    break;
  }
}
console.log('[overnight] done');
