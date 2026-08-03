// video.js — yam's video pipeline, built on the Seedance Prompter v3 discipline.
//
// LICENSING: the prompter knowledge base is a PAID product (purchased from
// jboogxcreative). It lives in ./knowledge/ which is GITIGNORED. This module
// loads it from disk at runtime and will refuse to run without it. Do not
// commit those files to the public repo.
//
// Pipeline per sequence:
//   concept → shot list → per-clip YAML prompt (Claude, with the knowledge
//   file in context) → generate (provider) → extract last frame → next clip
//   re-establishes EVERYTHING (zero-memory rule) with @video1 continuation +
//   carried state → ffmpeg concat at the end.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execSync } from 'child_process';
import { recordSpend, budgetRemaining } from './memory.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';
const KNOWLEDGE_PATH = `${process.env.AGENT_HOME || '.'}/knowledge/seedance-prompter-v3-master-knowledge.md`;

function loadKnowledge() {
  if (!existsSync(KNOWLEDGE_PATH)) {
    throw new Error(
      'Seedance Prompter knowledge not found. Copy the purchased files into ' +
      'knowledge/ (gitignored) before running the video pipeline.'
    );
  }
  return readFileSync(KNOWLEDGE_PATH, 'utf8');
}

/**
 * chainState — the continuity ledger carried between clips:
 * {
 *   characters: { name: { base, features, cumulativeState } },   // damage/state carried forward
 *   spatialLayout: "yam on the LEFT, ... throughout",            // locked across clips
 *   environment: "full re-description of the current setting",
 *   lastHook: "the mid-motion moment the previous clip ended on",
 *   referenceImages: ["path/to/canon1.png", ...],                // yam's canonical refs
 * }
 */

export async function writeClipPrompt({ concept, clipIndex, totalClips, durationSec, chainState }) {
  const knowledge = loadKnowledge();
  const continuing = clipIndex > 0;

  const system =
    `You are a Seedance 2.0 cinematic prompt engineer. The complete master knowledge base ` +
    `follows — obey it exactly, especially: reference_handling as the SECOND field; the ` +
    `one-primary camera rule; speed asymmetry; per-shot lighting; staggered timestamps; ` +
    `the zero-memory rule (fully re-establish characters, environment, wardrobe, and scene ` +
    `state from scratch in EVERY clip); carry visible damage/state forward via ` +
    `state_in_this_scene; lock spatial layout in critical_constraint; end on a hook, not a ` +
    `resolution (except the final clip of the sequence).\n\n` +
    `Output ONLY the YAML prompt in a single fenced yaml block. Under 4000 characters.\n\n` +
    `=== MASTER KNOWLEDGE ===\n${knowledge}`;

  const user =
    `SEQUENCE CONCEPT: ${concept}\n` +
    `CLIP ${clipIndex + 1} of ${totalClips}. Duration: ${durationSec} seconds.\n\n` +
    (continuing
      ? `This clip CONTINUES the sequence. Open with prompt_start: "Continue from @video1." ` +
        `before title. Re-establish everything from scratch per the zero-memory rule.\n\n` +
        `CARRIED STATE (must appear in character blocks as current design/state):\n` +
        `${JSON.stringify(chainState.characters, null, 2)}\n\n` +
        `LOCKED SPATIAL LAYOUT (restate in critical_constraint): ${chainState.spatialLayout}\n` +
        `ENVIRONMENT (re-describe fully as established setting): ${chainState.environment}\n` +
        `PREVIOUS CLIP ENDED ON: ${chainState.lastHook}\n` +
        `Open this clip resolving that hook, then advance.\n`
      : `This is the FIRST clip. Reference images ${chainState.referenceImages?.length ?? 0 > 0
          ? '(@image1..) are yam\'s canonical character design — apply full reference ' +
            'discipline: design-only, name the poses to avoid, use reference-incompatible framings.'
          : 'are not provided; describe the character fully from the canon description.'}\n`) +
    `\nAfter the yaml block, output a JSON block: {"end_hook": "...", "state_updates": {per-character ` +
    `cumulative state after this clip}, "environment": "current environment after this clip"}.`;

  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: 3500, system,
    messages: [{ role: 'user', content: user }],
  });

  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const yaml = (text.match(/```yaml\n([\s\S]*?)```/) || [])[1];
  const meta = (text.match(/```json\n([\s\S]*?)```/) || [])[1];
  if (!yaml) throw new Error('prompt writer returned no yaml block');

  const cost = ((msg.usage?.input_tokens ?? 0) / 1e6) * 3 + ((msg.usage?.output_tokens ?? 0) / 1e6) * 15;
  return { yaml: yaml.trim(), meta: meta ? JSON.parse(meta) : null, costUsd: Number(cost.toFixed(4)) };
}

