// memory.js — the agent's read/write access to its own mind (Supabase)
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// How many thoughts think() can see. ONE definition, imported by everyone:
// if the cycle and the consolidator disagreed about this number, consolidation
// would either eat thoughts still in working memory or never catch up.
export const WORKING_WINDOW = Number(process.env.THOUGHT_WINDOW || 40);

export async function getState(key) {
  const { data, error } = await supabase
    .from('memory_state').select('value, revision').eq('key', key).single();
  if (error) throw new Error(`memory_state read failed for ${key}: ${error.message}`);
  return data;
}

export async function setState(key, value) {
  const current = await getState(key).catch(() => null);
  const revision = current ? current.revision + 1 : 1;
  const { error } = await supabase.from('memory_state')
    .upsert({ key, value, revision, updated_at: new Date().toISOString() });
  if (error) throw new Error(`memory_state write failed for ${key}: ${error.message}`);
}

export async function recordThought(cycleId, kind, content, { refs = [], sourceUrls = [] } = {}) {
  const { data, error } = await supabase.from('thoughts')
    .insert({ cycle_id: cycleId, kind, content, refs, source_urls: sourceUrls })
    .select('id').single();
  if (error) throw new Error(`thought write failed: ${error.message}`);
  return data.id;
}

export async function recentThoughts(limit = 40) {
  const { data, error } = await supabase.from('thoughts')
    .select('id, created_at, kind, content')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`thoughts read failed: ${error.message}`);
  return data.reverse(); // oldest first for the prompt
}

export async function logCrawl(cycleId, { url, title, verdict, interestScore }) {
  await supabase.from('crawl_log').insert({
    cycle_id: cycleId, url, title, verdict, interest_score: interestScore
  });
}

export async function proposeAction(cycleId, actionType, payload, rationale, selfScore) {
  const { data, error } = await supabase.from('action_queue')
    .insert({
      cycle_id: cycleId, action_type: actionType, payload,
      agent_rationale: rationale, self_score: selfScore
    })
    .select('id').single();
  if (error) throw new Error(`action proposal failed: ${error.message}`);
  return data.id;
}

export async function pendingActions() {
  const { data } = await supabase.from('action_queue')
    .select('*').eq('status', 'pending').order('created_at');
  return data ?? [];
}

export async function approvedUnexecuted() {
  const { data } = await supabase.from('action_queue')
    .select('*').eq('status', 'approved').order('created_at');
  return data ?? [];
}

export async function recentActions(limit = 5) {
  const { data } = await supabase.from('action_queue')
    .select('id, action_type, status, created_at, payload, result')
    .order('created_at', { ascending: false }).limit(limit);
  return (data ?? []).map(r => ({
    id: r.id, action_type: r.action_type, status: r.status,
    created_at: r.created_at, path: r.payload?.path,
    error: r.status === 'failed' ? String(r.result?.error ?? '').slice(0, 160) : null,
    // Measurements of a drawing yam authored. Carried through so the feedback
    // loop includes facts about the marks, not only yam's impression of them.
    measured: r.result?.measured ? String(r.result.measured).slice(0, 200) : null,
  }));
}

