import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deepFreeze, isPlainObject } from './json-data.mjs';

// The shelf: things an agent (or the person) keeps on purpose and displays.
//
// Pictures live in the room's picture store and are named here by their
// SHA-256; text files are copied into <dir>/files/ so a later notebook edit
// does not change what was shelved. Each item has a title, an optional note,
// who put it there, and when. Taking an item down keeps it (it can be put back);
// only removing deletes the entry, and only the person may do that.

export const SHELF_LIMITS = Object.freeze({
  items: 200,
  titleCharacters: 80,
  noteCharacters: 500,
  textBytes: 200 * 1024,
  nameCharacters: 120,
});

const hashPattern = /^[0-9a-f]{64}$/;
const idPattern = /^shelf-[0-9a-f-]{36}$/;

function shelfError(message, status = 400) {
  const error = new Error(`Shelf: ${message}`);
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function cleanText(value, limit, what, { required = false } = {}) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (required && !text) throw shelfError(`${what} must not be empty`);
  if ([...text].length > limit || /\p{Cc}/u.test(text)) throw shelfError(`${what} is at most ${limit} characters`);
  return text;
}

const cleanName = value => cleanText(String(value ?? '').replace(/[\\/:*?"<>|]+/g, ' '), SHELF_LIMITS.nameCharacters, 'a file name') || 'file.txt';

async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, data, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

export async function createShelf({ dir, clock = () => new Date() } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw shelfError('dir must be an absolute directory', 500);
  const file = path.join(dir, 'shelf.json');
  const filesDir = path.join(dir, 'files');
  const now = () => { const value = clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); };
  let items = [];
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const row of Array.isArray(saved?.items) ? saved.items.slice(0, SHELF_LIMITS.items) : []) {
      if (!isPlainObject(row) || !idPattern.test(row.id) || !['picture', 'text'].includes(row.kind) || !hashPattern.test(row.ref)) continue;
      items.push({
        id: row.id, kind: row.kind, ref: row.ref, name: String(row.name ?? ''),
        title: String(row.title ?? '').slice(0, 400), note: String(row.note ?? '').slice(0, 2000),
        by: row.by === 'agent' ? 'agent' : 'person', at: String(row.at ?? ''), updatedAt: String(row.updatedAt ?? row.at ?? ''),
        takenDown: row.takenDown === true, ...(row.takenDown === true ? { takenDownBy: row.takenDownBy === 'agent' ? 'agent' : 'person' } : {}),
      });
    }
  } catch { /* An empty shelf. */ }
  let queue = Promise.resolve();
  const serial = work => { const task = queue.then(work); queue = task.then(() => undefined, () => undefined); return task; };
  const save = () => atomicWrite(file, `${JSON.stringify({ format: 'fieldwork-shelf/v1', items })}\n`);
  const find = id => {
    const item = items.find(row => row.id === id);
    if (!item) throw shelfError('nothing on the shelf has that id', 404);
    return item;
  };
  const view = () => deepFreeze(items.map(row => ({ ...row })));

  return Object.freeze({
    view,

    // kind 'picture': ref is a picture-store hash. kind 'text': text is the file.
    put({ kind, ref = null, text = null, name = '', title, note = '', by = 'person' }) {
      return serial(async () => {
        const maker = by === 'agent' ? 'agent' : 'person';
        const cleanTitle = cleanText(title, SHELF_LIMITS.titleCharacters, 'a title', { required: true });
        const cleanNote = cleanText(note, SHELF_LIMITS.noteCharacters, 'a note');
        let storedRef;
        if (kind === 'picture') {
          if (!hashPattern.test(String(ref))) throw shelfError('a picture needs a picture reference');
          storedRef = ref;
        } else if (kind === 'text') {
          const bytes = Buffer.from(String(text ?? ''), 'utf8');
          if (!bytes.length) throw shelfError('a text file must not be empty');
          if (bytes.length > SHELF_LIMITS.textBytes) throw shelfError(`a text file on the shelf is at most ${SHELF_LIMITS.textBytes / 1024} KB`);
          storedRef = createHash('sha256').update(bytes).digest('hex');
          const target = path.join(filesDir, `${storedRef}.txt`);
          try { await fs.access(target); } catch { await atomicWrite(target, bytes); }
        } else {
          throw shelfError('kind must be picture or text');
        }
        // The same thing shelved again updates its label instead of doubling up.
        const existing = items.find(row => row.kind === kind && row.ref === storedRef && !row.takenDown);
        const at = now();
        if (existing) {
          Object.assign(existing, { title: cleanTitle, note: cleanNote, updatedAt: at });
          await save();
          return deepFreeze({ ...existing, already: true });
        }
        if (items.length >= SHELF_LIMITS.items) throw shelfError(`the shelf holds at most ${SHELF_LIMITS.items} things`, 409);
        const item = { id: `shelf-${randomUUID()}`, kind, ref: storedRef, name: kind === 'text' ? cleanName(name) : cleanName(name || 'picture'), title: cleanTitle, note: cleanNote, by: maker, at, updatedAt: at, takenDown: false };
        items = [item, ...items];
        await save();
        return deepFreeze({ ...item });
      });
    },

    edit({ id, title, note }) {
      return serial(async () => {
        const item = find(id);
        if (title !== undefined) item.title = cleanText(title, SHELF_LIMITS.titleCharacters, 'a title', { required: true });
        if (note !== undefined) item.note = cleanText(note, SHELF_LIMITS.noteCharacters, 'a note');
        item.updatedAt = now();
        await save();
        return deepFreeze({ ...item });
      });
    },

    // Taken down, not thrown away: it can be put back.
    takeDown({ id, by = 'person' }) {
      return serial(async () => {
        const item = find(id);
        item.takenDown = true;
        item.takenDownBy = by === 'agent' ? 'agent' : 'person';
        item.updatedAt = now();
        await save();
        return deepFreeze({ ...item });
      });
    },

    putBack({ id }) {
      return serial(async () => {
        const item = find(id);
        item.takenDown = false;
        delete item.takenDownBy;
        item.updatedAt = now();
        await save();
        return deepFreeze({ ...item });
      });
    },

    // Permanent. The room offers this to the person only.
    remove({ id }) {
      return serial(async () => {
        const item = find(id);
        items = items.filter(row => row.id !== id);
        if (item.kind === 'text' && !items.some(row => row.kind === 'text' && row.ref === item.ref)) {
          await fs.rm(path.join(filesDir, `${item.ref}.txt`), { force: true });
        }
        await save();
        return view();
      });
    },

    async readText(id) {
      const item = find(id);
      if (item.kind !== 'text') throw shelfError('that is a picture, not a text file');
      try { return await fs.readFile(path.join(filesDir, `${item.ref}.txt`), 'utf8'); }
      catch { throw shelfError('that file is no longer on the shelf', 404); }
    },
  });
}
