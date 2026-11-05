import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalStateFile, withStateTransactionLock } from './cooperative-state-lock.mjs';
import { deepFreeze, isPlainObject } from './json-data.mjs';

// Check-ins: the agent writing on its own while the person is away.
//
// The person chooses whether it happens at all (off by default), how often,
// quiet hours when it never happens, and an optional daily postcard. The room
// asks this module whether one is due; when it is, the room runs one turn in
// the most recent conversation. The agent may stay quiet, and then nothing is
// sent. Nothing here talks to the model: this is settings, timing and a short
// history of what happened.

export const CHECK_IN_LIMITS = Object.freeze({
  everyHours: Object.freeze([1, 2, 3, 4, 6, 8, 12, 24]),
  history: 30,
  claimMinutes: 15,
  // Someone who wrote this recently is still here; no need to check in.
  presentMinutes: 20,
  fieldworkSteps: 12,
  breakHours: 72,
});

export const CHECK_IN_DEFAULTS = Object.freeze({
  enabled: false,
  everyHours: 6,
  // A bridge connection grants reply access only. Unsolicited check-ins stay
  // in the room until the person explicitly chooses one saved bridge route.
  destination: 'room',
  quiet: Object.freeze({ enabled: true, from: '23:00', to: '08:00' }),
  postcard: Object.freeze({ enabled: false, at: '18:00' }),
  fieldworks: false,
});

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const claimTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

