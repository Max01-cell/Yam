// venice.js — Venice generation pipeline (image now, Seedance video next).
//
// HONESTY NOTE: endpoint paths below are placeholders. Before first run, pull
// Venice's official agent skill files + x402 client SDK (they publish both on
// GitHub — see their changelog) and replace the marked sections. Do not trust
// these paths as-is; they encode the *shape* of the integration, not the API.
//
// Two payment modes:
//   1. API key (simple, start here):   VENICE_API_KEY env var
//   2. x402 per-call (the lore mode):  agent's wallet pays per generation.
//      Wire through the same x402 flow as the launchpad. TODO: integrate
//      Venice's x402 Client SDK here and log every payment to spend_ledger.

import { recordSpend, budgetRemaining } from './memory.js';

const VENICE_BASE = process.env.VENICE_BASE || 'https://api.venice.ai/api/v1';

export async function generateImage(cycleId, prompt, { estCostUsd = 0.04 } = {}) {
  const remaining = await budgetRemaining();
  if (remaining < estCostUsd) {
    throw new Error(`budget exhausted: $${remaining.toFixed(2)} left today`);
  }

  // TODO(venice-docs): verify path + body against Venice API reference.
  const res = await fetch(`${VENICE_BASE}/image/generate`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt, width: 1024, height: 1024 }),
  });
  if (!res.ok) throw new Error(`venice image gen failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  await recordSpend(cycleId, 'venice', estCostUsd, `image: ${prompt.slice(0, 80)}`);
  return data; // caller stores to Supabase storage + creations table
}

// Seedance reference-to-video: locks character identity from reference images.
// TODO(venice-docs): confirm model id, reference-image upload format, and
// duration params from Venice's Seedance docs before enabling.
export async function generateVideo(cycleId, prompt, referenceImagePaths = [], { estCostUsd = 0.5 } = {}) {
  const remaining = await budgetRemaining();
  if (remaining < estCostUsd) {
    throw new Error(`budget exhausted: $${remaining.toFixed(2)} left today`);
  }
  throw new Error('generateVideo not wired yet — fill from Venice Seedance docs first');
}
