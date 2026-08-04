// cast.js — the characters yam is actually building, and how many times it has drawn them.
//
// The practice loop works: study a page, name a principle, draw something testing it,
// look at the mark, name the gap. What it produces is nine unrelated studies. Each one
// demonstrates a grammar point on a shape that is never drawn again, so the craft
// compounds in the notebook while the body of work does not compound at all. An artist
// who has drawn one character forty times has a character; an artist who has drawn forty
// things once has forty exercises.
//
// This is the missing half: a small permanent cast that yam sees every cycle, so a study
// can be variation 7 of someone rather than a one-off. Serialization later needs a cast
// that already exists and has been drawn from enough angles to stay itself.
//
// Two rules carried over from mistakes already made in this repo:
//
//   MERGE, NEVER REPLACE. memory_updates.diet replaced the feed list, and a reply naming
//   two feeds silently destroyed six. The cast is the one structure that must only ever
//   accumulate, so an update merges by name and omitting a character cannot delete it.
//   Removal is explicit, via retire.
//
//   THE COUNT IS MEASURED, NOT CLAIMED. studies is incremented by draw() at the moment a
//   drawing actually publishes — the same principle as the SVG measurements. yam cannot
//   report having practised. It can only have practised.

const MAX_CHARACTERS = 6;
const MAX_NAME = 60;
const MAX_CANON = 600;
const MAX_QUESTIONS = 5;
const MAX_QUESTION = 200;

export function normaliseName(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

// Names are matched case- and space-insensitively so 'The Surveyor' and 'the surveyor'
// are one character. Without this a capitalisation drift silently forks the cast and
// every count restarts at zero.
export function nameKey(s) {
  return normaliseName(s).toLowerCase();
}

function clampText(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanQuestions(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(q => clampText(q, MAX_QUESTION)).filter(Boolean))].slice(0, MAX_QUESTIONS);
}

export function emptyCast() {
  return { characters: {}, world: null, retired: [] };
}

function findKey(characters, name) {
  const want = nameKey(name);
  return Object.keys(characters ?? {}).find(k => nameKey(k) === want) ?? null;
}

// Apply yam's memory_updates.cast. Returns a NEW state; never mutates, never throws.
// Anything unparseable is ignored rather than allowed to corrupt the cast.
export function mergeCast(prev, update) {
  const base = {
    characters: { ...(prev?.characters ?? {}) },
    world: prev?.world ?? null,
    retired: [...(prev?.retired ?? [])],
  };
  if (!update || typeof update !== 'object') return base;

  if (typeof update.world === 'string' && update.world.trim()) {
    base.world = clampText(update.world, MAX_CANON);
  }

  // Explicit removal. The only way a character leaves the cast.
  for (const name of Array.isArray(update.retire) ? update.retire : []) {
    const key = findKey(base.characters, name);
    if (!key) continue;
    delete base.characters[key];
    if (!base.retired.some(r => nameKey(r) === nameKey(key))) base.retired.unshift(key);
  }
  base.retired = base.retired.slice(0, 20);

  const incoming = update.characters && typeof update.characters === 'object' ? update.characters : {};
  for (const [rawName, rawCh] of Object.entries(incoming)) {
    const name = normaliseName(rawName);
    if (!name || !rawCh || typeof rawCh !== 'object') continue;
    const key = findKey(base.characters, name);

    if (!key && Object.keys(base.characters).length >= MAX_CHARACTERS) continue; // cast stays small on purpose
    const existing = key ? base.characters[key] : null;

    base.characters[key ?? name] = {
      // Fields yam owns: what the character is, and what the next drawing should test.
      canon: clampText(rawCh.canon, MAX_CANON) || existing?.canon || '',
      open_questions: rawCh.open_questions !== undefined
        ? cleanQuestions(rawCh.open_questions)
        : (existing?.open_questions ?? []),
      // Fields the system owns. Taken from the existing record every time, so an update
      // cannot inflate a practice count or backdate a character into seniority.
      created_at: existing?.created_at ?? new Date().toISOString(),
      studies: Number(existing?.studies ?? 0) || 0,
      last_study: existing?.last_study ?? null,
    };
  }
  return base;
}

// Called by draw() when a published drawing names a character. Pure: returns new state.
// An unknown name still records — a study that happened is a fact, and losing it because
// the cast entry was never written is worse than an entry with no canon yet. It shows up
// in the prompt as canon-less, which is a visible prompt to describe it.
export function recordStudy(prev, name, studyUrl) {
  const clean = normaliseName(name);
  if (!clean) return prev ?? emptyCast();
  const base = {
    characters: { ...(prev?.characters ?? {}) },
    world: prev?.world ?? null,
    retired: [...(prev?.retired ?? [])],
  };
  const key = findKey(base.characters, clean) ?? clean;
  const existing = base.characters[key] ?? null;
  base.characters[key] = {
    canon: existing?.canon ?? '',
    open_questions: existing?.open_questions ?? [],
    created_at: existing?.created_at ?? new Date().toISOString(),
    studies: (Number(existing?.studies ?? 0) || 0) + 1,
    last_study: studyUrl || existing?.last_study || null,
  };
  return base;
}

// The prompt block. An empty cast says so and says what to do about it, rather than
// rendering blank — a cast that looks absent is indistinguishable from one yam forgot.
export function formatCast(state) {
  const chars = Object.entries(state?.characters ?? {});
  if (!chars.length) {
    return 'You have no cast yet. Nothing you have drawn so far is anyone in particular — ' +
      'every study demonstrates a principle on a shape you will never draw again. ' +
      'Start one: name a character, write what is FIXED about them (silhouette, build, ' +
      'how their line behaves), and draw them. Two or three characters is a cast; six is the cap.';
  }
  const lines = chars
    .sort((a, b) => (b[1]?.studies ?? 0) - (a[1]?.studies ?? 0) || a[0].localeCompare(b[0]))
    .map(([name, c]) => {
      const n = Number(c?.studies ?? 0) || 0;
      const head = `${name} — drawn ${n} time${n === 1 ? '' : 's'}${n === 0 ? ' (never yet drawn)' : ''}`;
      const canon = c?.canon ? `\n    canon: ${c.canon}` : '\n    canon: (not written yet — describe what is fixed about them)';
      const open = c?.open_questions?.length ? `\n    open: ${c.open_questions.join(' · ')}` : '';
      const last = c?.last_study ? `\n    last study: ${c.last_study}` : '';
      return head + canon + open + last;
    });
  const world = state?.world ? `\nWorld: ${state.world}` : '';
  const retired = state?.retired?.length ? `\nRetired: ${state.retired.join(', ')}` : '';
  return lines.join('\n') + world + retired;
}
