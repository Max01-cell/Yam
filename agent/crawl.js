// crawl.js — what the agent looks at each cycle.
// v1: curated RSS/JSON feeds + any URLs the agent asked to revisit last cycle.
// Deliberately simple: fetch, strip, truncate. The thinking happens in think.js.

import { extractImages } from './images.js';

// The seed diet. Every entry was probed against extractImages under the same 60_000
// char truncation fetchText applies, and every one yields images in production.
//
// The five reddit .json feeds that used to sit at the top of this list are gone: they
// return HTTP 403 to datacenter IPs, so they had been contributing nothing but latency.
// They were also off-mission — cinematography, vfx and glitch art are what yam read when
// it was a growth organism studying what spreads, not a mangaka learning the page.
export const DEFAULT_FEEDS = [
  'https://www.tcj.com/feed/',                    // The Comics Journal — criticism, interviews
  'https://www.comicsbeat.com/feed/',             // comics news, heavy on art
  'https://mangabrog.wordpress.com/feed/',        // translated mangaka interviews
  'https://www.solrad.co/feed',                   // comics criticism
  'https://publicdomainreview.org/rss.xml',       // historical illustration and print
  'https://letterformarchive.org/feed/',          // lettering and type
  'https://hyperallergic.com/feed/',              // art criticism
  'https://www.thisiscolossal.com/feed/',
  'https://vimeo.com/channels/staffpicks/videos/rss',
];

const UA = 'persona-agent/0.1 (autonomous art project; contact in repo)';

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    if (!text.trim()) return { ok: false, error: 'empty response body' };
    return { ok: true, text: text.slice(0, 60_000) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `no response in ${timeoutMs / 1000}s` : e.message };
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

// Returns { sources: [{ url, content, images }], failures: [{ url, error }] }.
// Images are harvested from the RAW bytes, before stripToReadable removes every
// tag: that strip is why yam's diet has been text-only, and why its look action
// has had to guess at URLs instead of using one it actually saw.
//
// Failures are returned rather than skipped. A feed that has quietly 404'd for a
// week is indistinguishable, from inside the cycle, from a feed yam removed on
// purpose — and yam cannot fix what it cannot see.
export async function crawlCycle(extraUrls = [], feeds) {
  const targets = [...(feeds?.length ? feeds : DEFAULT_FEEDS), ...extraUrls.slice(0, 5)];
  const sources = [];
  const failures = [];
  for (const url of targets) {
    const res = await fetchText(url);
    if (!res.ok) { failures.push({ url, error: res.error }); continue; }
    let images = [];
    try { images = extractImages(res.text, url); }
    catch (e) { console.warn(`image harvest failed for ${url}: ${e.message}`); }
    sources.push({ url, content: stripToReadable(res.text), images });
  }
  return { sources, failures };
}
