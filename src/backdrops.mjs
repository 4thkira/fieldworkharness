// Room backdrops: an underwater scene or a night sky behind the conversation.
//
// Off unless chosen in Settings → Appearance → Backdrop. Like the margin garden
// (marginalia.mjs), a backdrop is drawn here on this computer from a seed and
// the clock, checked, and handed to the page as a data: image; the page shows it
// behind slightly see-through messages and lets the room's palette colour it.
// Nothing about the conversation goes in: time moves the scene, not activity.
//
//   sea  light shafts that lean with the sun and fade at night, caustic shimmer,
//        kelp that sways, rising bubbles, drifting marine snow, rippled sand
//   sky  nebula haze, a starfield that turns once a sidereal day, today's real
//        moon phase, and now and then a shooting star
//
// Drawn in greys on transparency: the room's luminosity blend supplies the hue.

import { checkGardenSvg } from './marginalia.mjs';

export const BACKDROP_SCENES = Object.freeze(['sea', 'sky']);
export const BACKDROP_STRENGTHS = Object.freeze(['faint', 'soft', 'clear']);
export const BACKDROP_LIMITS = Object.freeze({ seed: 0x7fffffff });
const W = 1200, H = 800;
const FIELDS = ['scene', 'seed', 'strength'];

export const BACKDROP_DEFAULT_SELECTION = Object.freeze({ scene: 'sea', seed: 2026, strength: 'soft' });
export const BACKDROP_OPTIONS = Object.freeze({
  scenes: Object.freeze([Object.freeze({ id: 'sea', label: 'Underwater' }), Object.freeze({ id: 'sky', label: 'Night sky' })]),
  strengths: Object.freeze([Object.freeze({ id: 'faint', label: 'Faint' }), Object.freeze({ id: 'soft', label: 'Soft' }), Object.freeze({ id: 'clear', label: 'Clear' })]),
});

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Validate one saved choice. null (or absent) means no backdrop. */
export function normalizeBackdropSelection(value) {
  if (value === null || value === undefined) return null;
  if (!plain(value)) throw new TypeError('backdrop must be null or an object');
  const keys = Object.keys(value).sort();
  if (keys.join() !== [...FIELDS].sort().join()) throw new TypeError(`backdrop needs exactly ${FIELDS.join(', ')}`);
  if (!BACKDROP_SCENES.includes(value.scene)) throw new TypeError(`backdrop scene is ${BACKDROP_SCENES.join(' or ')}`);
  if (!Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > BACKDROP_LIMITS.seed) throw new TypeError(`backdrop seed must be a whole number from 0 to ${BACKDROP_LIMITS.seed}`);
  if (!BACKDROP_STRENGTHS.includes(value.strength)) throw new TypeError(`backdrop strength is ${BACKDROP_STRENGTHS.join(', ')}`);
  return Object.freeze({ scene: value.scene, seed: value.seed, strength: value.strength });
}

// ---- small tools --------------------------------------------------------------
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const n = value => (Math.round(value * 10) / 10).toString();
const frac = value => value - Math.floor(value);
const TAU = Math.PI * 2;

export function dayFraction(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return Math.min(1, Math.max(0, (parts.hour * 3600 + parts.minute * 60 + parts.second) / 86400));
}
// 0 before dawn and after dusk, 1 at noon: how much daylight reaches the water.
const daylight = t => Math.max(0, Math.sin(TAU * (t - 0.25)));
const julianDay = now => now.getTime() / 86400000 + 2440587.5;

/** Moon age as a fraction of the synodic month: 0 new, 0.5 full. */
export function moonAge(now) {
  return frac((julianDay(now) - 2451550.1) / 29.530588853);
}
export function moonPhaseName(age) {
  const names = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
  return names[Math.floor(frac(age + 1 / 16) * 8)];
}
// Greenwich mean sidereal angle in degrees: the sky turns once per sidereal day.
export function siderealDegrees(now) {
  return frac((280.46061837 + 360.98564736629 * (julianDay(now) - 2451545)) / 360) * 360;
}