// --- real Seedance 2.0 via Venice: quote -> queue -> poll retrieve ---
// Verified: POST /video/quote (authoritative price), POST /video/queue -> queue_id,
// POST /video/retrieve returns JSON {status} until done, then raw video/mp4 bytes.
// R2V prompt grammar is canonical + case-sensitive: <Image 1>, <Video 1>.
// STAGE 4 CAPABILITY (animating its own panels) — remains gated, not autonomous.

function VENICE_BASE_V() { return process.env.VENICE_BASE || 'https://api.venice.ai/api/v1'; }

async function veniceVideo(path, body) {
  return fetch(`${VENICE_BASE_V()}/video/${path}`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function quoteUsd(body) {
  const res = await veniceVideo('quote', body);
  if (!res.ok) throw new Error(`video quote failed: ${res.status} ${await res.text()}`);
  const q = await res.json();
  // Defensive parse — quote response field name not pinned in the docs excerpt we verified.
  const usd = Number(q.usd ?? q.cost ?? q.price ?? q.amount_usd ?? q.total ?? NaN);
  if (Number.isNaN(usd)) {
    console.warn('quote shape unrecognized, falling back to estimate:', JSON.stringify(q).slice(0, 200));
    return Number(process.env.VENICE_CLIP_EST_COST || 0.8);
  }
  return usd;
}

export async function generateClip({ cycleId, prompt, model = 'seedance-2-0-text-to-video',
  durationSec = 5, resolution = '720p', aspectRatio = '16:9',
  referenceImageUrls = [], referenceVideoUrls = [], referenceVideoTotalDuration = null,
  outPath }) {

  const body = { model, prompt, duration: `${durationSec}s`, resolution };
  // I2V auto-derives aspect ratio and 400s if you send it (per docs)
  if (!model.includes('image-to-video')) body.aspect_ratio = aspectRatio;
  if (referenceImageUrls.length) body.reference_image_urls = referenceImageUrls;
  if (referenceVideoUrls.length) {
    body.reference_video_urls = referenceVideoUrls;
    body.reference_video_total_duration =
      referenceVideoTotalDuration ?? referenceVideoUrls.length * durationSec;
  }

  const price = await quoteUsd(body);
  if ((await budgetRemaining()) < price) {
    throw new Error(`budget insufficient: clip quoted at $${price.toFixed(2)}`);
  }

  const qres = await veniceVideo('queue', body);
  if (qres.status === 409) {
    throw new Error(`seedance consent required (human face in refs) — operator decision, not auto-attesting: ${await qres.text()}`);
  }
  if (!qres.ok) throw new Error(`video queue failed: ${qres.status} ${await qres.text()}`);
  const { queue_id } = await qres.json();
  if (!queue_id) throw new Error('queue returned no queue_id');

  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10_000));
    const rres = await veniceVideo('retrieve', { model, queue_id });
    const ctype = rres.headers.get('content-type') || '';
    if (ctype.includes('video/mp4')) {
      const buf = Buffer.from(await rres.arrayBuffer());
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
      await recordSpend(cycleId, 'venice', price, `clip: ${prompt.slice(0, 70)}`);
      return { outPath, priceUsd: price, queueId: queue_id };
    }
    const j = await rres.json().catch(() => ({}));
    if (j.status === 'failed') throw new Error(`video generation failed: ${JSON.stringify(j).slice(0, 300)}`);
    // queued | running -> keep polling
  }
  throw new Error('video generation timed out after 12 minutes');
}

// Native continuation — preferred over last-frame chaining.
// Canonical grammar: "Extend <Video 1>, generate ..."
export async function extendClip({ cycleId, previousClipUrl, previousClipDurationSec,
  continuation, outPath, resolution = '720p' }) {
  return generateClip({
    cycleId,
    model: 'seedance-2-0-reference-to-video',
    prompt: `Extend <Video 1>, generate ${continuation}`,
    referenceVideoUrls: [previousClipUrl],
    referenceVideoTotalDuration: previousClipDurationSec,
    resolution, outPath,
  });
}

