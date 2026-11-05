// Églantine marginalia: an optional garden drawn in the room's margin.
//
// Off unless someone chooses it in Settings → Appearance. A chosen garden
// grows with the time of day only: stems in the morning, flowers by noon,
// seed by night. "Fullness" adds leaves, mycelium or crystals, and it is
// either neutral (always 0) or a value the person set by hand. Nothing here
// counts messages, words or tasks, so a quiet day flowers exactly as fully as
// a busy one.
//
// The drawing comes from Églantine Marginalia by cadaeix (MIT), vendored as
// built JavaScript in vendor/eglantine-marginalia/ (see docs/third-party.md).
// It runs on this computer and makes no network requests. The room turns the
// SVG into an image here, checks it, and hands the page a data: URL, so the
// page never inserts SVG markup.
//
// Integration designed by an agent who lives in Fieldwork, 2026-11-03.

import {
  FORM_MODULES,
  PALETTES,
  growGarden,
  paletteInks,
  renderGarden,
  withInks,
} from '../vendor/eglantine-marginalia/index.js';
import { calendarDay, localDate } from '../vendor/eglantine-marginalia/calendar/index.js';

const FORM_IDS = Object.freeze([...FORM_MODULES.keys()]);
const FORM_SET = new Set(FORM_IDS);
const PALETTE_IDS = Object.freeze(PALETTES.map(({ id }) => id));
const PALETTE_SET = new Set(PALETTE_IDS);
const MODE_SET = new Set(['form', 'calendar']);
const MANNER_SET = new Set(['taille-douce', 'lavis']);
const READING_SET = new Set(['room', 'light', 'dark']);
const FULLNESS_SOURCE_SET = new Set(['neutral', 'manual']);
const FIELDS = Object.freeze(['form', 'fullness', 'manner', 'mode', 'palette', 'reading', 'seed']);
// Measured 2026-11-03: the largest garden over 13 forms × 2 manners × 12 seeds
// at full bloom was 757 KB (ombelle, copperplate). Base64 of the cap stays
// under the room's 2 MB response limit.
export const MARGINALIA_LIMITS = Object.freeze({ svgBytes: 1280 * 1024, seed: 0x7fffffff });

// Room palettes that are light enough for daylight ink. Every Fieldwork
// palette is dark today, so "follow the room" means candlelight; a light room
// palette added later belongs in this list.
const LIGHT_ROOM_PALETTES = new Set([]);

// Shown in the controls before anything is chosen. Never saved by itself.
export const MARGINALIA_DEFAULT_SELECTION = Object.freeze({
  mode: 'form',
  seed: 1793,
  form: FORM_SET.has('capitule') ? 'capitule' : FORM_IDS[0],
  manner: 'taille-douce',
  palette: PALETTE_SET.has('iron-gall') ? 'iron-gall' : PALETTE_IDS[0],
  reading: 'room',
  fullness: Object.freeze({ source: 'neutral', value: 0 }),
});

const option = (id, label) => Object.freeze({ id, label });
export const MARGINALIA_OPTIONS = Object.freeze({
  modes: Object.freeze([option('form', 'A plant form I choose'), option('calendar', "The day's plant (French Republican calendar)")]),
  forms: Object.freeze(FORM_IDS.map(id => option(id, FORM_MODULES.get(id)?.name ?? id))),
  manners: Object.freeze([option('taille-douce', 'Copperplate line'), option('lavis', 'Ink wash')]),
  palettes: Object.freeze(PALETTES.map(({ id, name }) => option(id, name ?? id))),
  readings: Object.freeze([option('room', 'Follow the room'), option('light', 'Daylight'), option('dark', 'Candlelight')]),
  fullnessSources: Object.freeze([option('neutral', 'Neutral (counts nothing)'), option('manual', 'Set by hand')]),
});

