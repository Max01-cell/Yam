// venice.js — real Venice API integration.
// Verified against docs.venice.ai (images/generations OpenAI-compat, b64_json).
// Studies save into the public site so the notebook publishes itself.

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createClient } from '@supabase/supabase-js';
import { recordSpend, budgetRemaining } from './memory.js';

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

export async function generateImage(cycleId, prompt, {
  width = 1024, height = 1024, selfScore = null,
  seed = null, stylePreset = null, negativePrompt = null, label = null,
} = {}) {
  if ((await budgetRemaining()) < IMAGE_EST_COST) {
    throw new Error(`budget exhausted for image generation`);
  }
  const body = {
    model: IMAGE_MODEL,
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
  const data = await res.json();
  const b64 = pickB64(data);
  if (!b64) throw new Error(`venice returned no image: ${JSON.stringify(data).slice(0, 200)}`);

  const stamp = new Date().toISOString().slice(0, 10);
  const rel = `studies/${stamp}-${slugify(label || prompt)}.png`;
  const target = `${process.env.AGENT_HOME}/workspace/site/${rel}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(b64, 'base64'));

  await recordSpend(cycleId, 'venice', IMAGE_EST_COST, `study: ${prompt.slice(0, 80)}`);
  await supabase.from('creations').insert({
    cycle_id: cycleId, media_type: 'image', prompt, self_score: selfScore,
    storage_path: `https://yam.garden/${rel}`, posted: false,
  });
  return { rel, publicUrl: `https://yam.garden/${rel}`, seed: body.seed ?? null };
}

// Pose and angle variations that keep the SAME face. A fixed seed reproduces an image
// exactly, but it does not hold identity across a CHANGED prompt — same seed with a new
// pose description gives a related composition, not the same character. Editing from the
// canonical sheet does hold it, because the character is in the pixels being edited.
export async function editImage(cycleId, imageUrl, prompt, { selfScore = null, label = null } = {}) {
  if ((await budgetRemaining()) < IMAGE_EST_COST) {
    throw new Error(`budget exhausted for image editing`);
  }
  const src = await fetch(imageUrl);
  if (!src.ok) throw new Error(`could not fetch the reference image ${imageUrl} (HTTP ${src.status})`);
  const b64in = Buffer.from(await src.arrayBuffer()).toString('base64');

  const res = await fetch(`${VENICE_BASE}/image/edit`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt, image: b64in }),
  });
  if (!res.ok) throw new Error(`venice image edit failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const b64 = pickB64(data);
  if (!b64) throw new Error(`venice edit returned no image: ${JSON.stringify(data).slice(0, 200)}`);

  const stamp = new Date().toISOString().slice(0, 10);
  const rel = `studies/${stamp}-${slugify(label || prompt)}.png`;
  const target = `${process.env.AGENT_HOME}/workspace/site/${rel}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(b64, 'base64'));

  await recordSpend(cycleId, 'venice', IMAGE_EST_COST, `variation: ${prompt.slice(0, 80)}`);
  await supabase.from('creations').insert({
    cycle_id: cycleId, media_type: 'image', prompt, self_score: selfScore,
    storage_path: `https://yam.garden/${rel}`, posted: false,
  });
  return { rel, publicUrl: `https://yam.garden/${rel}`, from: imageUrl };
}
