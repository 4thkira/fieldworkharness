import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';

// Tool groups: the person makes each group resident, loadable on demand for
// one run, or unavailable. Modes change schema residency, never host authority:
// an off group cannot be loaded and no mode grants a tool kit the host omitted.

export const TOOL_GROUPS = Object.freeze([
  { id: 'help', label: 'Fieldwork help', summary: 'Searching and reading the documentation packaged with this Fieldwork build.' },
  { id: 'memory', label: 'Memory', summary: 'Writing, timing, reviewing, revising and forgetting memories, plus searching saved conversation evidence.' },
  { id: 'notebook', label: 'Notebook', summary: 'Reading and writing files in its notebook folder.' },
  { id: 'collections', label: 'Collections', summary: 'Little searchable databases of markdown in its notebook.' },
  { id: 'shelf', label: 'Shelf', summary: 'Keeping and showing pictures and files on its shelf.' },
  { id: 'web', label: 'Web', summary: 'Reading public web pages.' },
  { id: 'clock', label: 'Clock', summary: 'Checking the date and time.' },
  { id: 'expression', label: 'Moods & expression', summary: 'Choosing and making moods, thinking lines.' },
  { id: 'self', label: 'Self & room', summary: 'Its pronouns, portrait, house guides, its own rest, notes to you, and reading the change log.' },
  { id: 'other', label: 'Other', summary: 'Tools from packs and anything not in a group above.' },
]);

const BY_NAME = new Map(Object.entries({
  search_fieldwork_docs: 'help', read_fieldwork_doc: 'help',
  remember: 'memory', recall: 'memory', inspect_memory: 'memory', review_due_memories: 'memory', update_memory_lifecycle: 'memory',
  search_conversations: 'memory', revise_memory: 'memory', forget: 'memory',
  list_files: 'notebook', read_file: 'notebook', write_file: 'notebook',
  list_collections: 'collections', make_collection: 'collections', save_entry: 'collections', read_entry: 'collections', search_collections: 'collections', remove_entry: 'collections',
  put_on_shelf: 'shelf', look_at_shelf: 'shelf', read_from_shelf: 'shelf', edit_shelf_item: 'shelf', take_down_from_shelf: 'shelf',
  read_web_page: 'web',
  what_time_is_it: 'clock',
  set_mood: 'expression', add_mood: 'expression', set_thinking_lines: 'expression',
  set_my_quiet_hours: 'self', take_a_break: 'self', tell_my_builder: 'self', my_notes_to_builder: 'self',
  set_my_pronouns: 'self', set_my_portrait: 'self', restore_my_portrait: 'self', read_house_guides: 'self', rewrite_house_guides: 'self', review_changes: 'self',
}));

export const toolGroupOf = name => BY_NAME.get(name) ?? 'other';

// About how much prompt space a tool's declaration takes (four characters
// per token is a common rough rule; real tokenizers differ).
export const estimatedTokens = declaration => Math.ceil(JSON.stringify(declaration).length / 4);

// A gentle warning above this many offered tools: small models start missing them.
export const MANY_TOOLS = 25;
export const TOOL_GROUP_SETTINGS_FORMAT = 'fieldwork-tool-groups/v3';
export const TOOL_GROUP_MODES = Object.freeze(['resident', 'on-demand', 'off']);

// A brand-new agent starts light: the kits the person chose at setup stay
// declared, and the room's own extras (including the goal and promise tools,
// which sit in "other") wait on demand. With every group resident a new room
// offers about 40 tool schemas, and the small local models suggested for a
// first start stop noticing tools in a list that long. Agents that already
// exist keep their saved (or all-resident) modes.
export const NEW_AGENT_TOOL_GROUP_MODES = Object.freeze({
  help: 'on-demand',
  memory: 'resident',
  notebook: 'resident',
  collections: 'on-demand',
  shelf: 'on-demand',
  web: 'resident',
  clock: 'resident',
  expression: 'on-demand',
  self: 'on-demand',
  other: 'on-demand',
});

// The starting modes for an agent state folder: the light new-agent set when
// the agent has never held a conversation or a memory there, otherwise null
// (keep the existing default). Check this before any store creates its files.
export async function startingToolGroupModes(stateDir) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw groupError('stateDir must be an absolute path', 500);
  for (const name of ['memory.jsonl', 'conversation.jsonl', 'tool-groups.json']) {
    try {
      await fs.lstat(path.join(stateDir, name));
      return null;
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
    }
  }
  return NEW_AGENT_TOOL_GROUP_MODES;
}

const settingsObjects = new WeakSet();

