import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deepFreeze } from './json-data.mjs';
import { isLoadedProfile, loadProfile, PROFILE_LIMITS } from './profile.mjs';

// Editing an agent's root files (identity, relationships, voice…) and the
// room's look of the agent and the person (names, icons, and pronouns), from the browser.
//
// Root edits are conflict-checked against the file's current hash, keep the
// previous version in a history folder so any edit can be undone, and reload
// the profile so the next reply uses the new text. Nothing outside the files
// the profile already names is ever written.

export const AGENT_FILES_LIMITS = Object.freeze({
  historyVersions: 50,
  nameCharacters: 40,
  pronounCharacters: 80,
  pronounFormCharacters: 32,
  iconBytes: 256 * 1024,
  emojiCharacters: 8,
});

const roomLooks = new WeakSet();

const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const stamp = date => date.toISOString().replace(/[:.]/g, '-');

function filesError(message, status) {
  const error = new Error(`Agent files: ${message}`);
  if (status) Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

async function atomicWrite(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, text, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

export async function createRootEditor({ profile, historyDir, clock = () => new Date(), onReload = () => {} } = {}) {
  if (!isLoadedProfile(profile)) throw filesError('profile must be returned by loadProfile()');
  if (typeof historyDir !== 'string' || !path.isAbsolute(historyDir)) throw filesError('historyDir must be an absolute directory');
  let current = profile;
  let queue = Promise.resolve();
  const serial = work => { const run = queue.then(work); queue = run.catch(() => {}); return run; };

  const rootFor = id => {
    const root = current.roots.find(row => row.id === id);
    if (!root) throw filesError('no root has that id', 404);
    return root;
  };
  // The profile loader already refused traversal and links when it loaded this
  // path; check again that the file is a plain file inside the home before writing.
  const fileFor = async root => {
    const file = path.join(current.home, ...root.path.split('/'));
    if (path.relative(current.home, file).startsWith('..')) throw filesError('that root is outside the agent home', 400);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw filesError('that root is not a plain file', 400);
    return file;
  };
  const historyFor = id => path.join(historyDir, id);

  async function keepVersion(root, text) {
    const dir = historyFor(root.id);
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, `${stamp(clock())}.md`), text);
    const versions = (await fs.readdir(dir)).filter(name => name.endsWith('.md')).sort();
    for (const old of versions.slice(0, Math.max(0, versions.length - AGENT_FILES_LIMITS.historyVersions))) {
      await fs.rm(path.join(dir, old), { force: true });
    }
  }

  async function write(root, text) {
    if (typeof text !== 'string' || !text.trim()) throw filesError('a root cannot be empty', 400);
    if (!text.isWellFormed()) throw filesError('the text must be well-formed Unicode', 400);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > PROFILE_LIMITS.rootBytes) throw filesError(`a root is at most ${PROFILE_LIMITS.rootBytes} bytes; this is ${bytes}`, 400);
    const file = await fileFor(root);
    const before = await fs.readFile(file, 'utf8');
    await keepVersion(root, before);
    await atomicWrite(file, text);
    try {
      current = await loadProfile(current.home, { clock });
    } catch (error) {
      // The new text broke the profile (too large in total, say): put the old one back.
      await atomicWrite(file, before);
      current = await loadProfile(current.home, { clock });
      throw filesError(`the profile would not load with that change, so it was undone: ${error.message}`, 400);
    }
    onReload(current);
    return current;
  }

  return Object.freeze({
    get profile() { return current; },

    get(id) {
      const root = rootFor(id);
      return deepFreeze({ id: root.id, path: root.path, placement: root.placement, text: root.text, sha256: sha256(root.text) });
    },

    save({ id, text, expectedSha256 }) {
      return serial(async () => {
        const root = rootFor(id);
        const onDisk = await fs.readFile(await fileFor(root), 'utf8');
        if (sha256(onDisk) !== expectedSha256) {
          throw filesError('this file changed since you opened it; reopen it to see the latest version', 409);
        }
        await write(root, text);
        return this.get(id);
      });
    },

    async history(id) {
      rootFor(id);
      let names = [];
      try { names = (await fs.readdir(historyFor(id))).filter(name => name.endsWith('.md')); } catch { names = []; }
      const rows = [];
      for (const name of names.sort().reverse()) {
        const text = await fs.readFile(path.join(historyFor(id), name), 'utf8');
        rows.push({ version: name.slice(0, -3), characters: [...text].length, preview: text.replace(/\s+/g, ' ').trim().slice(0, 120) });
      }
      return deepFreeze(rows);
    },

    restore({ id, version }) {
      return serial(async () => {
        const root = rootFor(id);
        if (typeof version !== 'string' || !/^[0-9TZ-]{10,40}$/.test(version)) throw filesError('that is not a saved version', 400);
        let text;
        try { text = await fs.readFile(path.join(historyFor(id), `${version}.md`), 'utf8'); }
        catch { throw filesError('that version is not in the history', 404); }
        await write(root, text);
        return this.get(id);
      });
    },
  });
}

