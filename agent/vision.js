// vision.js — yam looks at an image and describes what it sees.
// Uses Claude's vision via the same Anthropic SDK. Fetches an image URL,
// sends it as a base64 image block, returns yam's structured observation.
import Anthropic from '@anthropic-ai/sdk';
import { recordSpend, budgetRemaining } from './memory.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-4-6';
const VISION_EST_COST = 0.01;

export async function look(cycleId, imageUrl, question) {
  if ((await budgetRemaining()) < VISION_EST_COST) throw new Error('budget exhausted for vision');
  // Auto-rewrite Wikimedia file-description pages into scaled direct-file URLs.
  let target = imageUrl;
  const wm = imageUrl.match(/(?:commons|[a-z]+)\.(?:wikimedia|wikipedia)\.org\/wiki\/File:(.+)$/i);
  if (wm) target = `https://commons.wikimedia.org/wiki/Special:FilePath/${wm[1]}?width=1600`;

  const imgRes = await fetch(target, { headers: {
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) yam.garden art-study bot (contact: repo)',
    'accept': 'image/*,*/*;q=0.8',
  } });
  if (!imgRes.ok) throw new Error(`image fetch failed: HTTP ${imgRes.status} — the host refused; try a Wikimedia Commons file or a direct artist-posted image`);
  const ctype = imgRes.headers.get('content-type') || 'image/jpeg';
  if (!ctype.startsWith('image/')) throw new Error(`not an image (got ${ctype.split(';')[0]}) — this URL is a webpage, not a file; use a direct .jpg/.png, or a Wikimedia File: page (auto-converted)`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  if (buf.length > 4.5 * 1024 * 1024) throw new Error(`image too large (${(buf.length/1048576).toFixed(1)}MB, limit ~4.5MB) — use a scaled version, e.g. Wikimedia Special:FilePath/<File>?width=1600`);
  const b64 = buf.toString('base64');
  const msg = await anthropic.messages.create({
    model: VISION_MODEL, max_tokens: 1500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: ctype.split(';')[0], data: b64 } },
      { type: 'text', text: question || 'You are yam, studying to become a mangaka. Look at this image as a student of the craft. Describe what you actually see: line weight, paneling, composition, use of blacks and negative space, how the drawing controls the eye. Be specific about technique, not vibes.' },
    ]}],
  });
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const cost = ((msg.usage?.input_tokens ?? 0)/1e6)*3 + ((msg.usage?.output_tokens ?? 0)/1e6)*15;
  await recordSpend(cycleId, 'anthropic-vision', Number(cost.toFixed(4)), `look: ${imageUrl.slice(0,60)}`);
  return text;
}
