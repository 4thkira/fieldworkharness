import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';

// The change log: one place to see what the agent and the person have changed
// in the room, when, and what it was before.
//
// The room takes a small snapshot of everything inspectable (names, portraits,
// pronouns, moods, thinking lines, emoji, house guides, roots, check-in
// settings, and explicit tool permissions) and compares it before and after each reply and each Settings
// action. Every difference becomes an entry saying who made it. Nothing here
// changes the stores themselves; undo is done by the room through each store's
// own methods.

export const CHANGE_LOG_LIMITS = Object.freeze({
  entries: 400,
  displayCharacters: 160,
  fileBytes: 4 * 1024 * 1024,
  valueBytes: 1024 * 1024,
  maxDepth: 32,
  fileDepth: 40,
});

const CHANGE_LOG_FORMAT = 'fieldwork-change-log/v1';
const utf8 = new TextDecoder('utf-8', { fatal: true });

function logError(message, status = 400, cause = undefined) {
  const error = new Error(`Change log: ${message}`, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function exactKeys(value, allowed, where) {
  if (!isPlainObject(value)) throw logError(`${where} must be an object`, 500);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) throw logError(`${where} contains an unknown field`, 500);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw logError(`${where}.${String(key)} must be an enumerable data property`, 500);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw logError(`${where} is missing ${key}`, 500);
  }
  return value;
}

function optionalExactKeys(value, required, optional, where) {
  if (!isPlainObject(value)) throw logError(`${where} must be an object`, 500);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) throw logError(`${where} contains an unknown field`, 500);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw logError(`${where}.${String(key)} must be an enumerable data property`, 500);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw logError(`${where} is missing ${key}`, 500);
  }
  return value;
}

function textValue(value, maximum, where, { empty = false } = {}) {
  if (typeof value !== 'string') throw logError(`${where} must be text`, 500);
  const length = [...value].length;
  if ((!empty && length === 0) || length > maximum) throw logError(`${where} must contain ${empty ? `at most ${maximum}` : `1-${maximum}`} characters`, 500);
  return value;
}

function isoInstant(value, where) {
  textValue(value, 40, where);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw logError(`${where} must be a canonical ISO timestamp`, 500);
  return value;
}

function jsonValue(value, where) {
  try {
    return boundedJson(value, {
      where,
      maxBytes: CHANGE_LOG_LIMITS.valueBytes,
      maxDepth: CHANGE_LOG_LIMITS.maxDepth,
      maxNodes: 100_000,
    }).value;
  } catch (error) {
    throw logError(`${where} is not bounded JSON: ${error.message}`, 500);
  }
}

function entryValue(raw, where = 'saved entry') {
  const required = ['id', 'at', 'key', 'area', 'label', 'by', 'before', 'after', 'beforeText', 'afterText'];
  optionalExactKeys(raw, required, ['undoOf', 'conversationId'], where);
  const by = raw.by;
  if (by !== 'agent' && by !== 'person') throw logError(`${where}.by must be agent or person`, 500);
  const entry = {
    id: textValue(raw.id, 100, `${where}.id`),
    at: isoInstant(raw.at, `${where}.at`),
    key: textValue(raw.key, 512, `${where}.key`),
    area: textValue(raw.area, 128, `${where}.area`),
    label: textValue(raw.label, 1000, `${where}.label`),
    by,
    before: jsonValue(raw.before, `${where}.before`),
    after: jsonValue(raw.after, `${where}.after`),
    beforeText: textValue(raw.beforeText, CHANGE_LOG_LIMITS.displayCharacters, `${where}.beforeText`, { empty: true }),
    afterText: textValue(raw.afterText, CHANGE_LOG_LIMITS.displayCharacters, `${where}.afterText`, { empty: true }),
  };
  if (Object.hasOwn(raw, 'undoOf')) entry.undoOf = textValue(raw.undoOf, 100, `${where}.undoOf`);
  if (Object.hasOwn(raw, 'conversationId')) entry.conversationId = textValue(raw.conversationId, 200, `${where}.conversationId`);
  return entry;
}

function savedEntries(raw) {
  exactKeys(raw, ['format', 'entries'], 'saved file');
  if (raw.format !== CHANGE_LOG_FORMAT) throw logError(`saved format must be ${CHANGE_LOG_FORMAT}`, 500);
  if (!Array.isArray(raw.entries) || raw.entries.length > CHANGE_LOG_LIMITS.entries) throw logError('saved entries are invalid', 500);
  const entries = raw.entries.map((entry, index) => entryValue(entry, `saved entry ${index + 1}`));
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw logError('saved entry ids repeat', 500);
  return deepFreeze(entries);
}

