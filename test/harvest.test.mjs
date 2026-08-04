// Real checks for the harvest patch. Image rules are exercised against verbatim
// excerpts from published feeds; drawing measurement is exercised against the
// actual SVG yam authored for Study 008, not a synthetic document.
import assert from 'assert';
import { readFileSync } from 'fs';
import { REAL } from './fixtures/feeds.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_KEY ||= 'x';
process.env.ANTHROPIC_API_KEY ||= 'x';

const { extractImages, decodeEntities, declaredWidth, imageIdentity, collectImages } = await import('../agent/images.js');
const { measureSvg, summariseMeasurements, titleFromStudyUrl, isOwnWork } = await import('../agent/draw.js');
const { formatDietStats } = await import('../agent/recall.js');

const BASE = 'https://example.com/feed';
const one = (markup, opts) => extractImages(markup, BASE, opts);

console.log('\nimage harvest — against verbatim real feed markup:');

t('collapses one image offered at several widths, keeping the largest', () => {
  const got = one(REAL.guardianVariants);
  assert.strictEqual(got.length, 1, `expected 1 image from 2 variants, got ${got.length}`);
  assert.ok(got[0].includes('w=460'), `kept the wrong variant: ${got[0]}`);
});

t('rejects a tracking beacon dressed as an img tag', () => {
  assert.deepStrictEqual(one(REAL.mediumBeacon), []);
});

t('keeps the real content image from the same feed', () => {
  const got = one(REAL.mediumContent);
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].includes('cdn-images-1.medium.com'));
});

t('rejects feed branding', () => assert.deepStrictEqual(one(REAL.redditBranding), []));
t('rejects a sub-300px thumbnail host', () => assert.deepStrictEqual(one(REAL.redditThumb), []));
t('rejects a dimension-suffixed 142x100 image', () => assert.deepStrictEqual(one(REAL.uolDimensioned), []));
t('rejects an entity-escaped img with no real extension', () => assert.deepStrictEqual(one(REAL.escapedImg), []));
t('accepts a plain content image with no declared width', () => {
  assert.strictEqual(one(REAL.heiseScaled).length, 1);
});

t('an unknown width is accepted; only a known-and-small width is dropped', () => {
  assert.strictEqual(one('<img src="https://x.test/a.jpg">').length, 1);
  assert.strictEqual(one('<img src="https://x.test/a.jpg" width="120">').length, 0);
});
t('a small declared width is NOT resurrected by the bare-url pass', () => {
  // the same picture appears twice: once condemned by width, once naked in json
  const both = '<img src="https://x.test/a.jpg" width="90"> {"url":"https://x.test/a.jpg"}';
  assert.deepStrictEqual(one(both), []);
});
t('but a large sighting rescues a small one — evidence, not suspicion', () => {
  const both = '<media:content width="140" url="https://x.test/b.jpg"/><media:content width="900" url="https://x.test/b.jpg"/>';
  assert.strictEqual(one(both).length, 1);
});

console.log('\nimage harvest — mixed and adversarial input:');

t('one feed with beacon + branding + thumbnail + two real images yields exactly the two', () => {
  const mixed = [REAL.mediumBeacon, REAL.redditBranding, REAL.redditThumb,
                 REAL.mediumContent, REAL.heiseScaled].join('\n');
  const got = one(mixed);
  assert.strictEqual(got.length, 2, `got ${got.length}: ${got.join(' | ')}`);
});

t('resolves relative src against the source url', () => {
  const got = extractImages('<img src="/art/plate.jpg">', 'https://colossal.test/feed/');
  assert.deepStrictEqual(got, ['https://colossal.test/art/plate.jpg']);
});

t('harvests bare urls from a json feed (reddit .json diet)', () => {
  const json = '{"data":{"children":[{"data":{"url":"https://i.redd.it/abc123.png","over_18":false}}]}}';
  assert.deepStrictEqual(one(json), ['https://i.redd.it/abc123.png']);
});

t('decodes &amp; inside a harvested url', () => {
  const got = one('<media:content url="https://x.test/a.jpg?w=800&amp;q=55" />');
  assert.ok(got[0].includes('&q=55') && !got[0].includes('&amp;'), got[0]);
});

t('honours the per-source limit', () => {
  const many = Array.from({ length: 12 }, (_, i) => `<img src="https://x.test/p${i}.jpg">`).join('');
  assert.strictEqual(one(many).length, 8);
  assert.strictEqual(one(many, { limit: 2 }).length, 2);
});

t('non-image and non-http urls never survive', () => {
  assert.deepStrictEqual(one('<img src="https://x.test/page.html"><img src="data:image/png;base64,AAAA">'), []);
});

