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

// A real extension separates images from beacons — but ONLY where the source
// told us nothing. When markup positively declares an image (media:thumbnail,
// or a type/medium that says image), the declaration is better evidence than a
// file suffix, and demanding a suffix anyway throws away whole CDNs. Vimeo
// serves 960px thumbnails at paths ending -d_960?region=us: no extension, ten
// real images per feed, all of them silently discarded by an extension gate.
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)(?:$|[?#])/i;

// Explicitly not an image, whatever the url looks like.
const NOT_IMAGE = /^(?:video|audio|application)\//i;

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

export function extractImages(raw, baseUrl, { limit = 8, minKnownWidth = 400 } = {}) {
  const text = decodeEntities(String(raw ?? ''));
  const found = [];
  // declared=true means the markup asserted this is an image. Only unverified
  // candidates have to prove it with a file extension.
  const push = (u, w, declared = false, denied = false) => {
    if (u) found.push({ raw: u, width: w ?? null, declared, denied });
  };

  // media:content / media:thumbnail / enclosure — attribute order varies by publisher
  for (const m of text.matchAll(/<(media:content|media:thumbnail|enclosure)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const url = (attrs.match(/\burl\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!url) continue;
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const medium = ((attrs.match(/\bmedium\s*=\s*["']([^"']+)["']/i) || [])[1] || '').toLowerCase();
    // Recorded as denied rather than skipped: dropping it here only means the
    // bare-url pass finds the same address a moment later and lets it through.
    // A rejection has to attach to the image, not to the sighting.
    if (NOT_IMAGE.test(type) || medium === 'video' || medium === 'audio') {
      push(url, null, false, true);
      continue;
    }
    // media:thumbnail is an image by definition; the others must say so.
    const declared = tag === 'media:thumbnail' || /^image\//i.test(type) || medium === 'image';
    push(url, (attrs.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1], declared);
  }
  for (const m of text.matchAll(/<meta\b[^>]*?(?:property|name)\s*=\s*["']og:image(?::url)?["'][^>]*>/gi)) {
    push((m[0].match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1], null, true);
  }
  // <img> and bare urls are where beacons live, so these stay unverified.
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
    // A denied sighting must always reach its group so it can poison it.
    if (!f.denied) {
      // The extension gate applies only where nothing declared this an image.
      if (!f.declared && !IMAGE_EXT.test(abs)) continue;
      if (FURNITURE.test(abs)) continue;
    }
    const key = imageIdentity(abs);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ url: abs, width: declaredWidth(abs, f.width), denied: f.denied });
  }

  const out = [];
  for (const sightings of groups.values()) {
    if (sightings.some(s => s.denied)) continue;
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
// Allocation is round-robin rather than a fixed slice per source: a hard per-source
// cap assumed a broad diet, and starves yam precisely when the diet has narrowed to
// one productive source — the moment it most needs whatever that source has.
export function collectImages(crawled, { total = 12 } = {}) {
  const queues = (crawled ?? []).map(c => {
    let host = c.url;
    try { host = new URL(c.url).host.replace(/^www\./, ''); } catch { /* keep raw */ }
    return { host, images: [...(c.images ?? [])] };
  });
  const out = [];
  const seen = new Set();
  let round = 0;
  while (out.length < total) {
    let took = false;
    for (const q of queues) {
      if (round >= q.images.length) continue;
      took = true;
      const url = q.images[round];
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, from: q.host });
      if (out.length >= total) break;
    }
    if (!took) break;
    round += 1;
  }
  return out;
}
