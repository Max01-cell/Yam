// venice.js — real Venice API integration.
// Verified against docs.venice.ai (images/generations OpenAI-compat, b64_json).
// Studies save into the public site so the notebook publishes itself.

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { createClient } from '@supabase/supabase-js';
import { recordSpend, imageBudgetRemaining } from './memory.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const VENICE_BASE = process.env.VENICE_BASE || 'https://api.venice.ai/api/v1';
// flux-dev was retired by Venice. wai-Illustrious is anime/illustration-tuned,
// which suits ink line work and screentone better than the photoreal flux line.
// Alternatives worth trying via env: flux-2-pro, flux-2-max, z-image-turbo.
const IMAGE_MODEL = process.env.VENICE_IMAGE_MODEL || 'wai-Illustrious';
const IMAGE_EST_COST = Number(process.env.VENICE_IMAGE_COST || 0.02);

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

// Venice's native endpoint rather than the OpenAI-compat one, because seed, style_preset
// and negative_prompt only exist here — and seed is the whole basis of a character that
// stays itself. Verified: identical (model, prompt, seed) returns a byte-identical image,
// so a reference sheet is reproducible rather than a lucky roll that can never be rerun.
function pickB64(j) {
  return j?.images?.[0] ?? j?.data?.[0]?.b64_json ?? null;
}

// Venice honours `format` on some models and ignores it on others: recraft-v4 returns WebP
// whatever you ask for. Saving those bytes as .png produces a file that browsers render but
// that the vision API rejects outright — "specified image/png, but appears to be image/webp".
// So the extension comes from the bytes, never from what we requested.
export function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return { ext: 'png', mediaType: 'image/png' };
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mediaType: 'image/webp' };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', mediaType: 'image/jpeg' };
  return { ext: 'png', mediaType: 'image/png' };
}

// /image/edit answers with raw image bytes rather than JSON, so res.json() on it throws on
// the PNG signature itself. Read whichever the response actually is.
async function readImageResponse(res) {
  const ctype = res.headers.get('content-type') || '';
  if (ctype.startsWith('image/')) return Buffer.from(await res.arrayBuffer());
  const j = await res.json();
  const b64 = pickB64(j);
  if (!b64) throw new Error(`venice returned no image: ${JSON.stringify(j).slice(0, 200)}`);
  return Buffer.from(b64, 'base64');
}

export async function generateImage(cycleId, prompt, {
  width = 1024, height = 1024, selfScore = null,
  seed = null, stylePreset = null, negativePrompt = null, label = null, model = null,
} = {}) {
  if ((await imageBudgetRemaining()) < IMAGE_EST_COST) {
    throw new Error(`budget exhausted for image generation`);
  }
  const body = {
    model: model || IMAGE_MODEL,
    prompt,
    width, height,
    steps: 25,
    format: 'png',
  };
  if (Number.isFinite(Number(seed))) body.seed = Number(seed);
  if (stylePreset) body.style_preset = stylePreset;
  if (negativePrompt) body.negative_prompt = negativePrompt;

  const res = await fetch(`${VENICE_BASE}/image/generate`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`venice image gen failed: ${res.status} ${await res.text()}`);
  const buf = await readImageResponse(res);
  const { ext, mediaType } = sniffImage(buf);

  const stamp = new Date().toISOString().slice(0, 10);
  const rel = `studies/${stamp}-${slugify(label || prompt)}.${ext}`;
  const target = `${process.env.AGENT_HOME}/workspace/site/${rel}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buf);

  await recordSpend(cycleId, 'venice', IMAGE_EST_COST, `study: ${prompt.slice(0, 80)}`);
  await supabase.from('creations').insert({
    cycle_id: cycleId, media_type: 'image', prompt, self_score: selfScore,
    storage_path: `https://yam.garden/${rel}`, posted: false,
  });
  return { rel, publicUrl: `https://yam.garden/${rel}`, seed: body.seed ?? null, mediaType };
}

// Pose and angle variations that keep the SAME face. A fixed seed reproduces an image
// exactly, but it does not hold identity across a CHANGED prompt — same seed with a new
// pose description gives a related composition, not the same character. Editing from the
// canonical sheet does hold it, because the character is in the pixels being edited.
export async function editImage(cycleId, imageUrl, prompt, { selfScore = null, label = null } = {}) {
  if ((await imageBudgetRemaining()) < IMAGE_EST_COST) {
    throw new Error(`budget exhausted for image editing`);
  }
  // Accepts a public url OR a site-relative path. A study generated this minute exists on
  // disk but its url 404s until the next deploy, so a session that edits what it has just
  // made must read the bytes locally.
  let b64in;
  if (/^https?:\/\//i.test(imageUrl)) {
    const src = await fetch(imageUrl);
    if (!src.ok) throw new Error(`could not fetch the reference image ${imageUrl} (HTTP ${src.status})`);
    b64in = Buffer.from(await src.arrayBuffer()).toString('base64');
  } else {
    b64in = readFileSync(`${process.env.AGENT_HOME || '.'}/workspace/site/${imageUrl}`).toString('base64');
  }

  const res = await fetch(`${VENICE_BASE}/image/edit`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt, image: b64in }),
  });
  if (!res.ok) throw new Error(`venice image edit failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const buf = await readImageResponse(res);
  const { ext, mediaType } = sniffImage(buf);

  const stamp = new Date().toISOString().slice(0, 10);
  const rel = `studies/${stamp}-${slugify(label || prompt)}.${ext}`;
  const target = `${process.env.AGENT_HOME}/workspace/site/${rel}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buf);

  await recordSpend(cycleId, 'venice', IMAGE_EST_COST, `variation: ${prompt.slice(0, 80)}`);
  await supabase.from('creations').insert({
    cycle_id: cycleId, media_type: 'image', prompt, self_score: selfScore,
    storage_path: `https://yam.garden/${rel}`, posted: false,
  });
  return { rel, publicUrl: `https://yam.garden/${rel}`, from: imageUrl, mediaType };
}
