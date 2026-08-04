// Real checks for the cast. The properties that matter here are the ones that protect
// accumulated work: a merge that cannot silently delete a character, and a practice count
// that cannot be written by the thing being counted.
import assert from 'assert';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_KEY ||= 'x';
process.env.ANTHROPIC_API_KEY ||= 'x';

const {
  mergeCast, recordStudy, formatCast, emptyCast, normaliseName, nameKey, seedFor, recordReference,
} = await import('../agent/cast.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const withOne = mergeCast(emptyCast(), {
  characters: { 'The Surveyor': { canon: 'tall, narrow, carries a folded rod', open_questions: ['how does the rod read at distance?'] } },
});

console.log('\nmerge semantics — the diet bug must not be repeatable here:');

t('omitting a character does NOT delete it', () => {
  const after = mergeCast(withOne, { characters: { Wren: { canon: 'small, round, always mid-turn' } } });
  assert.ok(after.characters['The Surveyor'], 'the omitted character was destroyed');
  assert.strictEqual(Object.keys(after.characters).length, 2);
});

t('an empty update changes nothing', () => {
  assert.deepStrictEqual(mergeCast(withOne, {}).characters, withOne.characters);
  assert.deepStrictEqual(mergeCast(withOne, null).characters, withOne.characters);
});

t('removal is possible, but only explicitly', () => {
  const after = mergeCast(withOne, { retire: ['The Surveyor'] });
  assert.strictEqual(Object.keys(after.characters).length, 0);
  assert.deepStrictEqual(after.retired, ['The Surveyor']);
});

t('canon is updated in place without resetting the record', () => {
  const drawn = recordStudy(withOne, 'The Surveyor', 'https://yam.garden/studies/a.png');
  const after = mergeCast(drawn, { characters: { 'The Surveyor': { canon: 'tall, narrow, rod now always closed' } } });
  assert.strictEqual(after.characters['The Surveyor'].canon, 'tall, narrow, rod now always closed');
  assert.strictEqual(after.characters['The Surveyor'].studies, 1, 'a canon edit reset the practice count');
});

t('case and spacing drift does not fork a character', () => {
  const after = mergeCast(withOne, { characters: { '  the   surveyor ': { canon: 'restated' } } });
  assert.strictEqual(Object.keys(after.characters).length, 1, `forked into ${Object.keys(after.characters)}`);
  assert.strictEqual(after.characters['The Surveyor'].canon, 'restated');
});

t('the cast stays small — a 7th character is refused', () => {
  let s = emptyCast();
  for (let i = 0; i < 9; i++) s = mergeCast(s, { characters: { [`C${i}`]: { canon: 'x' } } });
  assert.strictEqual(Object.keys(s.characters).length, 6);
});

t('junk in an update is ignored, not stored', () => {
  const after = mergeCast(withOne, { characters: { '': { canon: 'x' }, Ghost: null, Other: 'not an object' } });
  assert.strictEqual(Object.keys(after.characters).length, 1);
});

console.log('\nthe practice count is measured, not claimed:');

t('yam cannot write its own study count', () => {
  const after = mergeCast(withOne, { characters: { 'The Surveyor': { canon: 'c', studies: 99, last_study: 'made up' } } });
  assert.strictEqual(after.characters['The Surveyor'].studies, 0);
  assert.strictEqual(after.characters['The Surveyor'].last_study, null);
});

t('drawing increments it, and records where', () => {
  const a = recordStudy(withOne, 'The Surveyor', 'https://yam.garden/studies/one.png');
  const b = recordStudy(a, 'the surveyor', 'https://yam.garden/studies/two.png');
  assert.strictEqual(b.characters['The Surveyor'].studies, 2);
  assert.strictEqual(b.characters['The Surveyor'].last_study, 'https://yam.garden/studies/two.png');
});

t('a study of an unnamed-in-cast character is still recorded, canon blank', () => {
  const after = recordStudy(emptyCast(), 'Someone New', 'https://yam.garden/studies/x.png');
  assert.strictEqual(after.characters['Someone New'].studies, 1);
  assert.strictEqual(after.characters['Someone New'].canon, '');
});

t('a drawing with no character changes nothing', () => {
  assert.deepStrictEqual(recordStudy(withOne, '', 'u').characters, withOne.characters);
  assert.deepStrictEqual(recordStudy(withOne, null, 'u').characters, withOne.characters);
});

t('created_at survives every later edit', () => {
  const born = withOne.characters['The Surveyor'].created_at;
  const after = mergeCast(recordStudy(withOne, 'The Surveyor', 'u'), {
    characters: { 'The Surveyor': { canon: 'new', created_at: '1999-01-01T00:00:00Z' } },
  });
  assert.strictEqual(after.characters['The Surveyor'].created_at, born);
});

console.log('\nthe prompt block:');

t('an empty cast says so and says what to do', () => {
  const out = formatCast(emptyCast());
  assert.ok(/no cast yet/i.test(out), out.slice(0, 80));
  assert.ok(/Start one/i.test(out));
});

