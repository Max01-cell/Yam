// images.js — pull real image URLs out of what yam actually crawled.
//
// stripToReadable() deletes every tag, so until now yam's entire diet arrived as
// text: it read about images it could never see. Its only eyes were a look action
// that had to recall a URL (always invented) or search Commons by keyword (six
// consecutive failures). This harvests the images that were genuinely in the
// bytes, so a look can target something yam demonstrably saw this cycle.
//
// Every rule here is calibrated against a corpus of real captured feeds, not
// against what feeds are supposed to look like:
//   - media:content and media:thumbnail carry nearly all feed imagery.
//     <enclosure type="image/*"> is rare enough to be an afterthought.
//   - Publishers emit one image at many widths — the Guardian's feed holds 110
//     media:content elements for 55 distinct images — so variants must collapse.
//   - <img> tags inside feed content are frequently tracking beacons with no
//     image extension (medium.com/_/stat?event=post.clientViewed). Requiring a
//     real extension is what keeps those out.
//   - img tags appear both raw inside CDATA and entity-escaped as &lt;img, so
//     entities must be decoded before anything is matched.
//   - Feeds routinely advertise 70–264px thumbnails. Those are useless to study
//     from, so a declared width below the floor is dropped.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    const k = e.toLowerCase();
    return k in NAMED ? NAMED[k] : m;
  });
}

// A real extension, optionally followed by a query. This single rule is what
// separates images from beacons, trackers and API endpoints.
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)(?:$|[?#])/i;

// Furniture, not artwork. Matched against the whole URL including host, which
// is what catches b.thumbs.redditmedia.com.
const FURNITURE = /(?:thumb|avatar|icon|logo|favicon|spacer|pixel|beacon|emoji|badge|sprite|banner|header|footer|1x1|\/stat\?)/i;

const DIM_SUFFIX = /[_-](\d{2,5})x(\d{2,5})(?=\.(?:jpe?g|png|webp|gif))/i;

export function declaredWidth(url, attrWidth) {
  const a = Number(attrWidth);
  if (Number.isFinite(a) && a > 0) return a;
  const q = url.match(/[?&](?:w|width)=(\d{2,5})/i);
  if (q) return Number(q[1]);
  const d = url.match(DIM_SUFFIX);
  if (d) return Math.max(Number(d[1]), Number(d[2]));
  return null;
}

// Same picture at different sizes collapses to one entry.
export function imageIdentity(url) {
  return url.replace(/[?#].*$/, '').replace(DIM_SUFFIX, '');
}

export function extractImages(raw, baseUrl, { limit = 4, minKnownWidth = 400 } = {}) {
  const text = decodeEntities(String(raw ?? ''));
  const found = [];
  const push = (u, w) => { if (u) found.push({ raw: u, width: w ?? null }); };

  // media:content / media:thumbnail / enclosure — attribute order varies by publisher
  for (const m of text.matchAll(/<(?:media:content|media:thumbnail|enclosure)\b([^>]*)>/gi)) {
    const attrs = m[1];
    const url = (attrs.match(/\burl\s*=\s*["']([^"']+)["']/i) || [])[1];
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!url || (type && !/^image\//i.test(type))) continue;
    push(url, (attrs.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1]);
  }
  for (const m of text.matchAll(/<meta\b[^>]*?(?:property|name)\s*=\s*["']og:image(?::url)?["'][^>]*>/gi)) {
    push((m[0].match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1], null);
  }
  for (const m of text.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1];
    push((attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1],
         (attrs.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1]);
  }
  // Bare URLs: reddit's .json diet and any other JSON feed.
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\)\]]+\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>\\)\]]*)?/gi)) {
    push(m[0], null);
  }

  // Group every sighting of the same picture before deciding. A size limit
  // applied per sighting is not a limit at all: the bare-url pass sees the same
  // thumbnail without the width attribute that condemned it and lets it back in.
  const groups = new Map();
  for (const f of found) {
    let abs;
    try { abs = new URL(String(f.raw).trim(), baseUrl).href; } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    if (!IMAGE_EXT.test(abs)) continue;
    if (FURNITURE.test(abs)) continue;
    const key = imageIdentity(abs);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ url: abs, width: declaredWidth(abs, f.width) });
  }

  const out = [];
  for (const sightings of groups.values()) {
    const known = sightings.map(s => s.width).filter(w => w != null);
    // Only condemn on evidence: if every width we know about is too small, the
    // image is too small. If no width was ever declared, give it the benefit.
    if (known.length && Math.max(...known) < minKnownWidth) continue;
    const best = sightings.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
    out.push(best.url);
    if (out.length >= limit) break;
  }
  return out;
}

// One flat list for the prompt, with provenance, capped so the block stays cheap.
export function collectImages(crawled, { perSource = 3, total = 12 } = {}) {
  const out = [];
  for (const c of crawled ?? []) {
    let host = c.url;
    try { host = new URL(c.url).host.replace(/^www\./, ''); } catch { /* keep raw */ }
    for (const url of (c.images ?? []).slice(0, perSource)) {
      if (out.length >= total) return out;
      if (!out.some(o => o.url === url)) out.push({ url, from: host });
    }
  }
  return out;
}
