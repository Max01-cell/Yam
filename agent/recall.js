// recall.js — yam reads its own archive back.
//
// Working memory is the last WORKING_WINDOW thoughts: about six cycles. Everything
// older was written and never read again — the notebook past its recent slice, the
// published entries, the notes it filed weeks ago. This module gives yam two things:
// an INDEX of everything it has (always shown, cheap) and RECALL of specific things
// it asks for by name (one cycle of latency, exactly like revisit_urls).
//
// Nothing here invents or paraphrases. If a store cannot be read, the block says so
// in yam's own view instead of quietly rendering an empty archive — an archive that
// looks empty is indistinguishable from having nothing to remember.

import { readdirSync, readFileSync } from 'fs';
import { searchNotes, notebookTopics } from './memory.js';

const entryDir = () => `${process.env.AGENT_HOME || '.'}/workspace/site/thoughts`;

export function titleOf(md) {
  const m = String(md ?? '').match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m);
  return m ? m[1].trim() : null;
}

export function wordCount(s) {
  return String(s ?? '').split(/\s+/).filter(Boolean).length;
}

// Everything yam has published under site/thoughts, with bodies loaded so a
// requested entry can be quoted back in full without a second pass.
export function publishedIndex(dir = entryDir()) {
  let files;
  try {
    files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    try {
      const body = readFileSync(`${dir}/${file}`, 'utf8');
      out.push({ file, title: titleOf(body) || file.replace(/\.md$/i, ''), words: wordCount(body), body });
    } catch { /* an unreadable entry is skipped, not faked */ }
  }
  return out;
}

// Whole-word matching, not substring. yam's vocabulary contains short load-bearing
// terms — 'ma' is the subject of an entire published entry — and a length floor
// would make them unrecallable, while a bare substring match would score 'ma'
// against every occurrence of 'manga', 'mark' and 'made'.
function wordRe(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, 'iu');
}

// Filename and title matches outrank body matches: naming an entry should beat
// merely being mentioned inside a different one.
export function matchEntries(index, terms, limit = 2) {
  const needles = (terms ?? [])
    .map(t => String(t ?? '').trim())
    .filter(t => t.length >= 2)
    .map(t => ({ term: t, re: wordRe(t) }));
  if (!needles.length) return [];
  return (index ?? [])
    .map(entry => {
      const head = `${entry.file} ${entry.title}`;
      const body = String(entry.body ?? '');
      let score = 0;
      for (const n of needles) {
        if (n.re.test(head)) score += 3;
        else if (n.re.test(body)) score += 1;
      }
      return { entry, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file))
    .slice(0, limit)
    .map(s => s.entry);
}

export function formatPublishedIndex(index) {
  if (!index?.length) return '(nothing published yet)';
  return index.map(e => `${e.file} — "${e.title}" (${e.words} words)`).join('\n');
}

// Rows arrive newest-first, so the first sighting of a topic is its latest note.
export function formatNotebookIndex(rows) {
  if (!rows?.length) return '(notebook empty)';
  const byTopic = new Map();
  for (const r of rows) {
    const topic = String(r?.topic ?? 'untitled').trim() || 'untitled';
    if (!byTopic.has(topic)) byTopic.set(topic, { count: 0, subjects: [], last: r?.created_at ?? null });
    const t = byTopic.get(topic);
    t.count += 1;
    const subject = r?.subject ? String(r.subject).trim() : '';
    if (subject && !t.subjects.includes(subject)) t.subjects.push(subject);
  }
  return [...byTopic.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([topic, t]) => {
      const subs = t.subjects.slice(0, 4).join(', ');
      const more = t.subjects.length > 4 ? ` +${t.subjects.length - 4} more` : '';
      return `${topic} (${t.count})${subs ? ` — ${subs}${more}` : ''}`;
    })
    .join('\n');
}

export function formatNotes(notes) {
  if (!notes?.length) return '';
  return notes
    .map(n => `[${n.topic}${n.subject ? `/${n.subject}` : ''}] ${n.content}`)
    .join('\n\n');
}

export function formatConsolidationStatus(state) {
  if (!state) return 'memory consolidation: has not run yet';
  if (state.last_error) return `memory consolidation: LAST RUN FAILED — ${state.last_error}`;
  const when = state.last_run_at ? String(state.last_run_at).replace('T', ' ').slice(0, 16) : 'unknown time';
  return `memory consolidation: last ran ${when}, distilled ${state.last_batch ?? 0} aged thoughts into ${state.notes_written ?? 0} notes`;
}

// The always-on block: what yam HAS, without the cost of showing all of it.
export async function buildArchive({ consolidationState = null, dir = entryDir() } = {}) {
  const sections = [];
  try {
    sections.push(`YOUR NOTEBOOK — EVERY TOPIC YOU HAVE EVER FILED (topic (count) — subjects):\n${formatNotebookIndex(await notebookTopics())}`);
  } catch (e) {
    sections.push(`YOUR NOTEBOOK INDEX IS UNREADABLE THIS CYCLE: ${e.message}`);
  }
  sections.push(`WHAT YOU HAVE PUBLISHED (site/thoughts — ask for any of these by name):\n${formatPublishedIndex(publishedIndex(dir))}`);
  sections.push(formatConsolidationStatus(consolidationState));
  return sections.join('\n\n');
}

// The on-request block: full text of what yam asked for last cycle.
export async function buildRecalled(topics, { dir = entryDir(), entryChars = 3500, noteLimit = 5 } = {}) {
  const asked = (topics ?? []).map(t => String(t ?? '').trim()).filter(Boolean).slice(0, 3);
  if (!asked.length) return '';

  const parts = [];
  for (const term of asked) {
    let notes = [];
    let failure = null;
    try {
      notes = await searchNotes(term, noteLimit);
    } catch (e) {
      failure = e.message;
    }
    if (failure) parts.push(`"${term}" — notebook search failed: ${failure}`);
    else if (notes.length) parts.push(`"${term}" — ${notes.length} note(s) from your notebook:\n${formatNotes(notes)}`);
    else parts.push(`"${term}" — nothing in your notebook under that name.`);
  }

  const entries = matchEntries(publishedIndex(dir), asked);
  for (const e of entries) {
    const body = e.words * 6 > entryChars ? `${e.body.slice(0, entryChars)}\n…(truncated — the full entry is at site/thoughts/${e.file})` : e.body;
    parts.push(`YOUR PUBLISHED ENTRY ${e.file} — "${e.title}", in full:\n${body}`);
  }

  return parts.join('\n\n---\n\n');
}
