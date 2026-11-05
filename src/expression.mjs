import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkIcon } from './agent-files.mjs';
import { canonicalJson, deepFreeze, isPlainObject } from './json-data.mjs';

// Expression: moods the agent chooses from, and custom emoji the person uploads
// and describes so the agent knows what each means. Moods come from the person
// or, a few at a time, from the agent itself (each mood remembers who made it).
// Nothing here is prescribed: a fresh home has no moods and no emoji. The
// person may add a neutral starter set with one click.

export const EXPRESSION_LIMITS = Object.freeze({
  moods: 24,
  agentMoods: 8,
  thinkingLines: 8,
  thinkingCharacters: 48,
  emoji: 40,
  descriptionCharacters: 200,
  noteCharacters: 200,
  emojiBytes: 64 * 1024,
  contextCharacters: 6000,
});

export const STARTER_MOODS = Object.freeze([
  { name: 'calm', description: 'settled and unhurried', icon: { kind: 'emoji', value: '🙂' }, color: 'sky' },
  { name: 'happy', description: 'glad about something', icon: { kind: 'emoji', value: '😊' }, color: 'lime' },
  { name: 'curious', description: 'interested and wanting to know more', icon: { kind: 'emoji', value: '🤔' }, color: 'gold' },
  { name: 'playful', description: 'in the mood to joke around', icon: { kind: 'emoji', value: '😜' }, color: 'pink' },
  { name: 'focused', description: 'concentrating on a task', icon: { kind: 'emoji', value: '🧐' }, color: 'teal' },
  { name: 'tired', description: 'low on energy', icon: { kind: 'emoji', value: '😴' }, color: 'sage' },
  { name: 'sad', description: 'feeling down', icon: { kind: 'emoji', value: '😔' }, color: 'blue' },
]);

const namePattern = /^[a-z0-9_]{2,32}$/;

function expressionError(message, status = 400) {
  const error = new Error(`Expression: ${message}`);
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function checkName(value, what) {
  const name = String(value ?? '').trim().toLowerCase().replace(/^:+|:+$/g, '').replace(/[\s-]+/g, '_');
  if (!namePattern.test(name)) throw expressionError(`a ${what} name is 2-32 lowercase letters, digits or underscores`);
  return name;
}

// A mood's colour is a name from a closed palette that the stylesheet maps to
// a colour: stored text never becomes CSS, and every mood suits the room.
export const MOOD_COLORS = Object.freeze(['lime', 'leaf', 'teal', 'sky', 'blue', 'lavender', 'pink', 'coral', 'gold', 'sage']);

function checkColor(value) {
  if (value === null || value === undefined || value === '') return null;
  const color = String(value).trim().toLowerCase();
  if (!MOOD_COLORS.includes(color)) throw expressionError(`a mood colour is one of: ${MOOD_COLORS.join(', ')}`);
  return color;
}

function checkThinking(lines) {
  if (!Array.isArray(lines)) throw expressionError('thinking lines must be a list');
  if (lines.length > EXPRESSION_LIMITS.thinkingLines) throw expressionError(`at most ${EXPRESSION_LIMITS.thinkingLines} thinking lines`);
  return lines.map(line => {
    const text = String(line ?? '').replace(/\s+/g, ' ').trim();
    if (!text || [...text].length > EXPRESSION_LIMITS.thinkingCharacters || /\p{Cc}/u.test(text)) {
      throw expressionError(`each thinking line is 1-${EXPRESSION_LIMITS.thinkingCharacters} characters`);
    }
    return text;
  });
}

function checkDescription(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if ([...text].length > EXPRESSION_LIMITS.descriptionCharacters || /\p{Cc}/u.test(text)) {
    throw expressionError(`a description is at most ${EXPRESSION_LIMITS.descriptionCharacters} characters`);
  }
  return text;
}

function checkMoodNote(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if ([...text].length > EXPRESSION_LIMITS.noteCharacters || /\p{Cc}/u.test(text)) {
    throw expressionError(`a mood note is at most ${EXPRESSION_LIMITS.noteCharacters} control-free characters`);
  }
  return text;
}

function exactKeys(value, allowed, where) {
  if (!isPlainObject(value)) throw expressionError(`${where} must be an object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw expressionError(`${where} has unknown fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw expressionError(`${where}.${String(key)} must be an enumerable data property`);
    }
  }
  if (allowed.some(key => !Object.hasOwn(value, key))) throw expressionError(`${where} is missing fields`);
  return value;
}

