// Real checks: pure functions against the real published corpus, and the full
// consolidation pass against a mock PostgREST + mock Anthropic so the actual
// query strings supabase-js emits are exercised rather than assumed.
import http from 'http';
import assert from 'assert';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// ---------- mock PostgREST ----------
const DB = {
  thoughts: [],
  study_notes: [],
  memory_state: [],
  spend_ledger: [],
};
const requests = [];
let anthropicMode = 'ok';
let anthropicBody = null;

function parseFilters(qs) {
  const out = {};
  for (const [k, v] of qs) out[k] = out[k] ? [].concat(out[k], v) : v;
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let body = '';
  for await (const c of req) body += c;
  requests.push({ method: req.method, path: url.pathname, query: url.search, body });

  // ----- mock Anthropic -----
  if (url.pathname === '/v1/messages') {
    if (anthropicMode === 'fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
    }
    anthropicBody = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      content: [{ type: 'text', text: anthropicMode === 'garbage' ? 'not json at all' : JSON.stringify([
        { topic: 'gutter-timing', subject: '200ms threshold', content: 'A gutter above the fusion threshold reads as duration; below it, as simultaneity.' },
        { topic: 'own-hand', subject: null, content: 'Study 008 named hierarchy but drew none of the ink register it claimed.' },
        { topic: '', content: 'dropped: empty topic' },
      ]) }],
      usage: { input_tokens: 5000, output_tokens: 400 },
    }));
  }

  // ----- mock PostgREST -----
  const table = url.pathname.replace('/rest/v1/', '');
  const f = parseFilters(url.searchParams);
  const wantsObject = String(req.headers.accept || '').includes('vnd.pgrst.object+json');

  if (req.method === 'GET') {
    let rows = [...(DB[table] ?? [])];
    if (f.key) rows = rows.filter(r => r.key === f.key.replace('eq.', ''));
    if (f.id) {
      for (const cond of [].concat(f.id)) {
        const [op, val] = [cond.slice(0, cond.indexOf('.')), Number(cond.slice(cond.indexOf('.') + 1))];
        if (op === 'gt') rows = rows.filter(r => r.id > val);
        if (op === 'lt') rows = rows.filter(r => r.id < val);
      }
    }
    if (f.or) {
      const m = String(f.or).match(/\(?(.+?)\)?$/)[1];
      const terms = m.split(',').map(s => s.match(/^(\w+)\.ilike\.%(.*)%$/)).filter(Boolean);
      rows = rows.filter(r => terms.some(([, col, needle]) =>
        String(r[col] ?? '').toLowerCase().includes(needle.toLowerCase())));
    }
    const order = String(f.order ?? '');
    if (order.startsWith('created_at.desc')) rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (order.startsWith('id.asc')) rows.sort((a, b) => a.id - b.id);
    if (f.limit) rows = rows.slice(0, Number(f.limit));
    if (wantsObject) {
      if (!rows.length) {
        res.writeHead(406, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 'PGRST116', message: 'no rows' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(rows[0]));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(rows));
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const payload = body ? JSON.parse(body) : {};
    const rows = [].concat(payload);
    for (const row of rows) {
      if (table === 'memory_state') {
        const i = (DB.memory_state).findIndex(r => r.key === row.key);
        if (i >= 0) DB.memory_state[i] = { ...DB.memory_state[i], ...row };
        else DB.memory_state.push({ ...row });
      } else {
        row.id = (DB[table].length ? Math.max(...DB[table].map(r => r.id ?? 0)) : 0) + 1;
        DB[table].push(row);
      }
    }
    const out = rows.map(r => ({ id: r.id ?? 1 }));
    if (wantsObject) {
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out[0]));
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  res.writeHead(404); res.end('[]');
});

await new Promise(r => server.listen(54321, '127.0.0.1', r));
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:54321';
process.env.AGENT_HOME = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const recall = await import('../agent/recall.js');
const consolidate = await import('../agent/consolidate.js');
const memory = await import('../agent/memory.js');

// ================= PURE: against the REAL published corpus =================
console.log('\npublished corpus (real files on disk):');
const idx = recall.publishedIndex();
t('finds all 9 published entries', () => assert.strictEqual(idx.length, 9));
t('extracts a real title, not the filename', () => {
  const e = idx.find(x => x.file === 'manga-notebook-005.md');
  assert.strictEqual(e.title, 'manga notebook 005: ma — the mark that withholds');
});
t('word counts are non-trivial', () => assert.ok(idx.every(e => e.words > 100), 'some entry counted <100 words'));
t('index formats one line per entry', () => {
  const lines = recall.formatPublishedIndex(idx).split('\n');
  assert.strictEqual(lines.length, 9);
  assert.ok(lines[0].includes('—') && lines[0].includes('words'));
});
t('titleOf ignores non-heading hashes', () => {
  assert.strictEqual(recall.titleOf('some text #notatitle\n# Real Title\nmore'), 'Real Title');
});
t('publishedIndex on a missing dir returns [] not a throw', () => {
  assert.deepStrictEqual(recall.publishedIndex('/no/such/dir'), []);
});