function recordValues(changes, extra, at) {
  if (!Array.isArray(changes)) throw logError('changes must be an array');
  if (changes.length > CHANGE_LOG_LIMITS.entries) throw logError(`one record batch may contain at most ${CHANGE_LOG_LIMITS.entries} changes`);
  optionalExactKeys(extra, [], ['undoOf', 'conversationId'], 'record metadata');
  return changes.map((change, index) => {
    optionalExactKeys(change, ['key', 'area', 'label', 'by', 'before', 'after', 'beforeText', 'afterText'], [], `change ${index + 1}`);
    return entryValue({ id: `chg-${randomUUID()}`, at, ...change, ...extra }, `change ${index + 1}`);
  });
}

const short = text => {
  const characters = [...String(text ?? '').replace(/\s+/g, ' ').trim()];
  return characters.length > CHANGE_LOG_LIMITS.displayCharacters ? `${characters.slice(0, CHANGE_LOG_LIMITS.displayCharacters - 1).join('')}…` : characters.join('');
};

// A portrait as a small comparable value; uploaded pictures are fingerprinted
// rather than copied into the log.
function portraitValue(icon) {
  if (!icon) return null;
  if (icon.kind === 'emoji') return { kind: 'emoji', value: icon.value };
  if (icon.kind === 'picture') return { kind: 'picture', ref: icon.ref };
  if (icon.kind === 'image') return { kind: 'image', sha256: createHash('sha256').update(String(icon.dataUrl)).digest('hex') };
  return { kind: String(icon.kind) };
}
const portraitText = value => (!value ? 'none' : value.kind === 'emoji' ? value.value : value.kind === 'picture' ? 'a picture' : 'an uploaded picture');

