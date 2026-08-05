// invent.js — start a new character, deliberately unlike the ones that exist.
//
// The cast had exactly one member for the project's whole life, and the refinement loop
// picks whoever is scoring worst — which, with a cast of one, is the same figure every
// time, forever. Nine consecutive runs went to THRESHOLD, and all nine critiques named the
// same raised shoulder. Every character yam had ever drawn was one character with one
// anatomical idea, because nothing in the system could ever propose a second.
//
// Inventing is therefore not a nice-to-have, it is the missing half of the loop: refinement
// makes one design better, invention makes the body of work wider. This writes a character
// that must differ from everyone already in the cast along named structural axes, so the
// next one cannot be the raised shoulder again under a different name.

import Anthropic from '@anthropic-ai/sdk';
import { getState, setState, cognitionBudgetRemaining, recordSpend } from './memory.js';
import { mergeCast } from './cast.js';
import { readLibrary, pickInspiration } from './inspiration.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';
const EST_COST = Number(process.env.INVENT_COST || 0.03);

// How many characters the cast should hold before invention stops and everything goes into
// refining what exists. Below cast.js's cap of six, so there is always room to retire one
// and try again rather than the cast being wedged full.
export const TARGET_CAST = Number(process.env.TARGET_CAST || 4);

// The axes a new character must differ along. Named explicitly because "make it different"
// produces the same person with a different coat — the model reaches for whatever it just
// saw unless the dimensions of difference are spelled out and it is asked to state which
// one it moved along.
const DIFFERENCE_AXES = [
  'body architecture — where the mass sits, what the skeleton does that is unusual',
  'age and wear — how much life has already happened to this body and where it shows',
  'silhouette logic — what single shape the figure reads as in pure black',
  'how they are dressed — construction, volume, condition, and what that says about their work',
  'what they carry or refuse to carry, and what it has done to how they stand',
  'register — whether the body is closed and guarded or open and extended',
];

export async function inventCharacter({ reason = '' } = {}) {
  const log = (m) => console.log(`[invent] ${m}`);
  if ((await cognitionBudgetRemaining()) < EST_COST) {
    return { ran: false, reason: 'thinking budget too low to invent' };
  }

  const castState = (await getState('cast').catch(() => null))?.value ?? null;
  const existing = Object.entries(castState?.characters ?? {});
  if (existing.length >= TARGET_CAST) {
    return { ran: false, reason: `cast already holds ${existing.length}`, cast: existing.map(([n]) => n) };
  }

  // The existing cast is shown so the new one can be made unlike it — and the raised
  // shoulder in particular is called out, because it is the idea that has quietly become
  // the house style through sheer repetition.
  const roster = existing.length
    ? existing.map(([n, c]) => `- ${n}: ${String(c.canon).slice(0, 260)}`).join('\n')
    : '(the cast is empty)';

  // Two real references so the invention starts from something seen rather than from the
  // model's defaults, which is where generic anime leads come from.
  const lib = await readLibrary();
  const refs = [pickInspiration(lib), (lib.items ?? [])[1]].filter(Boolean)
    .map(i => `- [${i.kind}] ${i.silhouette || i.garment || i.pose}`).join('\n') || '(no references yet)';

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1400,
    messages: [{
      role: 'user',
      content:
        `You are yam, a mangaka in training, inventing a NEW character for your cast.\n\n`
        + `WHO ALREADY EXISTS — the new character must not be a variation on any of them:\n${roster}\n\n`
        + `REAL REFERENCES you studied recently, for grounding:\n${refs}\n\n`
        + `You must differ from everyone above along at least THREE of these axes, and say which:\n`
        + DIFFERENCE_AXES.map(a => `- ${a}`).join('\n') + '\n\n'
        + `HARD CONSTRAINTS.\n`
        + `1. Do NOT give this character an asymmetric or raised shoulder, a growth on the shoulder, `
        + `or anything carried that reshapes the shoulder line. That idea already belongs to an `
        + `existing character and repeating it is how a cast of one becomes a cast of five that all `
        + `look the same.\n`
        + `2. Not a conventionally handsome or pretty anime protagonist. No large glossy eyes, no `
        + `idealised symmetry, no stock hero face. A body and face nobody else has drawn.\n`
        + `3. Not a copy of any existing franchise character, and never "in the style of" anyone.\n\n`
        + `Write: a NAME (one word, uppercase, not a real person's name), CANON (what is permanently `
        + `fixed about them — the things that must survive every redraw, written for a reader), `
        + `APPEARANCE (a fixed physical description written for an image RENDERER: build, proportion, `
        + `head and face structure, how they are dressed, what the silhouette does), and two OPEN `
        + `QUESTIONS the drawing has not answered yet.\n\n`
        + `Return ONLY JSON: {"name":"...","canon":"...","appearance":"...","open_questions":["...","..."],"differs_by":["axis","axis","axis"]}`,
    }],
  });

  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  const cost = ((msg.usage?.input_tokens ?? 0) / 1e6) * 3.0 + ((msg.usage?.output_tokens ?? 0) / 1e6) * 15.0;
  await recordSpend(null, 'anthropic-invent', Number(cost.toFixed(4)), `invented ${parsed.name}`).catch(() => {});

  const name = String(parsed.name ?? '').trim().slice(0, 60);
  if (!name) return { ran: false, reason: 'no name returned' };
  if (existing.some(([n]) => n.toLowerCase() === name.toLowerCase())) {
    return { ran: false, reason: `${name} already exists` };
  }

  const fresh = (await getState('cast')).value;
  await setState('cast', mergeCast(fresh, {
    characters: {
      [name]: {
        canon: String(parsed.canon ?? '').slice(0, 600),
        appearance: String(parsed.appearance ?? '').slice(0, 600),
        open_questions: Array.isArray(parsed.open_questions) ? parsed.open_questions.slice(0, 5) : [],
      },
    },
  }));

  log(`${name} joins the cast — differs by: ${(parsed.differs_by ?? []).join('; ').slice(0, 140)}`);
  log(`  ${String(parsed.canon ?? '').slice(0, 170)}`);
  return { ran: true, name, differsBy: parsed.differs_by ?? [], reason };
}