// Native join of 2-3 clips (combined input <= 15s).
export async function stitchClips({ cycleId, clipUrls, transitions, totalDurationSec, outPath, resolution = '720p' }) {
  if (clipUrls.length < 2 || clipUrls.length > 3) throw new Error('stitch takes 2-3 clips');
  const parts = clipUrls.map((_, i) => `<Video ${i + 1}>`);
  let prompt = parts[0];
  for (let i = 1; i < parts.length; i++) {
    prompt += ` + ${transitions?.[i - 1] || 'a smooth seamless cut'} + followed by ${parts[i]}`;
  }
  return generateClip({
    cycleId, model: 'seedance-2-0-reference-to-video', prompt,
    referenceVideoUrls: clipUrls, referenceVideoTotalDuration: totalDurationSec,
    resolution, outPath,
  });
}

// ---- chaining utilities (real, tested) ----
export function extractLastFrame(clipPath, framePath) {
  execSync(`ffmpeg -y -sseof -0.1 -i "${clipPath}" -frames:v 1 -q:v 2 "${framePath}"`, { stdio: 'pipe' });
  return framePath;
}

export function concatClips(clipPaths, outPath, { crossfadeSec = 0 } = {}) {
  if (crossfadeSec === 0) {
    const list = clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    execSync(`printf "%s" "${list}" > /tmp/concat.txt && ffmpeg -y -f concat -safe 0 -i /tmp/concat.txt -c copy "${outPath}"`, { stdio: 'pipe', shell: '/bin/bash' });
  } else {
    // xfade chain for n clips (re-encodes)
    const inputs = clipPaths.map(p => `-i "${p}"`).join(' ');
    let filter = '', prev = '[0:v]';
    for (let i = 1; i < clipPaths.length; i++) {
      const out = i === clipPaths.length - 1 ? '[v]' : `[x${i}]`;
      filter += `${prev}[${i}:v]xfade=transition=fade:duration=${crossfadeSec}:offset=${i * 14}${out};`;
      prev = `[x${i}]`;
    }
    execSync(`ffmpeg -y ${inputs} -filter_complex "${filter.slice(0, -1)}" -map "[v]" "${outPath}"`, { stdio: 'pipe' });
  }
  return outPath;
}

// ---- the full sequence runner, called by the executor ----
export async function runSequence(cycleId, { concept, clips = 3, clipSeconds = 15, chainState }) {
  const est = clips * 0.6; // rough provider cost estimate per clip; tune once wired
  if ((await budgetRemaining()) < est) throw new Error('budget insufficient for sequence');

  const dir = `${process.env.AGENT_HOME}/workspace/video/${Date.now()}`;
  execSync(`mkdir -p "${dir}"`);
  const clipPaths = [];
  let state = { ...chainState };

  for (let i = 0; i < clips; i++) {
    const { yaml, meta, costUsd } = await writeClipPrompt({
      concept, clipIndex: i, totalClips: clips, durationSec: clipSeconds, chainState: state,
    });
    await recordSpend(cycleId, 'anthropic', costUsd, `clip ${i + 1} prompt`);

    const outPath = `${dir}/clip_${i + 1}.mp4`;
    await generateClip({
      yamlPrompt: yaml,
      referenceImages: state.referenceImages,
      previousClipPath: i > 0 ? clipPaths[i - 1] : null,
      outPath,
    });
    clipPaths.push(outPath);

    // fold this clip's outcome into the chain ledger
    if (meta) {
      state = {
        ...state,
        lastHook: meta.end_hook ?? state.lastHook,
        environment: meta.environment ?? state.environment,
        characters: Object.fromEntries(Object.entries(state.characters ?? {}).map(([name, ch]) => [
          name, { ...ch, cumulativeState: meta.state_updates?.[name] ?? ch.cumulativeState },
        ])),
      };
    }
  }

  const finalPath = `${dir}/sequence.mp4`;
  concatClips(clipPaths, finalPath);
  return { finalPath, clipPaths, chainState: state };
}
