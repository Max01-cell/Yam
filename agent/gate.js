// gate.js — tiny Fastify server with two faces:
//   PUBLIC  (read-only): the agent's mind, for the website + anyone curious
//   ADMIN   (x-admin-token): approve/reject queued actions from your phone
//
// Approved actions are executed by executor.js on its own timer — the gate
// only flips status. Separation means a bug here can't fire an action.

import Fastify from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { pendingActions, markAction } from './memory.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const app = Fastify({ logger: true });
app.addHook('onSend', async (req, reply) => {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-headers', 'x-admin-token, content-type');
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
});
app.options('/*', async (req, reply) => reply.code(204).send());
const ADMIN = process.env.ADMIN_TOKEN;

// ---------- PUBLIC: the mind, readable by anyone ----------
app.get('/mind/thoughts', async (req) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const { data } = await supabase.from('thoughts')
    .select('created_at, kind, content')
    .order('created_at', { ascending: false }).limit(limit);
  return data ?? [];
});

app.get('/mind/state', async () => {
  const { data } = await supabase.from('memory_state').select('key, value, updated_at, revision');
  // budget is public on purpose — the ledger is part of the proof
  return data ?? [];
});

app.get('/mind/trail', async () => {
  const { data } = await supabase.from('crawl_log')
    .select('created_at, url, title, verdict, interest_score')
    .order('created_at', { ascending: false }).limit(100);
  return data ?? [];
});

app.get('/mind/creations', async () => {
  const { data } = await supabase.from('creations')
    .select('created_at, media_type, prompt, storage_path, self_score, posted')
    .order('created_at', { ascending: false }).limit(24);
  // storage_path → public URL is resolved client-side or via Supabase storage public bucket
  return (data ?? []).map(c => ({ ...c, url: c.storage_path || null }));
});

app.get('/mind/ledger', async () => {
  const { data } = await supabase.from('spend_ledger')
    .select('created_at, service, amount_usd, detail')
    .order('created_at', { ascending: false }).limit(200);
  return data ?? [];
});

// ---------- ADMIN: the gate ----------
function auth(req, reply) {
  if (!ADMIN || req.headers['x-admin-token'] !== ADMIN) {
    reply.code(401).send({ error: 'nope' });
    return false;
  }
  return true;
}

app.get('/gate/pending', async (req, reply) => {
  if (!auth(req, reply)) return;
  return pendingActions();
});

app.post('/gate/:id/approve', async (req, reply) => {
  if (!auth(req, reply)) return;
  await markAction(Number(req.params.id), 'approved');
  return { ok: true, id: req.params.id, status: 'approved' };
});

app.post('/gate/:id/reject', async (req, reply) => {
  if (!auth(req, reply)) return;
  await markAction(Number(req.params.id), 'rejected');
  return { ok: true, id: req.params.id, status: 'rejected' };
});

app.listen({ port: Number(process.env.PORT ?? 8787), host: '0.0.0.0' });