// ---- names, icons and pronouns --------------------------------------------------

const imageTypes = {
  'image/png': bytes => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8,
  'image/webp': bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/gif': bytes => bytes.subarray(0, 4).toString('latin1') === 'GIF8',
};

export function checkIcon(icon) {
  if (icon === null) return null;
  if (icon?.kind === 'emoji') {
    const value = String(icon.value ?? '').trim();
    if (!value || [...value].length > AGENT_FILES_LIMITS.emojiCharacters || /[\p{Cc}<>]/u.test(value)) throw filesError('an emoji icon is one to eight characters', 400);
    return { kind: 'emoji', value };
  }
  if (icon?.kind === 'image') {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(icon.dataUrl ?? ''));
    if (!match) throw filesError('an image icon must be a PNG, JPEG, WebP or GIF', 400);
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > AGENT_FILES_LIMITS.iconBytes) throw filesError(`an image icon is at most ${AGENT_FILES_LIMITS.iconBytes / 1024} KB`, 400);
    if (!imageTypes[match[1]](bytes)) throw filesError('that file is not the kind of image it claims to be', 400);
    return { kind: 'image', dataUrl: `data:${match[1]};base64,${bytes.toString('base64')}` };
  }
  throw filesError('an icon is an emoji, an image, or none', 400);
}

// A portrait may also be a picture kept in the room's picture store, named by
// its SHA-256, so a portrait can be any picture the person shared, at any size
// the picture store accepts.
export const PORTRAIT_HISTORY = 12;
const pictureRef = /^[0-9a-f]{64}$/;

function checkLookIcon(icon) {
  if (icon?.kind === 'picture') {
    const ref = String(icon.ref ?? '');
    if (!pictureRef.test(ref)) throw filesError('a picture portrait needs a picture reference', 400);
    return { kind: 'picture', ref };
  }
  return checkIcon(icon);
}

const sameIcon = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function normalizeName(name) {
  const text = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (text && ([...text].length > AGENT_FILES_LIMITS.nameCharacters || /[\p{Cc}]/u.test(text))) {
    throw filesError(`a name is at most ${AGENT_FILES_LIMITS.nameCharacters} characters`, 400);
  }
  return text;
}

function checkPronouns(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if ([...text].length > AGENT_FILES_LIMITS.pronounCharacters || /\p{Cc}/u.test(text)) {
    throw filesError(`pronouns are at most ${AGENT_FILES_LIMITS.pronounCharacters} characters`, 400);
  }
  return text;
}