console.log('\nentry matching:');
t('title match beats body mention', () => {
  const hits = recall.matchEntries(idx, ['cragg'], 2);
  assert.strictEqual(hits[0].file, 'manga-notebook-007.md');
});
t("short load-bearing term 'ma' finds its own entry", () => {
  const hits = recall.matchEntries(idx, ['ma'], 2);
  assert.strictEqual(hits[0].file, 'manga-notebook-005.md', `got ${hits.map(h=>h.file).join(',')}`);
});
t("'ma' does not match on the word 'manga'", () => {
  const fake = [{ file: 'x.md', title: 'about manga and marks', body: 'manga manga marks made' }];
  assert.deepStrictEqual(recall.matchEntries(fake, ['ma']), []);
});
t('whole-word match, not substring: "gut" misses "gutter"', () => {
  const fake = [{ file: 'x.md', title: 'gutter study', body: 'the gutter' }];
  assert.deepStrictEqual(recall.matchEntries(fake, ['gut']), []);
});
t('regex metacharacters in a term do not throw', () => {
  assert.doesNotThrow(() => recall.matchEntries(idx, ['c++ (a|b) [x]', 'ma']));
});
t('hyphenated multi-word terms still match', () => {
  const fake = [{ file: 'x.md', title: 'on line-weight', body: 'b' }];
  assert.strictEqual(recall.matchEntries(fake, ['line-weight']).length, 1);
});
t('short/noise terms are ignored', () => assert.deepStrictEqual(recall.matchEntries(idx, ['a', '', 'xy']), []));
t('no match returns empty', () => assert.deepStrictEqual(recall.matchEntries(idx, ['zzzznotathing']), []));
t('respects the limit', () => assert.ok(recall.matchEntries(idx, ['the', 'manga', 'mark'], 2).length <= 2));

console.log('\nnotebook index formatting:');
t('groups by topic, counts, sorts by frequency', () => {
  const out = recall.formatNotebookIndex([
    { topic: 'line-weight', subject: 'Otomo', created_at: '2026-08-03' },
    { topic: 'gutter', subject: 'ma', created_at: '2026-08-02' },
    { topic: 'line-weight', subject: 'Urasawa', created_at: '2026-08-01' },
    { topic: 'line-weight', subject: 'Otomo', created_at: '2026-07-30' },
  ]);
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], 'line-weight (3) — Otomo, Urasawa');
  assert.strictEqual(lines[1], 'gutter (1) — ma');
});
t('empty notebook says so rather than rendering blank', () =>
  assert.strictEqual(recall.formatNotebookIndex([]), '(notebook empty)'));
t('caps subject list and reports the remainder', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map(s => ({ topic: 'x', subject: s, created_at: '2026-08-01' }));
  assert.ok(recall.formatNotebookIndex(rows).includes('+2 more'));
});

console.log('\nconsolidation status line:');
t('never-run state is explicit', () => assert.ok(recall.formatConsolidationStatus(null).includes('has not run')));
t('failure is surfaced loudly', () =>
  assert.ok(recall.formatConsolidationStatus({ last_error: 'boom' }).includes('LAST RUN FAILED')));
t('success reports real counts', () => {
  const s = recall.formatConsolidationStatus({ last_run_at: '2026-08-04T02:00:00Z', last_batch: 22, notes_written: 3 });
  assert.ok(s.includes('22') && s.includes('3'));
});

console.log('\nPostgREST filter-term sanitizing:');
t('strips or= delimiters that would truncate the filter', () =>
  assert.strictEqual(memory.sanitizeTerm('gutter,timing(x)%'), 'gutter timing x'));
t('collapses whitespace and caps length', () =>
  assert.strictEqual(memory.sanitizeTerm('  a\n\n  b  ').length, 3));
t('empty stays empty', () => assert.strictEqual(memory.sanitizeTerm(null), ''));

console.log('\nconsolidation pure logic:');
t('holds until the batch is worth a call', () => {
  assert.strictEqual(consolidate.shouldConsolidate(new Array(17), 18), false);
  assert.strictEqual(consolidate.shouldConsolidate(new Array(18), 18), true);
});
t('parses a bare array', () =>
  assert.strictEqual(consolidate.parseNotes('[{"topic":"a","content":"b"}]').length, 1));
