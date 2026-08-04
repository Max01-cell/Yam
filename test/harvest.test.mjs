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
  const many = Array.from({ length: 9 }, (_, i) => `<img src="https://x.test/p${i}.jpg">`).join('');
  assert.strictEqual(one(many).length, 4);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