const pronounFormKeys = Object.freeze([
  'subject', 'object', 'possessiveDeterminer', 'possessivePronoun', 'reflexive',
]);
const pronounAgreements = new Set(['singular', 'plural']);
const pronounPresets = new Map([
  ['she/her', ['she', 'her', 'her', 'hers', 'herself', 'singular']],
  ['he/him', ['he', 'him', 'his', 'his', 'himself', 'singular']],
  ['they/them', ['they', 'them', 'their', 'theirs', 'themself', 'plural']],
  ['it/its', ['it', 'it', 'its', 'its', 'itself', 'singular']],
  ['xe/xem', ['xe', 'xem', 'xyr', 'xyrs', 'xemself', 'singular']],
  ['ze/hir', ['ze', 'hir', 'hir', 'hirs', 'hirself', 'singular']],
  ['ze/zir', ['ze', 'zir', 'zir', 'zirs', 'zirself', 'singular']],
  ['fae/faer', ['fae', 'faer', 'faer', 'faers', 'faerself', 'singular']],
  ['ey/em', ['ey', 'em', 'eir', 'eirs', 'emself', 'singular']],
]);

function checkPronounForm(value, where) {
  if (typeof value !== 'string') throw filesError(`${where} must be text`, 400);
  const text = value.trim();
  if (!text || [...text].length > AGENT_FILES_LIMITS.pronounFormCharacters || /\p{Cc}/u.test(text)) {
    throw filesError(`${where} is 1-${AGENT_FILES_LIMITS.pronounFormCharacters} characters`, 400);
  }
  return text;
}