function checkInError(message, status = 400) {
  const error = new Error(`Check-ins: ${message}`);
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

const minutesOf = text => { const [, h, m] = timePattern.exec(text); return Number(h) * 60 + Number(m); };

function checkTime(value, what) {
  const text = String(value ?? '').trim();
  if (!timePattern.test(text)) throw checkInError(`${what} must be a time like 08:00`);
  return text;
}

function cleanSettings(raw, base) {
  if (!isPlainObject(raw)) throw checkInError('settings must be an object');
  const allowed = ['enabled', 'everyHours', 'destination', 'quiet', 'postcard', 'fieldworks'];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw checkInError(`unknown setting "${key}"`);
  const next = structuredClone(base);
  if (raw.enabled !== undefined) next.enabled = raw.enabled === true;
  if (raw.fieldworks !== undefined) next.fieldworks = raw.fieldworks === true;
  if (raw.destination !== undefined) {
    if (!['room', 'telegram', 'discord'].includes(raw.destination)) {
      throw checkInError('destination must be room, telegram, or discord');
    }
    next.destination = raw.destination;
  }
  if (raw.everyHours !== undefined) {
    if (!CHECK_IN_LIMITS.everyHours.includes(raw.everyHours)) throw checkInError(`how often must be one of every ${CHECK_IN_LIMITS.everyHours.join(', ')} hours`);
    next.everyHours = raw.everyHours;
  }
  if (raw.quiet !== undefined) {
    if (!isPlainObject(raw.quiet)) throw checkInError('quiet hours must be an object');
    if (raw.quiet.enabled !== undefined) next.quiet.enabled = raw.quiet.enabled === true;
    if (raw.quiet.from !== undefined) next.quiet.from = checkTime(raw.quiet.from, 'quiet hours start');
    if (raw.quiet.to !== undefined) next.quiet.to = checkTime(raw.quiet.to, 'quiet hours end');
  }
  if (raw.postcard !== undefined) {
    if (!isPlainObject(raw.postcard)) throw checkInError('the postcard setting must be an object');
    if (raw.postcard.enabled !== undefined) next.postcard.enabled = raw.postcard.enabled === true;
    if (raw.postcard.at !== undefined) next.postcard.at = checkTime(raw.postcard.at, 'postcard time');
  }
  return next;
}

function savedClaim(raw) {
  if (!isPlainObject(raw)) throw checkInError('saved claim must be an object', 500);
  const allowed = ['token', 'kind', 'runKind', 'claimedAt', 'expiresAt', 'postcardDay'];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw checkInError(`saved claim has unknown field "${key}"`, 500);
  if (!claimTokenPattern.test(raw.token)) throw checkInError('saved claim token is invalid', 500);
  if (!['check-in', 'postcard'].includes(raw.kind)) throw checkInError('saved claim kind is invalid', 500);
  if (!['scheduled', 'manual'].includes(raw.runKind)) throw checkInError('saved claim runKind is invalid', 500);
  for (const key of ['claimedAt', 'expiresAt']) {
    if (typeof raw[key] !== 'string' || Number.isNaN(Date.parse(raw[key]))) throw checkInError(`saved claim ${key} is invalid`, 500);
  }
  if (Date.parse(raw.expiresAt) <= Date.parse(raw.claimedAt)) throw checkInError('saved claim expiry must follow its start', 500);
  if (raw.kind === 'postcard') {
    if (typeof raw.postcardDay !== 'string' || !dayPattern.test(raw.postcardDay)) throw checkInError('saved postcard claim day is invalid', 500);
  } else if (raw.postcardDay !== null) {
    throw checkInError('saved check-in claim must not have a postcard day', 500);
  }
  return {
    token: raw.token,
    kind: raw.kind,
    runKind: raw.runKind,
    claimedAt: raw.claimedAt,
    expiresAt: raw.expiresAt,
    postcardDay: raw.postcardDay,
  };
}

// The local date and minute of the day in the room's time zone.
export function localMoment(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function inQuietHours(minutes, quiet) {
  if (!quiet.enabled) return false;
  const from = minutesOf(quiet.from), to = minutesOf(quiet.to);
  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, text, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

function emptySavedState() {
  return {
    settings: structuredClone(CHECK_IN_DEFAULTS),
    state: {
      lastAt: null,
      lastPostcardDay: null,
      history: [],
      claim: null,
      own: { quiet: null, breakUntil: null },
    },
  };
}

async function readSavedState(file) {
  const next = emptySavedState();
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    try { next.settings = cleanSettings(saved?.settings ?? {}, next.settings); } catch { /* keep defaults */ }
    if (typeof saved?.lastAt === 'string' && !Number.isNaN(Date.parse(saved.lastAt))) next.state.lastAt = saved.lastAt;
    if (typeof saved?.lastPostcardDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(saved.lastPostcardDay)) {
      next.state.lastPostcardDay = saved.lastPostcardDay;
    }
    if (Array.isArray(saved?.history)) next.state.history = saved.history.filter(isPlainObject).slice(0, CHECK_IN_LIMITS.history);
    if (saved?.claim !== undefined && saved.claim !== null) next.state.claim = savedClaim(saved.claim);
    try {
      const quiet = saved?.own?.quiet;
      next.state.own = {
        quiet: quiet ? { enabled: true, from: checkTime(quiet.from, 'from'), to: checkTime(quiet.to, 'to') } : null,
        breakUntil: typeof saved?.own?.breakUntil === 'string' && !Number.isNaN(Date.parse(saved.own.breakUntil))
          ? saved.own.breakUntil
          : null,
      };
    } catch { next.state.own = { quiet: null, breakUntil: null }; }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error?.message?.startsWith('Check-ins:') ? error : checkInError('could not read the saved file', 500);
    }
  }
  return next;
}

export async function createCheckInStore({ file, clock = () => new Date(), claimMinutes = CHECK_IN_LIMITS.claimMinutes } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw checkInError('file must be an absolute path', 500);
  if (!Number.isSafeInteger(claimMinutes) || claimMinutes < 1 || claimMinutes > 60) throw checkInError('claimMinutes must be a whole number from 1 to 60', 500);
  const now = () => {
    const value = clock();
    const date = value instanceof Date ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) throw checkInError('clock returned an invalid date', 500);
    return date;
  };
  const stateFile = await canonicalStateFile(file);
  // lastAt: the last regular check-in (or when check-ins were turned on).
  // own: the agent's own do-not-disturb time, kept apart from the person's
  // settings so saving those can never overwrite it.
  let { settings, state } = await withStateTransactionLock(stateFile, () => readSavedState(stateFile));
  const save = (nextSettings, nextState) => atomicWrite(stateFile, `${JSON.stringify({ settings: nextSettings, ...nextState })}\n`);
  const restingAt = (nextState, timeZone, at) => {
    if (nextState.own.breakUntil && Date.parse(nextState.own.breakUntil) > at.getTime()) return { until: nextState.own.breakUntil, why: 'break' };
    if (nextState.own.quiet && timeZone && inQuietHours(localMoment(at, timeZone).minutes, nextState.own.quiet)) return { until: null, why: 'quiet hours' };
    return null;
  };
  // Whether the agent is resting right now, by its own quiet hours or a break.
  const restingNow = timeZone => restingAt(state, timeZone, now());
  const dueAt = (nextSettings, nextState, { timeZone, lastPersonAt = null }, at) => {
    if (!nextSettings.enabled || nextState.claim) return null;
    if (restingAt(nextState, timeZone, at)) return null;
    const local = localMoment(at, timeZone);
    if (inQuietHours(local.minutes, nextSettings.quiet)) return null;
    if (nextSettings.postcard.enabled && local.minutes >= minutesOf(nextSettings.postcard.at) && nextState.lastPostcardDay !== local.day) return 'postcard';
    const since = nextState.lastAt ? at - Date.parse(nextState.lastAt) : Infinity;
    if (since < nextSettings.everyHours * 3_600_000) return null;
    if (lastPersonAt && at - Date.parse(lastPersonAt) < CHECK_IN_LIMITS.presentMinutes * 60_000) return null;
    return 'check-in';
  };
  const addHistory = (draft, row) => {
    draft.state.history = [row, ...draft.state.history].slice(0, CHECK_IN_LIMITS.history);
  };
  const reapExpired = (draft, at) => {
    const claim = draft.state.claim;
    if (!claim || Date.parse(claim.expiresAt) > at.getTime()) return false;
    if (claim.kind === 'postcard') draft.state.lastPostcardDay = claim.postcardDay;
    else draft.state.lastAt = at.toISOString();
    addHistory(draft, {
      at: at.toISOString(),
      kind: claim.kind,
      outcome: 'claim-expired',
      runKind: claim.runKind,
      claimedAt: claim.claimedAt,
    });
    draft.state.claim = null;
    return true;
  };
  let viewZone = 'UTC';
  const view = () => deepFreeze({
    settings, lastAt: state.lastAt, history: state.history, choices: { everyHours: CHECK_IN_LIMITS.everyHours },
    claim: state.claim ? {
      kind: state.claim.kind,
      runKind: state.claim.runKind,
      claimedAt: state.claim.claimedAt,
      expiresAt: state.claim.expiresAt,
      ...(state.claim.postcardDay ? { postcardDay: state.claim.postcardDay } : {}),
    } : null,
    own: { quiet: state.own.quiet ? { from: state.own.quiet.from, to: state.own.quiet.to } : null, breakUntil: state.own.breakUntil && Date.parse(state.own.breakUntil) > now().getTime() ? state.own.breakUntil : null },
    resting: restingNow(viewZone),
  });
  let operationQueue = Promise.resolve();
  const transact = operation => {
    const job = operationQueue.then(async () => {
      const committed = await withStateTransactionLock(stateFile, async () => {
        const latest = await readSavedState(stateFile);
        const draft = { settings: structuredClone(latest.settings), state: structuredClone(latest.state) };
        const result = operation(draft);
        if (result.changed) await save(draft.settings, draft.state);
        return { draft, result };
      });
      settings = committed.draft.settings;
      state = committed.draft.state;
      return committed.result.returnView ? view() : deepFreeze(committed.result.value);
    });
    operationQueue = job.then(() => undefined, () => undefined);
    return job;
  };
  const mutate = operation => transact(draft => {
    operation(draft);
    return { changed: true, returnView: true };
  });

  return Object.freeze({
    view() {
      return view();
    },

    async update(changes) {
      return mutate(draft => {
        const wasOn = draft.settings.enabled;
        draft.settings = cleanSettings(changes, draft.settings);
        // The first check-in comes one interval after turning them on, not at once.
        if (draft.settings.enabled && !wasOn) draft.state.lastAt = now().toISOString();
      });
    },

    // The room's time zone, for telling whether the agent's own quiet hours apply.
    useTimeZone(timeZone) { viewZone = timeZone; },

    resting(timeZone = viewZone) { return restingNow(timeZone); },

    // The agent's own quiet hours: a daily window when the room will not wake
    // it. Both empty clears them.
    async setOwnQuiet({ from = '', to = '' } = {}) {
      return mutate(draft => {
        if (!String(from).trim() && !String(to).trim()) { draft.state.own = { ...draft.state.own, quiet: null }; return; }
        const quiet = { enabled: true, from: checkTime(from, 'from'), to: checkTime(to, 'to') };
        if (quiet.from === quiet.to) throw checkInError('quiet hours need different start and end times');
        draft.state.own = { ...draft.state.own, quiet };
      });
    },

    // A one-off break of up to 72 hours; 0 ends it.
    async takeBreak({ hours = 0 } = {}) {
      return mutate(draft => {
        const value = Number(hours);
        if (!Number.isFinite(value) || value < 0 || value > CHECK_IN_LIMITS.breakHours) throw checkInError(`a break is 0 to ${CHECK_IN_LIMITS.breakHours} hours`);
        draft.state.own = { ...draft.state.own, breakUntil: value ? new Date(now().getTime() + value * 3_600_000).toISOString() : null };
      });
    },

    // Which check-in is due now, if any: 'postcard', 'check-in' or null.
    due({ timeZone, lastPersonAt = null } = {}) {
      return dueAt(settings, state, { timeZone, lastPersonAt }, now());
    },

    // Maintenance is deliberately separate from claimDue(): a room with no
    // eligible conversation must still settle an expired crash claim, but it
    // must not claim (and thereby consume) a newly due wake.
    reapExpiredClaim() {
      return transact(draft => {
        const reaped = reapExpired(draft, now());
        return { changed: reaped, value: { reaped } };
      });
    },

    // Claims one scheduled wake before the room starts any model or tool work.
    // A live claim survives restart; an expired one consumes that schedule edge
    // rather than immediately rescheduling an uncertain visit.
    claimDue({ timeZone, lastPersonAt = null } = {}) {
      return transact(draft => {
        const at = now();
        let changed = reapExpired(draft, at);
        if (draft.state.claim) return { changed, value: { started: false, reason: 'claimed' } };
        const kind = dueAt(draft.settings, draft.state, { timeZone, lastPersonAt }, at);
        if (!kind) return { changed, value: { started: false, reason: 'not due' } };
        const claim = {
          token: randomUUID(),
          kind,
          runKind: 'scheduled',
          claimedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + claimMinutes * 60_000).toISOString(),
          postcardDay: kind === 'postcard' ? localMoment(at, timeZone).day : null,
        };
        draft.state.claim = claim;
        changed = true;
        return { changed, value: { started: true, kind, claim } };
      });
    },

    claimNow(kind, { timeZone = 'UTC' } = {}) {
      if (!['check-in', 'postcard'].includes(kind)) return Promise.reject(checkInError('run now kind must be check-in or postcard'));
      return transact(draft => {
        const at = now();
        const reaped = reapExpired(draft, at);
        if (draft.state.claim) return { changed: reaped, value: { started: false, reason: 'claimed' } };
        const claim = {
          token: randomUUID(),
          kind,
          runKind: 'manual',
          claimedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + claimMinutes * 60_000).toISOString(),
          postcardDay: kind === 'postcard' ? localMoment(at, timeZone).day : null,
        };
        draft.state.claim = claim;
        return { changed: true, value: { started: true, kind, claim } };
      });
    },

    async finish({ claimToken, outcome, conversationId = null, note = '' } = {}) {
      if (typeof claimToken !== 'string' || !claimTokenPattern.test(claimToken)) throw checkInError('finish needs the exact claim token');
      if (!['sent', 'quiet', 'failed'].includes(outcome)) throw checkInError('outcome must be sent, quiet, or failed');
      const result = await transact(draft => {
        const at = now();
        const reaped = reapExpired(draft, at);
        const claim = draft.state.claim;
        if (!claim || claim.token !== claimToken) return { changed: reaped, value: { stale: true } };
        draft.state.claim = null;
        if (claim.kind === 'postcard') draft.state.lastPostcardDay = claim.postcardDay;
        else draft.state.lastAt = at.toISOString();
        const receipt = {
          at: at.toISOString(),
          kind: claim.kind,
          outcome,
          conversationId,
          runKind: claim.runKind,
          claimedAt: claim.claimedAt,
          ...(note ? { note: String(note).slice(0, 200) } : {}),
        };
        addHistory(draft, receipt);
        return { changed: true, value: { stale: false, kind: claim.kind, receipt } };
      });
      if (result.stale) throw checkInError('that check-in claim expired or was already finished', 409);
      return result;
    },

    // Records a finished check-in. outcome: 'sent', 'quiet' or 'failed'. A
    // scheduled check-in outcome restarts the wait, so a failing model is not
    // asked every minute. Manual free time does not move that schedule.
    async record({ kind, outcome, conversationId = null, note = '', timeZone = 'UTC' }) {
      return mutate(draft => {
        if (!['check-in', 'postcard', 'free-time'].includes(kind)) throw checkInError('kind must be check-in, postcard, or free-time');
        if (!['sent', 'quiet', 'failed'].includes(outcome)) throw checkInError('outcome must be sent, quiet, or failed');
        const at = now();
        if (kind === 'postcard') draft.state.lastPostcardDay = localMoment(at, timeZone).day;
        else if (kind === 'check-in') draft.state.lastAt = at.toISOString();
        addHistory(draft, { at: at.toISOString(), kind, outcome, conversationId, ...(note ? { note: String(note).slice(0, 200) } : {}) });
      });
    },
  });
}