const fail = message => { throw new TypeError(`marginalia ${message}`); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const pick = (value, allowed, name) => (typeof value === 'string' && allowed.has(value) ? value : fail(`${name} is not one of the offered choices`));

/** Validate one saved choice. null (or absent) means no garden. */
export function normalizeMarginaliaSelection(value) {
  if (value === null || value === undefined) return null;
  if (!plain(value)) fail('must be null or an object');
  const keys = Object.keys(value).sort();
  if (keys.length !== FIELDS.length || keys.some((key, index) => key !== FIELDS[index])) {
    fail(`needs exactly ${FIELDS.join(', ')} (got ${keys.join(', ') || 'nothing'})`);
  }
  const mode = pick(value.mode, MODE_SET, 'mode');
  const { seed } = value;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MARGINALIA_LIMITS.seed) fail(`seed must be a whole number from 0 to ${MARGINALIA_LIMITS.seed}`);
  const form = pick(value.form, FORM_SET, 'form');
  const manner = pick(value.manner, MANNER_SET, 'manner');
  const palette = pick(value.palette, PALETTE_SET, 'palette');
  const reading = pick(value.reading, READING_SET, 'reading');
  if (!plain(value.fullness)) fail('fullness must be an object');
  const fullnessKeys = Object.keys(value.fullness).sort();
  if (fullnessKeys.join() !== 'source,value') fail('fullness needs exactly source and value');
  const source = pick(value.fullness.source, FULLNESS_SOURCE_SET, 'fullness.source');
  const amount = value.fullness.value;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1) fail('fullness.value must be from 0 to 1');
  // Neutral means zero. A hidden score kept under a neutral label would be a lie.
  const fullness = Object.freeze({ source, value: source === 'neutral' ? 0 : amount });
  return Object.freeze({ mode, seed, form, manner, palette, reading, fullness });
}

function inkReading(selection, roomPalette) {
  if (selection.reading !== 'room') return selection.reading;
  return LIGHT_ROOM_PALETTES.has(roomPalette) ? 'light' : 'dark';
}

// How far through the day it is where the room lives, 0 at midnight, 1 at the
// next midnight. The room's time zone, not the process's or UTC.
function dayFraction(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const seconds = parts.hour * 3600 + parts.minute * 60 + parts.second + now.getMilliseconds() / 1000;
  return Math.min(1, Math.max(0, seconds / 86400));
}

// The renderer is ours and is never given a guest figure or a decoration, so
// its output needs no scripts, event handlers, foreign content, or outside
// references. The copperplate manner does reuse its own outlines with
// <use href="#…">, so only same-document "#" references are allowed.
export function checkGardenSvg(svg) {
  if (typeof svg !== 'string' || !svg.startsWith('<svg') || !svg.endsWith('</svg>')) throw new Error('Églantine returned something that is not an SVG document');
  if (Buffer.byteLength(svg, 'utf8') > MARGINALIA_LIMITS.svgBytes) throw new Error('the garden drawing is larger than the room allows');
  if (/<(?:script|foreignObject|image|iframe|a)\b/iu.test(svg)) throw new Error('the garden drawing contains an element the room does not allow');
  if (/\son[a-z]+\s*=/iu.test(svg)) throw new Error('the garden drawing contains an event handler');
  if (/\bhref\s*=\s*(?!["']#)/iu.test(svg)) throw new Error('the garden drawing refers to something outside itself');
  if (/url\(\s*(?!["']?#)/iu.test(svg)) throw new Error('the garden drawing refers to something outside itself');
  return svg;
}

/**
 * Draw the chosen garden for this moment. null selection → nothing drawn.
 * `check` is replaceable only so tests can prove a bad drawing fails closed.
 */
export function renderMarginalia({ selection, roomPalette, now, timeZone, check = checkGardenSvg }) {
  const chosen = normalizeMarginaliaSelection(selection);
  if (chosen === null) return Object.freeze({ enabled: false, image: null, meta: null });
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('marginalia needs a valid time');

  const date = localDate(now, timeZone);
  const day = chosen.mode === 'calendar' ? calendarDay(date) : null;
  const calendarMeta = day ? { dateline: day.dateline, dayName: day.name, dayKind: day.kind, plantName: day.plant?.name ?? null } : {};
  if (day && day.plant === null) {
    return Object.freeze({
      enabled: true,
      image: null,
      meta: Object.freeze({ mode: 'calendar', date, ...calendarMeta, guestIncluded: false, note: 'Today is a complementary day, which has no plant in the calendar.' }),
    });
  }

  const form = day?.plant?.form ?? chosen.form;
  const garden = growGarden({ seed: chosen.seed, form, variant: day?.plant?.variant ?? {} });
  const reading = inkReading(chosen, roomPalette);
  const moment = { t: dayFraction(now, timeZone), fullness: chosen.fullness.value };
  // No guestFigure and no decorate: the calendar's animal and tool engravings
  // are not loaded, fetched or implied by this integration.
  const raw = renderGarden(garden, moment, { manner: chosen.manner, id: 'fieldwork-margin', scale: 36 });
  const svg = check(withInks(raw, paletteInks(chosen.palette, reading)));
  return Object.freeze({
    enabled: true,
    image: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    meta: Object.freeze({
      mode: chosen.mode,
      date,
      ...calendarMeta,
      form,
      seed: chosen.seed,
      manner: chosen.manner,
      palette: chosen.palette,
      reading,
      time: moment.t,
      fullness: chosen.fullness,
      guestIncluded: false,
    }),
  });
}
