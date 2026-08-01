// memory.js — the agent's read/write access to its own mind (Supabase)
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

export async function markAction(id, status, result = null) {
  const patch = { status, result };
  if (status === 'approved' || status === 'rejected') patch.reviewed_at = new Date().toISOString();
  if (status === 'executed' || status === 'failed') patch.executed_at = new Date().toISOString();
  await supabase.from('action_queue').update(patch).eq('id', id);
}

export async function recordSpend(cycleId, service, amountUsd, detail = '') {
  await supabase.from('spend_ledger').insert({
    cycle_id: cycleId, service, amount_usd: amountUsd, detail
  });
  const budget = await getState('budget');
  const v = budget.value;
  v.spent_today = Number((Number(v.spent_today || 0) + amountUsd).toFixed(4));
  await setState('budget', v);
}

export async function budgetRemaining() {
  const { value } = await getState('budget');
  return Number(value.daily_cap_usd) - Number(value.spent_today || 0);
}