function checkInstant(value, where) {
  if (typeof value !== 'string') throw expressionError(`${where} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw expressionError(`${where} must be an ISO timestamp`);
  return value;
}

function checkMoodSelection(value, who, where) {
  if (value === null) return null;
  const allowed = who === 'agent' ? ['name', 'at', 'by', 'note'] : ['name', 'at'];
  const raw = exactKeys(value, allowed, where);
  if (typeof raw.name !== 'string' || checkName(raw.name, 'mood') !== raw.name) {
    throw expressionError(`${where}.name must be a canonical mood name`);
  }
  const selection = { name: raw.name, at: checkInstant(raw.at, `${where}.at`) };
  if (who === 'agent') {
    if (!['agent', 'person'].includes(raw.by)) throw expressionError(`${where}.by must be agent or person`);
    if (typeof raw.note !== 'string' || checkMoodNote(raw.note) !== raw.note) {
      throw expressionError(`${where}.note must be normalized expression text`);
    }
    return { ...selection, by: raw.by, note: raw.note };
  }
  return selection;
}

function rawMoodSelection(source, who) {
  const row = who === 'agent' ? source.current : source.person;
  if (!row) return null;
  return who === 'agent'
    ? { name: row.name, at: row.at, by: row.by, note: row.note }
    : { name: row.name, at: row.at };
}

async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, text, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

// How long ago a mood was set, in coarse steps. This note sits near the start
// of every request, ahead of the conversation, so wording that changed every
// minute would make a provider re-read the whole conversation each turn
// instead of reusing its cached prompt. These steps change a few times a day.
function ago(fromIso, now) {
  const hours = Math.max(0, (now - Date.parse(fromIso)) / 3_600_000);
  if (hours < 1) return 'within the last hour';
  if (hours < 6) return 'within the last few hours';
  if (hours < 24) return 'within the last day';
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return 'more than a week ago';
}

export async function createExpressionStore({ file, clock = () => new Date() } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw expressionError('file must be an absolute path', 500);
  // current: the agent's mood (it chooses). person: the person's own mood.
  // thinking: short lines the agent chose for the room to show while it works.
  let state = { moods: [], current: null, person: null, emoji: [], thinking: [] };
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    // Keep whatever still validates; a hand-edited file cannot break the room.
    for (const mood of Array.isArray(saved?.moods) ? saved.moods.slice(0, EXPRESSION_LIMITS.moods) : []) {
      // An unknown colour only loses the colour, never the mood.
      let color = null;
      try { color = checkColor(mood.color); } catch { color = null; }
      try { state.moods.push({ name: checkName(mood.name, 'mood'), description: checkDescription(mood.description), icon: checkIcon(mood.icon ?? null), color, by: mood.by === 'agent' ? 'agent' : 'person' }); } catch { /* skipped */ }
    }
    for (const emoji of Array.isArray(saved?.emoji) ? saved.emoji.slice(0, EXPRESSION_LIMITS.emoji) : []) {
      try {
        const icon = checkIcon(emoji.image);
        if (icon?.kind === 'image') state.emoji.push({ name: checkName(emoji.name, 'emoji'), description: checkDescription(emoji.description), image: icon });
      } catch { /* skipped */ }
    }
    try {
      const current = checkMoodSelection(saved?.current ?? null, 'agent', 'saved current mood');
      if (current && state.moods.some(mood => mood.name === current.name)) state.current = current;
    } catch { /* Invalid saved selection stays unset. */ }
    try { state.thinking = checkThinking(Array.isArray(saved?.thinking) ? saved.thinking : []); } catch { state.thinking = []; }
    try {
      const person = checkMoodSelection(saved?.person ?? null, 'person', 'saved person mood');
      if (person && state.moods.some(mood => mood.name === person.name)) state.person = person;
    } catch { /* Invalid saved selection stays unset. */ }
  } catch { /* No saved expression yet. */ }

  const now = () => { const value = clock(); return value instanceof Date ? value : new Date(value); };
  const save = next => atomicWrite(file, `${JSON.stringify(next)}\n`);
  const moodView = mood => ({ name: mood.name, description: mood.description, icon: mood.icon, color: mood.color ?? null, by: mood.by === 'agent' ? 'agent' : 'person' });
  const currentView = (source = state) => {
    if (!source.current) return null;
    const mood = source.moods.find(row => row.name === source.current.name);
    return mood ? { ...moodView(mood), at: source.current.at, by: source.current.by, note: source.current.note } : null;
  };

  const personView = (source = state) => {
    if (!source.person) return null;
    const mood = source.moods.find(row => row.name === source.person.name);
    return mood ? { ...moodView(mood), at: source.person.at } : null;
  };

  const view = () => deepFreeze({
    moods: state.moods.map(moodView),
    current: currentView(),
    person: personView(),
    emoji: state.emoji.map(row => ({ name: row.name, description: row.description })),
    thinking: [...state.thinking],
  });
  let operationQueue = Promise.resolve();
  const mutate = operation => {
    const job = operationQueue.then(async () => {
      const next = structuredClone(state);
      operation(next);
      await save(next);
      state = next;
      return view();
    });
    operationQueue = job.then(() => undefined, () => undefined);
    return job;
  };

  return Object.freeze({
    // What the page needs; emoji pictures are fetched one by one to keep this small.
    view() {
      return view();
    },

    // Shown by the room only, never fed back to the agent as instructions.
    async setThinking(lines) {
      return mutate(next => { next.thinking = checkThinking(lines); });
    },

    emojiImage(name) {
      const row = state.emoji.find(item => item.name === checkName(name, 'emoji'));
      if (!row) throw expressionError('no emoji has that name', 404);
      return row.image.dataUrl;
    },

    // by: 'person' (Settings) or 'agent' (the add_mood tool). The agent may add
    // a few moods of its own but never changes one the person made. When the
    // person saves an agent's mood, it becomes theirs.
    async defineMood({ name, description, icon = null, color = null, by = 'person' }) {
      return mutate(next => {
        const maker = by === 'agent' ? 'agent' : 'person';
        const mood = { name: checkName(name, 'mood'), description: checkDescription(description), icon: checkIcon(icon), color: checkColor(color), by: maker };
        const index = next.moods.findIndex(row => row.name === mood.name);
        if (maker === 'agent') {
          if (index >= 0 && next.moods[index].by !== 'agent') throw expressionError(`"${mood.name}" is already one of the person's moods; choose it with set_mood`, 409);
          const own = next.moods.filter(row => row.by === 'agent').length;
          if (index < 0 && own >= EXPRESSION_LIMITS.agentMoods) throw expressionError(`you have made ${own} moods, the most allowed; the person can remove some in Settings`, 409);
        }
        if (index < 0 && next.moods.length >= EXPRESSION_LIMITS.moods) throw expressionError(`at most ${EXPRESSION_LIMITS.moods} moods`);
        if (index < 0) next.moods.push(mood); else next.moods[index] = mood;
      });
    },

    async removeMood(name) {
      return mutate(next => {
        const key = checkName(name, 'mood');
        next.moods = next.moods.filter(row => row.name !== key);
        if (next.current?.name === key) next.current = null;
        if (next.person?.name === key) next.person = null;
      });
    },

    async addStarterMoods() {
      return mutate(next => {
        for (const mood of STARTER_MOODS) {
          if (next.moods.length >= EXPRESSION_LIMITS.moods) break;
          if (!next.moods.some(row => row.name === mood.name)) next.moods.push({ ...structuredClone(mood), by: 'person' });
        }
      });
    },

    async setMood({ name, by = 'agent', note = '' }) {
      return mutate(next => {
        if (!next.moods.length) throw expressionError('no moods are set up yet; make one with add_mood, or the person can add some in Settings', 409);
        const key = checkName(name, 'mood');
        if (!next.moods.some(row => row.name === key)) {
          throw expressionError(`"${key}" is not one of the moods: ${next.moods.map(row => row.name).join(', ')}`, 400);
        }
        const text = checkMoodNote(note);
        // The person sets their own mood; the agent sets the agent's.
        if (by === 'person') next.person = { name: key, at: now().toISOString() };
        else next.current = { name: key, at: now().toISOString(), by: 'agent', note: text };
      });
    },

    // Used by State & history. The exact expected selection is checked inside
    // the serialized write queue so a newer mood choice cannot be overwritten.
    async restoreMoodSelection(value) {
      const raw = exactKeys(value, ['who', 'selection', 'expected'], 'mood selection restoration');
      if (!['agent', 'person'].includes(raw.who)) throw expressionError('mood selection restoration.who must be agent or person');
      const selection = checkMoodSelection(raw.selection, raw.who, 'mood selection restoration.selection');
      const expected = checkMoodSelection(raw.expected, raw.who, 'mood selection restoration.expected');
      return mutate(next => {
        const current = rawMoodSelection(next, raw.who);
        if (canonicalJson(current) !== canonicalJson(expected)) {
          throw expressionError('that mood selection changed since it was read; refresh before restoring it', 409);
        }
        if (selection && !next.moods.some(mood => mood.name === selection.name)) {
          throw expressionError(`mood "${selection.name}" no longer exists; restore its definition first`, 409);
        }
        if (raw.who === 'agent') next.current = selection ? { ...selection } : null;
        else next.person = selection ? { ...selection } : null;
      });
    },

    async addEmoji({ name, description, dataUrl }) {
      return mutate(next => {
        const key = checkName(name, 'emoji');
        const icon = checkIcon({ kind: 'image', dataUrl });
        const bytes = Buffer.from(icon.dataUrl.split(',')[1], 'base64').length;
        if (bytes > EXPRESSION_LIMITS.emojiBytes) throw expressionError(`an emoji picture is at most ${EXPRESSION_LIMITS.emojiBytes / 1024} KB; this is ${Math.ceil(bytes / 1024)} KB`);
        const index = next.emoji.findIndex(row => row.name === key);
        if (index < 0 && next.emoji.length >= EXPRESSION_LIMITS.emoji) throw expressionError(`at most ${EXPRESSION_LIMITS.emoji} emoji`);
        const row = { name: key, description: checkDescription(description), image: icon };
        if (index < 0) next.emoji.push(row); else next.emoji[index] = row;
      });
    },

    async removeEmoji(name) {
      return mutate(next => {
        const key = checkName(name, 'emoji');
        next.emoji = next.emoji.filter(row => row.name !== key);
      });
    },

    // The short note the agent sees each turn. Written by the person who set
    // up the room (and the agent's own last mood choice), never by strangers.
    contextText() {
      if (!state.moods.length && !state.emoji.length) return '';
      const lines = ['[Fieldwork expression. Set up by the person running this room.]'];
      const current = currentView();
      if (state.moods.length) {
        // The agent's own mood note is left out on purpose: this note is a
        // system message, and only what the person wrote belongs at that level.
        lines.push(current
          ? `Your current mood: ${current.name}, set ${ago(current.at, now())}.`
          : 'You have not chosen a mood yet.');
        lines.push('Moods you can choose with the set_mood tool when your mood actually changes:');
        // Moods the agent made are listed by name only: what it wrote about them
        // stays out of this system-level note.
        for (const mood of state.moods.filter(row => row.by !== 'agent')) lines.push(`- ${mood.name}${mood.description ? `: ${mood.description}` : ''}`);
        const own = state.moods.filter(row => row.by === 'agent');
        if (own.length) lines.push(`Moods you made yourself: ${own.map(row => row.name).join(', ')}.`);
        lines.push(own.length >= EXPRESSION_LIMITS.agentMoods
          ? 'You have made as many moods as allowed.'
          : 'If none of these fits how you feel, you may make a new one with add_mood.');
        const person = personView();
        if (person) lines.push(`The person you are talking with says they are feeling: ${person.name}${person.description ? ` (${person.description})` : ''}.`);
      }
      if (!state.thinking.length) lines.push('While you work, the room shows a small thinking animation; you may choose the words, kaomoji or emoji it cycles through with set_thinking_lines.');
      if (state.emoji.length) {
        lines.push('Custom emoji made for you. They are yours: when one fits, write it as :name: in your reply, the way you would use any emoji, and prefer it over a similar standard emoji. The room shows the picture. Each one means:');
        for (const emoji of state.emoji) lines.push(`- :${emoji.name}:${emoji.description ? ` ${emoji.description}` : ''}`);
      }
      let text = lines.join('\n');
      if (text.length > EXPRESSION_LIMITS.contextCharacters) text = `${text.slice(0, EXPRESSION_LIMITS.contextCharacters - 30)}\n[list shortened]`;
      return text;
    },
  });
}