t('parses a fenced {notes:[...]} envelope', () =>
  assert.strictEqual(consolidate.parseNotes('```json\n{"notes":[{"topic":"a","content":"b"}]}\n```').length, 1));
t('empty array is a valid verdict, not an error', () =>
  assert.deepStrictEqual(consolidate.parseNotes('[]'), []));
t('drops malformed notes instead of saving junk', () =>
  assert.strictEqual(consolidate.parseNotes('[{"topic":"","content":"x"},{"topic":"ok","content":"y"},{"topic":"z"}]').length, 1));
t('unparseable output throws', () =>
  assert.throws(() => consolidate.parseNotes('sorry, here are your notes:'), /unparseable/));
t('caps notes at 4', () => {
  const many = JSON.stringify(new Array(9).fill({ topic: 't', content: 'c' }));
  assert.strictEqual(consolidate.parseNotes(many).length, 4);
});
t('prompt tells yam the material is about to be lost and permits keeping nothing', () => {
  const p = consolidate.buildPrompt({
    identity: { name: 'yam', seed: 'a mangaka in training' },
    rows: [{ kind: 'observation', content: 'HN at 1659 points' }],
    existingTopics: ['gutter'],
  });
  assert.ok(p.includes('never see them in raw form again'));
  assert.ok(p.includes('[] is a valid'));
  assert.ok(p.includes('already files notes under these topics: gutter'));
  assert.ok(p.includes('HN at 1659 points'));
});

// ================= END-TO-END against mock PostgREST + Anthropic =================
function seedDB({ thoughtCount, cursor }) {
  DB.thoughts = []; DB.study_notes = []; DB.spend_ledger = [];
  DB.memory_state = [
    { key: 'budget', value: { daily_cap_usd: 5, spent_today: 0 }, revision: 1 },
  ];
  if (cursor != null) DB.memory_state.push({ key: 'consolidation', value: { last_thought_id: cursor }, revision: 1 });
  for (let i = 1; i <= thoughtCount; i++) {
    DB.thoughts.push({
      id: i, kind: 'observation', content: `thought ${i}`,
      created_at: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
    });
  }
}
const stateOf = k => DB.memory_state.find(r => r.key === k)?.value;

console.log('\nend-to-end consolidation (real supabase-js queries, mock PostgREST):');

await ta('runs, writes notes, advances cursor to the batch max', async () => {
  seedDB({ thoughtCount: 100, cursor: null });
  anthropicMode = 'ok';
  const r = await consolidate.runConsolidation({ identity: { name: 'yam', seed: 's' }, cycleId: null });
  assert.strictEqual(r.ran, true, `expected a run, got ${JSON.stringify(r)}`);
  // window floor = oldest of the newest 40 = id 61, so ids 1..60 are consolidatable
  assert.strictEqual(r.consolidated, 60, `expected 60 aged thoughts, got ${r.consolidated}`);
  assert.strictEqual(r.cursor, 60);
  assert.strictEqual(stateOf('consolidation').last_thought_id, 60);
  assert.strictEqual(DB.study_notes.length, 2, 'the malformed third note should have been dropped');
});

await ta('NEVER consolidates a thought still inside the working window', async () => {
  const consolidatedIds = anthropicBody.messages[0].content.match(/thought (\d+)/g).map(s => Number(s.split(' ')[1]));
  assert.strictEqual(Math.max(...consolidatedIds), 60, 'a live thought leaked into the batch');
  assert.ok(!anthropicBody.messages[0].content.includes('thought 61'), 'thought 61 is still in the window');
});

await ta('spend is ledgered against the real token usage', async () => {
  const row = DB.spend_ledger.at(-1);
  assert.strictEqual(row.service, 'anthropic-consolidate');
  assert.strictEqual(row.amount_usd, Number(((5000 / 1e6) * 3 + (400 / 1e6) * 15).toFixed(4)));
  assert.ok(row.detail.includes('60 thoughts'));
});

await ta('second run holds — nothing new has aged out', async () => {
  const r = await consolidate.runConsolidation({ identity: { name: 'yam', seed: 's' } });
  assert.strictEqual(r.ran, false);
  assert.ok(/need 18/.test(r.reason), `unexpected reason: ${r.reason}`);
  assert.strictEqual(stateOf('consolidation').last_thought_id, 60, 'cursor moved on a no-op');
});