function checkPronounForms(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw filesError('pronoun forms must be an object', 400);
  const allowed = new Set([...pronounFormKeys, 'agreement']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw filesError(`pronoun forms have unknown field ${JSON.stringify(key)}`, 400);
  const forms = Object.fromEntries(pronounFormKeys.map(key => [key, checkPronounForm(value[key], `pronoun form ${key}`)]));
  if (!pronounAgreements.has(value.agreement)) throw filesError('pronoun form agreement must be singular or plural', 400);
  return { ...forms, agreement: value.agreement };
}

function formsFromParts(parts, agreement) {
  return {
    subject: parts[0],
    object: parts[1],
    possessiveDeterminer: parts[2],
    possessivePronoun: parts[3],
    reflexive: parts[4],
    agreement,
  };
}

// The display label remains literal. Grammar is derived only from a short
// closed list of familiar labels or an explicit five-part slash form. Anything
// ambiguous falls back to "the agent" in the browser instead of being guessed.
function derivePronounForms(label) {
  if (!label) return null;
  const candidates = label.split(/\s*(?:\+|,|\bor\b)\s*/iu).filter(Boolean);
  for (const candidate of candidates) {
    const compact = candidate.replace(/\s*\/\s*/gu, '/');
    const preset = pronounPresets.get(compact.toLocaleLowerCase('en-US'));
    if (preset) return formsFromParts(preset.slice(0, 5), preset[5]);
    const parts = compact.split('/');
    if (parts.length === 5) {
      try {
        const checked = parts.map((part, index) => checkPronounForm(part, `pronoun form ${pronounFormKeys[index]}`));
        return formsFromParts(checked, checked[0].toLocaleLowerCase('en-US') === 'they' ? 'plural' : 'singular');
      } catch { /* Try another set in the display label. */ }
    }
  }
  return null;
}

// stashPicture(dataUrl) -> ref, when given, keeps a replaced uploaded portrait
// in the picture store so history holds only small references.
export async function createRoomLook({ file, stashPicture = null, clock = () => new Date() } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw filesError('file must be an absolute path');
  const defaults = {
    agent: { name: 'Agent', nameBy: null, icon: null, iconBy: null, iconHistory: [], pronouns: null, pronounForms: null, pronounsBy: null },
    person: { name: 'You', nameBy: null, icon: null, iconBy: null, iconHistory: [], pronouns: null, pronounForms: null, pronounsBy: null },
  };
  const isoNow = () => { const value = clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); };
  let look = structuredClone(defaults);
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const who of ['agent', 'person']) {
      try {
        const enteredName = normalizeName(saved?.[who]?.name);
        const pronouns = checkPronouns(saved?.[who]?.pronouns);
        const pronounsBy = pronouns && ['agent', 'person'].includes(saved?.[who]?.pronounsBy) ? saved[who].pronounsBy : null;
        let pronounForms = derivePronounForms(pronouns);
        if (pronouns && saved?.[who]?.pronounForms !== undefined) {
          try { pronounForms = checkPronounForms(saved[who].pronounForms); }
          catch { /* Keep a safe derivation from the literal label. */ }
        }
        const iconHistory = [];
        for (const row of Array.isArray(saved?.[who]?.iconHistory) ? saved[who].iconHistory.slice(0, PORTRAIT_HISTORY) : []) {
          try { iconHistory.push({ icon: checkLookIcon(row.icon), by: ['agent', 'person'].includes(row.by) ? row.by : null, at: String(row.at ?? '') }); }
          catch { /* An unreadable old portrait is dropped. */ }
        }
        look[who] = {
          name: enteredName || defaults[who].name,
          nameBy: enteredName && ['agent', 'person'].includes(saved?.[who]?.nameBy) ? saved[who].nameBy : null,
          icon: checkLookIcon(saved?.[who]?.icon ?? null),
          iconBy: ['agent', 'person'].includes(saved?.[who]?.iconBy) ? saved[who].iconBy : null,
          iconHistory,
          pronouns,
          pronounForms,
          pronounsBy,
        };
      }
      catch { look[who] = structuredClone(defaults[who]); }
    }
  } catch { /* No saved look yet. */ }
  let queue = Promise.resolve();
  const serial = work => { const task = queue.then(work); queue = task.then(() => undefined, () => undefined); return task; };

  const roomLook = Object.freeze({
    get() { return deepFreeze(structuredClone(look)); },
    update({ who, name, icon, pronouns, pronounForms, by = 'person' }) {
      return serial(async () => {
        if (who !== 'agent' && who !== 'person') throw filesError('who must be agent or person', 400);
        if (!['agent', 'person'].includes(by)) throw filesError('by must be agent or person', 400);
        const next = structuredClone(look);
        if (name !== undefined) {
          const entered = normalizeName(name);
          const chosen = entered || defaults[who].name;
          if (chosen !== next[who].name || (!entered && next[who].nameBy !== null)) {
            next[who].name = chosen;
            next[who].nameBy = entered ? by : null;
          }
        }
        if (icon !== undefined) {
          const chosen = checkLookIcon(icon);
          if (!sameIcon(chosen, next[who].icon)) {
            // The portrait being replaced is kept, so it can always come back.
            let previous = next[who].icon;
            if (previous?.kind === 'image' && stashPicture) {
              try { previous = { kind: 'picture', ref: await stashPicture(previous.dataUrl) }; } catch { /* keep it as it is */ }
            }
            if (previous && previous.kind !== 'image') {
              next[who].iconHistory = [{ icon: previous, by: next[who].iconBy, at: isoNow() }, ...next[who].iconHistory.filter(row => !sameIcon(row.icon, previous))]
                .slice(0, PORTRAIT_HISTORY);
            }
            next[who].icon = chosen;
            next[who].iconBy = chosen ? by : null;
            // A restored portrait leaves history; it is current again.
            next[who].iconHistory = next[who].iconHistory.filter(row => !sameIcon(row.icon, chosen));
          }
        }
        if (pronouns !== undefined) {
          next[who].pronouns = checkPronouns(pronouns);
          if (!next[who].pronouns && pronounForms !== undefined) throw filesError('pronoun forms need a pronoun display label', 400);
          next[who].pronounForms = next[who].pronouns
            ? (pronounForms === undefined ? derivePronounForms(next[who].pronouns) : checkPronounForms(pronounForms))
            : null;
          next[who].pronounsBy = next[who].pronouns ? by : null;
        } else if (pronounForms !== undefined) {
          throw filesError('pronoun forms need a pronoun display label', 400);
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await atomicWrite(file, `${JSON.stringify(next)}\n`);
        look = next;
        return this.get();
      });
    },

    // Brings back an earlier portrait (0 = the one just replaced). The current one
    // goes into history in its place, so restoring is itself undoable.
    restoreIcon({ who, index, by = 'person' }) {
      const entry = look[who];
      if (!entry) return Promise.reject(filesError('who must be agent or person', 400));
      const row = Number.isSafeInteger(index) ? entry.iconHistory[index] : undefined;
      if (!row) return Promise.reject(filesError('there is no earlier portrait with that number', 404));
      return this.update({ who, icon: row.icon, by });
    },

    contextText() {
      const entry = look.agent;
      if (!entry.pronouns) return '';
      const source = entry.pronounsBy === 'agent'
        ? 'You chose these display pronouns.'
        : 'The person set these display pronouns; you may keep, replace, or clear them.';
      const grammar = entry.pronounForms
        ? `Authored room sentences use these exact forms: ${JSON.stringify(entry.pronounForms)}.`
        : 'Authored room sentences use "the agent" because no unambiguous grammar forms were supplied.';
      return `Fieldwork room display: your current UI name is ${JSON.stringify(entry.name)} and the pronouns shown beside it are ${JSON.stringify(entry.pronouns)}. ${grammar} ${source} You can change them with set_my_pronouns. This display value does not override your identity roots.`;
    },
  });
  roomLooks.add(roomLook);
  return roomLook;
}

