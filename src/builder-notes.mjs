import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deepFreeze, isPlainObject } from './json-data.mjs';

// Notes from the agent to the person who runs its room: "this is broken",
// "this is confusing", "I wish this existed". The person marks them seen or
// done and may reply in a line; the agent can read the status and the reply,
// so a note is never sent into silence.

export const BUILDER_NOTE_LIMITS = Object.freeze({
  notes: 200,
  whatCharacters: 200,
  detailCharacters: 2000,
  replyCharacters: 500,
  perDay: 10,
});

const KINDS = ['broken', 'confusing', 'wish'];
const STATUSES = ['new', 'seen', 'done'];

function noteError(message, status = 400) {
  const error = new Error(`Builder notes: ${message}`);
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function clean(value, limit, what, { required = false, multiline = false } = {}) {
  let text = String(value ?? '');
  text = multiline ? text.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim() : text.replace(/\s+/g, ' ').trim();
  if (required && !text) throw noteError(`${what} must not be empty`);
  if ([...text].length > limit || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) throw noteError(`${what} is at most ${limit} characters`);
  return text;
}

export async function createBuilderNotes({ file, clock = () => new Date() } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw noteError('file must be an absolute path', 500);
  const now = () => { const value = clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); };
  let notes = [];
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    notes = (Array.isArray(saved?.notes) ? saved.notes : []).filter(row => isPlainObject(row) && typeof row.id === 'string' && KINDS.includes(row.kind) && STATUSES.includes(row.status))
      .slice(0, BUILDER_NOTE_LIMITS.notes);
  } catch { /* no notes yet */ }
  let queue = Promise.resolve();
  const serial = work => { const task = queue.then(work); queue = task.then(() => undefined, () => undefined); return task; };
  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify({ format: 'fieldwork-builder-notes/v1', notes })}\n`, { flag: 'wx' });
    try { await fs.rename(temporary, file); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  };
  const find = id => {
    const note = notes.find(row => row.id === id);
    if (!note) throw noteError('no note has that id', 404);
    return note;
  };

  return Object.freeze({
    view: () => deepFreeze(notes.map(row => ({ ...row }))),
    unread: () => notes.filter(row => row.status === 'new').length,

    // From the agent. The same open note again just updates it.
    send({ what, detail = '', kind = 'broken' }) {
      return serial(async () => {
        if (!KINDS.includes(kind)) throw noteError(`kind is one of ${KINDS.join(', ')}`);
        const cleanWhat = clean(what, BUILDER_NOTE_LIMITS.whatCharacters, 'what', { required: true });
        const cleanDetail = clean(detail, BUILDER_NOTE_LIMITS.detailCharacters, 'detail', { multiline: true });
        const at = now();
        const same = notes.find(row => row.status !== 'done' && row.what.toLowerCase() === cleanWhat.toLowerCase());
        if (same) {
          Object.assign(same, { detail: cleanDetail || same.detail, kind, updatedAt: at, status: 'new' });
          await save();
          return deepFreeze({ ...same, again: true });
        }
        const today = at.slice(0, 10);
        if (notes.filter(row => row.at.slice(0, 10) === today).length >= BUILDER_NOTE_LIMITS.perDay) {
          throw noteError(`at most ${BUILDER_NOTE_LIMITS.perDay} new notes a day; this one can wait until tomorrow`, 429);
        }
        const note = { id: `note-${randomUUID()}`, at, updatedAt: at, kind, what: cleanWhat, detail: cleanDetail, status: 'new', reply: '' };
        notes = [note, ...notes].slice(0, BUILDER_NOTE_LIMITS.notes);
        await save();
        return deepFreeze({ ...note });
      });
    },

    // From the person: mark seen or done, and reply in a line.
    answer({ id, status, reply }) {
      return serial(async () => {
        const note = find(id);
        if (status !== undefined) {
          if (!STATUSES.includes(status)) throw noteError(`status is one of ${STATUSES.join(', ')}`);
          note.status = status;
        }
        if (reply !== undefined) note.reply = clean(reply, BUILDER_NOTE_LIMITS.replyCharacters, 'a reply', { multiline: true });
        note.updatedAt = now();
        await save();
        return deepFreeze({ ...note });
      });
    },
  });
}

export function builderNoteTools(store) {
  return [{
    name: 'tell_my_builder',
    description: 'Send a short note to the person who runs this room about the room itself: something broken, something confusing, or something you wish existed. They see it in Settings and can mark it done or reply. For problems with Fieldwork, not for ordinary conversation.',
    permissionSummary: ({ what, detail = '', kind = 'broken' }) => `Send one ${kind} room note to the builder (${[...what].length} summary characters${detail ? `, ${[...detail].length} detail characters` : ''}).`,
    inputSchema: {
      type: 'object',
      properties: {
        what: { type: 'string', minLength: 1, maxLength: BUILDER_NOTE_LIMITS.whatCharacters, description: 'One line: what happened or what you wish for.' },
        detail: { type: 'string', maxLength: BUILDER_NOTE_LIMITS.detailCharacters, description: 'Optional: what you tried, what you expected, what you saw.' },
        kind: { type: 'string', enum: KINDS },
      },
      required: ['what'],
      additionalProperties: false,
    },
    async execute({ what, detail = '', kind = 'broken' }) {
      const note = await store.send({ what, detail, kind });
      return { sent: true, ...(note.again ? { note: 'You had already sent this; it was marked new again.' } : {}) };
    },
  }, {
    name: 'my_notes_to_builder',
    description: 'See the notes you sent to the person who runs this room, whether each was seen or done, and any reply.',
    effect: 'read-only',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() {
      return { notes: store.view().slice(0, 20).map(note => ({ at: note.at, kind: note.kind, what: note.what, status: note.status, ...(note.reply ? { reply: note.reply } : {}) })) };
    },
  }];
}
