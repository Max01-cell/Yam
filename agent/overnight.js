// overnight.js — run design rounds until the budget floor, then stop.
//
// One round is a complete convergence: explore a spread, judge it, commit to a winner,
// draw that winner in poses and outfits. Running several rounds is how a design stops
// being the best of six rolls and starts being a decision that survived being remade.
//
// It stops on budget, never on a clock, and it stops itself rather than being killed —
// a run that has to be killed leaves a half-published git tree behind.

import { imageBudgetRemaining, getState } from './memory.js';
import { runDesignSession } from './design-session.js';
import { veniceBalance } from './venice.js';

const FLOOR = Number(process.env.OVERNIGHT_FLOOR || 0);
const ROUND_COST = Number(process.env.OVERNIGHT_ROUND_COST || 0.70);
const CHARACTER = process.env.OVERNIGHT_CHARACTER || null;

// Whoever needs designing most, rather than one name fixed in an env var. A character with
// no reference sheet has never been designed at all and comes first; after that the one
// designed longest ago. Hardcoding THRESHOLD meant every round the project ever ran was
// spent on the same figure, which is how a cast of one stays a cast of one.
async function nextCharacter() {
  if (CHARACTER) return CHARACTER;
  const cast = (await getState('cast').catch(() => null))?.value ?? null;
  const entries = Object.entries(cast?.characters ?? {});
  if (!entries.length) return null;
  const undesigned = entries.filter(([, c]) => !c?.reference);
  const pool = undesigned.length ? undesigned : entries;
  pool.sort((a, b) => String(a[1]?.designed_at ?? '').localeCompare(String(b[1]?.designed_at ?? '')));
  return pool[0][0];
}

// Ask Venice what it will actually honour before spending an hour finding out. The
// internal budget is what yam intends to spend; this is the account that has to pay.
try {
  const bal = await veniceBalance();
  console.log(`[overnight] venice: USD ${bal.usd}, DIEM ${bal.diem}, permitted ${bal.permitted}${bal.nextEpoch ? `, next epoch ${bal.nextEpoch}` : ''}`);
  if (!bal.permitted) {
    console.log('[overnight] venice will refuse every request until the next epoch — not starting a session');
    process.exit(0);
  }
} catch (e) {
  console.log(`[overnight] venice balance unreadable (${String(e.message).slice(0, 100)}) — continuing anyway`);
}

let round = 0;
while (true) {
  const left = await imageBudgetRemaining();
  if (left < FLOOR + ROUND_COST) {
    console.log(`[overnight] stopping after ${round} round(s): $${left.toFixed(2)} left, a round needs $${ROUND_COST}`);
    break;
  }
  const character = await nextCharacter();
  if (!character) { console.log('[overnight] the cast is empty — nothing to design'); break; }
  round += 1;
  console.log(`\n[overnight] === round ${round}: ${character} — $${left.toFixed(2)} available ===`);
  try {
    const r = await runDesignSession({ character, explore: 6, variations: 6, tag: `r${round}-${new Date().toISOString().slice(11, 16).replace(":", "")}` });
    console.log(`[overnight] round ${round}: ${JSON.stringify(r)}`);
    if (r.outOfFunds) { console.log('[overnight] venice account is out of funds; stopping'); break; }
    if (!r.ran) { console.log('[overnight] round produced nothing; stopping rather than burning the cap'); break; }
  } catch (e) {
    console.log(`[overnight] round ${round} threw: ${String(e.message).slice(0, 200)}`);
    break;
  }
}
console.log('[overnight] done');