t('malformed markup does not throw', () => {
  assert.doesNotThrow(() => one('<img src=<<<>> <media:content url= > <img'));
});

t('empty input is empty output, not a crash', () => {
  assert.deepStrictEqual(one(''), []);
  assert.deepStrictEqual(extractImages(null, BASE), []);
});

console.log('\ndeclared image containers — the vimeo regression:');

t('recovers extensionless 960px thumbnails from a real vimeo item', () => {
  const got = one(REAL.vimeoItem);
  assert.strictEqual(got.length, 1, `got ${got.length}: ${got.join(' | ')}`);
  assert.ok(got[0].includes('i.vimeocdn.com/video/'), got[0]);
  assert.ok(!/\.(jpe?g|png|webp|gif)/i.test(got[0]), 'fixture should have no extension at all');
});

t('does not leak the player or video url from the same item', () => {
  const got = one(REAL.vimeoItem);
  assert.strictEqual(got.filter(u => /player\.vimeo|\.mp4/.test(u)).length, 0);
});

t('still rejects extensionless channel branding', () => {
  assert.deepStrictEqual(one(REAL.vimeoBranding), []);
});

t('a whole vimeo feed yields one image per item', () => {
  const feed = [REAL.vimeoBranding, REAL.vimeoItem,
                REAL.vimeoItem.replace(/2177134176/g, '2169341475')].join('');
  assert.strictEqual(one(feed).length, 2);
});

t('media:content declaring video is dropped even when the url looks like an image', () => {
  assert.deepStrictEqual(one('<media:content medium="video" url="https://x.test/frame.jpg"/>'), []);
  assert.deepStrictEqual(one('<enclosure type="video/mp4" url="https://x.test/a.jpg"/>'), []);
  assert.deepStrictEqual(one('<enclosure type="audio/mpeg" url="https://x.test/a.jpg"/>'), []);
});

t('an image type or medium is trusted without an extension', () => {
  assert.strictEqual(one('<media:content medium="image" url="https://x.test/plate?id=9"/>').length, 1);
  assert.strictEqual(one('<enclosure type="image/jpeg" url="https://x.test/plate?id=9"/>').length, 1);
  assert.strictEqual(one('<meta property="og:image" content="https://x.test/plate?id=9">').length, 1);
});

t('an undeclared container still has to prove it with an extension', () => {
  assert.deepStrictEqual(one('<media:content url="https://x.test/mystery?id=9"/>'), []);
  assert.strictEqual(one('<media:content url="https://x.test/real.jpg"/>').length, 1);
});

t('trust does NOT extend to img tags, where the beacons live', () => {
  assert.deepStrictEqual(one(REAL.mediumBeacon), [], 'beacon regression');
  assert.deepStrictEqual(one('<img src="https://x.test/track?ev=1">'), []);
});

t('declared images are still size-filtered and furniture-filtered', () => {
  assert.deepStrictEqual(one('<media:thumbnail width="90" url="https://x.test/small"/>'), []);
  assert.deepStrictEqual(one('<media:thumbnail width="900" url="https://x.test/site-logo"/>'), []);
});

console.log('\nimage allocation:');

t('one productive source is not throttled when the others are empty', () => {
  const out = collectImages([
    { url: 'https://thisiscolossal.com/feed/', images: Array.from({ length: 9 }, (_, i) => `https://c.test/${i}.jpg`) },
    { url: 'https://vimeo.com/f', images: [] },
  ]);
  assert.strictEqual(out.length, 9, `a lone source should supply the block, got ${out.length}`);
});

t('but many sources still share the block round-robin', () => {
  const out = collectImages([
    { url: 'https://a.test/f', images: ['https://a.test/1.jpg', 'https://a.test/2.jpg', 'https://a.test/3.jpg'] },
    { url: 'https://b.test/f', images: ['https://b.test/1.jpg', 'https://b.test/2.jpg'] },
  ]);
  assert.deepStrictEqual(out.map(o => o.from), ['a.test', 'b.test', 'a.test', 'b.test', 'a.test'],
    'sources should interleave, not be taken in blocks');
});

