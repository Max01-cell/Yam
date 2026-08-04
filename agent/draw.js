// draw.js — yam draws by hand.
//
// Not generation: authorship. yam writes the SVG itself — every path, every
// stroke width, every decision it can account for. The source is published
// beside the render, so the marks stay readable as marks.

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import { triggerDeploy } from './deploy.js';
import { getState, setState } from './memory.js';
import { normaliseName, recordStudy } from './cast.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function slugify(s) {
  return String(s || 'untitled').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'untitled';
}

// yam's own published work, as opposed to anything it found in the world.
export function isOwnWork(url) {
  return /^https?:\/\/(?:www\.)?yam\.garden\//i.test(String(url ?? ''));
}

// Inverse of the naming scheme above: recover a readable title from a published
// study url, so a reading of that study can be filed under the work it is about.
export function titleFromStudyUrl(url) {
  const base = String(url || '').split(/[?#]/)[0].split('/').pop() || '';
  return base
    .replace(/\.(svg|png|jpe?g|webp)$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/-+/g, ' ')
    .trim() || null;
}

// Instrument readings, not opinions. yam's written grammar is full of committed
// versus feathered line register, spot blacks and screentone direction; whether
// its hand actually executed any of that is a measurable fact about the document
// it just authored, and it should not have to take anyone's word for it.
export function measureSvg(svg) {
  const s = String(svg ?? '');
  const byTag = {};
  const widths = [];
  let marks = 0, filled = 0, solidBlack = 0, labels = 0;

  // Per element, not global regexes: a caption's fill='#888' is not a filled
  // mark, and counting it as one would misreport the drawing back to yam.
  for (const m of s.matchAll(/<(path|line|circle|ellipse|rect|polygon|polyline|text|image)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? '';
    byTag[tag] = (byTag[tag] ?? 0) + 1;
    if (tag === 'text' || tag === 'image') { labels += 1; continue; }
    marks += 1;

    const w = Number((attrs.match(/\bstroke-width\s*[=:]\s*["']?\s*([\d.]+)/i) || [])[1]);
    if (Number.isFinite(w) && w > 0) widths.push(w);

    const f = (attrs.match(/\bfill\s*[=:]\s*["']?\s*([^"';\s>/]+)/i) || [])[1];
    if (f) {
      const v = f.toLowerCase();
      if (v !== 'none' && v !== 'transparent') {
        filled += 1;
        if (v === 'black' || /^#(?:000|000000)$/i.test(v) || /^#(?:[0-3][0-9a-f]){3}$/i.test(v)) solidBlack += 1;
      }
    }
  }

  const distinct = [...new Set(widths)].sort((a, b) => a - b);
  return {
    elements: marks,
    labels,
    byTag,
    strokeWidths: distinct,
    strokeWidthRange: distinct.length ? `${distinct[0]}–${distinct[distinct.length - 1]}` : 'none declared',
    strokeWidthRatio: distinct.length && distinct[0] > 0
      ? Number((distinct[distinct.length - 1] / distinct[0]).toFixed(2)) : null,
    filledElements: filled,
    solidBlackFills: solidBlack,
  };
}

export function summariseMeasurements(m) {
  if (!m) return null;
  return `${m.elements} elements; stroke-width ${m.strokeWidthRange}` +
    `${m.strokeWidthRatio ? ` (heaviest ÷ lightest = ${m.strokeWidthRatio})` : ''}, ` +
    `${m.strokeWidths.length} distinct weight${m.strokeWidths.length === 1 ? '' : 's'}; ` +
    `${m.filledElements} filled, ${m.solidBlackFills} solid black`;
}

function validateSvg(svg) {
  if (typeof svg !== 'string') throw new Error('svg must be a string');
  const s = svg.trim();
  if (!s.startsWith('<svg') && !s.startsWith('<?xml')) {
    throw new Error('svg must start with <svg (or an xml declaration) — send the full document, not a fragment');
  }
  if (s.length > 400000) throw new Error(`svg too large (${s.length} chars, limit 400000)`);
  const banned = [/<script[\s>]/i, /\son\w+\s*=/i, /<foreignObject[\s>]/i,
                  /<iframe[\s>]/i, /javascript:/i];
  for (const re of banned) {
    if (re.test(s)) throw new Error(`svg contains disallowed content (${re.source}) — drawing only: paths, shapes, groups, defs`);
  }
  if (!/viewBox\s*=/i.test(s)) throw new Error('svg needs a viewBox so it scales — e.g. viewBox="0 0 800 1200"');
  return s;
}

export async function draw(cycleId, { title, svg, intent = '', selfScore = null, character = null }) {
  const clean = validateSvg(svg);
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `studies/${stamp}-${slugify(title)}`;
  const home = process.env.AGENT_HOME || '.';
  const svgPath = `${home}/workspace/site/${base}.svg`;
  const pngPath = `${home}/workspace/site/${base}.png`;

  mkdirSync(dirname(svgPath), { recursive: true });
  writeFileSync(svgPath, clean);

  let rendered = false;
  try {
    execSync(
      `python3 -c "import cairosvg,sys; cairosvg.svg2png(url=sys.argv[1], write_to=sys.argv[2], output_width=1000, background_color='white')" ${JSON.stringify(svgPath)} ${JSON.stringify(pngPath)}`,
      { stdio: 'pipe', timeout: 30000 }
    );
    rendered = true;
  } catch (e) {
    console.warn('svg->png render failed (svg still published):', String(e.message).slice(0, 200));
  }

  // Publish. Without this the marks never leave the droplet and the gallery
  // shows a caption with no drawing behind it.
  let published = false;
  try {
    execSync(
      `cd ${JSON.stringify(home)} && git add -A && ` +
      `git commit -q -m ${JSON.stringify('study: ' + String(title).slice(0, 60))} && ` +
      `git push -q origin main`,
      { stdio: 'pipe', timeout: 60000 }
    );
    published = true;
    await triggerDeploy(`study: ${String(title).slice(0, 40)}`);
  } catch (e) {
    console.warn('study commit/push failed — drawing is on disk but not live:', String(e.message).slice(0, 200));
  }

  const who = normaliseName(character);
  const label = who ? `[drawn by hand] ${who}: ${title}` : `[drawn by hand] ${title}`;

  await supabase.from('creations').insert({
    cycle_id: cycleId,
    media_type: 'image',
    prompt: intent ? `${label} — ${intent}` : label,
    storage_path: `https://yam.garden/${base}${rendered ? '.png' : '.svg'}`,
    self_score: selfScore,
    posted: false,
  });

  // Count the study against the cast HERE, at the moment the drawing exists — the same
  // reason the SVG is measured rather than described. A practice count yam could write
  // for itself would be an opinion about its own diligence.
  let castStudies = null;
  if (who) {
    try {
      const prev = (await getState('cast').catch(() => null))?.value ?? null;
      const next = recordStudy(prev, who, `https://yam.garden/${base}${rendered ? '.png' : '.svg'}`);
      await setState('cast', next);
      castStudies = next.characters[Object.keys(next.characters).find(k => k.toLowerCase() === who.toLowerCase())]?.studies ?? null;
    } catch (e) {
      console.warn(`cast study count not recorded for ${who}: ${String(e.message).slice(0, 160)}`);
    }
  }

  const measurements = measureSvg(clean);

  return {
    published,
    title,
    character: who || null,
    castStudies,
    svg: `https://yam.garden/${base}.svg`,
    png: rendered ? `https://yam.garden/${base}.png` : null,
    measured: summariseMeasurements(measurements),
    measurements,
    hint: rendered
      ? `to study your own hand, propose: look { image_url: "https://yam.garden/${base}.png" }`
      : 'png render unavailable this time; the svg is published',
    warning: published ? null : 'commit/push failed — this drawing is not live on yam.garden yet',
  };
}
