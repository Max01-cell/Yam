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
import { readFileSync, existsSync } from 'fs';
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

// ---- provider call: fill from Venice or Higgsfield docs before first run ----
// Both expose Seedance 2.0. Reference-to-video carries @image refs; continuation
// passes the previous clip as @video1. This stub is honest: it throws until wired.
export async function generateClip({ yamlPrompt, referenceImages, previousClipPath, outPath }) {
  throw new Error(
    'generateClip not wired: fill from the Venice Seedance docs (or Higgsfield ' +
    'route bytedance/seedance) — pass yamlPrompt as the prompt, referenceImages ' +
    'as @image1.., previousClipPath as @video1, poll to completion, save to outPath.'
  );
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
