// curriculum.js — who yam is studying, what to take from each, and who it has ignored.
//
// yam's identity already commits it to studying "the living tradition of contemporary
// manga and webcomics". What it lacked was a roster. Left to itself it studied principles
// in the abstract — gutter timing, line-as-decision — derived from essays about art rather
// than from pages somebody drew. Principles with no author attached are easy to name and
// impossible to check against a real hand.
//
// Two boundaries are structural, not decorative:
//
//   ACCESS. Modern manga is read only where it is legitimately readable: official free
//   chapters and publisher previews, pages the artist posted, and panels reproduced inside
//   criticism and interviews. Never scan sites. This is already yam's stated identity and
//   it is repeated here because this is the file that names copyrighted work.
//
//   ORIGINALITY. The point of naming a master is to steal a PRINCIPLE — how a silhouette
//   stays readable, where a black lands, what a line does at speed. It is never to
//   reproduce a signature or draw someone else's character. yam's public promise is that
//   every mark in the workshop is its own, and a curriculum is what makes that promise
//   expensive rather than easy.
//
// The oldest entries are public domain, which is not a footnote: they are the only ones
// yam can currently fetch and LOOK at directly through Commons. Everything modern is
// studied through criticism, interviews and official previews.

import { notebookTopics } from './memory.js';

// take = the specific transferable thing. Vague admiration teaches nothing.
export const CURRICULUM = [
  { name: 'Eiichiro Oda', works: 'One Piece',
    take: 'silhouette readability under crowd density — every figure identifiable in pure black silhouette, and a packed panel that still routes the eye',
    access: 'official free chapters (MANGA Plus / Shonen Jump), panels quoted in criticism' },
  { name: 'Tite Kubo', works: 'Bleach',
    take: 'negative space and spot blacks — the panel composed as a poster, restraint as drama, costume as character design',
    access: 'official free chapters, interviews, panels quoted in criticism' },
  { name: 'Kei Urana', works: 'Gachiakuta',
    take: 'grit texture and kinetic line — how surface noise and graffiti energy carry motion instead of speed lines doing it alone',
    access: 'official previews, interviews, panels quoted in criticism' },
  { name: 'Naoki Urasawa', works: 'Monster, 20th Century Boys',
    take: 'facial acting and micro-expression — dread built out of mundane panels and restraint rather than emphasis',
    access: 'interviews (mangabrog), criticism, official previews' },
  { name: 'Katsuhiro Otomo', works: 'Akira',
    take: 'architectural precision and scale — debris, perspective, and the mechanical drawn with the same rigour as the figure',
    access: 'criticism, interviews, museum and gallery coverage' },
  { name: 'Junji Ito', works: 'Uzumaki, Tomie',
    take: 'fine hatching and pattern disruption — horror produced by breaking a regular texture, and the timing of a reveal panel',
    access: 'official free samples, criticism' },
  { name: 'Taiyo Matsumoto', works: 'Tekkonkinkreet, Ping Pong',
    take: 'deliberately unstable line — distortion used as expressive control rather than as error, and perspective bent on purpose',
    access: 'criticism, interviews, publisher previews' },
  { name: 'Inio Asano', works: 'Oyasumi Punpun',
    take: 'photoreal background against abstracted figure — tonal contrast between environment and character as an emotional device',
    access: 'criticism, interviews, publisher previews' },
  { name: 'Kentaro Miura', works: 'Berserk',
    take: 'hatching density as weight — blacks and texture describing mass and fatigue, not just shadow',
    access: 'criticism, official previews' },
  { name: 'Akira Toriyama', works: 'Dragon Ball',
    take: 'economy of line and readable motion — the clearest possible action arc with the fewest marks',
    access: 'official free chapters, criticism' },
  { name: 'Hokusai', works: 'Hokusai Manga',
    take: 'the ancestor: figures in motion observed in quantity, the sketchbook as accumulation rather than composition',
    access: 'PUBLIC DOMAIN — look at it directly, propose look {search: "Hokusai manga"}' },
  { name: 'Kuniyoshi', works: 'ukiyo-e warrior prints',
    take: 'dynamic staging and pattern against figure — the diagonal, the crowded surface that still reads',
    access: 'PUBLIC DOMAIN — look at it directly, propose look {search: "Kuniyoshi warrior"}' },
];

// Surname alone is how these names actually appear in a notebook subject
// ('Urasawa vs Otomo'), so match on it as well as the full name.
function needles(name) {
  const parts = String(name).split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  return [...new Set([String(name).toLowerCase(), last.toLowerCase()])].filter(s => s.length >= 3);
}

function hit(haystack, name) {
  const h = ` ${String(haystack ?? '').toLowerCase()} `;
  return needles(name).some(n => h.includes(n));
}

// Coverage is counted from notes yam actually filed — an instrument reading, like the
// stroke measurements and the practice count. Intending to study someone is not studying
// them, and a curriculum that reported intent would be worthless.
export function studyCoverage(rows, curriculum = CURRICULUM) {
  const counts = new Map(curriculum.map(c => [c.name, 0]));
  for (const r of rows ?? []) {
    const text = `${r?.topic ?? ''} ${r?.subject ?? ''}`;
    for (const c of curriculum) if (hit(text, c.name)) counts.set(c.name, counts.get(c.name) + 1);
  }
  return counts;
}

// Compact roster plus expanded briefs for the least-studied. Showing all twelve briefs
// every cycle would cost tokens to repeat what yam already read; showing none would leave
// the roster a list of names with no instruction in it.
export function formatCurriculum(rows, { curriculum = CURRICULUM, expand = 3 } = {}) {
  const counts = studyCoverage(rows, curriculum);
  const studied = curriculum.filter(c => counts.get(c.name) > 0);
  const untouched = curriculum.filter(c => counts.get(c.name) === 0);

  const lines = [];
  lines.push(studied.length
    ? `Studied so far (notes you have actually filed): ${studied.map(c => `${c.name} (${counts.get(c.name)})`).join(', ')}`
    : 'Studied so far: none of them. Every principle in your notebook was derived from writing about art rather than from a page somebody drew.');

  if (untouched.length) {
    lines.push(`Not yet touched: ${untouched.map(c => c.name).join(', ')}`);
  }

  const focus = (untouched.length ? untouched : curriculum).slice(0, expand);
  if (focus.length) {
    lines.push('\nNext, in detail:');
    for (const c of focus) {
      lines.push(`  ${c.name} — ${c.works}\n    take: ${c.take}\n    where: ${c.access}`);
    }
  }
  return lines.join('\n');
}

// Never throws: a curriculum that could take down a cycle would be worse than no
// curriculum. An unreadable notebook degrades to the roster with zero coverage.
export async function buildCurriculum({ curriculum = CURRICULUM } = {}) {
  let rows = [];
  try {
    rows = await notebookTopics();
  } catch {
    rows = [];
  }
  return formatCurriculum(rows, { curriculum });
}
