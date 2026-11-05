import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import {
  checkGardenSvg,
  MARGINALIA_DEFAULT_SELECTION,
  MARGINALIA_LIMITS,
  MARGINALIA_OPTIONS,
  normalizeMarginaliaSelection,
  renderMarginalia,
} from '../src/marginalia.mjs';
import { startBrowserView } from '../src/browser-view.mjs';
import { loadProfile, PROFILE_FORMAT } from '../src/profile.mjs';

// The margin garden is off unless chosen, grows with the time of day only, and
// never counts anything the person or the agent does.

const chosen = (changes = {}) => ({ ...MARGINALIA_DEFAULT_SELECTION, fullness: { ...MARGINALIA_DEFAULT_SELECTION.fullness }, ...changes });
const at = (iso) => new Date(iso);
const draw = (selection, now = at('2030-01-02T12:00:00Z'), extra = {}) => renderMarginalia({ selection, roomPalette: 'fieldwork', now, timeZone: 'UTC', ...extra });
const svgOf = result => Buffer.from(result.image.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');

async function regularTree(root, directory = root) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularTree(root, file));
    else if (entry.isFile()) files.push(path.relative(root, file).replaceAll('\\', '/'));
    else assert.fail(`vendored tree contains a non-regular entry: ${path.relative(root, file)}`);
  }
  return files;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function canonicalVendorBytes(bytes) {
  return Buffer.from(strictUtf8.decode(bytes).replaceAll('\r\n', '\n'), 'utf8');
}

test('vendor canonicalization changes only Git CRLF checkout conversion', () => {
  assert.deepEqual(canonicalVendorBytes(Buffer.from('one\r\ntwo\n', 'utf8')), Buffer.from('one\ntwo\n', 'utf8'));
  assert.deepEqual(
    canonicalVendorBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6e, 0x65])),
    Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6e, 0x65]),
  );
  assert.throws(() => canonicalVendorBytes(Buffer.from([0xc3, 0x28])), /encoded data/iu);
});