console.log('\nharvest helpers:');
t('declaredWidth reads attr, query and filename dimensions', () => {
  assert.strictEqual(declaredWidth('https://x.test/a.jpg', '460'), 460);
  assert.strictEqual(declaredWidth('https://x.test/a.jpg?w=800'), 800);
  assert.strictEqual(declaredWidth('https://x.test/a-1024x768.jpg'), 1024);
  assert.strictEqual(declaredWidth('https://x.test/a.jpg'), null);
});
t('imageIdentity collapses query and size suffix', () => {
  assert.strictEqual(imageIdentity('https://x.test/a-1024x768.jpg?w=460'), 'https://x.test/a.jpg');
});
t('decodeEntities handles named and numeric forms', () => {
  assert.strictEqual(decodeEntities('a&amp;b&lt;c&#39;d&#x27;e'), "a&b<c'd'e");
});
t('collectImages carries provenance and dedupes across sources', () => {
  const out = collectImages([
    { url: 'https://thisiscolossal.com/feed/', images: ['https://a.test/1.jpg', 'https://a.test/2.jpg'] },
    { url: 'https://www.tcj.com/feed/', images: ['https://a.test/1.jpg', 'https://b.test/3.jpg'] },
  ]);
  assert.strictEqual(out.length, 3, 'duplicate not collapsed');
  assert.strictEqual(out[0].from, 'thisiscolossal.com');
  assert.strictEqual(out[2].from, 'tcj.com');
});
t('collectImages respects the total cap', () => {
  const sources = Array.from({ length: 6 }, (_, s) => ({
    url: `https://s${s}.test/feed`, images: Array.from({ length: 4 }, (_, i) => `https://s${s}.test/${i}.jpg`),
  }));
  assert.strictEqual(collectImages(sources).length, 12);
});
t('a source with no images contributes nothing', () => {
  assert.deepStrictEqual(collectImages([{ url: 'https://x.test/f' }]), []);
});

console.log('\ndrawing measurement — against yam\'s real Study 008:');
const STUDY = 'workspace/site/studies/2026-08-04-pre-panel-democratic-field-notebook-study-008.svg';
const svg = readFileSync(new URL(`../${STUDY}`, import.meta.url), 'utf8');
const m = measureSvg(svg);

t('counts every drawable element', () => {
  assert.strictEqual(m.elements, 32, `got ${m.elements}: ${JSON.stringify(m.byTag)}`);
  assert.strictEqual(m.labels, 1, 'the caption should be counted as a label, not a mark');
});
t('reports the real stroke-width span', () => {
  assert.deepStrictEqual(m.strokeWidths, [0.6, 1.8, 2, 2.2, 2.5, 2.8]);
  assert.strictEqual(m.strokeWidthRange, '0.6–2.8');
  assert.strictEqual(m.strokeWidthRatio, 4.67);
});
t('finds zero solid blacks in a study whose stated register is committed ink', () => {
  assert.strictEqual(m.filledElements, 0, `expected an all-outline drawing, got ${m.filledElements} filled`);
  assert.strictEqual(m.solidBlackFills, 0);
});
t('summary is one legible line', () => {
  const s = summariseMeasurements(m);
  assert.ok(s.includes('32 elements') && s.includes('0.6–2.8') && s.includes('0 solid black'), s);
});
t("a caption's grey fill is not counted as a filled mark", () => {
  const withLabel = `<svg><path fill='none' stroke-width='2'/><text fill='#888'>caption</text></svg>`;
  const lm = measureSvg(withLabel);
  assert.strictEqual(lm.filledElements, 0);
  assert.strictEqual(lm.elements, 1);
  assert.strictEqual(lm.labels, 1);
});
t('detects blacks and weight range when they ARE present', () => {
  const inked = `<svg viewBox="0 0 10 10">
    <path d="M0 0" fill="#000" stroke-width="12"/>
    <rect fill="black" style="stroke-width:0.5"/>
    <line fill="none" stroke-width="3"/></svg>`;
  const im = measureSvg(inked);
  assert.strictEqual(im.solidBlackFills, 2);
  assert.strictEqual(im.filledElements, 2);
  assert.strictEqual(im.strokeWidthRatio, 24);
});
t('fill-rule is not mistaken for a fill', () => {
  assert.strictEqual(measureSvg('<svg><path fill-rule="evenodd" fill="none"/></svg>').filledElements, 0);
});
t('an empty document measures as empty, not as an error', () => {
  const em = measureSvg('<svg viewBox="0 0 1 1"></svg>');
  assert.strictEqual(em.elements, 0);
  assert.strictEqual(em.strokeWidthRange, 'none declared');
  assert.strictEqual(em.strokeWidthRatio, null);
});

console.log('\nown-work routing:');
t('recognises yam.garden urls, with or without www', () => {
  assert.ok(isOwnWork('https://yam.garden/studies/x.png'));
  assert.ok(isOwnWork('https://www.yam.garden/studies/x.png'));
});
t('does not claim other hosts, including lookalikes', () => {
  assert.ok(!isOwnWork('https://commons.wikimedia.org/wiki/Special:FilePath/x.jpg'));
  assert.ok(!isOwnWork('https://notyam.garden/x.png'));
  assert.ok(!isOwnWork('https://evil.test/?u=https://yam.garden/x.png'));
  assert.ok(!isOwnWork(null));
});
t('recovers a readable title from a real published study url', () => {
  assert.strictEqual(
    titleFromStudyUrl('https://yam.garden/studies/2026-08-04-pre-panel-democratic-field-notebook-study-008.png'),
    'pre panel democratic field notebook study 008');
});
t('title survives query strings and returns null on junk', () => {
  assert.strictEqual(titleFromStudyUrl('https://yam.garden/studies/2026-08-04-x.svg?v=2'), 'x');
  assert.strictEqual(titleFromStudyUrl(''), null);
});