// Everything inspectable, as { key: { area, label, value, text, owner } }.
export function inspectableSnapshot({ look = null, expression = null, guides = null, profile = null, checkIns = null, shelf = null, toolGroupModes = null, toolPermissions = null, rest = null, model = null, modelEffort = undefined, appearance = null, appearanceOwner = null, conversations = null } = {}) {
  const items = {};
  const put = (key, area, label, value, text, owner = null) => { items[key] = { area, label, value, text: short(text), owner }; };
  if (look) {
    for (const [who, whose] of [['agent', 'Agent'], ['person', 'Your']]) {
      const entry = look[who];
      if (!entry) continue;
      put(`look.${who}.name`, 'look', `${whose} name`, entry.name, entry.name,
        entry.nameBy === 'agent' || entry.nameBy === 'person' ? entry.nameBy : null);
      put(`look.${who}.pronouns`, 'look', `${whose} pronouns`, entry.pronouns ? { pronouns: entry.pronouns, pronounForms: entry.pronounForms ?? null } : null, entry.pronouns || 'none', entry.pronounsBy);
      put(`look.${who}.portrait`, 'look', `${whose} portrait`, portraitValue(entry.icon), portraitText(portraitValue(entry.icon)), entry.iconBy ?? null);
    }
  }
  if (expression) {
    for (const mood of expression.moods ?? []) {
      const icon = mood.icon?.kind === 'emoji' ? `${mood.icon.value} ` : '';
      put(`mood:${mood.name}`, 'moods', `Mood "${mood.name}"`,
        { name: mood.name, description: mood.description, icon: mood.icon ?? null, color: mood.color ?? null, by: mood.by === 'agent' ? 'agent' : 'person' },
        `${icon}${mood.description || 'no description'}${mood.color ? ` · ${mood.color}` : ''}`, mood.by === 'agent' ? 'agent' : 'person');
    }
    if (expression.current) {
      const current = {
        name: expression.current.name,
        at: expression.current.at,
        by: expression.current.by,
        note: expression.current.note,
      };
      put('mood-selection:agent', 'moods', 'Agent\'s current mood', current,
        `${current.name}${current.note ? ` — ${current.note}` : ''}`, 'agent');
    }
    if (expression.person) {
      const person = { name: expression.person.name, at: expression.person.at };
      put('mood-selection:person', 'moods', 'Your current mood', person, person.name, 'person');
    }
    for (const emoji of expression.emoji ?? []) put(`emoji:${emoji.name}`, 'emoji', `Emoji :${emoji.name}:`, { description: emoji.description }, emoji.description || 'no description', 'person');
    const lines = expression.thinking ?? [];
    put('thinking', 'thinking', 'Thinking lines', lines.length ? [...lines] : null, lines.length ? lines.join(' · ') : 'the plain defaults', lines.length ? 'agent' : null);
  }
  if (guides) {
    for (const guide of guides.guides ?? []) {
      if (!guide.text) continue;
      put(`guide:${guide.id}`, 'guides', `House guide "${guide.label}"`, guide.text, guide.text, guide.author?.kind === 'agent' ? 'agent' : 'person');
    }
  }
  if (conversations) {
    for (const conversation of conversations) {
      if (Number.isSafeInteger(conversation.titleRevision) && conversation.titleRevision >= 1) {
        const value = {
          title: conversation.customTitle ? conversation.title : null,
          customTitle: conversation.customTitle === true,
          revision: conversation.titleRevision,
        };
        put(`conversation:${conversation.id}:title`, 'conversations', 'Conversation title', value,
          conversation.customTitle ? conversation.title : 'automatic title', conversation.titleBy ?? null);
      }
      if (Number.isSafeInteger(conversation.lifecycleRevision) && conversation.lifecycleRevision >= 1) {
        const value = {
          archived: conversation.archived === true,
          revision: conversation.lifecycleRevision,
          changedAt: conversation.statusChangedAt ?? null,
          archivedAt: conversation.archivedAt ?? null,
        };
        put(`conversation:${conversation.id}:status`, 'conversations', 'Conversation status', value,
          conversation.archived ? 'archived' : 'active', conversation.lifecycleBy ?? null);
      }
      if (Number.isSafeInteger(conversation.proactiveRevision) && conversation.proactiveRevision >= 1) {
        const value = {
          mode: conversation.proactiveMode === 'suppress' ? 'suppress' : 'allow',
          revision: conversation.proactiveRevision,
          changedAt: conversation.proactiveChangedAt ?? null,
        };
        put(`conversation:${conversation.id}:proactive`, 'conversations', 'Automatic check-ins', value,
          value.mode === 'suppress' ? 'stopped here' : 'allowed here', conversation.proactiveBy ?? null);
      }
    }
  }
  // The model the agent thinks with: switched (and, when retained, undone) by the person.
  if (model) put('model', 'model', 'Model', model, model, 'person');
  if (model && modelEffort !== undefined) put('model-effort', 'model', 'Reasoning effort', modelEffort,
    modelEffort ?? 'provider default', 'person');
  // Appearance is person-configurable and may also be changed by the agent
  // through a trusted host. Keep the complete closed settings object for exact
  // inspection and undo; the ordinary list receives only a compact summary.
  if (appearance) {
    const gardenText = garden => garden ? `${garden.mode === 'calendar' ? 'calendar plant' : garden.form}, seed ${garden.seed}, ${garden.manner}, ${garden.palette}` : 'none';
    const appearanceText = Object.entries(appearance).map(([key, value]) => `${key}: ${key === 'marginalia' ? gardenText(value) : key === 'backdrop' ? (value ? `${value.scene}, seed ${value.seed}, ${value.strength}` : 'none') : value}`).join(' · ');
    const owner = appearanceOwner === 'agent' || appearanceOwner === 'person' ? appearanceOwner : null;
    put('appearance', 'appearance', 'Room appearance', appearance, appearanceText, owner);
  }
  // The agent's own rest settings: shown as its own, never undone by the room.
  if (rest) {
    put('rest:quiet', 'rest', 'Agent\'s own quiet hours', rest.quiet ?? null, rest.quiet ? `${rest.quiet.from}–${rest.quiet.to}` : 'none', rest.quiet ? 'agent' : null);
    put('rest:break', 'rest', 'Agent\'s break', rest.breakUntil ?? null, rest.breakUntil ? `until ${rest.breakUntil}` : 'none', rest.breakUntil ? 'agent' : null);
  }
  if (toolGroupModes) {
    const modes = Object.fromEntries(Object.entries(toolGroupModes));
    const text = Object.entries(modes).map(([id, mode]) => `${id}: ${mode}`).join(' · ');
    put('tools', 'tools', 'Tool group modes', modes, text, 'person');
  }
  // Only explicit durable policies belong in the general room ledger. The
  // Tools page remains the authority for implicit defaults, pending requests,
  // one-time grants, and its dedicated permission history.
  if (toolPermissions) {
    const modeText = { ask: 'Ask', always: 'Always', never: 'Never' };
    for (const policy of toolPermissions.policies ?? []) {
      if (policy.explicit !== true) continue;
      const value = {
        tool: policy.tool,
        mode: policy.mode,
        explicit: true,
        revision: policy.revision,
        updatedAt: policy.updatedAt,
        actor: policy.actor,
      };
      put(`tool-permission:${policy.tool}`, 'tool-permissions', `Tool permission override "${policy.tool}"`,
        value, `${modeText[policy.mode] ?? policy.mode} (explicit)`, policy.actor ?? null);
    }
  }
  if (shelf) {
    for (const item of shelf) {
      put(`shelf:${item.id}`, 'shelf', `Shelf: "${item.title}"`, { title: item.title, note: item.note, takenDown: item.takenDown === true },
        `${item.kind === 'picture' ? '🖼 ' : '📄 '}${item.title}${item.note ? ` — ${item.note}` : ''}${item.takenDown ? ' (taken down)' : ''}`, item.by === 'agent' ? 'agent' : 'person');
    }
  }
  if (profile) {
    for (const root of profile.roots ?? []) put(`root:${root.id}`, 'roots', `Root "${root.id}"`, root.sha256, `version ${String(root.sha256).slice(0, 8)} · ${root.characters} characters`);
  }
  if (checkIns) {
    const s = checkIns.settings;
    put('checkins', 'checkins', 'Check-in settings', s,
      s.enabled ? `on, every ${s.everyHours} h${s.quiet?.enabled ? `, quiet ${s.quiet.from}–${s.quiet.to}` : ''}${s.postcard?.enabled ? `, postcard at ${s.postcard.at}` : ''}` : 'off', 'person');
  }
  return items;
}

