import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BACKDROP_DEFAULT_SELECTION, moonAge, moonPhaseName, normalizeBackdropSelection, renderBackdrop, siderealDegrees,
} from '../src/backdrops.mjs';
import { startBrowserView } from '../src/browser-view.mjs';
import { loadProfile, PROFILE_FORMAT } from '../src/profile.mjs';

// A backdrop is off unless chosen, is moved by the clock and nothing else, is a
// self-contained drawing, and fails closed.

const sea = (changes = {}) => ({ ...BACKDROP_DEFAULT_SELECTION, ...changes });
const sky = (changes = {}) => ({ ...BACKDROP_DEFAULT_SELECTION, scene: 'sky', ...changes });
const draw = (selection, iso = '2030-01-02T12:00:00Z', timeZone = 'UTC') => renderBackdrop({ selection, now: new Date(iso), timeZone });
const svgOf = result => Buffer.from(result.image.split(',')[1], 'base64').toString('utf8');

test('no choice means no backdrop', () => {
  assert.equal(normalizeBackdropSelection(null), null);
  assert.deepEqual(draw(null), { enabled: false, image: null, meta: null });
});

test('a saved choice is closed', () => {
  for (const bad of [sea({ scene: 'lava' }), sea({ seed: -1 }), sea({ seed: 1.5 }), sea({ strength: 'loud' }), sea({ extra: 1 }), 'sea', []])
    assert.throws(() => normalizeBackdropSelection(bad), TypeError, JSON.stringify(bad));
  const { strength: _strength, ...missing } = sea();
  assert.throws(() => normalizeBackdropSelection(missing), /needs exactly/);
});