function groupError(message, status = 400) {
  const error = new Error(`Tool groups: ${message}`);
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

export async function createToolGroupSettings({ file, initialModes = null } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw groupError('file must be an absolute path', 500);
  const ids = TOOL_GROUPS.map(group => group.id);
  const known = new Set(ids);
  const defaults = () => new Map(ids.map(id => [id, 'resident']));
  const exactKeys = (value, allowed, where) => {
    if (!isPlainObject(value)) throw groupError(`${where} must be an object`, 500);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) throw groupError(`${where} has unknown fields`, 500);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw groupError(`${where}.${String(key)} must be an enumerable data property`, 500);
    }
    return value;
  };
  const parseSaved = saved => {
    exactKeys(saved, saved?.format === 'fieldwork-tool-groups/v1' ? ['format', 'off'] : ['format', 'modes'], 'saved settings');
    if (saved.format === 'fieldwork-tool-groups/v1') {
      if (!Array.isArray(saved.off) || new Set(saved.off).size !== saved.off.length || saved.off.some(id => !known.has(id))) {
        throw groupError('saved v1 settings.off must contain unique known group ids', 500);
      }
      const migrated = defaults();
      migrated.set('help', 'on-demand');
      for (const id of saved.off) migrated.set(id, 'off');
      return migrated;
    }
    const legacyV2 = saved.format === 'fieldwork-tool-groups/v2';
    if (!legacyV2 && saved.format !== TOOL_GROUP_SETTINGS_FORMAT) throw groupError('saved settings.format is unsupported', 500);
    const savedIds = legacyV2 ? ids.filter(id => id !== 'help') : ids;
    exactKeys(saved.modes, savedIds, 'saved settings.modes');
    if (Reflect.ownKeys(saved.modes).length !== savedIds.length) throw groupError('saved settings.modes must name every tool group', 500);
    const restored = new Map();
    for (const id of ids) {
      const mode = legacyV2 && id === 'help' ? 'on-demand' : saved.modes[id];
      if (!TOOL_GROUP_MODES.includes(mode)) throw groupError(`saved settings.modes.${id} is invalid`, 500);
      restored.set(id, mode);
    }
    return restored;
  };
  const validateModes = value => {
    exactKeys(value, ids, 'modes');
    if (Reflect.ownKeys(value).length !== ids.length) throw groupError('modes must name every tool group');
    return new Map(ids.map(id => {
      if (!TOOL_GROUP_MODES.includes(value[id])) throw groupError(`modes.${id} must be resident, on-demand, or off`);
      return [id, value[id]];
    }));
  };
  const starting = initialModes === null ? null : validateModes(initialModes);
  let current = defaults();
  let missing = false;
  try {
    current = parseSaved(parseJsonNoDuplicates(await fs.readFile(file, 'utf8'), { where: 'saved tool-group settings' }));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (String(error?.message ?? '').startsWith('Tool groups:')) throw error;
      throw groupError(`could not read saved settings: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
    missing = true;
  }
  let queue = Promise.resolve();
  const snapshot = () => deepFreeze(Object.fromEntries(ids.map(id => [id, current.get(id)])));
  const persist = async next => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    const modes = Object.fromEntries(ids.map(id => [id, next.get(id)]));
    await fs.writeFile(temporary, `${JSON.stringify({ format: TOOL_GROUP_SETTINGS_FORMAT, modes })}\n`, { flag: 'wx' });
    try { await fs.rename(temporary, file); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  };
  const enqueue = operation => {
    const job = queue.then(operation);
    queue = job.then(() => undefined, () => undefined);
    return job;
  };
  // Starting modes apply once, to an agent with no saved settings, and are
  // saved straight away so the choice is visible and never flips later.
  if (missing && starting) {
    await persist(starting);
    current = starting;
  }
  const settings = Object.freeze({
    mode(id) {
      if (!known.has(id)) throw groupError(`unknown group "${id}"`);
      return current.get(id);
    },
    modes: snapshot,
    isResident(id) { return settings.mode(id) === 'resident'; },
    isAvailable(id) { return settings.mode(id) !== 'off'; },
    isOn(id) { return settings.isAvailable(id); },
    off: () => deepFreeze(ids.filter(id => current.get(id) === 'off')),
    async set(id, mode) {
      if (!known.has(id)) throw groupError(`unknown group "${id}"`);
      if (!TOOL_GROUP_MODES.includes(mode)) throw groupError('mode must be resident, on-demand, or off');
      return enqueue(async () => {
        if (current.get(id) === mode) return snapshot();
        const next = new Map(current);
        next.set(id, mode);
        await persist(next);
        current = next;
        return snapshot();
      });
    },
    async replace(value) {
      const replacement = validateModes(value);
      return enqueue(async () => {
        if (ids.every(id => current.get(id) === replacement.get(id))) return snapshot();
        await persist(replacement);
        current = replacement;
        return snapshot();
      });
    },
  });
  settingsObjects.add(settings);
  return settings;
}

export function isToolGroupSettings(value) {
  return Boolean(value) && settingsObjects.has(value);
}