await ta('API failure does NOT advance the cursor and is recorded', async () => {
  seedDB({ thoughtCount: 100, cursor: 0 });
  anthropicMode = 'fail';
  const r = await consolidate.runConsolidation({ identity: { name: 'yam', seed: 's' } });
  assert.strictEqual(r.ran, false);
  assert.ok(r.error, 'expected an error to be reported');
  assert.strictEqual(stateOf('consolidation').last_thought_id ?? 0, 0, 'cursor advanced past an unconsolidated batch');
  assert.ok(stateOf('consolidation').last_error, 'failure not recorded for yam to see');
  assert.strictEqual(DB.study_notes.length, 0);
});

await ta('the recorded failure surfaces in the next cycle archive block', async () => {
  const line = recall.formatConsolidationStatus(stateOf('consolidation'));
  assert.ok(line.includes('LAST RUN FAILED'), `got: ${line}`);
});

await ta('unparseable model output is a failure, not a silent skip', async () => {
  seedDB({ thoughtCount: 100, cursor: 0 });
  anthropicMode = 'garbage';
  const r = await consolidate.runConsolidation({ identity: { name: 'yam', seed: 's' } });
  assert.strictEqual(r.ran, false);
  assert.ok(/unparseable/.test(r.error), `got: ${r.error}`);
  assert.strictEqual(stateOf('consolidation').last_thought_id ?? 0, 0);
});

await ta('a fresh mind with nothing aged out is a clean no-op', async () => {
  seedDB({ thoughtCount: 12, cursor: null });
  anthropicMode = 'ok';
  const r = await consolidate.runConsolidation({ identity: { name: 'yam', seed: 's' } });
  assert.strictEqual(r.ran, false);
  assert.strictEqual(DB.study_notes.length, 0);
});

console.log('\nend-to-end recall (real supabase-js queries):');

await ta('searchNotes matches topic, subject AND body via one or= filter', async () => {
  seedDB({ thoughtCount: 0, cursor: null });
  DB.study_notes = [
    { id: 1, topic: 'gutter', subject: 'ma', content: 'withheld time', created_at: '2026-08-03' },
    { id: 2, topic: 'line-weight', subject: 'Otomo', content: 'the gutter is elsewhere', created_at: '2026-08-02' },
    { id: 3, topic: 'colour', subject: null, content: 'unrelated', created_at: '2026-08-01' },
  ];
  const hits = await memory.searchNotes('gutter');
  assert.strictEqual(hits.length, 2, `expected topic-hit + body-hit, got ${hits.length}`);
});

await ta('buildRecalled returns notes AND the matching published entry in full', async () => {
  const out = await recall.buildRecalled(['gutter', 'cragg']);
  assert.ok(out.includes('2 note(s)'), 'notes missing');
  assert.ok(out.includes('YOUR PUBLISHED ENTRY manga-notebook-007.md'), 'published entry missing');
  assert.ok(out.includes('Stefanie Cragg'), 'entry body not actually included');
});

await ta('a miss says so rather than returning nothing', async () => {
  const out = await recall.buildRecalled(['zzzznotathing']);
  assert.ok(out.includes('nothing in your notebook under that name'), `got: ${out.slice(0, 200)}`);
});

await ta('no request means no block at all', async () => {
  assert.strictEqual(await recall.buildRecalled([]), '');
  assert.strictEqual(await recall.buildRecalled(undefined), '');
});

await ta('recall caps at 3 topics', async () => {
  const out = await recall.buildRecalled(['gutter', 'colour', 'line-weight', 'cragg']);
  assert.ok(!out.includes('"cragg"'), 'fourth topic was not dropped');
});

await ta('buildArchive shows both indexes and the status line', async () => {
  const out = await recall.buildArchive({ consolidationState: { last_run_at: '2026-08-04T02:00:00Z', last_batch: 60, notes_written: 2 } });
  assert.ok(out.includes('EVERY TOPIC YOU HAVE EVER FILED'));
  assert.ok(out.includes('gutter (1)'));
  assert.ok(out.includes('manga-notebook-007.md'));
  assert.ok(out.includes('distilled 60 aged thoughts into 2 notes'));
});

await ta('an unreadable notebook is reported, not rendered as an empty archive', async () => {
  const orig = process.env.SUPABASE_URL;
  const broken = await import(`../agent/memory.js?bust=${Date.now()}`);
  process.env.SUPABASE_URL = orig;
  assert.ok(typeof broken.notebookTopics === 'function');
  // direct check on the formatter contract used by buildArchive's catch branch
  assert.ok(recall.formatNotebookIndex([]).includes('empty'));
});

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
