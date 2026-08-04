// Real checks for the curriculum. The property that matters is that coverage is counted
// from notes yam actually filed — a roster that reported intent instead of practice would
// tell yam it had studied someone it had only meant to study.
import assert from 'assert';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_KEY ||= 'x';
process.env.ANTHROPIC_API_KEY ||= 'x';

const { CURRICULUM, studyCoverage, formatCurriculum } = await import('../agent/curriculum.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

console.log('\nroster integrity:');
t('every entry names a work, a transferable take, and a legitimate access route', () => {
  for (const c of CURRICULUM) {
    assert.ok(c.name && c.works && c.take && c.access, `incomplete entry: ${JSON.stringify(c)}`);
    assert.ok(c.take.length > 30, `take too vague to transfer: ${c.name}`);
  }
});
t('the mangaka the project was asked to study are on it', () => {
  const names = CURRICULUM.map(c => c.name);
  for (const n of ['Eiichiro Oda', 'Tite Kubo', 'Kei Urana']) assert.ok(names.includes(n), `${n} missing`);
});
t('at least two entries are public domain, the only ones directly viewable', () => {
  assert.ok(CURRICULUM.filter(c => /PUBLIC DOMAIN/.test(c.access)).length >= 2);
});
t('no entry points at a scan site', () => {
  for (const c of CURRICULUM) assert.ok(!/scan|aggregat|pirat/i.test(c.access), c.name);
});

console.log('\ncoverage is measured from filed notes:');
const notes = [
  { topic: 'line-weight', subject: 'Urasawa vs Otomo' },
  { topic: 'silhouette', subject: 'Oda crowd staging' },
  { topic: 'negative-space', subject: 'Eiichiro Oda again' },
  { topic: 'gutter', subject: null },
];

t('counts by surname as it actually appears in a subject', () => {
  const c = studyCoverage(notes);
  assert.strictEqual(c.get('Naoki Urasawa'), 1, 'surname-only mention missed');
  assert.strictEqual(c.get('Katsuhiro Otomo'), 1);
});
t('counts full name and surname as the same artist', () => {
  assert.strictEqual(studyCoverage(notes).get('Eiichiro Oda'), 2);
});
t('an unstudied artist counts zero, not undefined', () => {
  assert.strictEqual(studyCoverage(notes).get('Junji Ito'), 0);
});
t('unrelated notes do not create phantom coverage', () => {
  const c = studyCoverage([{ topic: 'compost', subject: 'nothing to do with anyone' }]);
  assert.strictEqual([...c.values()].reduce((a, b) => a + b, 0), 0);
});
t('empty and junk input is zero coverage, not a throw', () => {
  assert.doesNotThrow(() => studyCoverage([]));
  assert.doesNotThrow(() => studyCoverage(null));
  assert.doesNotThrow(() => studyCoverage([null, {}, { topic: 5 }]));
});

console.log('\nthe prompt block:');
t('with no notes it says plainly that none of them have been studied', () => {
  const out = formatCurriculum([]);
  assert.ok(/none of them/i.test(out), out.slice(0, 120));
  assert.ok(/derived from writing about art/i.test(out));
});
t('reports who has been studied, with real counts', () => {
  const out = formatCurriculum(notes);
  assert.ok(out.includes('Eiichiro Oda (2)'), out.slice(0, 200));
  assert.ok(out.includes('Naoki Urasawa (1)'));
});
t('names who has been ignored', () => {
  const out = formatCurriculum(notes);
  assert.ok(/Not yet touched:.*Tite Kubo/s.test(out), 'untouched list missing Kubo');
  assert.ok(!/Not yet touched:[^\n]*Eiichiro Oda/.test(out), 'a studied artist was listed as untouched');
});
t('expands briefs only for the least-studied, and caps them', () => {
  const out = formatCurriculum(notes, { expand: 2 });
  assert.strictEqual((out.match(/take:/g) || []).length, 2);
  assert.ok(out.includes('where:'), 'access route not shown');
});
t('once everything is studied it still offers briefs rather than going blank', () => {
  const all = CURRICULUM.map(c => ({ topic: 'x', subject: c.name }));
  const out = formatCurriculum(all);
  assert.ok(out.includes('take:'), 'no brief shown when coverage is complete');
  assert.ok(!/Not yet touched/.test(out));
});
t('formatting never throws on junk', () => {
  assert.doesNotThrow(() => formatCurriculum(null));
  assert.doesNotThrow(() => formatCurriculum([{}]));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