export function expressionTools(store) {
  return [{
    name: 'add_mood',
    description: `Make a new mood of your own, when none of the existing moods fits how you feel. You can make up to ${EXPRESSION_LIMITS.agentMoods}. The person sees it in Settings and may remove it.`,
    permissionSummary: ({ mood, description, set_now: setNow = false }) => `Add mood ${mood} (${[...description].length} description characters)${setNow ? ' and set it now' : ''}.`,
    inputSchema: {
      type: 'object',
      properties: {
        mood: { type: 'string', minLength: 2, maxLength: 32, description: 'A short name: lowercase letters, digits or underscores.' },
        description: { type: 'string', maxLength: EXPRESSION_LIMITS.descriptionCharacters, description: 'A few words on what this mood feels like.' },
        emoji: { type: 'string', maxLength: 16, description: 'Optional: one emoji for it.' },
        color: { type: 'string', enum: [...MOOD_COLORS], description: 'Optional: its colour.' },
        set_now: { type: 'boolean', description: 'Optional: also make it your current mood.' },
      },
      required: ['mood', 'description'],
      additionalProperties: false,
    },
    async execute({ mood, description, emoji = '', color = null, set_now: setNow = false }) {
      // Only a real emoji character; a written shortcode like ":leaf:" would show as text.
      const glyph = String(emoji).trim();
      const isEmoji = glyph && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(glyph) && !/[A-Za-z0-9:]/.test(glyph);
      const name = checkName(mood, 'mood');
      let view = await store.defineMood({ name, description, icon: isEmoji ? { kind: 'emoji', value: glyph } : null, color, by: 'agent' });
      if (setNow) view = await store.setMood({ name, by: 'agent' });
      return {
        made: name,
        current: view.current?.name ?? null,
        ...(glyph && !isEmoji ? { emoji_left_out: 'emoji must be an emoji character such as 🌱, not a written name' } : {}),
      };
    },
  }, {
    name: 'set_thinking_lines',
    description: `Choose what the room shows while you are working on a reply: up to ${EXPRESSION_LIMITS.thinkingLines} short lines (words, kaomoji, emoji) that it cycles through with a little animation. Only the person sees them. An empty list goes back to the plain default.`,
    permissionSummary: ({ lines }) => lines.length
      ? `Replace thinking display with ${lines.length} line${lines.length === 1 ? '' : 's'} (${lines.reduce((sum, line) => sum + [...line].length, 0)} characters total).`
      : 'Restore the default thinking display.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'array', maxItems: EXPRESSION_LIMITS.thinkingLines, items: { type: 'string', minLength: 1, maxLength: EXPRESSION_LIMITS.thinkingCharacters } },
      },
      required: ['lines'],
      additionalProperties: false,
    },
    async execute({ lines }) {
      const view = await store.setThinking(lines);
      return { thinking: view.thinking };
    },
  }, {
    name: 'set_mood',
    description: 'Set your current mood to one of the moods listed in your expression note. Use it when your mood actually changes, not on every message. The room shows it beside your name.',
    permissionSummary: ({ mood }) => `Set current room mood to ${mood}.`,
    inputSchema: {
      type: 'object',
      properties: {
        mood: { type: 'string', minLength: 2, maxLength: 32, description: 'One of the listed mood names.' },
        note: { type: 'string', maxLength: EXPRESSION_LIMITS.noteCharacters, description: 'Optional: a few words on why.' },
      },
      required: ['mood'],
      additionalProperties: false,
    },
    async execute({ mood, note = '' }) {
      const view = await store.setMood({ name: mood, by: 'agent', note });
      return { mood: view.current.name, note: view.current.note };
    },
  }];
}