test('both scenes are self-contained greyscale drawings', () => {
  for (const selection of [sea(), sky()]) {
    const svg = svgOf(draw(selection));
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.doesNotMatch(svg, /<(script|image|foreignObject|a)\b|\son\w+=|href=|url\((?!#)/i);
    for (const colour of svg.match(/#[0-9a-f]{3,6}\b/gi) || []) assert.ok(/^#fff$/i.test(colour), `only white ink, coloured by the room's blend (${colour})`);
  }
});

test('same seed and moment draw the same; the seed changes the place', () => {
  assert.equal(draw(sea()).image, draw(sea()).image);
  assert.notEqual(draw(sea({ seed: 7 })).image, draw(sea()).image);
  assert.equal(draw(sky()).image, draw(sky()).image);
});

test('the sea follows the sun: bright at noon, dim at night, and it moves', () => {
  const noon = draw(sea(), '2030-01-02T12:00:00Z'), night = draw(sea(), '2030-01-02T01:00:00Z');
  assert.equal(noon.meta.daylight, 1);
  assert.equal(night.meta.daylight, 0);
  assert.notEqual(draw(sea(), '2030-01-02T12:05:00Z').image, noon.image, 'five minutes later the kelp and bubbles have moved');
  assert.equal(draw(sea(), '2030-01-02T12:00:00Z', 'Asia/Tokyo').meta.daylight, 0, 'noon in UTC is night in Tokyo');
});

test('the moon phase is the real one', () => {
  assert.equal(moonPhaseName(moonAge(new Date('2000-01-06T18:14:00Z'))), 'new moon');
  assert.equal(moonPhaseName(moonAge(new Date('2000-01-21T04:44:00Z'))), 'full moon', 'the total lunar eclipse of 21 January 2000');
  assert.equal(moonPhaseName(moonAge(new Date('2024-04-08T18:21:00Z'))), 'new moon', 'the total solar eclipse of 8 April 2024');
  assert.equal(draw(sky(), '2024-04-08T18:21:00Z').meta.moonPhase, 'new moon');
});

test('the sky turns once a sidereal day, not once a solar day', () => {
  const start = new Date('2030-01-02T00:00:00Z');
  const solarDay = siderealDegrees(new Date(start.getTime() + 86400000)) - siderealDegrees(start);
  assert.ok(Math.abs(((solarDay + 360) % 360) - 0.9856) < 0.001, 'a solar day later the sky has gained about one degree');
  assert.notEqual(draw(sky(), '2030-01-02T00:00:00Z').meta.skyTurn, draw(sky(), '2030-01-02T06:00:00Z').meta.skyTurn);
});

// ---- in the room ----

async function room(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-backdrop-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'agent-home');
  await fs.mkdir(path.join(home, 'roots'), { recursive: true });
  await fs.writeFile(path.join(home, 'profile.json'), JSON.stringify({ format: PROFILE_FORMAT, roots: [{ id: 'identity', path: 'roots/identity.md', placement: 'system' }, { id: 'voice', path: 'roots/voice.md', placement: 'user-tail' }] }));
  await fs.writeFile(path.join(home, 'roots', 'identity.md'), 'A synthetic test agent.');
  await fs.writeFile(path.join(home, 'roots', 'voice.md'), 'Plain.');
  const view = await startBrowserView({ profile: await loadProfile(home), clock: () => new Date('2030-01-02T12:00:00Z'), timeZone: 'UTC', ...options });
  t.after(() => view.close());
  const url = new URL(view.url);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const post = async (route, body) => {
    const response = await fetch(new URL(route, view.url), { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json', 'x-fieldwork-token': token }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const boot = async () => (await fetch(new URL('/api/bootstrap', view.url), { headers: { 'x-fieldwork-token': token } })).json();
  return { post, boot };
}

test('a stock room has no backdrop; choosing one is a revisioned change; null removes it', async t => {
  const { post, boot } = await room(t);
  const first = await boot();
  assert.equal(first.appearance.settings.backdrop, null);
  assert.deepEqual(first.backdrop.unchosen, BACKDROP_DEFAULT_SELECTION);
  assert.equal((await post('/api/backdrop/render', {})).value.backdrop.enabled, false);
  const on = await post('/api/appearance', { expectedRevision: 0, changes: { backdrop: sky({ seed: 9 }) } });
  assert.equal(on.status, 200);
  assert.equal(on.value.appearance.settings.backdrop.scene, 'sky');
  const drawn = (await post('/api/backdrop/render', {})).value.backdrop;
  assert.match(drawn.image, /^data:image\/svg\+xml;base64,/);
  assert.equal(drawn.meta.scene, 'sky');
  assert.equal((await post('/api/appearance', { expectedRevision: 1, changes: { backdrop: sea({ scene: 'lava' }) } })).status, 400);
  const off = await post('/api/appearance', { expectedRevision: 1, changes: { backdrop: null } });
  assert.equal(off.value.appearance.settings.backdrop, null);
  assert.equal((await post('/api/backdrop/render', { scene: 'sky' })).status, 400, 'the drawing route takes no input');
});

test('a damaged saved backdrop switches off alone; the garden and palette stay', async t => {
  const garden = { mode: 'form', seed: 1, form: 'capitule', manner: 'lavis', palette: 'iron-gall', reading: 'room', fullness: { source: 'neutral', value: 0 } };
  const { boot } = await room(t, { appearanceState: { revision: 2, settings: { palette: 'amber', marginalia: garden, backdrop: { scene: 'lava' } } } });
  const opened = await boot();
  assert.equal(opened.appearance.settings.backdrop, null);
  assert.equal(opened.appearance.settings.marginalia.form, 'capitule');
  assert.equal(opened.appearance.settings.palette, 'amber');
  assert.match(opened.startupNotice.message, /saved backdrop could not be read/);
});

test('the page shows the backdrop as a picture and never inserts markup', async () => {
  const app = await fs.readFile(new URL('../browser/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../browser/index.html', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../browser/styles.css', import.meta.url), 'utf8');
  const code = app.slice(app.indexOf('const backdrop = {'), app.indexOf('function hideGarden('));
  assert.ok(code.length > 200);
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|style\.setProperty/);
  assert.match(code, /backdrop\.image\.src = image/);
  assert.match(code, /response\?\.backdrop\?\.meta\?\.error/);
  assert.match(code, /!backdrop\.failed && state\.bootstrap\?\.appearance\?\.settings\?\.backdrop/);
  for (const id of ['room-backdrop', 'room-backdrop-image', 'backdrop-enabled', 'backdrop-controls', 'backdrop-scene', 'backdrop-seed', 'backdrop-strength'])
    assert.equal(html.split(`id="${id}"`).length, 2, `#${id} exists exactly once`);
  assert.match(css, /\.room-backdrop \{[^}]*mix-blend-mode: luminosity;/);
  assert.match(css, /\.conversation-panel\.decorated \.message-content \{ background: color-mix/);
});