console.log('\ndiet, measured:');
t('aggregates per host with counts and averages', () => {
  const out = formatDietStats([
    { url: 'https://news.ycombinator.com/', interest_score: 30 },
    { url: 'https://news.ycombinator.com/', interest_score: 20 },
    { url: 'https://www.tcj.com/a', interest_score: 90 },
  ]);
  const lines = out.split('\n');
  assert.strictEqual(lines[0], 'news.ycombinator.com: logged 2×, average interest 25, best 30');
  assert.strictEqual(lines[1], 'tcj.com: logged 1×, average interest 90, best 90');
});
t('unscored rows still count, average reads as unknown', () => {
  const out = formatDietStats([{ url: 'https://x.test/a', interest_score: null }]);
  assert.ok(out.includes('logged 1×') && out.includes('average interest —'), out);
});
t('malformed urls are skipped, not crashed on', () => {
  assert.doesNotThrow(() => formatDietStats([{ url: 'not a url', interest_score: 5 }]));
});
t('empty history says so', () => assert.ok(formatDietStats([]).includes('no crawl history')));

console.log('\ndiet legibility:');
const { formatDiet } = await import('../agent/recall.js');

t('shows the exact feed list, numbered', () => {
  const out = formatDiet({ feeds: ['https://a.test/f', 'https://b.test/f'] });
  assert.ok(out.startsWith('1. https://a.test/f'), out);
  assert.ok(out.includes('2. https://b.test/f'));
});
t('an unset diet says the seed list is in use', () => {
  assert.ok(formatDiet(null).includes('default seed list'));
  assert.ok(formatDiet({ feeds: [] }).includes('default seed list'));
});
t('a shrink is stated in full, with what was dropped', () => {
  const out = formatDiet({
    feeds: ['https://a.test/f'],
    retired: ['https://x.test/f'],
    last_change: { at: '2026-08-03T21:00:00Z', removed: ['https://b.test/f', 'https://c.test/f'], added: [], from: 3, to: 1 },
  });
  assert.ok(out.includes('dropped 2'), out);
  assert.ok(out.includes('3 sources became 1'), out);
  assert.ok(out.includes('https://b.test/f') && out.includes('https://c.test/f'));
});
t('retired feeds are offered back for restoration', () => {
  const out = formatDiet({ feeds: ['https://a.test/f'], retired: ['https://old.test/f'] });
  assert.ok(out.includes('could crawl again'), out);
  assert.ok(out.includes('https://old.test/f'));
});
t('a no-op change is not announced', () => {
  const out = formatDiet({ feeds: ['https://a.test/f'], last_change: { at: 'x', removed: [], added: [], from: 1, to: 1 } });
  assert.ok(!out.includes('last diet change'), out);
});

console.log('\ncrawl failures are returned, not swallowed:');
const http = await import('http');
const { crawlCycle } = await import('../agent/crawl.js');
const srv = http.createServer((q, r) => {
  if (q.url === '/good') { r.writeHead(200, { 'content-type': 'application/rss+xml' }); return r.end(REAL.vimeoItem); }
  if (q.url === '/empty') { r.writeHead(200); return r.end(''); }
  r.writeHead(404); r.end('nope');
});
await new Promise(r => srv.listen(54401, '127.0.0.1', r));
const B = 'http://127.0.0.1:54401';
const crawl = await crawlCycle([], [`${B}/good`, `${B}/missing`, `${B}/empty`]);
srv.close();

t('a live feed still yields content and images', () => {
  assert.strictEqual(crawl.sources.length, 1);
  assert.strictEqual(crawl.sources[0].images.length, 1);
  assert.ok(crawl.sources[0].content.length > 0);
});
t('a 404 is reported with its status, not dropped', () => {
  const f = crawl.failures.find(x => x.url.endsWith('/missing'));
  assert.ok(f, 'the 404 vanished silently');
  assert.strictEqual(f.error, 'HTTP 404');
});
t('a 200 with an empty body counts as a failure', () => {
  const f = crawl.failures.find(x => x.url.endsWith('/empty'));
  assert.ok(f, 'empty body was treated as a live source');
  assert.ok(/empty/.test(f.error), f.error);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
