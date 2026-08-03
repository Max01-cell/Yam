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
  const imgRes = await fetch(imageUrl, { headers: { 'user-agent': 'yam/0.1' } });
  if (!imgRes.ok) throw new Error(`image fetch failed: ${imgRes.status}`);
  const ctype = imgRes.headers.get('content-type') || 'image/jpeg';
  if (!ctype.startsWith('image/')) throw new Error(`not an image: ${ctype}`);
  const b64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
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