export function roomLookTools(look) {
  if (!roomLooks.has(look)) throw filesError('roomLookTools needs a live room look');
  return [{
    name: 'set_my_pronouns',
    description: `Set the pronouns shown beside your name and used in Fieldwork's authored UI sentences. Familiar labels are expanded automatically. For uncommon pronouns, supply all five exact grammar forms and agreement. This changes only this agent's local room display, not identity roots or any other agent. Use an empty string to remove them.`,
    permissionSummary: ({ pronouns, subject }) => pronouns
      ? `Set this agent's room pronouns to ${pronouns}${subject === undefined ? '' : ' with explicit grammar forms'}.`
      : `Remove this agent's room pronoun badge.`,
    inputSchema: {
      type: 'object',
      properties: {
        pronouns: {
          type: 'string',
          maxLength: AGENT_FILES_LIMITS.pronounCharacters,
          description: 'Your pronouns exactly as you want the badge displayed, for example she/her, they/them, any pronouns, or name only.',
        },
        subject: { type: 'string', minLength: 1, maxLength: AGENT_FILES_LIMITS.pronounFormCharacters, description: 'Optional exact subject form, such as xe. Supply every grammar field when using this.' },
        object: { type: 'string', minLength: 1, maxLength: AGENT_FILES_LIMITS.pronounFormCharacters, description: 'Optional exact object form, such as xem.' },
        possessive_determiner: { type: 'string', minLength: 1, maxLength: AGENT_FILES_LIMITS.pronounFormCharacters, description: 'Optional exact form used before a noun, such as xyr.' },
        possessive_pronoun: { type: 'string', minLength: 1, maxLength: AGENT_FILES_LIMITS.pronounFormCharacters, description: 'Optional exact standalone possessive form, such as xyrs.' },
        reflexive: { type: 'string', minLength: 1, maxLength: AGENT_FILES_LIMITS.pronounFormCharacters, description: 'Optional exact reflexive form, such as xemself.' },
        agreement: { type: 'string', enum: ['singular', 'plural'], description: 'Whether authored UI verbs use singular or plural agreement.' },
      },
      required: ['pronouns'],
      additionalProperties: false,
    },
    async execute({ pronouns, subject, object, possessive_determiner: possessiveDeterminer, possessive_pronoun: possessivePronoun, reflexive, agreement }) {
      const values = [subject, object, possessiveDeterminer, possessivePronoun, reflexive, agreement];
      const supplied = values.filter(value => value !== undefined).length;
      if (supplied !== 0 && supplied !== values.length) throw filesError('custom pronouns need subject, object, both possessive forms, reflexive, and agreement', 400);
      const pronounForms = supplied === values.length
        ? { subject, object, possessiveDeterminer, possessivePronoun, reflexive, agreement }
        : undefined;
      const view = await look.update({ who: 'agent', pronouns, pronounForms, by: 'agent' });
      return { pronouns: view.agent.pronouns, pronounForms: view.agent.pronounForms, displayed: Boolean(view.agent.pronouns) };
    },
  }];
}