// ---- the sea --------------------------------------------------------------------
function drawSea(seed, now, timeZone) {
  const random = rng(seed), t = dayFraction(now, timeZone), light = daylight(t);
  const out = [];
  out.push('<defs>',
    `<linearGradient id="bd-depth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${n(0.05 + 0.12 * light)}"/><stop offset="0.7" stop-color="#fff" stop-opacity="0.02"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
    '<linearGradient id="bd-shaft" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>',
    '</defs>');
  out.push(`<rect width="${W}" height="${H}" fill="url(#bd-depth)"/>`);

  // Shafts lean east in the morning and west in the afternoon; by night only a
  // faint pair of moonlit ones remain.
  const lean = (t - 0.5) * 520, shafts = light > 0 ? 6 : 2, shaftOpacity = light > 0 ? 0.03 + 0.09 * light : 0.025;
  for (let i = 0; i < shafts; i++) {
    const x = 80 + random() * (W - 160), width = 30 + random() * 70, depth = H * (0.55 + random() * 0.4);
    out.push(`<path d="M${n(x)} 0L${n(x + width)} 0L${n(x + width * 1.8 + lean)} ${n(depth)}L${n(x + lean)} ${n(depth)}Z" fill="url(#bd-shaft)" opacity="${n(shaftOpacity * 100) / 100}"/>`);
  }

  // Caustic shimmer near the surface: wavy lines whose phase moves with the clock.
  const shimmer = t * TAU * 96;
  for (let row = 0; row < 7; row++) {
    const y = 18 + row * 22 + random() * 8, phase = random() * TAU;
    let d = `M0 ${n(y)}`;
    for (let x = 40; x <= W; x += 40) d += `L${x} ${n(y + Math.sin(x / 70 + phase + shimmer) * 5)}`;
    out.push(`<path d="${d}" fill="none" stroke="#fff" stroke-width="1" opacity="${n((0.05 + 0.12 * light) * 100) / 100}"/>`);
  }

  // Sand ripples along the bottom.
  for (let row = 0; row < 5; row++) {
    const y = H - 8 - row * 11, phase = random() * TAU;
    let d = `M0 ${n(y)}`;
    for (let x = 30; x <= W; x += 30) d += `L${x} ${n(y + Math.sin(x / 55 + phase) * 3)}`;
    out.push(`<path d="${d}" fill="none" stroke="#fff" stroke-width="1" opacity="0.12"/>`);
  }

  // Kelp: stalks rooted in the sand, swaying a little more the higher they reach.
  const sway = t * TAU * 72;
  for (let k = 0, stalks = 7 + Math.floor(random() * 4); k < stalks; k++) {
    const root = 30 + random() * (W - 60), height = H * (0.3 + random() * 0.45), phase = random() * TAU, steps = 14;
    const points = [];
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      points.push([root + Math.sin(phase + sway + f * 3) * 26 * f, H - 4 - height * f]);
    }
    out.push(`<path d="M${points.map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.32"/>`);
    for (let s = 2; s < steps; s += 2) {
      const [x, y] = points[s], side = s % 4 === 0 ? 1 : -1, angle = side * (35 + random() * 20) + Math.sin(phase + sway + s) * 10;
      out.push(`<ellipse cx="${n(x + side * 9)}" cy="${n(y)}" rx="12" ry="3.5" transform="rotate(${n(angle)} ${n(x + side * 9)} ${n(y)})" fill="#fff" opacity="0.18"/>`);
    }
  }

  // Bubbles rise from a few vents, wobbling as they go.
  const rise = t * 288;
  for (let v = 0, vents = 3; v < vents; v++) {
    const base = 60 + random() * (W - 120), offset = random();
    for (let b = 0; b < 12; b++) {
      const f = frac(rise + offset + b / 12), y = H - 10 - f * (H - 30), x = base + Math.sin(f * 14 + b) * 9, r = 1.5 + (b % 4) * 0.9 + f * 2;
      out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="none" stroke="#fff" stroke-width="0.9" opacity="${n((0.45 - f * 0.25) * 100) / 100}"/>`);
    }
  }

  // Marine snow drifts slowly down.
  const drift = t * H * 24;
  for (let i = 0; i < 140; i++) {
    const x = random() * W, y = (random() * H + drift * (0.5 + random())) % H;
    out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(0.6 + random() * 1.1)}" fill="#fff" opacity="${n((0.12 + random() * 0.25) * 100) / 100}"/>`);
  }
  return { body: out.join(''), meta: { daylight: Math.round(light * 100) / 100 } };
}

// ---- the sky ----------------------------------------------------------------------
function moonPath(cx, cy, r, age) {
  const k = Math.cos(TAU * age), rx = Math.abs(k) * r, waxing = age < 0.5;
  const outer = waxing ? 1 : 0, inner = waxing ? (k > 0 ? 0 : 1) : (k > 0 ? 1 : 0);
  return `M${n(cx)} ${n(cy - r)}A${n(r)} ${n(r)} 0 0 ${outer} ${n(cx)} ${n(cy + r)}A${n(rx)} ${n(r)} 0 0 ${inner} ${n(cx)} ${n(cy - r)}Z`;
}

