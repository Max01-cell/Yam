// executor.js — the only file allowed to DO things in the outside world.
// Runs on its own systemd timer. Picks up status='approved' rows, executes,
// marks executed/failed. If a handler isn't wired yet, it fails loudly
// instead of pretending.

import { approvedUnexecuted, autonomousPending, markAction } from './memory.js';
import { generateImage } from './venice.js';
import { runSequence } from './video.js';
import { draw } from './draw.js';
import { triggerDeploy } from './deploy.js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execSync } from 'child_process';

// In-sandbox actions self-execute from status='pending'. Outbound actions
// (ig_post, token_launch, x402_spend) still require status='approved'.
const AUTONOMOUS = ['site_update', 'venice_generate', 'look', 'draw'];

const HANDLERS = {
  // Agent redesigns its own home. Blast radius: its own site directory.
  async site_update(action) {
    const dir = `${process.env.AGENT_HOME}/workspace/site`;
    const path = action.payload.path || action.payload.location;
    const { content } = action.payload;
    if (!path || typeof content !== 'string') throw new Error('site_update needs {path, content}');
    if (path.includes('..')) throw new Error('path traversal blocked');
    const target = `${dir}/${path}`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    execSync(`cd ${process.env.AGENT_HOME} && git add -A && git commit -q -m "site: ${path}" && git push -q origin main`, { stdio: 'pipe' });
    await triggerDeploy(`site: ${path}`);
    return { wrote: path };
  },

  async venice_generate(action) {
    const { prompt, character, style_preset: stylePreset, variation_of: variationOf } = action.payload;
    const { getState, setState } = await import('./memory.js');
    const { normaliseName, recordReference, seedFor } = await import('./cast.js');

    // A character generation is not a free-text prompt. The canonical appearance text and
    // the character's fixed seed are prepended by the system, so identity does not depend
    // on yam remembering to redescribe them the same way every time — which is exactly the
    // thing a language model cannot be relied on to do.
    const who = normaliseName(character);
    let castState = null, entry = null, seed = null, fullPrompt = prompt;
    if (who) {
      castState = (await getState('cast').catch(() => null))?.value ?? null;
      const key = Object.keys(castState?.characters ?? {}).find(k => k.toLowerCase() === who.toLowerCase());
      entry = key ? castState.characters[key] : null;
      seed = entry?.seed ?? seedFor(who);
      if (entry?.appearance) fullPrompt = `${entry.appearance}. ${prompt}`;
    }

    // Variations edit the canonical sheet instead of regenerating, because a seed holds an
    // image, not a likeness: change the prompt and the same seed gives a different person.
    if (variationOf || (who && entry?.reference && /\b(pose|angle|turnaround|expression|variation)\b/i.test(String(prompt)))) {
      const { editImage } = await import('./venice.js');
      const base = variationOf || entry.reference;
      const out = await editImage(action.cycle_id, base, fullPrompt,
        { selfScore: action.self_score ?? null, label: who ? `${who}-${prompt}` : null });
      try {
        execSync(`cd ${process.env.AGENT_HOME} && git add -A && git commit -q -m "study: ${String(prompt).slice(0, 60).replace(/"/g, '')}" && git push -q origin main`, { stdio: 'pipe' });
        await triggerDeploy(`variation: ${String(prompt).slice(0, 40)}`);
      } catch (e) { console.warn('variation commit/push skipped:', e.message); }
      return { ...out, character: who || null, editedFrom: base };
    }

    // A character generation renders on the SAME terms the design sessions established:
    // recraft-v4, the Line Art preset, and the negative prompt. The old default here was
    // wai-Illustrious with the 'Anime' preset, which is the exact combination that returns
    // a generic anime lead in an orange gi — so every character yam generated from a cycle
    // came back as somebody else's character, however carefully it had written the brief.
    const { DESIGN_MODEL, DESIGN_PRESET, NEGATIVE, IMAGE_COST } = await import('./design-session.js');
    const result = await generateImage(action.cycle_id, fullPrompt, {
      seed,
      model: who ? DESIGN_MODEL : null,
      stylePreset: stylePreset ?? (who ? DESIGN_PRESET : null),
      negativePrompt: who ? NEGATIVE : null,
      cost: who ? IMAGE_COST : null,
      label: who ? `${who}-${prompt}` : null,
    });

    // First sheet for this character becomes the canonical reference it draws toward.
    if (who) {
      try {
        const fresh = (await getState('cast').catch(() => null))?.value ?? castState;
        await setState('cast', recordReference(fresh, who, result.publicUrl));
        console.log(`[cast] reference sheet for ${who}: ${result.publicUrl} (seed ${seed})`);
      } catch (e) { console.warn(`cast reference not recorded for ${who}: ${e.message}`); }
      result.character = who;
    }
    try {
      execSync(`cd ${process.env.AGENT_HOME} && git add -A && git commit -q -m "study: ${(action.payload.prompt || '').slice(0, 60).replace(/"/g, '')}" && git push -q origin main`, { stdio: 'pipe' });
    } catch (e) { console.warn('study commit/push skipped:', e.message); }
    return result;
  },

  // yam draws by hand: it authors the SVG itself. Every mark is its decision.
  async draw(action) {
    const { title, svg, intent, character } = action.payload;
    return draw(action.cycle_id, { title, svg, intent, character, selfScore: action.self_score ?? null });
  },

  async look(action) {
    const { look } = await import('./vision.js');
    const res = await look(action.cycle_id, action.payload.image_url, action.payload.question, action.payload.search);
    // record what it ACTUALLY saw — the resolved url, not the requested one
    const { recordThought, saveNote } = await import('./memory.js');
    await recordThought(action.cycle_id, 'observation', `[looked at ${res.url}]: ${res.text}`);

    // A reading of yam's OWN work is the payoff step of the practice loop
    // (draw -> look -> name the gap) and the most valuable thing it produces.
    // As a thought it scrolls out of working memory in about six cycles, and it
    // cannot become a study note the normal way: think() picks the cycle's note
    // during the cycle, while look runs later on the executor timer. So the one
    // output the loop exists to generate is the one output that can never be
    // saved. Persist it here, at the moment it is produced.
    let noted = false;
    const { isOwnWork, titleFromStudyUrl } = await import('./draw.js');
    if (isOwnWork(res.url)) {
      try {
        await saveNote('own-work-reading', titleFromStudyUrl(res.url), res.text);
        noted = true;
      } catch (e) {
        console.warn(`own-work note save failed: ${e.message}`);
      }
    }
    return { saw: res.text.slice(0, 200), url: res.url, substituted: res.substituted ?? null, noted };
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
  const combined = [...await approvedUnexecuted(), ...await autonomousPending(AUTONOMOUS)];
  const actions = [...new Map(combined.map(a => [a.id, a])).values()];
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