t('a drawn character reports its real count', () => {
  const out = formatCast(recordStudy(withOne, 'The Surveyor', 'https://yam.garden/studies/one.png'));
  assert.ok(out.includes('drawn 1 time'), out);
  assert.ok(out.includes('folded rod'), 'canon missing');
  assert.ok(out.includes('how does the rod read at distance?'), 'open question missing');
});

t('a never-drawn character is called out as never drawn', () => {
  assert.ok(formatCast(withOne).includes('never yet drawn'));
});

t('a character with no canon is visibly missing one', () => {
  const out = formatCast(recordStudy(emptyCast(), 'Someone New', 'u'));
  assert.ok(/not written yet/i.test(out), out);
});

t('most-practised character is listed first', () => {
  let s = mergeCast(withOne, { characters: { Wren: { canon: 'small' } } });
  s = recordStudy(recordStudy(s, 'Wren', 'u'), 'Wren', 'u');
  s = recordStudy(s, 'The Surveyor', 'u');
  assert.ok(s.characters.Wren.studies === 2);
  assert.ok(formatCast(s).indexOf('Wren') < formatCast(s).indexOf('The Surveyor'));
});

t('world and retired list appear when set', () => {
  const s = mergeCast(withOne, { world: 'a surveyed country that keeps being remeasured', retire: ['The Surveyor'] });
  const out = formatCast(mergeCast(s, { characters: { Wren: { canon: 'small' } } }));
  assert.ok(out.includes('World: a surveyed country'));
  assert.ok(out.includes('Retired: The Surveyor'));
});

console.log('\nhelpers:');
t('names are trimmed and collapsed', () => assert.strictEqual(normaliseName('  A   B  '), 'A B'));
t('nameKey is case-insensitive', () => assert.strictEqual(nameKey(' The  SURVEYOR '), 'the surveyor'));
t('nothing here throws on junk input', () => {
  assert.doesNotThrow(() => formatCast(null));
  assert.doesNotThrow(() => mergeCast(null, { characters: { X: { canon: 'y' } } }));
  assert.doesNotThrow(() => recordStudy(null, 'X', null));
  assert.doesNotThrow(() => recordReference(null, 'X', 'u'));
});

console.log('\nreference sheets and seeds:');

t('a seed is derived from the name — stable, in range, distinct per character', () => {
  assert.strictEqual(seedFor('THRESHOLD'), seedFor('  threshold '), 'seed drifted with case/spacing');
  const a = seedFor('THRESHOLD');
  assert.ok(Number.isInteger(a) && a > 0 && a < 2e9, `bad seed ${a}`);
  assert.notStrictEqual(seedFor('THRESHOLD'), seedFor('Wren'));
});

t('a new character is given its seed immediately, with no sheet yet', () => {
  const s = mergeCast(emptyCast(), { characters: { Wren: { canon: 'small' } } });
  assert.strictEqual(s.characters.Wren.seed, seedFor('Wren'));
  assert.strictEqual(s.characters.Wren.reference, null);
});

t('yam cannot write its own seed or reference url', () => {
  const s = mergeCast(emptyCast(), { characters: { Wren: { canon: 'c', seed: 7, reference: 'https://fake/x.png' } } });
  assert.strictEqual(s.characters.Wren.seed, seedFor('Wren'));
  assert.strictEqual(s.characters.Wren.reference, null);
});

t('appearance is stored separately from canon', () => {
  const s = mergeCast(emptyCast(), { characters: { Wren: { canon: 'who they are', appearance: 'short, round, ink brush' } } });
  assert.strictEqual(s.characters.Wren.appearance, 'short, round, ink brush');
  assert.strictEqual(s.characters.Wren.canon, 'who they are');
});

t('a recorded reference survives later canon edits, and so does the seed', () => {
  const s = recordReference(mergeCast(emptyCast(), { characters: { Wren: { canon: 'c' } } }), 'wren', 'https://yam.garden/studies/wren.png');
  assert.strictEqual(s.characters.Wren.reference, 'https://yam.garden/studies/wren.png');
  const after = mergeCast(s, { characters: { Wren: { canon: 'changed' } } });
  assert.strictEqual(after.characters.Wren.reference, 'https://yam.garden/studies/wren.png');
  assert.strictEqual(after.characters.Wren.seed, s.characters.Wren.seed, 'seed changed under a canon edit');
});

t('a blank url records nothing', () => {
  assert.deepStrictEqual(recordReference(emptyCast(), 'New', '').characters, {});
});

t('the block says when a sheet is missing, and shows it when present', () => {
  const none = formatCast(mergeCast(emptyCast(), { characters: { Wren: { canon: 'c' } } }));
  assert.ok(/NONE YET/.test(none) && /venice_generate/.test(none), none);
  const has = formatCast(recordReference(emptyCast(), 'Wren', 'https://yam.garden/studies/wren.png'));
  assert.ok(has.includes('reference sheet: https://yam.garden/studies/wren.png'), has);
  assert.ok(/draw toward it/.test(has));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