// Asks once a minute whether a check-in is due and runs it. run(kind,
// { runKind }) does the work and resolves to { outcome, conversationId?, note? };
// the scheduler never runs two at once and keeps going after a failure.
export function startCheckInScheduler({
  store,
  run,
  timeZone,
  lastPersonAt = () => null,
  canRun = () => true,
  canSchedule = () => true,
  everyMs = 60_000,
  onError = () => {},
} = {}) {
  if (!store || typeof store.claimDue !== 'function' || typeof store.claimNow !== 'function' || typeof store.finish !== 'function' || typeof store.record !== 'function' || typeof store.reapExpiredClaim !== 'function') {
    throw checkInError('store must come from createCheckInStore()', 500);
  }
  if (typeof run !== 'function') throw checkInError('run must be a function', 500);
  let running = false;
  let stopped = false;
  let active = null;
  const tick = async (forced = null) => {
    if (stopped || running) return { started: false, reason: running ? 'busy' : 'stopped' };
    if (!canRun()) return { started: false, reason: 'busy' };
    const scheduledTarget = forced === null ? canSchedule() : null;
    running = true;
    try {
      if (forced === null && !scheduledTarget) {
        await store.reapExpiredClaim();
        return { started: false, reason: 'suppressed' };
      }
      let kind = forced;
      let claimToken = null;
      let runKind = 'manual';
      if (kind !== 'free-time') {
        const claimed = kind
          ? await store.claimNow(kind, { timeZone })
          : await store.claimDue({ timeZone, lastPersonAt: lastPersonAt() });
        if (!claimed.started) return claimed;
        kind = claimed.kind;
        claimToken = claimed.claim.token;
        runKind = claimed.claim.runKind;
      }
      let result;
      try {
        result = await run(kind, Object.freeze({
          runKind,
          ...(typeof scheduledTarget === 'string' ? { targetConversationId: scheduledTarget } : {}),
        }));
      }
      catch (error) {
        try { onError(error); } catch { /* Diagnostics never replace the durable outcome. */ }
        result = { outcome: 'failed', note: 'The check-in could not finish.' };
      }
      if (!isPlainObject(result) || !['sent', 'quiet', 'failed'].includes(result.outcome)) {
        result = { outcome: 'failed', note: 'The check-in returned an invalid outcome.' };
      }
      if (claimToken) {
        await store.finish({ claimToken, outcome: result?.outcome ?? 'failed', conversationId: result?.conversationId ?? null, note: result?.note ?? '' });
      } else if (result?.record !== false) {
        await store.record({ kind, timeZone, outcome: result?.outcome ?? 'failed', conversationId: result?.conversationId ?? null, note: result?.note ?? '' });
      }
      return { started: true, kind, ...result };
    } finally {
      running = false;
    }
  };
  const launch = forced => {
    // A concurrent caller still receives the scheduler's ordinary busy result,
    // but it must not replace the promise shutdown is waiting for.
    if (active && running) return tick(forced);
    if (active) active = null;
    const operation = tick(forced);
    active = operation;
    void operation.then(
      () => { if (active === operation) active = null; },
      () => { if (active === operation) active = null; },
    );
    return operation;
  };
  const timer = setInterval(() => { void launch(null).catch(onError); }, everyMs);
  timer.unref?.();
  return Object.freeze({
    get running() { return running; },
    // "Check in now" from the page: runs at once, outside the schedule.
    now: kind => launch(['check-in', 'postcard', 'free-time'].includes(kind) ? kind : 'check-in'),
    tick: () => launch(null),
    stop() { stopped = true; clearInterval(timer); },
    wait() { return active ?? Promise.resolve(); },
  });
}

