// venice.js — real Venice API integration.
// Verified against docs.venice.ai (images/generations OpenAI-compat, b64_json).
// Studies save into the public site so the notebook publishes itself.

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { recordSpend, imageBudgetRemaining } from './memory.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const VENICE_BASE = process.env.VENICE_BASE || 'https://api.venice.ai/api/v1';
// flux-dev was retired by Venice. wai-Illustrious is anime/illustration-tuned,
// which suits ink line work and screentone better than the photoreal flux line.
// Alternatives worth trying via env: flux-2-pro, flux-2-max, z-image-turbo.
const IMAGE_MODEL = process.env.VENICE_IMAGE_MODEL || 'wai-Illustrious';
// Was 0.02, which matched nothing Venice actually charges: the model list prices
// recraft-v4 at 0.05 and nano-banana-pro at 0.18, so every session under-reported its own
// spend to the budget guarding it. Callers that know their model pass the real figure.
const IMAGE_EST_COST = Number(process.env.VENICE_IMAGE_COST || 0.05);
// Venice allows up to 50 on every current image model and defaults to 20. 25 was leaving
// detail on the table on every render for no saving — steps are not separately billed.
const STEPS = Number(process.env.VENICE_STEPS || 50);

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

// The REAL balance, which the internal ledger does not know about. Our budget tracks what
// yam intends to spend; this is what Venice will actually honour, and they are different
// numbers — a session once ran with $3.56 of internal budget against an account that was
// already at -$0.09 and answered every request with a 402. accessPermitted is the flag that
// matters; nextEpochBegins is when the daily Diem allowance comes back.
export async function veniceBalance() {
  const res = await fetch(`${VENICE_BASE}/api_keys/rate_limits`, {
    headers: { authorization: `Bearer ${process.env.VENICE_API_KEY}` },
  });
  if (!res.ok) throw new Error(`venice balance check failed: ${res.status}`);
  const d = (await res.json())?.data ?? {};
  return {
    permitted: d.accessPermitted !== false,
    usd: Number(d.balances?.USD ?? 0),
    diem: Number(d.balances?.DIEM ?? 0),
    nextEpoch: d.nextEpochBegins ?? null,
  };
}

// The row that puts a generated image on the website. creations.cycle_id is NOT NULL and
// this insert was written without an error check, so a design session — which had no cycle
// to belong to and passed null — spent real credits on every image and silently recorded
// none of them. The gallery reads this table, so the work existed on disk and on the public
// url and was invisible on the site. A session now gets its own id, and a refused insert
// raises instead of vanishing: an image nobody can find is not a published image.
async function recordCreation({ cycleId, prompt, selfScore, rel }) {
  const { error } = await supabase.from('creations').insert({
    cycle_id: cycleId ?? randomUUID(),
    media_type: 'image',
    prompt,
    self_score: selfScore,
    storage_path: `https://yam.garden/${rel}`,
    posted: false,
  });
  if (error) throw new Error(`image generated but not recorded — it will not appear on the site: ${error.message}`);
}

// A 402 is not a transient failure to be retried through — it is the account saying it will
// refuse everything until the next epoch. Marked so callers can stop the whole session
// instead of walking the rest of the list into six identical errors.
function paymentRequired(message) {
  const e = new Error(message);
  e.veniceOutOfFunds = true;
  return e;
}

export async function generateImage(cycleId, prompt, {
  width = 1024, height = 1024, selfScore = null,
  seed = null, stylePreset = null, negativePrompt = null, label = null, model = null,
  cost = null,
} = {}) {
  const price = Number.isFinite(Number(cost)) ? Number(cost) : IMAGE_EST_COST;
  if ((await imageBudgetRemaining()) < price) {
    throw new Error(`budget exhausted for image generation`);
  }
  const body = {
    model: model || IMAGE_MODEL,
    prompt,
    width, height,
    steps: STEPS,
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
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 402) throw paymentRequired(`venice account out of funds: ${detail}`);
    throw new Error(`venice image gen failed: ${res.status} ${detail}`);
  }
  const buf = await readImageResponse(res);
  const { ext, mediaType } = sniffImage(buf);

  const stamp = new Date().toISOString().slice(0, 10);
  const rel = `studies/${stamp}-${slugify(label || prompt)}.${ext}`;
  const target = `${process.env.AGENT_HOME}/workspace/site/${rel}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buf);

  await recordSpend(cycleId, 'venice', price, `study: ${prompt.slice(0, 80)}`);
  await recordCreation({ cycleId, prompt, selfScore, rel });
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
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 402) throw paymentRequired(`venice account out of funds: ${detail}`);
    throw new Error(`venice image edit failed: ${res.status} ${detail}`);
  }
  const buf = await readImageResponse(res);
  const { ext, mediaType } = sniffImage(buf);

  const stamp = new Date().toISOString().slice(0, 10);
  const rel = `studies/${stamp}-${slugify(label || prompt)}.${ext}`;
  const target = `${process.env.AGENT_HOME}/workspace/site/${rel}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buf);

  await recordSpend(cycleId, 'venice', IMAGE_EST_COST, `variation: ${prompt.slice(0, 80)}`);
  await recordCreation({ cycleId, prompt, selfScore, rel });
  return { rel, publicUrl: `https://yam.garden/${rel}`, from: imageUrl, mediaType };
}
