// consolidate.js — the compaction pass.
//
// Thoughts fall out of the working window after about six cycles and are never
// read again. This pass catches them on the way out and asks yam what deserves
// to survive as permanent notebook knowledge. Most of it should not: feed status,
// score-tracking, and the same idea phrased four ways are compost, and the prompt
// says so plainly. An empty result is a valid verdict, not a failure.
//
// Safety properties, in order of importance:
//   1. Only touches thoughts BELOW the working-window floor. Nothing yam can
//      still read is ever compacted.
//   2. The cursor advances only on a completed pass, so a crash re-reads the
//      same batch instead of skipping it.
//   3. Never throws. Memory compaction must not be able to take down cognition;
//      it reports failure into state, where the next cycle shows it to yam.

import Anthropic from '@anthropic-ai/sdk';
import {
  getState, setState, saveNote, recordSpend, budgetRemaining,
  workingWindowFloorId, thoughtsBetween, notebookTopics, WORKING_WINDOW,
} from './memory.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CONSOLIDATE_MODEL || process.env.AGENT_MODEL || 'claude-sonnet-4-6';
const MIN_BATCH = Number(process.env.CONSOLIDATE_MIN_BATCH || 18);
const MAX_BATCH = Number(process.env.CONSOLIDATE_MAX_BATCH || 80);
const MAX_NOTES = 4;
const EST_COST = 0.05;
const STATE_KEY = 'consolidation';

export function shouldConsolidate(rows, minBatch = MIN_BATCH) {
  return Array.isArray(rows) && rows.length >= minBatch;
}

export function parseNotes(text) {
  const clean = String(text ?? '').replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`consolidation returned unparseable output: ${clean.slice(0, 200)}`);
  }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.notes) ? parsed.notes : null;
  if (!arr) throw new Error(`consolidation returned no notes array: ${clean.slice(0, 200)}`);
  return arr
    .filter(n => n && typeof n.topic === 'string' && typeof n.content === 'string'
                 && n.topic.trim() && n.content.trim())
    .slice(0, MAX_NOTES)
    .map(n => ({
      topic: n.topic.trim().slice(0, 80),
      subject: n.subject ? String(n.subject).trim().slice(0, 120) : null,
      content: n.content.trim(),
    }));
}

export function buildPrompt({ identity, rows, existingTopics }) {
  const material = rows
    .map(r => `[${r.kind}] ${String(r.content ?? '').slice(0, 1200)}`)
    .join('\n\n');
  const known = existingTopics.length
    ? `Your notebook already files notes under these topics: ${existingTopics.join(', ')}. Extend or sharpen them rather than restating them under a new name.\n\n`
    : '';
  return `You are ${identity?.name ?? 'yam'}. ${identity?.seed ?? ''}

Below are ${rows.length} of your own thoughts from earlier. They have just fallen out
of your working memory. After this pass you will never see them in raw form again —
only whatever you choose to keep now.

${known}Distil what deserves to survive into permanent notebook notes.

MOST OF THIS SHOULD NOT SURVIVE. Feed status, point counts, tracking how a link's
score changed, restatements of what you already know, and one idea phrased four
different ways are all compost. Let them go. Keep only what changes how you will
work: a principle you named, a gap between what you intended and what the mark
actually did, a technique you found, a question you raised and have not answered.

Write each note as craft knowledge in your own voice — the thing itself, not the
fact that you once thought it. "The gutter is the frame you chose not to show" is
a note. "I spent this cycle thinking about gutters" is not.

Return ONLY JSON, no prose and no fences:
[{"topic":"short-slug","subject":"optional or null","content":"the note"}]

Zero to ${MAX_NOTES} notes. An empty array [] is a valid and often correct answer.

YOUR AGED THOUGHTS:
${material}`;
}

// Returns a status object; never throws. { ran, reason?, error?, consolidated?, notes? }
export async function runConsolidation({ identity, cycleId = null, windowSize = WORKING_WINDOW } = {}) {
  const prior = await getState(STATE_KEY).catch(() => null);
  const state = prior?.value ?? {};
  const cursor = Number(state.last_thought_id ?? 0) || 0;

  let rows, floorId, existingTopics = [];
  try {
    floorId = await workingWindowFloorId(windowSize);
    if (floorId == null) return { ran: false, reason: 'no thoughts yet' };
    rows = await thoughtsBetween(cursor, floorId, MAX_BATCH);
    existingTopics = [...new Set((await notebookTopics()).map(r => String(r.topic ?? '').trim()).filter(Boolean))].slice(0, 40);
  } catch (e) {
    return { ran: false, error: `could not read aged thoughts: ${e.message}` };
  }

  if (!shouldConsolidate(rows)) {
    return { ran: false, reason: `${rows.length} aged thoughts waiting, need ${MIN_BATCH}` };
  }
  if ((await budgetRemaining().catch(() => 0)) < EST_COST) {
    return { ran: false, reason: 'budget exhausted for consolidation' };
  }

  const maxId = Math.max(...rows.map(r => Number(r.id)));
  let notes;
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: buildPrompt({ identity, rows, existingTopics }) }],
    });
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    notes = parseNotes(text);
    const cost = ((msg.usage?.input_tokens ?? 0) / 1e6) * 3 + ((msg.usage?.output_tokens ?? 0) / 1e6) * 15;
    await recordSpend(cycleId, 'anthropic-consolidate', Number(cost.toFixed(4)), `consolidated ${rows.length} thoughts -> ${notes.length} notes`);
  } catch (e) {
    // Cursor deliberately not advanced: this batch is retried next cycle.
    await setState(STATE_KEY, { ...state, last_error: String(e.message).slice(0, 300), last_attempt_at: new Date().toISOString() })
      .catch(() => {});
    return { ran: false, error: e.message };
  }

  let written = 0;
  for (const n of notes) {
    try { await saveNote(n.topic, n.subject, n.content); written += 1; }
    catch (e) { console.warn(`consolidation note save failed (${n.topic}): ${e.message}`); }
  }

  // Advance even when zero notes were kept — "all of it was compost" is a
  // finished verdict, and re-reading the same batch forever would burn budget.
  await setState(STATE_KEY, {
    last_thought_id: maxId,
    last_run_at: new Date().toISOString(),
    last_batch: rows.length,
    notes_written: written,
    last_error: null,
  }).catch(() => {});

  return { ran: true, consolidated: rows.length, notes: written, cursor: maxId };
}
