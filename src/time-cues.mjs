import { deepFreeze, isPlainObject } from './json-data.mjs';

// A small, deterministic interpreter for calendar language used by memory
// retrieval. It identifies bounded date ranges; it does not guess event dates,
// rewrite memory, or treat "first" and "last" as global chronology requests.

export const TIME_CUES_FORMAT = 'fieldwork-time-cues/v1';
export const TIME_CUES_LIMITS = Object.freeze({ messageCharacters: 100_000, ranges: 32, yearsBack: 100 });

const cues = new WeakSet();
const cueDetails = new WeakMap();
const formatters = new Map();
const numberWords = Object.freeze({
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});
const monthNames = Object.freeze([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]);
const monthPattern = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function timeError(message) {
  return new Error(`Time cues: ${message}`);
}

function fields(value, allowed, where) {
  if (!isPlainObject(value)) throw timeError(`${where} must be an object`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw timeError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw timeError(`${where}.${key} must be an enumerable data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function isWellFormed(value) {
  if (typeof value.isWellFormed === 'function') return value.isWellFormed();
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function exactInstant(value, where) {
  if (typeof value !== 'string') throw timeError(`${where} must be an exact ISO timestamp`);
  let normalized = '';
  try { normalized = new Date(value).toISOString(); } catch { /* Rejected below. */ }
  if (normalized !== value) throw timeError(`${where} must be an exact ISO timestamp`);
  return value;
}

export function resolveTimeZone(value) {
  const zone = value === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : value;
  if (typeof zone !== 'string' || !zone) throw timeError('timeZone must be a nonempty IANA time zone');
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone; }
  catch { throw timeError(`timeZone ${JSON.stringify(zone)} is not a valid IANA time zone`); }
}

function formatter(zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return formatters.get(zone);
}

function zonedParts(milliseconds, zone) {
  const values = Object.create(null);
  for (const part of formatter(zone).formatToParts(new Date(milliseconds))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

function zoneOffset(milliseconds, zone) {
  const second = Math.trunc(milliseconds / 1000) * 1000;
  const part = zonedParts(second, zone);
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - second;
}

function normalizedDate(year, month, day) {
  const value = new Date(Date.UTC(year, month, day));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth(), day: value.getUTCDate() };
}

function validDate(year, month, day) {
  const value = normalizedDate(year, month, day);
  return value.year === year && value.month === month && value.day === day;
}

function localMidnight(year, month, day, zone) {
  const normalized = normalizedDate(year, month, day);
  const wall = Date.UTC(normalized.year, normalized.month, normalized.day);
  let instant = wall;
  for (let attempt = 0; attempt < 4; attempt++) instant = wall - zoneOffset(instant, zone);
  return instant;
}

function dayRange(year, month, day, zone, relation) {
  const normalized = normalizedDate(year, month, day);
  return {
    from: localMidnight(normalized.year, normalized.month, normalized.day, zone),
    to: localMidnight(normalized.year, normalized.month, normalized.day + 1, zone),
    kind: 'day',
    relation,
  };
}

function localDate(milliseconds, zone) {
  const part = zonedParts(milliseconds, zone);
  return { year: part.year, month: part.month - 1, day: part.day };
}

function shiftedDay(milliseconds, zone, offset, relation) {
  const local = localDate(milliseconds, zone);
  return dayRange(local.year, local.month, local.day + offset, zone, relation);
}

function weekRange(milliseconds, zone, previous) {
  const local = localDate(milliseconds, zone);
  const dayOfWeek = new Date(Date.UTC(local.year, local.month, local.day)).getUTCDay();
  const sinceMonday = (dayOfWeek + 6) % 7;
  const startOffset = -sinceMonday - (previous ? 7 : 0);
  const start = shiftedDay(milliseconds, zone, startOffset, previous ? 'last-week' : 'this-week');
  return {
    from: start.from,
    to: previous ? shiftedDay(milliseconds, zone, startOffset + 7, 'last-week').from : milliseconds + 1,
    kind: 'week',
    relation: previous ? 'last-week' : 'this-week',
  };
}

function monthIndex(value) {
  const prefix = value.toLowerCase().slice(0, 3);
  return monthNames.findIndex(name => name.startsWith(prefix));
}

function latestNamedDate(now, zone, month, day, explicitYear) {
  const current = localDate(now, zone);
  let year = explicitYear ?? current.year;
  if (!validDate(year, month, day)) return null;
  let range = dayRange(year, month, day, zone, 'named-date');
  if (explicitYear === undefined && range.from > now) {
    year--;
    if (!validDate(year, month, day)) return null;
    range = dayRange(year, month, day, zone, 'named-date');
  }
  return range;
}

function latestNamedMonth(now, zone, month) {
  const current = localDate(now, zone);
  const year = month > current.month ? current.year - 1 : current.year;
  return {
    from: localMidnight(year, month, 1, zone),
    to: localMidnight(year, month + 1, 1, zone),
    kind: 'month',
    relation: 'named-month',
  };
}

function mergeSpans(spans) {
  const sorted = spans.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

function withoutSpans(text, spans) {
  let cursor = 0;
  const pieces = [];
  for (const [from, to] of spans) {
    pieces.push(text.slice(cursor, from), ' ');
    cursor = to;
  }
  pieces.push(text.slice(cursor));
  return pieces.join('').replace(/\s+/gu, ' ').trim();
}

export function isTimeCues(value) {
  return Boolean(value) && cues.has(value);
}

export function parseTimeCues(message, options = {}) {
  if (typeof message !== 'string') throw timeError('message must be primitive text');
  if (!isWellFormed(message)) throw timeError('message must contain well-formed Unicode');
  const characters = [...message].length;
  if (characters > TIME_CUES_LIMITS.messageCharacters) {
    throw timeError(`message contains ${characters} characters; the limit is ${TIME_CUES_LIMITS.messageCharacters}`);
  }
  const raw = fields(options, ['now', 'timeZone'], 'options');
  const nowIso = raw.now === undefined ? new Date().toISOString() : exactInstant(raw.now, 'now');
  const now = Date.parse(nowIso);
  const timeZone = resolveTimeZone(raw.timeZone);
  const text = message.normalize('NFKC').toLowerCase();
  const ranges = [];
  const spans = [];
  const seen = new Set();
  let omittedRanges = 0;
  const add = (match, range) => {
    if (!range) return;
    spans.push([match.index, match.index + match[0].length]);
    const key = `${range.from}\0${range.to}\0${range.kind}\0${range.relation}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (ranges.length >= TIME_CUES_LIMITS.ranges) { omittedRanges++; return; }
    ranges.push(range);
  };

  for (const match of text.matchAll(/\b(20\d\d)-(\d{2})-(\d{2})\b/gu)) {
    const year = Number(match[1]), month = Number(match[2]) - 1, day = Number(match[3]);
    if (validDate(year, month, day)) add(match, dayRange(year, month, day, timeZone, 'named-date'));
  }
  for (const match of text.matchAll(new RegExp(`\\b${monthPattern}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\b`, 'gu'))) {
    add(match, latestNamedDate(now, timeZone, monthIndex(match[1]), Number(match[2]), match[3] ? Number(match[3]) : undefined));
  }
  for (const match of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+${monthPattern}(?:,?\\s+(20\\d\\d))?\\b`, 'gu'))) {
    add(match, latestNamedDate(now, timeZone, monthIndex(match[2]), Number(match[1]), match[3] ? Number(match[3]) : undefined));
  }
  for (const match of text.matchAll(/\b(today|tonight|this morning|this afternoon|this evening|earlier tonight)\b/gu)) {
    add(match, shiftedDay(now, timeZone, 0, 'today'));
  }
  for (const match of text.matchAll(/\b(yesterday|last night)\b/gu)) {
    add(match, shiftedDay(now, timeZone, -1, 'yesterday'));
  }
  for (const match of text.matchAll(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|night|week)s?\s+ago\b/gu)) {
    const count = numberWords[match[1]] ?? Number(match[1]);
    const days = count * (match[2] === 'week' ? 7 : 1);
    if (Number.isSafeInteger(days) && days > 0 && days <= TIME_CUES_LIMITS.yearsBack * 366) {
      add(match, shiftedDay(now, timeZone, -days, 'ago'));
    }
  }
  for (const match of text.matchAll(/\blast week\b/gu)) add(match, weekRange(now, timeZone, true));
  for (const match of text.matchAll(/\bthis week\b/gu)) add(match, weekRange(now, timeZone, false));
  for (const match of text.matchAll(new RegExp(`\\b(?:in|back in|during)\\s+${monthPattern}\\b(?!\\.?\\s+\\d)`, 'gu'))) {
    add(match, latestNamedMonth(now, timeZone, monthIndex(match[1])));
  }

  const merged = mergeSpans(spans);
  const contentText = withoutSpans(text, merged);
  const receipt = deepFreeze({
    format: TIME_CUES_FORMAT,
    now: nowIso,
    timeZone,
    ranges: ranges.map(range => ({
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
      kind: range.kind,
      relation: range.relation,
    })),
    omittedRanges,
    contentCharacters: [...contentText].length,
  });
  const result = deepFreeze({ receipt });
  cues.add(result);
  cueDetails.set(result, Object.freeze({ ranges: ranges.map(range => Object.freeze({ ...range })), contentText }));
  return result;
}

export function timeCueContentText(value) {
  if (!isTimeCues(value)) throw timeError('value must be returned by parseTimeCues()');
  return cueDetails.get(value).contentText;
}

export function timeCuesMatchInstant(value, instant) {
  if (!isTimeCues(value)) throw timeError('value must be returned by parseTimeCues()');
  const milliseconds = Date.parse(exactInstant(instant, 'instant'));
  return cueDetails.get(value).ranges.some(range => milliseconds >= range.from && milliseconds < range.to);
}