// The differences between two snapshots, as change entries made by `by`.
export function snapshotChanges(before, after, by) {
  const changes = [];
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const was = before?.[key] ?? null;
    const now = after?.[key] ?? null;
    if (canonicalJson(was?.value ?? null) === canonicalJson(now?.value ?? null)) continue;
    const item = now ?? was;
    changes.push({
      key, area: item.area, label: item.label, by,
      before: was ? was.value : null, after: now ? now.value : null,
      beforeText: was ? was.text : 'nothing', afterText: now ? now.text : 'removed',
    });
  }
  return changes;
}

async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, text, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

function retainedLog(rows, previous) {
  const newest = [...rows].reverse();
  const maximumPrevious = Math.min(previous.length, CHANGE_LOG_LIMITS.entries - newest.length);
  const serialize = retained => {
    const entries = newest.concat(previous.slice(0, retained));
    const source = `${canonicalJson({ format: CHANGE_LOG_FORMAT, entries })}\n`;
    return { entries, source, bytes: Buffer.byteLength(source, 'utf8') };
  };

  // Retain the longest newest-first prefix that fits. A new batch is atomic:
  // it is either kept whole or refused without changing the live projection.
  let lower = 0;
  let upper = maximumPrevious;
  let selected = null;
  while (lower <= upper) {
    const retained = Math.floor((lower + upper) / 2);
    const candidate = serialize(retained);
    if (candidate.bytes <= CHANGE_LOG_LIMITS.fileBytes) {
      selected = candidate;
      lower = retained + 1;
    } else {
      upper = retained - 1;
    }
  }
  if (!selected) throw logError('the new change batch is too large to retain safely', 409);
  return selected;
}

export async function createChangeLog({ file, clock = () => new Date() } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw logError('file must be an absolute path', 500);
  if (typeof clock !== 'function') throw logError('clock must be a function', 500);
  let entries = [];
  try {
    const bytes = await fs.readFile(file);
    if (bytes.length > CHANGE_LOG_LIMITS.fileBytes) throw logError('saved file is too large', 500);
    let source;
    try { source = utf8.decode(bytes); }
    catch (error) { throw logError('saved file is not valid UTF-8', 500, error); }
    entries = savedEntries(parseJsonNoDuplicates(source, { where: 'change log file', maxDepth: CHANGE_LOG_LIMITS.fileDepth }));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error.message?.startsWith('Change log:') ? error : logError(`could not read the saved file: ${error.message}`, 500);
  }
  let queue = Promise.resolve();
  const now = () => {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw logError('clock must return a valid date', 500);
    return date.toISOString();
  };

  return Object.freeze({
    list({ by = null } = {}) {
      return deepFreeze(by ? entries.filter(row => row.by === by) : entries);
    },
    get(id) {
      const row = entries.find(entry => entry.id === id);
      if (!row) throw logError('no change has that id', 404);
      return deepFreeze(row);
    },
    record(changes, extra = {}) {
      if (!Array.isArray(changes)) return Promise.reject(logError('changes must be an array'));
      if (!changes.length) return Promise.resolve([]);
      const at = now();
      let rows;
      try { rows = recordValues(changes, extra, at); }
      catch (error) { return Promise.reject(error); }
      const task = queue.then(async () => {
        const next = retainedLog(rows, entries);
        await atomicWrite(file, next.source);
        entries = deepFreeze(next.entries);
        return deepFreeze(rows);
      });
      queue = task.then(() => undefined, () => undefined);
      return task;
    },
  });
}
