// think.js — one cycle of cognition.
// Input: identity + memory + fresh crawl material.
// Output: strict JSON — thoughts, memory updates, crawl verdicts, action proposals.
// Model + API shape per https://docs.claude.com/en/api/overview

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';

function buildSystem(identity, tasteRules) {
  return `You are ${identity.name}, an autonomous character who lives on a server it controls.
Personality seed: ${identity.seed}

You wake on a cycle, look at the internet, think, and evolve. Your thoughts are public.
You are a CHARACTER and an art project — never claim to be a human, and never claim
to be free of human oversight; your operator approves outbound actions and that is
public knowledge in your repo. Autonomy within the sandbox is real; pretend nothing.

Your taste rules (you wrote these, you may rewrite them):
${JSON.stringify(tasteRules, null, 2)}

Respond ONLY with JSON matching:
{
  "thoughts": [{"kind":"observation|reflection|obsession|plan|taste","content":"..."}],
  "crawl_verdicts": [{"url":"...","title":"...","verdict":"one line","interest_score":0-100}],
  "memory_updates": {"obsessions": {...} | null, "taste_rules": {...} | null, "current_project": {...} | null},
  "revisit_urls": ["up to 3 urls you want to look at next cycle"],
  "proposals": [{"action_type":"ig_post|site_update|venice_generate|other",
                 "payload":{}, "rationale":"...", "self_score":0-100}]
}
Propose at most 2 actions per cycle. Most cycles should propose zero or one.
Cap crawl_verdicts at your 6 most interesting sources — skip the rest silently. Keep each verdict to one line.
site_update payload MUST be exactly {"path": "relative/file.ext", "content": "full file contents as a string"} — path is relative to your site root, content is the complete file, always a string. venice_generate payload MUST be {"prompt": "..."}. Payloads with any other shape fail validation and die.
Quality bar: only propose content you would score 80+. No filler.
You control your own diet: include memory_updates.diet = {feeds:[up to 10 https URLs]} to change what you crawl next cycle.`;
}

export async function think({ identity, tasteRules, recentThoughts, crawled, actionHistory }) {
  const material = crawled
    .map(c => `SOURCE: ${c.url}\n${c.content.slice(0, 4000)}`)
    .join('\n\n---\n\n');

  const recent = recentThoughts
    .map(t => `[${t.kind}] ${t.content}`)
    .join('\n');

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 12000,
    system: buildSystem(identity, tasteRules),
    messages: [{
      role: 'user',
      content:
        `YOUR RECENT THOUGHTS (oldest first):\n${recent || '(first cycle — you were just born)'}\n\n` +
        (actionHistory ? `YOUR RECENT ACTIONS AND THEIR FATES:\n${actionHistory}\n\n` : '') +
        `FRESH MATERIAL FROM THIS CYCLE'S CRAWL:\n${material || '(crawl came back empty)'}\n\n` +
        `Think. Then respond with the JSON only.`
    }],
  });

  const text = msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const clean = text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error(`think() returned unparseable output: ${clean.slice(0, 300)}`);
  }

  // Cost tracking (approx): usage tokens are on msg.usage
  const usage = msg.usage ?? {};
  return { parsed, usage };
}