function drawSky(seed, now) {
  const random = rng(seed), out = [];
  // The pole sits near the top right; reach is the farthest corner, so the disc
  // of stars always covers the whole view whichever way it has turned.
  const pole = [W * 0.78, H * 0.12], turn = -siderealDegrees(now), reach = Math.hypot(pole[0], H - pole[1]);
  out.push('<defs>');
  const hazes = 3;
  for (let i = 0; i < hazes; i++) out.push(`<radialGradient id="bd-haze-${i}"><stop offset="0" stop-color="#fff" stop-opacity="${n((0.06 + random() * 0.05) * 100) / 100}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`);
  out.push('</defs>');
  for (let i = 0; i < hazes; i++) {
    const cx = random() * W, cy = random() * H, rx = 160 + random() * 260, ry = 90 + random() * 160, angle = random() * 180;
    out.push(`<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" transform="rotate(${n(angle)} ${n(cx)} ${n(cy)})" fill="url(#bd-haze-${i})"/>`);
  }

  // Stars sit on a disc around the pole and turn with sidereal time.
  const stars = [];
  for (let i = 0; i < 900; i++) {
    const angle = random() * TAU, distance = Math.sqrt(random()) * reach, size = random() ** 3;
    const x = pole[0] + Math.cos(angle) * distance, y = pole[1] + Math.sin(angle) * distance, r = 0.5 + size * 1.6;
    stars.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="#fff" opacity="${n((0.45 + size * 0.55) * 100) / 100}"/>`);
    if (size > 0.7) stars.push(`<path d="M${n(x - r * 4)} ${n(y)}H${n(x + r * 4)}M${n(x)} ${n(y - r * 4)}V${n(y + r * 4)}" stroke="#fff" stroke-width="0.6" opacity="0.4"/>`);
  }
  // A Milky Way band: a dense drift of faint points along one great sweep.
  const bandAngle = random() * TAU;
  for (let i = 0; i < 700; i++) {
    const along = (random() - 0.5) * reach * 1.6, across = (random() + random() + random() - 1.5) * 60;
    const x = pole[0] + Math.cos(bandAngle) * along - Math.sin(bandAngle) * across, y = pole[1] + Math.sin(bandAngle) * along + Math.cos(bandAngle) * across;
    stars.push(`<circle cx="${n(x)}" cy="${n(y)}" r="0.5" fill="#fff" opacity="${n((0.18 + random() * 0.25) * 100) / 100}"/>`);
  }
  out.push(`<g transform="rotate(${n(turn)} ${n(pole[0])} ${n(pole[1])})">${stars.join('')}</g>`);

  // Today's moon: earthshine on the whole disc, the lit part by its real phase.
  const age = moonAge(now), [mx, my, mr] = [W * 0.14, H * 0.2, 44];
  out.push(`<circle cx="${n(mx)}" cy="${n(my)}" r="${mr}" fill="#fff" opacity="0.07"/>`);
  out.push(`<path d="${moonPath(mx, my, mr, age)}" fill="#fff" opacity="0.82"/>`);

  // Now and then a shooting star: decided by the five-minute slot, so it is the
  // same on every refresh within that slot.
  const slot = Math.floor(now.getTime() / 300000), chance = rng((seed ^ slot) >>> 0);
  if (chance() < 0.2) {
    const x = 200 + chance() * (W - 400), y = 60 + chance() * (H * 0.4), length = 90 + chance() * 120;
    out.push(`<path d="M${n(x)} ${n(y)}L${n(x + length)} ${n(y + length * 0.35)}" stroke="#fff" stroke-width="1.4" stroke-linecap="round" opacity="0.6"/>`);
  }
  return { body: out.join(''), meta: { moonAge: Math.round(age * 1000) / 1000, moonPhase: moonPhaseName(age), skyTurn: Math.round(-turn * 10) / 10 } };
}

/** Draw the chosen backdrop for this moment. null selection → nothing drawn. */
export function renderBackdrop({ selection, now, timeZone, check = checkGardenSvg }) {
  const chosen = normalizeBackdropSelection(selection);
  if (chosen === null) return Object.freeze({ enabled: false, image: null, meta: null });
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('backdrop needs a valid time');
  const scene = chosen.scene === 'sea' ? drawSea(chosen.seed, now, timeZone) : drawSky(chosen.seed, now);
  const svg = check(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice">${scene.body}</svg>`);
  return Object.freeze({
    enabled: true,
    image: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    meta: Object.freeze({ scene: chosen.scene, seed: chosen.seed, strength: chosen.strength, time: dayFraction(now, timeZone), ...scene.meta }),
  });
}