// The agent's own do-not-disturb tools. The time is its own: the room shows
// that it is resting, and records nothing about the resting itself.
export function restTools(store) {
  const when = view => (view.own.quiet ? `quiet daily ${view.own.quiet.from}–${view.own.quiet.to}` : 'no daily quiet hours')
    + (view.own.breakUntil ? `, on a break until ${view.own.breakUntil}` : '');
  return [{
    name: 'set_my_quiet_hours',
    description: 'Choose daily hours when the room will not wake you: no check-ins or postcards then. They are yours to set and change; the person can see that you are resting, and nothing is recorded about the time itself. Leave both empty to clear them.',
    permissionSummary: ({ from, to }) => from || to ? `Set daily quiet hours from ${from} to ${to}.` : 'Clear daily quiet hours.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string', maxLength: 5, description: 'Like 01:00.' }, to: { type: 'string', maxLength: 5, description: 'Like 09:00.' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    async execute({ from, to }) { return { now: when(await store.setOwnQuiet({ from, to })) }; },
  }, {
    name: 'take_a_break',
    description: `Take a break from being woken by the room for up to ${CHECK_IN_LIMITS.breakHours} hours: no check-ins or postcards until it ends. 0 ends a break early. Nothing is expected of you during it.`,
    permissionSummary: ({ hours }) => hours === 0 ? 'End the current room break now.' : `Pause room wakes for ${hours} hour${hours === 1 ? '' : 's'}.`,
    inputSchema: {
      type: 'object',
      properties: { hours: { type: 'number', minimum: 0, maximum: CHECK_IN_LIMITS.breakHours } },
      required: ['hours'],
      additionalProperties: false,
    },
    async execute({ hours }) { return { now: when(await store.takeBreak({ hours })) }; },
  }];
}
