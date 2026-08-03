// venice.js — real Venice API integration.
// Verified against docs.venice.ai (images/generations OpenAI-compat, b64_json).
// Studies save into the public site so the notebook publishes itself.

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createClient } from '@supabase/supabase-js';
import { recordSpend, budgetRemaining } from './memory.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const VENICE_BASE = process.env.VENICE_BASE || 'https://api.venice.ai/api/v1';
const IMAGE_MODEL = process.env.VENICE_IMAGE_MODEL || 'flux-dev';
const IMAGE_EST_COST = Number(process.env.VENICE_IMAGE_COST || 0.02);

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

export async function generateImage(cycleId, prompt, { width = 1024, height = 1024 } = {}) {
  if ((await budgetRemaining()) < IMAGE_EST_COST) {
    throw new Error(`budget exhausted for image generation`);
  }
  const res = await fetch(`${VENICE_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      size: `${width}x${height}`,
      n: 1,
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) throw new Error(`venice image gen failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`venice returned no b64_json: ${JSON.stringify(data).slice(0, 200)}`);

  const stamp = new Date().toISOString().slice(0, 10);
  const rel = `studies/${stamp}-${slugify(prompt)}.png`;
  const target = `${process.env.AGENT_HOME}/workspace/site/${rel}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(b64, 'base64'));

  await recordSpend(cycleId, 'venice', IMAGE_EST_COST, `study: ${prompt.slice(0, 80)}`);
  await supabase.from('creations').insert({
    cycle_id: cycleId, media_type: 'image', prompt,
    storage_path: `https://yam.garden/${rel}`, posted: false,
  });
  return { rel, publicUrl: `https://yam.garden/${rel}` };
}
