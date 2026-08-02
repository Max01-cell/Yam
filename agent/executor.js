// executor.js — the only file allowed to DO things in the outside world.
// Runs on its own systemd timer. Picks up status='approved' rows, executes,
// marks executed/failed. If a handler isn't wired yet, it fails loudly
// instead of pretending.

import { approvedUnexecuted, markAction } from './memory.js';
import { generateImage } from './venice.js';
import { runSequence } from './video.js';
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

const HANDLERS = {
  // Agent redesigns its own home. Blast radius: its own site directory.
  async site_update(action) {
    const dir = `${process.env.AGENT_HOME}/workspace/site`;
    mkdirSync(dir, { recursive: true });
    const { path, content } = action.payload;
    if (!path || typeof content !== 'string') throw new Error('site_update needs {path, content}');
    if (path.includes('..')) throw new Error('path traversal blocked');
    writeFileSync(`${dir}/${path}`, content);
    execSync(`cd ${process.env.AGENT_HOME} && git add -A && git commit -q -m "site: ${path}" && git push -q origin main`, { stdio: 'pipe' });
    return { wrote: path };
  },

  async venice_generate(action) {
    const { prompt } = action.payload;
    return generateImage(action.cycle_id, prompt);
  },

  // Multi-clip Seedance sequence. payload: { concept, clips, clipSeconds, chainState }
  // chainState.referenceImages should point at yam's canonical reference renders.
  async video_pipeline(action) {
    return runSequence(action.cycle_id, action.payload);
  },

  // Deliberately unwired. IG posting goes through the official Graph API on a
  // creator/business account — wire it when the account exists. Never scraped login.
  async ig_post() {
    throw new Error('ig_post not wired: connect IG Graph API first');
  },

  // Deliberately unwired until launch day. When wired, this calls the
  // launchpad-x402 /v1/launch route — and it STILL only runs from an
  // approved row, same as everything else.
  async token_launch() {
    throw new Error('token_launch not wired: launch day is a decision, not a default');
  },

  async x402_spend() {
    throw new Error('x402_spend not wired: integrate wallet flow first');
  },

  async other(action) {
    throw new Error(`no handler for freeform action: ${JSON.stringify(action.payload).slice(0, 120)}`);
  },
};

async function run() {
  const actions = await approvedUnexecuted();
  for (const a of actions) {
    const h = HANDLERS[a.action_type];
    try {
      if (!h) throw new Error(`unknown action_type ${a.action_type}`);
      const result = await h(a);
      await markAction(a.id, 'executed', result);
      console.log(`executed #${a.id} (${a.action_type})`);
    } catch (err) {
      await markAction(a.id, 'failed', { error: err.message });
      console.error(`failed #${a.id} (${a.action_type}): ${err.message}`);
    }
  }
}

run().catch(e => { console.error(e); process.exit(1); });