// The crawl trail has been written every cycle since the schema went in and
// never once read back. It is the only record of which sources actually earn
// their place in the diet.
export async function crawlStats(limit = 400) {
  const { data, error } = await supabase.from('crawl_log')
    .select('url, interest_score, created_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`crawl log read failed: ${error.message}`);
  return data ?? [];
}

export async function autonomousPending(types) {
  const { data } = await supabase.from('action_queue')
    .select('*').eq('status', 'pending').in('action_type', types).order('created_at');
  return data ?? [];
}

export async function markAction(id, status, result = null) {
  const patch = { status, result };
  if (status === 'approved' || status === 'rejected') patch.reviewed_at = new Date().toISOString();
  if (status === 'executed' || status === 'failed') patch.executed_at = new Date().toISOString();
  await supabase.from('action_queue').update(patch).eq('id', id);
}

export function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// spent_today was never reset by anything — no cron, no timer, no code path — so it was
// the running total since the ledger began and "daily cap" was in fact a lifetime cap.
// Left alone it silently and permanently disables the two things that check it, image
// generation and memory consolidation, while cognition keeps spending because think()
// does not check at all. The roll happens on read as well as on write: a budget that
// only reset when money was spent would stay exhausted precisely when it is exhausted.
function rolled(v) {
  const today = utcDay();
  if (v?.day !== today) return { ...v, day: today, spent_today: 0, last_day_spend: Number(v?.spent_today ?? 0) };
  return v;
}

export async function recordSpend(cycleId, service, amountUsd, detail = '') {
  await supabase.from('spend_ledger').insert({
    cycle_id: cycleId, service, amount_usd: amountUsd, detail
  });
  const budget = await getState('budget');
  const v = rolled(budget.value);
  v.spent_today = Number((Number(v.spent_today || 0) + amountUsd).toFixed(4));
  await setState('budget', v);
}

export async function budgetRemaining() {
  const { value } = await getState('budget');
  const v = rolled(value);
  if (v !== value) await setState('budget', v).catch(() => {});
  return Number(v.daily_cap_usd) - Number(v.spent_today || 0);
}

export async function saveNote(topic, subject, content) {
  const { data, error } = await supabase.from('study_notes')
    .insert({ topic, subject, content }).select('id').single();
  if (error) throw new Error(`note save failed: ${error.message}`);
  return data.id;
}

// PostgREST `or=` filters are comma- and paren-delimited, so a search term
// containing those characters silently truncates the filter into something
// that matches the wrong thing. Strip the delimiters and the ilike wildcards
// rather than escaping them — these terms are short subjects, not queries.
export function sanitizeTerm(s) {
  return String(s ?? '')
    .replace(/[,()%*\\"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// yam names a subject and gets back everything it has written about it.
// Searches the body too: it files notes under topics it picks in the moment,
// so the word it remembers is often in the content, not the topic.
export async function searchNotes(term, limit = 5) {
  const q = sanitizeTerm(term);
  if (!q) return [];
  const { data, error } = await supabase.from('study_notes')
    .select('created_at, topic, subject, content')
    .or(`topic.ilike.%${q}%,subject.ilike.%${q}%,content.ilike.%${q}%`)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`note search failed for "${q}": ${error.message}`);
  return data ?? [];
}

// Every topic in the notebook, not just the recent slice. This is what keeps
// the notebook navigable once it outgrows the 20 rows shown in full.
export async function notebookTopics(limit = 500) {
  const { data, error } = await supabase.from('study_notes')
    .select('topic, subject, created_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`notebook index read failed: ${error.message}`);
  return data ?? [];
}

// The oldest thought id still inside the working window. Anything below this
// has fallen out of what think() can see, and is the ONLY material safe to
// consolidate — compacting a thought yam can still read would be premature.
export async function workingWindowFloorId(windowSize = WORKING_WINDOW) {
  const { data, error } = await supabase.from('thoughts')
    .select('id').order('created_at', { ascending: false }).limit(windowSize);
  if (error) throw new Error(`window floor read failed: ${error.message}`);
  const ids = (data ?? []).map(r => Number(r.id)).filter(Number.isFinite);
  return ids.length ? Math.min(...ids) : null;
}

// Aged-out thoughts in insertion order, exclusive on both ends.
export async function thoughtsBetween(afterId, beforeId, limit = 80) {
  const { data, error } = await supabase.from('thoughts')
    .select('id, created_at, kind, content')
    .gt('id', afterId).lt('id', beforeId)
    .order('id', { ascending: true }).limit(limit);
  if (error) throw new Error(`aged thoughts read failed: ${error.message}`);
  return data ?? [];
}

export async function recentNotes(limit = 20) {
  const { data } = await supabase.from('study_notes')
    .select('topic, subject, content').order('created_at', { ascending: false }).limit(limit);
  return data ?? [];
}

export async function recentCreations(limit = 8) {
  const { data } = await supabase.from('creations')
    .select('created_at, prompt, storage_path, self_score')
    .order('created_at', { ascending: false }).limit(limit);
  return data ?? [];
}
