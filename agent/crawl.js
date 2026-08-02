// crawl.js — what the agent looks at each cycle.
// v1: curated RSS/JSON feeds + any URLs the agent asked to revisit last cycle.
// Deliberately simple: fetch, strip, truncate. The thinking happens in think.js.

const DEFAULT_FEEDS = [
  'https://www.reddit.com/r/cinematography/.json?limit=10',
  'https://www.reddit.com/r/Simulated/.json?limit=10',
  'https://www.reddit.com/r/generative/.json?limit=10',
  'https://www.reddit.com/r/vfx/.json?limit=10',
  'https://www.reddit.com/r/glitch_art/.json?limit=10',
  'https://www.thisiscolossal.com/feed/',
  'https://vimeo.com/channels/staffpicks/videos/rss',
];

const UA = 'persona-agent/0.1 (autonomous art project; contact in repo)';

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 60_000);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function stripToReadable(raw) {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

// Returns [{ url, content }] — raw material for the mind.
export async function crawlCycle(extraUrls = []) {
  const targets = [...DEFAULT_FEEDS, ...extraUrls.slice(0, 5)];
  const results = [];
  for (const url of targets) {
    const raw = await fetchText(url);
    if (!raw) continue;
    results.push({ url, content: stripToReadable(raw) });
  }
  return results;
}
