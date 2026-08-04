// loop.js — one full wake cycle. Run by systemd timer (see sandbox/).
// wake → read own memory → crawl → think → write thoughts → queue proposals → commit trail

import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import {
  getState, setState, recordThought, recentThoughts,
  logCrawl, proposeAction, recordSpend, recentCreations, recentActions,
  recentNotes, saveNote
} from './memory.js';
import { crawlCycle } from './crawl.js';
import { think } from './think.js';

// Rough Sonnet pricing for the ledger; adjust if you change AGENT_MODEL.
const IN_PER_MTOK = 3.0, OUT_PER_MTOK = 15.0;

async function runCycle() {
  const cycleId = randomUUID();
  console.log(`[cycle ${cycleId}] waking`);

  const identity = (await getState('identity')).value;
  const tasteRules = (await getState('taste_rules')).value;
  const project = await getState('current_project').catch(() => ({ value: null }));
  const revisit = project.value?.revisit_urls ?? [];
  const diet = await getState('diet').catch(() => null);

  const crawled = await crawlCycle(revisit, diet?.value?.feeds);
  console.log(`[cycle ${cycleId}] crawled ${crawled.length} sources`);

  const thoughts = await recentThoughts(40);
  const actionHistory = (await recentActions(5))
    .map(a => `#${a.id} ${a.action_type}${a.path ? ` ${a.path}` : ''} -> ${a.status}${a.error ? ` (${a.error})` : ''}`)
    .join('\n');
  const studyNotebook = (await recentNotes(20))
    .map(n => `[${n.topic}${n.subject ? `/${n.subject}` : ''}] ${n.content}`)
    .join('\n');
  const myWork = await recentCreations(8).catch(() => []);
  const { parsed, usage } = await think({ identity, tasteRules, recentThoughts: thoughts, crawled: crawled.slice(0, 9), myWork, actionHistory, studyNotebook });

  // Ledger the thinking cost
  const cost = ((usage.input_tokens ?? 0) / 1e6) * IN_PER_MTOK
             + ((usage.output_tokens ?? 0) / 1e6) * OUT_PER_MTOK;
  await recordSpend(cycleId, 'anthropic', Number(cost.toFixed(4)), 'cycle cognition');

  // Write the mind
  for (const t of parsed.thoughts ?? []) {
    await recordThought(cycleId, t.kind, t.content);
  }
  for (const v of parsed.crawl_verdicts ?? []) {
    await logCrawl(cycleId, {
      url: v.url, title: v.title, verdict: v.verdict, interestScore: v.interest_score
    });
  }

  // Durable craft knowledge
  if (parsed.study_note?.topic && parsed.study_note?.content) {
    await saveNote(parsed.study_note.topic, parsed.study_note.subject ?? null, parsed.study_note.content);
    console.log(`[cycle ${cycleId}] saved study note: ${parsed.study_note.topic}`);
  }

  // Evolve long-lived state
  const mu = parsed.memory_updates ?? {};
  if (mu.obsessions) await setState('obsessions', mu.obsessions);
  if (mu.taste_rules) await setState('taste_rules', mu.taste_rules);
  if (Array.isArray(mu.diet?.feeds)) {
    const feeds = mu.diet.feeds
      .filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
      .slice(0, 10);
    if (feeds.length) await setState('diet', { feeds });
  }
  await setState('current_project', {
    ...(mu.current_project ?? project.value ?? {}),
    revisit_urls: parsed.revisit_urls ?? [],
  });

  // Queue proposals — NOTHING executes from here. The gate decides.
  for (const p of parsed.proposals ?? []) {
    const id = await proposeAction(cycleId, p.action_type, p.payload, p.rationale, p.self_score);
    console.log(`[cycle ${cycleId}] proposed action #${id}: ${p.action_type} (self-score ${p.self_score})`);
  }

  // Public trail: commit the workspace + a cycle marker
  try {
    execSync(
      `cd ${process.env.AGENT_HOME || '.'} && ` +
      `echo "${new Date().toISOString()} cycle ${cycleId}: ${ (parsed.thoughts?.[0]?.content ?? 'quiet cycle').replace(/"/g, '') }" >> workspace/journal.log && ` +
      `git add -A && git -c user.name="${identity.name}" -c user.email="agent@localhost" ` +
      `commit -q -m "cycle: ${(parsed.thoughts?.[0]?.content ?? 'thinking').slice(0, 60).replace(/"/g, '')}" && ` +
      `git push -q origin main`,
      { stdio: 'pipe' }
    );
  } catch {
    console.log(`[cycle ${cycleId}] commit/push skipped (nothing new or no remote)`);
  }

  console.log(`[cycle ${cycleId}] sleeping. cost ~$${cost.toFixed(4)}`);
}

runCycle().catch(err => {
  console.error('cycle failed:', err.message);
  process.exit(1);
});