async function vendorTreeDigest(root, files) {
  const hash = createHash('sha256');
  hash.update('fieldwork-vendor-tree-v1\n');
  for (const relative of files) {
    const name = Buffer.from(relative, 'utf8');
    const bytes = canonicalVendorBytes(await fs.readFile(path.join(root, ...relative.split('/'))));
    hash.update(String(name.length));
    hash.update(':');
    hash.update(name);
    hash.update(':');
    hash.update(String(bytes.length));
    hash.update(':');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

test('the complete reviewed Églantine vendor tree is content-exact across Git line endings', async () => {
  const root = fileURLToPath(new URL('../vendor/eglantine-marginalia/', import.meta.url));
  const files = (await regularTree(root)).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  assert.equal(files.length, 35);
  const scripts = files.filter(file => file.endsWith('.js'));
  assert.equal(scripts.length, 32);
  for (const file of scripts) {
    const stat = await fs.stat(path.join(root, ...file.split('/')));
    assert.ok(stat.size > 0, `${file} is non-empty`);
  }
  assert.equal(
    await vendorTreeDigest(root, files),
    '43e75e92a2f65c1dac26892cc255b6ff636fa133ca98259fa5b6b79d220b0e0d',
  );
});

test('no choice means no garden', () => {
  assert.equal(normalizeMarginaliaSelection(null), null);
  assert.equal(normalizeMarginaliaSelection(undefined), null);
  assert.deepEqual(draw(null), { enabled: false, image: null, meta: null });
});

test('the offered choices match the library', () => {
  assert.equal(MARGINALIA_OPTIONS.forms.length, 13);
  assert.equal(MARGINALIA_OPTIONS.palettes.length, 8);
  assert.deepEqual(MARGINALIA_OPTIONS.manners.map(o => o.id), ['taille-douce', 'lavis']);
  assert.deepEqual(MARGINALIA_OPTIONS.readings.map(o => o.id), ['room', 'light', 'dark']);
  assert.deepEqual(MARGINALIA_OPTIONS.fullnessSources.map(o => o.id), ['neutral', 'manual']);
  assert.deepEqual(normalizeMarginaliaSelection(MARGINALIA_DEFAULT_SELECTION), MARGINALIA_DEFAULT_SELECTION);
});

test('a saved choice is closed: unknown fields, values and numbers are refused', () => {
  const bad = [
    chosen({ extra: 1 }),
    chosen({ mode: 'weather' }),
    chosen({ form: 'triffid' }),
    chosen({ manner: 'crayon' }),
    chosen({ palette: 'neon' }),
    chosen({ reading: 'dusk' }),
    chosen({ seed: 1.5 }), chosen({ seed: -1 }), chosen({ seed: MARGINALIA_LIMITS.seed + 1 }), chosen({ seed: '7' }),
    chosen({ fullness: { source: 'messages', value: 0 } }),
    chosen({ fullness: { source: 'manual', value: 1.2 } }),
    chosen({ fullness: { source: 'manual', value: Number.NaN } }),
    chosen({ fullness: { source: 'manual', value: 0.5, from: 'activity' } }),
    [],
    'garden',
  ];
  for (const value of bad) assert.throws(() => normalizeMarginaliaSelection(value), TypeError, JSON.stringify(value));
  const { seed: _seed, ...missing } = chosen();
  assert.throws(() => normalizeMarginaliaSelection(missing), /needs exactly/);
});

test('neutral fullness is zero, whatever was sent with it', () => {
  const kept = normalizeMarginaliaSelection(chosen({ fullness: { source: 'neutral', value: 0.9 } }));
  assert.deepEqual(kept.fullness, { source: 'neutral', value: 0 });
  assert.equal(normalizeMarginaliaSelection(chosen({ fullness: { source: 'manual', value: 0.4 } })).fullness.value, 0.4);
});

test('a chosen form is drawn locally as a self-contained picture', () => {
  const result = draw(chosen());
  assert.equal(result.enabled, true);
  assert.match(result.image, /^data:image\/svg\+xml;base64,/);
  const svg = svgOf(result);
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg, /<(script|image|foreignObject)\b|\son\w+=|href="(?!#)/i);
  assert.equal(result.meta.form, 'capitule');
  assert.equal(result.meta.guestIncluded, false);
  assert.equal(result.meta.time, 0.5);
});

test('copperplate and wash both pass the safety check for every form', () => {
  for (const form of MARGINALIA_OPTIONS.forms) {
    for (const manner of ['taille-douce', 'lavis']) {
      const result = draw(chosen({ form: form.id, manner }));
      assert.ok(result.image, `${form.id} in ${manner}`);
    }
  }
});

test('same choice, same moment, same drawing; only the clock grows it', () => {
  const noon = draw(chosen(), at('2030-01-02T12:00:00Z'));
  assert.equal(draw(chosen(), at('2030-01-02T12:00:00Z')).image, noon.image);
  const morning = draw(chosen(), at('2030-01-02T06:00:00Z'));
  assert.notEqual(morning.image, noon.image);
  assert.equal(morning.meta.time, 0.25);
  assert.deepEqual(morning.meta.fullness, noon.meta.fullness);
});

test('the time is read in the room\'s time zone', () => {
  const instant = at('2030-01-02T12:00:00Z');
  assert.equal(draw(chosen(), instant, { timeZone: 'America/New_York' }).meta.time, 7 / 24);
  assert.equal(draw(chosen(), instant, { timeZone: 'Asia/Tokyo' }).meta.time, 21 / 24);
});

test('a quiet day still flowers: fullness changes the detail, never whether it blooms', () => {
  const quiet = draw(chosen());
  const full = draw(chosen({ fullness: { source: 'manual', value: 1 } }));
  assert.ok(quiet.image && full.image);
  assert.notEqual(quiet.image, full.image);
  assert.ok(svgOf(quiet).length > 2000, 'a neutral garden at noon is a real drawing');
});

test('the calendar gives the day\'s plant, keeps the day before\'s on animal days, and says so on complementary days', () => {
  const plantDay = draw(chosen({ mode: 'calendar' }), at('2026-11-03T12:00:00Z'));
  assert.equal(plantDay.meta.dateline, '11 brumaire an CCXXXV');
  assert.equal(plantDay.meta.dayKind, 'plant');
  assert.equal(plantDay.meta.plantName, 'le salsifis');
  assert.equal(plantDay.meta.form, 'racine-tubercule');

  const animalDay = draw(chosen({ mode: 'calendar' }), at('2026-11-07T12:00:00Z'));
  assert.equal(animalDay.meta.dayKind, 'animal');
  assert.ok(animalDay.image, 'an animal day still has a garden');
  assert.notEqual(animalDay.meta.plantName, animalDay.meta.dayName);
  assert.equal(animalDay.meta.guestIncluded, false);
  assert.doesNotMatch(svgOf(animalDay), /<image\b/);

  const complementary = draw(chosen({ mode: 'calendar' }), at('2026-09-19T12:00:00Z'));
  assert.equal(complementary.enabled, true);
  assert.equal(complementary.image, null);
  assert.equal(complementary.meta.dayKind, 'complementary');
  assert.equal(complementary.meta.dateline, 'jour de la vertu, an CCXXXIV');
  assert.match(complementary.meta.note, /no plant/);
});

test('the calendar day is the room\'s day, not the computer\'s or UTC', () => {
  // 20:00 UTC on 2 November is already 3 November in Tokyo.
  const tokyo = draw(chosen({ mode: 'calendar' }), at('2026-11-02T20:00:00Z'), { timeZone: 'Asia/Tokyo' });
  assert.equal(tokyo.meta.date, '2026-11-03');
  assert.equal(tokyo.meta.dateline, '11 brumaire an CCXXXV');
  const honolulu = draw(chosen({ mode: 'calendar' }), at('2026-11-03T05:00:00Z'), { timeZone: 'Pacific/Honolulu' });
  assert.equal(honolulu.meta.date, '2026-11-02');
});

test('the heaviest garden measured still fits the room', () => {
  // ombelle in copperplate, seed 4, mid-afternoon, full: 757 KB, the largest of 2,496 measured.
  const heavy = draw(chosen({ form: 'ombelle-corymbe', manner: 'taille-douce', seed: 4, fullness: { source: 'manual', value: 1 } }), at('2030-01-02T14:00:00Z'));
  assert.ok(heavy.image);
  assert.ok(Buffer.byteLength(svgOf(heavy)) > 512 * 1024, 'a real case above the first proposed cap');
});

test('ink follows the room unless chosen', () => {
  assert.equal(draw(chosen()).meta.reading, 'dark', 'every Fieldwork palette is dark');
  assert.equal(draw(chosen({ reading: 'light' })).meta.reading, 'light');
});

test('a drawing with anything outside itself fails closed', () => {
  assert.equal(checkGardenSvg('<svg><use href="#a"/><g clip-path="url(#c)"/></svg>'), '<svg><use href="#a"/><g clip-path="url(#c)"/></svg>');
  for (const svg of [
    '<svg><script>x</script></svg>',
    '<svg><g onload="x"/></svg>',
    '<svg><image href="figure.png"/></svg>',
    '<svg><use href="https://example.invalid/a.svg#b"/></svg>',
    '<svg><g style="fill:url(https://example.invalid/x)"/></svg>',
    '<svg><foreignObject/></svg>',
    `<svg>${'x'.repeat(MARGINALIA_LIMITS.svgBytes)}</svg>`,
    'not svg',
  ]) assert.throws(() => checkGardenSvg(svg), Error, svg.slice(0, 40));
  assert.throws(() => draw(chosen(), undefined, { check: () => { throw new Error('refused'); } }), /refused/);
});

// ---- in the room ----

async function room(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-marginalia-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'agent-home');
  await fs.mkdir(path.join(home, 'roots'), { recursive: true });
  await fs.writeFile(path.join(home, 'profile.json'), JSON.stringify({ format: PROFILE_FORMAT, roots: [{ id: 'identity', path: 'roots/identity.md', placement: 'system' }, { id: 'voice', path: 'roots/voice.md', placement: 'user-tail' }] }));
  await fs.writeFile(path.join(home, 'roots', 'voice.md'), 'Plain.');
  await fs.writeFile(path.join(home, 'roots', 'identity.md'), 'A synthetic test agent.');
  const view = await startBrowserView({ profile: await loadProfile(home), clock: () => new Date('2030-01-02T12:00:00Z'), timeZone: 'UTC', ...options });
  t.after(() => view.close());
  const url = new URL(view.url);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const post = async (route, body, headers = {}) => {
    const response = await fetch(new URL(route, view.url), { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json', 'x-fieldwork-token': token, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const boot = async () => (await fetch(new URL('/api/bootstrap', view.url), { headers: { 'x-fieldwork-token': token } })).json();
  return { view, post, boot, url };
}

test('a stock room has no garden and draws none', async t => {
  const { post, boot } = await room(t);
  const first = await boot();
  assert.equal(first.appearance.settings.marginalia, null);
  assert.equal(first.marginalia.options.forms.length, 13);
  assert.deepEqual(first.marginalia.unchosen, MARGINALIA_DEFAULT_SELECTION);
  const drawn = await post('/api/marginalia/render', {});
  assert.equal(drawn.status, 200);
  assert.deepEqual(drawn.value.marginalia, { enabled: false, image: null, meta: null });
});

test('choosing a garden is a revisioned appearance change that can be undone with null', async t => {
  const saved = [];
  const { post, boot } = await room(t, { onAppearanceChange: async receipt => { saved.push(receipt); } });
  const on = await post('/api/appearance', { expectedRevision: 0, changes: { marginalia: chosen({ seed: 7 }) } });
  assert.equal(on.status, 200);
  assert.equal(on.value.appearance.revision, 1);
  assert.equal(on.value.appearance.settings.marginalia.seed, 7);
  assert.equal(saved[0].settings.marginalia.seed, 7, 'the host is handed the garden to keep');
  assert.equal((await boot()).appearance.settings.marginalia.seed, 7);
  const drawn = await post('/api/marginalia/render', {});
  assert.match(drawn.value.marginalia.image, /^data:image\/svg\+xml;base64,/);
  assert.equal(drawn.value.marginalia.meta.time, 0.5);

  const stale = await post('/api/appearance', { expectedRevision: 0, changes: { marginalia: null } });
  assert.equal(stale.status, 409);
  const off = await post('/api/appearance', { expectedRevision: 1, changes: { marginalia: null } });
  assert.equal(off.value.appearance.revision, 2);
  assert.equal(off.value.appearance.settings.marginalia, null);
  assert.equal((await post('/api/marginalia/render', {})).value.marginalia.enabled, false);
});

test('a bad garden is refused without changing anything', async t => {
  const { post, boot } = await room(t);
  for (const marginalia of [chosen({ extra: true }), chosen({ seed: -3 }), chosen({ fullness: { source: 'words', value: 1 } }), 'roses']) {
    const refused = await post('/api/appearance', { expectedRevision: 0, changes: { marginalia } });
    assert.equal(refused.status, 400, JSON.stringify(marginalia));
  }
  const after = await boot();
  assert.equal(after.appearance.revision, 0);
  assert.equal(after.appearance.settings.marginalia, null);
});

test('the drawing route takes no input, needs the token, and only answers POST', async t => {
  const { post, view } = await room(t);
  assert.equal((await post('/api/marginalia/render', { selection: chosen() })).status, 400);
  assert.equal((await post('/api/marginalia/render', {}, { 'x-fieldwork-token': 'wrong' })).status, 403);
  assert.equal((await fetch(new URL('/api/marginalia/render', view.url))).status, 405);
});

test('a damaged saved garden switches off without hiding a supplied lifecycle notice', async t => {
  const { boot } = await room(t, {
    appearanceState: { revision: 3, settings: { palette: 'amber', marginalia: { mode: 'weather' } } },
    startupNotice: { kind: 'success', message: 'Restored the synthetic agent state.' },
  });
  const opened = await boot();
  assert.equal(opened.appearance.revision, 3);
  assert.equal(opened.appearance.settings.palette, 'amber', 'the rest of the appearance is kept');
  assert.equal(opened.appearance.settings.marginalia, null);
  assert.equal(opened.startupNotice.kind, 'error');
  assert.match(opened.startupNotice.message, /margin garden could not be read/);
  assert.match(opened.startupNotice.message, /Restored the synthetic agent state/);
});

test('older saved appearances without a garden open unchanged', async t => {
  const { boot } = await room(t, { appearanceState: { revision: 2, settings: { palette: 'cyanotype' } } });
  const opened = await boot();
  assert.equal(opened.appearance.settings.palette, 'cyanotype');
  assert.equal(opened.appearance.settings.density, 'relaxed');
  assert.equal(opened.appearance.settings.textSize, 'standard');
  assert.equal(opened.appearance.settings.texture, 'plain');
  assert.equal(opened.appearance.settings.marginalia, null);
  assert.equal(opened.startupNotice, null);
});

test('the page shows the garden as a picture and never inserts its markup', async () => {
  const app = await fs.readFile(new URL('../browser/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../browser/index.html', import.meta.url), 'utf8');
  const start = app.indexOf('const garden = {');
  const end = app.indexOf('function renderAppearance(');
  const gardenCode = app.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(gardenCode, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(gardenCode, /garden\.image\.src = image/);
  assert.match(gardenCode, /response\?\.marginalia\?\.meta\?\.error/);
  assert.match(gardenCode, /gardenNarrow = window\.matchMedia\('\(max-width: 900px\)'\)/);
  assert.match(gardenCode, /!garden\.failed && !gardenNarrow\.matches/);
  for (const id of ['room-marginalia', 'room-marginalia-image', 'marginalia-enabled', 'marginalia-controls', 'marginalia-mode', 'marginalia-form', 'marginalia-form-row',
    'marginalia-seed', 'marginalia-manner', 'marginalia-palette', 'marginalia-reading', 'marginalia-fullness-source', 'marginalia-fullness-row',
    'marginalia-fullness', 'marginalia-fullness-output', 'marginalia-calendar-note', 'appearance-decoration-status']) {
    assert.equal(html.split(`id="${id}"`).length, 2, `#${id} exists exactly once`);
  }
  assert.match(html, /<aside class="room-marginalia" id="room-marginalia" hidden aria-hidden="true"><img id="room-marginalia-image" alt=""><\/aside>/);
  assert.match(html, /id="appearance-decoration-status" role="status" aria-live="polite" aria-atomic="true" hidden/);
  assert.equal((html.match(/<details class="appearance-advanced">/g) || []).length, 2);
  assert.doesNotMatch(html, /<details class="appearance-advanced" open/);
  assert.match(html, /Églantine Marginalia<\/a> by cadaeix, MIT/);
  assert.doesNotMatch(html, /The time of day grows stems and flowers/);
});
