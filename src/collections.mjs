import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deepFreeze, isPlainObject } from './json-data.mjs';

// Collections: little databases an agent builds for itself, kept as plain
// folders of markdown inside its notebook.
//
//   <notebook>/collections/<name>/_collection.md   what the collection is for
//   <notebook>/collections/<name>/<entry>.md       one entry: fields + text
//
// Every entry starts with a small header of fields between --- lines
// ("water: weekly"), then free markdown. Saving keeps the newest ten previous
// versions in .history/, and removing moves the entry to .removed/. Searching
// ranks entries by their words (title first, then fields, then text) and can
// filter on exact field values.

export const COLLECTION_LIMITS = Object.freeze({
  collections: 40,
  entriesPerCollection: 2000,
  fields: 24,
  fieldValueCharacters: 300,
  titleCharacters: 120,
  descriptionCharacters: 500,
  textBytes: 64 * 1024,
  historyVersions: 10,
  removedScan: 2_000,
  results: 25,
  snippetCharacters: 220,
});

const namePattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const fieldPattern = /^[a-z][a-z0-9_]{0,31}$/;
const reservedFields = new Set(['title', 'created', 'updated', 'by', 'restored_kind', 'restored_fingerprint', 'restored_version']);
const fingerprintPattern = /^[0-9a-f]{64}$/u;
const versionIdPattern = /^(current|history|removed):([A-Za-z0-9_-]{1,256}):([0-9a-f]{64})$/u;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,59}$/u;
const HISTORY_DIRECTORY_SCAN_LIMIT = COLLECTION_LIMITS.historyVersions * 4;

function collectionError(message, status = 400) {
  const error = new Error(`Collections: ${message}`);
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function checkCollectionName(value) {
  const name = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!namePattern.test(name)) throw collectionError('a collection name is 1-40 lowercase letters, digits, - or _, starting with a letter or digit');
  return name;
}

const oneLine = (value, limit, what) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if ([...text].length > limit || /\p{Cc}/u.test(text)) throw collectionError(`${what} is at most ${limit} characters on one line`);
  return text;
};

// A title becomes a file name: lowercase words joined by dashes.
export function entrySlug(title) {
  const source = String(title ?? '');
  const slug = source.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug || `entry-${createHash('sha256').update(source.normalize('NFKC')).digest('hex').slice(0, 12)}`;
}

function checkFields(value) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw collectionError('fields must be an object of short text values');
  const entries = Object.entries(value);
  if (entries.length > COLLECTION_LIMITS.fields) throw collectionError(`an entry has at most ${COLLECTION_LIMITS.fields} fields`);
  const fields = {};
  for (const [key, raw] of entries) {
    const name = String(key).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!fieldPattern.test(name) || reservedFields.has(name)) throw collectionError(`"${key}" cannot be a field name (use lowercase letters, digits and _, not title/created/updated/by)`);
    const text = oneLine(Array.isArray(raw) ? raw.join(', ') : raw, COLLECTION_LIMITS.fieldValueCharacters, `field "${name}"`);
    if (text) fields[name] = text;
  }
  return fields;
}

// --- the file format ----------------------------------------------------------

function parseEntry(source, { descriptor = false } = {}) {
  const text = String(source).replace(/\r\n?/g, '\n');
  const header = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!header) throw collectionError('an existing entry has no valid field header', 409);
  const meta = Object.create(null);
  for (const line of header[1].split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_]{0,31}):\s?(.*)$/.exec(line);
    if (!match) throw collectionError('an existing entry has a malformed field header', 409);
    const key = match[1].toLowerCase();
    if (Object.hasOwn(meta, key)) throw collectionError(`an existing entry repeats the field "${key}"`, 409);
    meta[key] = match[2].trim();
  }
  const body = text.slice(header[0].length);
  const restorationKeys = ['restored_kind', 'restored_fingerprint', 'restored_version'];
  const restorationKeyCount = restorationKeys.filter(key => Object.hasOwn(meta, key)).length;
  if (restorationKeyCount !== 0 && restorationKeyCount !== restorationKeys.length) {
    throw collectionError('an existing entry has incomplete restoration provenance', 409);
  }
  const {
    title = '', created = '', updated = '', by = '',
    restored_kind: restoredKind = '', restored_fingerprint: restoredFingerprint = '', restored_version: restoredVersion = '',
    ...fields
  } = meta;
  const cleanTitle = oneLine(title, COLLECTION_LIMITS.titleCharacters, 'an existing entry title');
  if (!cleanTitle) throw collectionError('an existing entry has no title', 409);
  for (const [label, value] of [['created', created], ['updated', updated]]) {
    const instant = new Date(value);
    if (!value || !Number.isFinite(instant.getTime()) || instant.toISOString() !== value) {
      throw collectionError(`an existing entry has an invalid ${label} time`, 409);
    }
  }
  if (by !== 'agent' && by !== 'person') throw collectionError('an existing entry has an invalid author', 409);
  const hasRestoration = restorationKeyCount === restorationKeys.length;
  const restoredVersionMatch = hasRestoration ? versionIdPattern.exec(restoredVersion) : null;
  if (hasRestoration && (!['history', 'removed'].includes(restoredKind)
    || !fingerprintPattern.test(restoredFingerprint)
    || !restoredVersionMatch
    || restoredVersionMatch[1] !== restoredKind
    || restoredVersionMatch[3] !== restoredFingerprint)) {
    throw collectionError('an existing entry has invalid restoration provenance', 409);
  }
  const cleanFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!fieldPattern.test(key) || reservedFields.has(key)) throw collectionError(`an existing entry has an invalid field "${key}"`, 409);
    const limit = descriptor && key === 'description'
      ? COLLECTION_LIMITS.descriptionCharacters
      : descriptor && key === 'fields'
        ? COLLECTION_LIMITS.fields * 34
        : COLLECTION_LIMITS.fieldValueCharacters;
    const clean = oneLine(value, limit, `existing field "${key}"`);
    if (clean) cleanFields[key] = clean;
  }
  const cleanBody = body.replace(/^\n+/, '');
  if (Buffer.byteLength(cleanBody, 'utf8') > COLLECTION_LIMITS.textBytes) {
    throw collectionError(`an existing entry's text is larger than ${COLLECTION_LIMITS.textBytes / 1024} KB`, 409);
  }
  return {
    title: cleanTitle, created, updated, by, fields: cleanFields, text: cleanBody,
    ...(hasRestoration ? { restoredFrom: { kind: restoredKind, fingerprint: restoredFingerprint, versionId: restoredVersion } } : {}),
  };
}

function formatEntry({ title, created, updated, by, fields, text, restoredFrom = null }) {
  const lines = [
    '---', `title: ${title}`, ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    `created: ${created}`, `updated: ${updated}`, `by: ${by}`,
    ...(restoredFrom ? [
      `restored_kind: ${restoredFrom.kind}`,
      `restored_fingerprint: ${restoredFrom.fingerprint}`,
      `restored_version: ${restoredFrom.versionId}`,
    ] : []),
    '---', '',
  ];
  return `${lines.join('\n')}${text.endsWith('\n') ? text : `${text}\n`}`;
}

async function stageWrite(file, data) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, data, { flag: 'wx' });
  return temporary;
}

async function publishStaged(temporary, file) {
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

async function atomicWrite(file, data) {
  const temporary = await stageWrite(file, data);
  await publishStaged(temporary, file);
}

const words = text => (String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const stamp = iso => iso.replace(/[:.]/g, '-');
const RETAINED_SEQUENCE_MAX = 999_999_999_999;
const retainedTimePattern = '(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z)';
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const historyNamePattern = new RegExp(`^${retainedTimePattern}(?:\\.(\\d{12})\\.(${uuidPattern})|\\.(${uuidPattern}))?\\.md$`, 'u');
const retainedSequence = name => {
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.(\d{12})\.[0-9a-f-]{36}\.md$/u.exec(name);
  return match ? Number(match[1]) : null;
};
const retainedOrder = (left, right) => {
  const leftSequence = retainedSequence(left);
  const rightSequence = retainedSequence(right);
  if (leftSequence === null && rightSequence !== null) return -1;
  if (leftSequence !== null && rightSequence === null) return 1;
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) return leftSequence - rightSequence;
  return left.localeCompare(right);
};
const retainedName = (iso, sequence = null) => `${stamp(iso)}.${sequence === null ? '' : `${String(sequence).padStart(12, '0')}.`}${randomUUID()}.md`;
const fingerprint = source => createHash('sha256').update(source).digest('hex');
const retainedAt = token => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u.exec(token);
  if (!match) return null;
  const iso = `${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso ? iso : null;
};

// --- the store ----------------------------------------------------------------

export async function createCollections({ root, clock = () => new Date() } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw collectionError('root must be an absolute directory', 500);
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  const now = () => { const value = clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); };
  // Parsed entries, reused while a file's modification time is unchanged.
  const cache = new Map();
  const missing = error => error?.code === 'ENOENT';
  const contained = candidate => {
    const relative = path.relative(realRoot, candidate);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const plainDirectory = async (directory, { create = false, label = 'collection directory' } = {}) => {
    if (create) {
      try { await fs.mkdir(directory); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) {
      if (!create && missing(error)) return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw collectionError(`${label} must be a plain directory`, 409);
    const resolved = await fs.realpath(directory);
    if (!contained(resolved)) throw collectionError(`${label} points outside the collections folder`, 409);
    return directory;
  };

  const folderOf = async name => {
    const folder = path.join(realRoot, checkCollectionName(name));
    return plainDirectory(folder, { label: 'a collection folder' });
  };
  const requireFolder = async name => {
    const folder = await folderOf(name);
    if (!folder) throw collectionError(`there is no collection called "${checkCollectionName(name)}"; list_collections shows what exists`, 404);
    return folder;
  };
  const readRecord = async (file, { fresh = false, cacheResult = true } = {}) => {
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) { if (missing(error)) return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw collectionError(`existing file "${path.basename(file)}" must be a plain file`, 409);
    const cached = cache.get(file);
    if (cacheResult && !fresh && cached && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && cached.ino === stat.ino && cached.size === stat.size) {
      return { entry: cached.entry, source: null };
    }
    if (stat.size > COLLECTION_LIMITS.textBytes * 2) throw collectionError(`existing file "${path.basename(file)}" is too large`, 409);
    const source = await fs.readFile(file);
    if (source.length > COLLECTION_LIMITS.textBytes * 2) throw collectionError(`existing file "${path.basename(file)}" is too large`, 409);
    const text = source.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(source)) throw collectionError(`existing file "${path.basename(file)}" is not valid UTF-8`, 409);
    const entry = parseEntry(text, { descriptor: path.basename(file) === '_collection.md' });
    if (cacheResult) cache.set(file, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, size: stat.size, entry });
    return { entry, source };
  };
  const readParsed = async (file, options) => (await readRecord(file, options))?.entry ?? null;
  const entriesIn = async (name, folder, options) => {
    const names = await fs.readdir(folder);
    const rows = [];
    for (const fileName of names) {
      if (!fileName.endsWith('.md') || fileName.startsWith('.') || fileName.startsWith('_')) continue;
      const entry = await readParsed(path.join(folder, fileName), options);
      if (entry) rows.push({ collection: name, entry: fileName.slice(0, -3), ...entry });
    }
    return rows;
  };
  const collectionInfo = async (name, folder) => {
    let about = { description: '', fields: [] };
    const parsed = await readParsed(path.join(folder, '_collection.md'));
    if (parsed) about = { description: parsed.fields.description ?? '', fields: (parsed.fields.fields ?? '').split(',').map(field => field.trim()).filter(Boolean) };
    const entries = await entriesIn(name, folder);
    const updated = entries.reduce((latest, row) => (row.updated > latest ? row.updated : latest), '');
    return { name, ...about, entries: entries.length, updated: updated || null };
  };
  const comparableTitle = value => String(value).normalize('NFKC').toLowerCase();
  const findEntry = async (name, reference, options) => {
    const folder = await requireFolder(name);
    const wanted = String(reference ?? '').trim();
    const slug = entrySlug(wanted);
    const bySlug = path.join(folder, `${slug}.md`);
    const parsed = await readParsed(bySlug, options);
    if (parsed && (wanted === slug || comparableTitle(parsed.title) === comparableTitle(wanted))) return { folder, slug, entry: parsed };
    const match = (await entriesIn(name, folder, options)).find(row => comparableTitle(row.title) === comparableTitle(wanted));
    if (match) return { folder, slug: match.entry, entry: match };
    throw collectionError(`no entry "${wanted}" in ${name}`, 404);
  };
  const archiveDirectory = async (folder, kind, slug = null, { create = true } = {}) => {
    const archive = await plainDirectory(path.join(folder, kind), { create, label: `${kind} archive` });
    if (!archive || slug === null) return archive;
    return plainDirectory(path.join(archive, slug), { create, label: `${kind} entry archive` });
  };
  const checkEntrySlug = value => {
    const slug = String(value ?? '');
    if (!slugPattern.test(slug)) throw collectionError('entry must be a stable collection entry id', 400);
    return slug;
  };
  const historyFileInfo = name => {
    const match = historyNamePattern.exec(name);
    if (!match) return null;
    const at = retainedAt(match[1]);
    if (!at) return null;
    return { name, at, sequence: match[2] ? Number(match[2]) : null };
  };
  const removedFileInfo = name => {
    if (!name.endsWith('.md')) return null;
    const firstDot = name.indexOf('.');
    if (firstDot <= 0) return null;
    const slug = name.slice(0, firstDot);
    if (!slugPattern.test(slug)) return null;
    const match = historyNamePattern.exec(name.slice(firstDot + 1));
    if (!match) return null;
    const at = retainedAt(match[1]);
    if (!at) return null;
    return { name, slug, at, sequence: match[2] ? Number(match[2]) : null };
  };
  const locatorFor = name => Buffer.from(name, 'utf8').toString('base64url');
  const nameFromLocator = locator => {
    let name;
    try { name = Buffer.from(locator, 'base64url').toString('utf8'); }
    catch { throw collectionError('versionId has an invalid version locator', 400); }
    if (!name || locatorFor(name) !== locator) throw collectionError('versionId has an invalid version locator', 400);
    return name;
  };
  const exactRecord = async ({ file, kind, collection, slug, name, at = null }) => {
    const record = await readRecord(file, { fresh: true, cacheResult: false });
    if (!record?.source) throw collectionError('a retained collection version disappeared', 409);
    const sourceFingerprint = fingerprint(record.source);
    return {
      kind,
      collection,
      entry: slug,
      versionId: `${kind}:${locatorFor(name)}:${sourceFingerprint}`,
      fingerprint: sourceFingerprint,
      bytes: record.source.length,
      ...(at ? { retainedAt: at } : {}),
      value: record.entry,
      raw: record.source.toString('utf8'),
      file,
      name,
    };
  };
  const publicMetadata = record => ({
    kind: record.kind,
    collection: record.collection,
    entry: record.entry,
    versionId: record.versionId,
    fingerprint: record.fingerprint,
    bytes: record.bytes,
    title: record.value.title,
    created: record.value.created,
    updated: record.value.updated,
    by: record.value.by,
    ...(record.retainedAt ? { retainedAt: record.retainedAt } : {}),
    ...(record.value.restoredFrom ? { restoredFrom: record.value.restoredFrom } : {}),
  });
  const publicExact = record => ({ ...publicMetadata(record), value: record.value, raw: record.raw });
  const historyFiles = async (folder, slug) => {
    const directory = await archiveDirectory(folder, '.history', slug, { create: false });
    if (!directory) return { directory: null, rows: [] };
    const rows = [];
    let scanned = 0;
    const handle = await fs.opendir(directory);
    for await (const dirent of handle) {
      scanned++;
      if (scanned > HISTORY_DIRECTORY_SCAN_LIMIT) {
        throw collectionError(`an entry history inspection is limited to ${HISTORY_DIRECTORY_SCAN_LIMIT} directory items`, 409);
      }
      const name = dirent.name;
      if (!name.endsWith('.md')) continue;
      const info = historyFileInfo(name);
      if (!info) throw collectionError('an entry history contains an invalid version name', 409);
      if (!dirent.isFile() || dirent.isSymbolicLink()) throw collectionError('an entry history version must be a plain file', 409);
      rows.push({ ...info, file: path.join(directory, name) });
      if (rows.length > COLLECTION_LIMITS.historyVersions) {
        throw collectionError(`an entry history has more than its ${COLLECTION_LIMITS.historyVersions} retained versions; archive older files before continuing`, 409);
      }
    }
    rows.sort((left, right) => retainedOrder(left.name, right.name));
    return { directory, rows };
  };
  const removedFiles = async (folder, { slug = null, scanLimit = COLLECTION_LIMITS.removedScan } = {}) => {
    const directory = await archiveDirectory(folder, '.removed', null, { create: false });
    if (!directory) return { directory: null, rows: [], scanned: 0 };
    const rows = [];
    let scanned = 0;
    const handle = await fs.opendir(directory);
    for await (const dirent of handle) {
      scanned++;
      if (scanned > scanLimit) {
        throw collectionError(`removed-entry inspection is limited to ${COLLECTION_LIMITS.removedScan} retained files; narrow the collection or archive older files`, 409);
      }
      const name = dirent.name;
      if (!dirent.isFile() || dirent.isSymbolicLink()) {
        throw collectionError('a removed-entry archive version must be a plain file', 409);
      }
      if (!name.endsWith('.md')) continue;
      const info = removedFileInfo(name);
      if (!info) throw collectionError('a removed-entry archive contains an invalid version name', 409);
      if (slug === null || info.slug === slug) rows.push({ ...info, file: path.join(directory, name) });
    }
    rows.sort((left, right) => {
      if (left.sequence !== null && right.sequence !== null && left.sequence !== right.sequence) return left.sequence - right.sequence;
      if (left.sequence === null && right.sequence !== null) return -1;
      if (left.sequence !== null && right.sequence === null) return 1;
      const time = String(left.at).localeCompare(String(right.at));
      if (time) return time;
      return left.name.localeCompare(right.name);
    });
    return { directory, rows, scanned };
  };
  const removedNewestFirst = (left, right) => (right.sequence ?? -1) - (left.sequence ?? -1)
    || String(right.at).localeCompare(String(left.at))
    || right.collection.localeCompare(left.collection)
    || right.name.localeCompare(left.name);
  const removedCursorRow = row => [row.sequence, row.at, row.collection, row.name];
  const removedCursorFor = ({ scope, head, after }) => Buffer.from(JSON.stringify([
    1, scope, removedCursorRow(head), removedCursorRow(after),
  ]), 'utf8').toString('base64url');
  const removedCursorRowFrom = (value, scope) => {
    if (!Array.isArray(value) || value.length !== 4) throw collectionError('cursor is not a removed-entry cursor');
    const [sequence, at, collection, name] = value;
    if ((sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > RETAINED_SEQUENCE_MAX))
      || typeof at !== 'string' || typeof collection !== 'string' || !namePattern.test(collection)
      || typeof name !== 'string') {
      throw collectionError('cursor is not a removed-entry cursor');
    }
    const info = removedFileInfo(name);
    if (!info || info.at !== at || info.sequence !== sequence || (scope !== null && collection !== scope)) {
      throw collectionError('cursor is not a removed-entry cursor');
    }
    return { ...info, collection };
  };
  const removedCursorFrom = (cursor, scope) => {
    if (cursor === undefined || cursor === null || cursor === 0) return null;
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/u.test(cursor)) {
      throw collectionError('cursor must be zero, null, or an opaque removed-entry cursor');
    }
    let source;
    try { source = Buffer.from(cursor, 'base64url').toString('utf8'); }
    catch { throw collectionError('cursor is not a removed-entry cursor'); }
    if (Buffer.from(source, 'utf8').toString('base64url') !== cursor) throw collectionError('cursor is not a removed-entry cursor');
    let value;
    try { value = JSON.parse(source); }
    catch { throw collectionError('cursor is not a removed-entry cursor'); }
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== scope) {
      throw collectionError('cursor is not valid for this removed-entry view');
    }
    const head = removedCursorRowFrom(value[2], scope);
    const after = removedCursorRowFrom(value[3], scope);
    if (removedNewestFirst(after, head) < 0) throw collectionError('cursor has an invalid removed-entry range');
    return { head, after };
  };
  const removalSequenceFile = path.join(realRoot, '.removed-sequence');
  let removalSequence = null;
  const readRemovalSequence = async () => {
    let stat;
    try { stat = await fs.lstat(removalSequenceFile); }
    catch (error) { if (missing(error)) return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32) throw collectionError('the removed-entry sequence must be a small plain file', 409);
    const resolved = await fs.realpath(removalSequenceFile);
    if (!contained(resolved)) throw collectionError('the removed-entry sequence points outside the collections folder', 409);
    const source = await fs.readFile(removalSequenceFile, 'utf8');
    if (!/^(?:0|[1-9]\d{0,11})\n$/u.test(source)) throw collectionError('the removed-entry sequence is malformed', 409);
    const value = Number(source.trim());
    if (!Number.isSafeInteger(value) || value > RETAINED_SEQUENCE_MAX) throw collectionError('the removed-entry sequence is out of range', 409);
    return value;
  };
  const initializeRemovalSequence = async () => {
    if (removalSequence !== null) return removalSequence;
    const saved = await readRemovalSequence();
    if (saved !== null) { removalSequence = saved; return saved; }
    let latest = 0;
    let scanned = 0;
    for (const name of (await fs.readdir(realRoot)).sort()) {
      if (!namePattern.test(name)) continue;
      const folder = await folderOf(name);
      if (!folder) continue;
      const inspected = await removedFiles(folder, { scanLimit: COLLECTION_LIMITS.removedScan - scanned });
      scanned += inspected.scanned;
      for (const row of inspected.rows) {
        latest = Math.max(latest, row.sequence ?? 0);
      }
    }
    await atomicWrite(removalSequenceFile, `${latest}\n`);
    removalSequence = latest;
    return latest;
  };
  const nextRemovalSequence = async () => {
    const saved = await readRemovalSequence();
    let latest;
    if (saved === null) latest = await initializeRemovalSequence();
    else {
      if (removalSequence !== null && saved < removalSequence) throw collectionError('the removed-entry sequence moved backwards', 409);
      removalSequence = saved;
      latest = saved;
    }
    if (latest >= RETAINED_SEQUENCE_MAX) throw collectionError('the removed-entry history has exhausted its version sequence', 409);
    const next = latest + 1;
    await atomicWrite(removalSequenceFile, `${next}\n`);
    removalSequence = next;
    return next;
  };
  const archiveCurrent = async ({ folder, slug, at, source }) => {
    const historyDir = await archiveDirectory(folder, '.history', slug);
    const { rows } = await historyFiles(folder, slug);
    const latestSequence = rows.reduce((latest, row) => Math.max(latest, row.sequence ?? 0), 0);
    if (latestSequence >= RETAINED_SEQUENCE_MAX) throw collectionError('this entry history has exhausted its version sequence', 409);
    const name = retainedName(at, latestSequence + 1);
    await atomicWrite(path.join(historyDir, name), source);
    return { historyDir, name, versions: [...rows.map(row => row.name), name].sort(retainedOrder) };
  };
  const pruneHistory = async ({ historyDir, versions, protect = [] }) => {
    if (!historyDir) return { limit: COLLECTION_LIMITS.historyVersions, retained: 0, pruned: 0 };
    const overflow = Math.max(0, versions.length - COLLECTION_LIMITS.historyVersions);
    const protectedNames = new Set(protect);
    const expired = versions.filter(name => !protectedNames.has(name)).slice(0, overflow);
    let pruned = 0;
    for (const old of expired) {
      const file = path.join(historyDir, old);
      try { await fs.rm(file, { force: true }); cache.delete(file); pruned++; }
      catch { /* A published current value must not turn into a false failure. */ }
    }
    return { limit: COLLECTION_LIMITS.historyVersions, retained: versions.length - pruned, pruned };
  };
  const publishCurrentWithRollback = async ({ file, folder, slug, at, data, currentSource = null }) => {
    const staged = await stageWrite(file, data);
    let archived = null;
    try {
      if (currentSource) archived = await archiveCurrent({ folder, slug, at, source: currentSource });
      await publishStaged(staged, file);
    } catch (error) {
      cache.delete(file);
      try { await fs.rm(staged, { force: true }); }
      catch { /* Preserve the publication failure; the hidden staging file is never authoritative. */ }
      if (archived) {
        const archivedFile = path.join(archived.historyDir, archived.name);
        try { await fs.rm(archivedFile, { force: true }); }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Collection publication and history rollback both failed');
        }
        finally { cache.delete(archivedFile); }
      }
      throw error;
    }
    cache.delete(file);
    return archived;
  };
  const findVersion = async ({ folder, collection, slug, versionId }) => {
    const match = versionIdPattern.exec(String(versionId ?? ''));
    if (!match) throw collectionError('versionId is not a collection version id', 400);
    const kind = match[1];
    const name = nameFromLocator(match[2]);
    let candidate;
    if (kind === 'current') {
      if (name !== `${slug}.md`) throw collectionError('versionId does not name this collection entry', 404);
      candidate = { file: path.join(folder, name), name, at: null };
    } else if (kind === 'history') {
      const info = historyFileInfo(name);
      if (!info) throw collectionError('versionId has an invalid history locator', 400);
      const directory = await archiveDirectory(folder, '.history', slug, { create: false });
      if (!directory) throw collectionError('that collection version is no longer retained', 404);
      candidate = { ...info, file: path.join(directory, name) };
    } else {
      const info = removedFileInfo(name);
      if (!info || info.slug !== slug) throw collectionError('versionId has an invalid removed-entry locator', 400);
      const directory = await archiveDirectory(folder, '.removed', null, { create: false });
      if (!directory) throw collectionError('that collection version is no longer retained', 404);
      candidate = { ...info, file: path.join(directory, name) };
    }
    const record = await exactRecord({ ...candidate, kind, collection, slug });
    if (record.fingerprint !== match[3] || record.versionId !== versionId) {
      throw collectionError('that collection version changed since it was inspected', 409);
    }
    return record;
  };
  let mutationQueue = Promise.resolve();
  const mutate = work => {
    const task = mutationQueue.then(work);
    mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  const store = Object.freeze({
    async list() {
      const names = await fs.readdir(realRoot);
      const rows = [];
      for (const name of names.sort()) {
        if (!namePattern.test(name)) continue;
        const folder = await folderOf(name);
        if (folder) rows.push(await collectionInfo(name, folder));
      }
      return deepFreeze(rows);
    },

    async make({ name, description = '', fields = [] }) {
      return mutate(async () => {
        const clean = checkCollectionName(name);
        if (await folderOf(clean)) throw collectionError(`a collection called "${clean}" already exists`, 409);
        if ((await store.list()).length >= COLLECTION_LIMITS.collections) throw collectionError(`at most ${COLLECTION_LIMITS.collections} collections`, 409);
        const fieldNames = (Array.isArray(fields) ? fields : String(fields).split(',')).map(field => String(field).trim().toLowerCase().replace(/[\s-]+/g, '_')).filter(Boolean);
        for (const field of fieldNames) if (!fieldPattern.test(field) || reservedFields.has(field)) throw collectionError(`"${field}" cannot be a field name`);
        const at = now();
        const folder = await plainDirectory(path.join(realRoot, clean), { create: true, label: 'a collection folder' });
        await atomicWrite(path.join(folder, '_collection.md'), formatEntry({
          title: clean, created: at, updated: at, by: 'agent',
          fields: { description: oneLine(description, COLLECTION_LIMITS.descriptionCharacters, 'a description'), ...(fieldNames.length ? { fields: fieldNames.join(', ') } : {}) },
          text: '',
        }));
        return deepFreeze({ name: clean, description, fields: fieldNames });
      });
    },

    // Creates or replaces one entry; the previous version goes to .history/.
    async save({ collection, title, fields = {}, text = '', by = 'agent', mergeFields = false }) {
      return mutate(async () => {
        const folder = await requireFolder(collection);
        const cleanTitle = oneLine(title, COLLECTION_LIMITS.titleCharacters, 'a title');
        if (!cleanTitle) throw collectionError('an entry needs a title');
        const body = String(text ?? '');
        if (Buffer.byteLength(body, 'utf8') > COLLECTION_LIMITS.textBytes) throw collectionError(`an entry's text is at most ${COLLECTION_LIMITS.textBytes / 1024} KB`);
        const baseSlug = entrySlug(cleanTitle);
        const sameTitle = value => comparableTitle(value.title) === comparableTitle(cleanTitle);
        let slug = baseSlug;
        let file = path.join(folder, `${slug}.md`);
        let previousRecord = await readRecord(file, { fresh: true });
        if (!previousRecord || !sameTitle(previousRecord.entry)) {
          const existing = (await entriesIn(collection, folder, { fresh: true })).find(sameTitle);
          if (existing) {
            slug = existing.entry;
            file = path.join(folder, `${slug}.md`);
            previousRecord = await readRecord(file, { fresh: true });
          } else if (previousRecord) {
            const suffix = createHash('sha256').update(cleanTitle.normalize('NFKC')).digest('hex').slice(0, 12);
            slug = `${baseSlug.slice(0, 47).replace(/-+$/u, '')}-${suffix}`;
            file = path.join(folder, `${slug}.md`);
            previousRecord = await readRecord(file, { fresh: true });
            if (previousRecord && !sameTitle(previousRecord.entry)) {
              throw collectionError('two distinct entry titles have the same stable file identity', 409);
            }
          }
        }
        const previous = previousRecord?.entry ?? null;
        if (!previous && (await entriesIn(collection, folder)).length >= COLLECTION_LIMITS.entriesPerCollection) throw collectionError('this collection is full', 409);
        const at = now();
        const nextFields = { ...(mergeFields && previous ? previous.fields : {}), ...checkFields(fields) };
        const archived = await publishCurrentWithRollback({
          file,
          folder,
          slug,
          at,
          currentSource: previousRecord?.source ?? null,
          data: formatEntry({
            title: cleanTitle,
            created: previous?.created || at,
            updated: at,
            by: by === 'person' ? 'person' : 'agent',
            fields: nextFields,
            text: body || (mergeFields && previous ? previous.text : body),
          }),
        });
        const retention = archived
          ? await pruneHistory({ historyDir: archived.historyDir, versions: archived.versions, protect: [archived.name] })
          : { limit: COLLECTION_LIMITS.historyVersions, retained: 0, pruned: 0 };
        return deepFreeze({
          collection: checkCollectionName(collection), entry: slug, title: cleanTitle, created: !previous,
          retention,
        });
      });
    },

    async read({ collection, entry }) {
      const found = await findEntry(collection, entry);
      return deepFreeze({ collection: checkCollectionName(collection), entry: found.slug, ...found.entry });
    },

    async history({ collection, entry }) {
      const cleanCollection = checkCollectionName(collection);
      let folder;
      let slug;
      let current = null;
      try {
        const found = await findEntry(cleanCollection, entry, { fresh: true });
        folder = found.folder;
        slug = found.slug;
        current = await exactRecord({
          file: path.join(folder, `${slug}.md`), kind: 'current', collection: cleanCollection, slug, name: `${slug}.md`,
        });
      } catch (error) {
        if (error?.status !== 404) throw error;
        folder = await requireFolder(cleanCollection);
        slug = checkEntrySlug(entry);
      }
      const historyRows = (await historyFiles(folder, slug)).rows;
      const hasRemoved = !current && historyRows.length === 0
        ? (await removedFiles(folder, { slug })).rows.length > 0
        : false;
      if (!current && historyRows.length === 0 && !hasRemoved) {
        throw collectionError(`no entry "${slug}" in ${cleanCollection}`, 404);
      }
      const retained = [];
      for (const row of historyRows.slice().reverse()) {
        retained.push(publicMetadata(await exactRecord({ ...row, kind: 'history', collection: cleanCollection, slug })));
      }
      return deepFreeze({
        collection: cleanCollection,
        entry: slug,
        retentionLimit: COLLECTION_LIMITS.historyVersions,
        current: current ? publicMetadata(current) : null,
        versions: retained,
      });
    },

    async version({ collection, entry, versionId }) {
      const cleanCollection = checkCollectionName(collection);
      const folder = await requireFolder(cleanCollection);
      const slug = checkEntrySlug(entry);
      return deepFreeze(publicExact(await findVersion({ folder, collection: cleanCollection, slug, versionId })));
    },

    async removed({ collection = null, cursor = 0, limit = COLLECTION_LIMITS.results } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > COLLECTION_LIMITS.results) {
        throw collectionError(`limit must be 1-${COLLECTION_LIMITS.results}`);
      }
      const folders = [];
      let scope = null;
      if (collection !== null && collection !== undefined && collection !== '') {
        scope = checkCollectionName(collection);
        folders.push({ collection: scope, folder: await requireFolder(scope) });
      } else {
        for (const name of (await fs.readdir(realRoot)).sort()) {
          if (!namePattern.test(name)) continue;
          const folder = await folderOf(name);
          if (folder) folders.push({ collection: name, folder });
        }
      }
      const cursorState = removedCursorFrom(cursor, scope);
      const candidates = [];
      let scanned = 0;
      for (const row of folders) {
        const inspected = await removedFiles(row.folder, { scanLimit: COLLECTION_LIMITS.removedScan - scanned });
        scanned += inspected.scanned;
        for (const removed of inspected.rows) {
          candidates.push({ ...removed, collection: row.collection });
        }
      }
      candidates.sort(removedNewestFirst);
      const head = cursorState?.head ?? candidates[0] ?? null;
      const snapshot = cursorState ? candidates.filter(row => removedNewestFirst(row, cursorState.head) >= 0) : candidates;
      const remaining = cursorState ? snapshot.filter(row => removedNewestFirst(row, cursorState.after) > 0) : snapshot;
      const page = remaining.slice(0, limit);
      const items = [];
      for (const row of page) {
        items.push(publicMetadata(await exactRecord({ ...row, kind: 'removed', slug: row.slug })));
      }
      return deepFreeze({
        items,
        cursor,
        total: snapshot.length,
        nextCursor: head && remaining.length > page.length
          ? removedCursorFor({ scope, head, after: page.at(-1) })
          : null,
      });
    },

    async restore({ collection, entry, versionId, expectedCurrentFingerprint, by }) {
      if (by !== 'person') throw collectionError('collection recovery must be attributed to the person');
      if (expectedCurrentFingerprint !== null && !fingerprintPattern.test(String(expectedCurrentFingerprint ?? ''))) {
        throw collectionError('expectedCurrentFingerprint must be an exact fingerprint or null');
      }
      const versionMatch = versionIdPattern.exec(String(versionId ?? ''));
      if (!versionMatch || !['history', 'removed'].includes(versionMatch[1])) {
        throw collectionError('only a retained history or removed version can be restored');
      }
      return mutate(async () => {
        const cleanCollection = checkCollectionName(collection);
        const folder = await requireFolder(cleanCollection);
        const slug = checkEntrySlug(entry);
        const source = await findVersion({ folder, collection: cleanCollection, slug, versionId });
        const currentFile = path.join(folder, `${slug}.md`);
        const current = await readRecord(currentFile, { fresh: true });
        const currentFingerprint = current?.source ? fingerprint(current.source) : null;
        if (currentFingerprint !== expectedCurrentFingerprint) {
          throw collectionError('the current entry changed since it was inspected', 409);
        }
        if (source.kind === 'removed' && current) throw collectionError('a removed version cannot replace a newly current entry', 409);
        if (!current && (await entriesIn(cleanCollection, folder, { fresh: true })).length >= COLLECTION_LIMITS.entriesPerCollection) {
          throw collectionError('this collection is full', 409);
        }
        const at = now();
        const restoredFrom = { kind: source.kind, fingerprint: source.fingerprint, versionId: source.versionId };
        const restored = formatEntry({
          title: source.value.title,
          created: source.value.created,
          updated: at,
          by: 'person',
          fields: source.value.fields,
          text: source.value.text,
          restoredFrom,
        });
        const archived = await publishCurrentWithRollback({
          file: currentFile,
          folder,
          slug,
          at,
          currentSource: current?.source ?? null,
          data: restored,
        });
        const retention = archived
          ? await pruneHistory({
            historyDir: archived.historyDir,
            versions: archived.versions,
            protect: [archived.name, ...(source.kind === 'history' ? [source.name] : [])],
          })
          : { limit: COLLECTION_LIMITS.historyVersions, retained: 0, pruned: 0 };
        const next = await exactRecord({
          file: currentFile, kind: 'current', collection: cleanCollection, slug, name: `${slug}.md`,
        });
        return deepFreeze({
          restored: publicMetadata(next),
          restoredFrom,
          retention,
        });
      });
    },

    // Kept aside rather than deleted: moved into .removed/.
    async remove({ collection, entry }) {
      return mutate(async () => {
        const found = await findEntry(collection, entry, { fresh: true });
        const at = now();
        const removed = await archiveDirectory(found.folder, '.removed');
        const sequence = await nextRemovalSequence();
        const file = path.join(found.folder, `${found.slug}.md`);
        const name = `${found.slug}.${retainedName(at, sequence)}`;
        await fs.rename(file, path.join(removed, name));
        cache.delete(file);
        const record = await exactRecord({ file: path.join(removed, name), kind: 'removed', collection: checkCollectionName(collection), slug: found.slug, name, at });
        return deepFreeze({ removed: found.slug, kept: true, version: publicMetadata(record) });
      });
    },

    // Words rank entries (title x4, fields x2, text x1, rarer words count more);
    // where = { field: value } keeps only exact matches. No words and no
    // filter lists the newest entries.
    async search({ query = '', collection = null, where = {}, limit = 10 } = {}) {
      const names = collection ? [checkCollectionName(collection)] : (await store.list()).map(row => row.name);
      let rows = [];
      for (const name of names) {
        const folder = collection ? await requireFolder(name) : await folderOf(name);
        if (folder) rows.push(...await entriesIn(name, folder));
      }
      const filters = Object.entries(isPlainObject(where) ? where : {}).map(([key, value]) => [String(key).toLowerCase(), String(value).trim().toLowerCase()]);
      if (filters.length) rows = rows.filter(row => filters.every(([key, value]) => (key === 'title' ? row.title : row.fields[key] ?? '').toLowerCase() === value));
      const terms = [...new Set(words(query))];
      const cap = Math.max(1, Math.min(Number(limit) || 10, COLLECTION_LIMITS.results));
      if (!terms.length) {
        return deepFreeze(rows.sort((a, b) => (b.updated || '').localeCompare(a.updated || '')).slice(0, cap).map(row => resultOf(row, [], 0)));
      }
      const indexed = rows.map(row => ({ row, title: words(row.title), fields: words(Object.values(row.fields).join(' ')), text: words(row.text) }));
      const documentFrequency = new Map(terms.map(term => [term, indexed.filter(doc => doc.title.includes(term) || doc.fields.includes(term) || doc.text.includes(term)).length]));
      const scored = [];
      for (const doc of indexed) {
        let score = 0;
        for (const term of terms) {
          const df = documentFrequency.get(term);
          if (!df) continue;
          const weight = Math.log(1 + indexed.length / df);
          const count = list => list.reduce((sum, word) => sum + (word === term ? 1 : 0), 0);
          score += weight * (4 * count(doc.title) + 2 * count(doc.fields) + Math.min(count(doc.text), 5));
        }
        if (score > 0) scored.push({ row: doc.row, score });
      }
      scored.sort((a, b) => b.score - a.score || (b.row.updated || '').localeCompare(a.row.updated || ''));
      return deepFreeze(scored.slice(0, cap).map(({ row, score }) => resultOf(row, terms, score)));
    },
  });

  function resultOf(row, terms, score) {
    const flat = row.text.replace(/\s+/g, ' ').trim();
    let start = 0;
    const lower = flat.toLowerCase();
    for (const term of terms) { const at = lower.indexOf(term); if (at >= 0) { start = Math.max(0, at - 60); break; } }
    const snippet = flat.slice(start, start + COLLECTION_LIMITS.snippetCharacters);
    return {
      collection: row.collection, entry: row.entry, title: row.title, fields: row.fields, updated: row.updated || null, by: row.by || null,
      snippet: `${start > 0 ? '…' : ''}${snippet}${start + COLLECTION_LIMITS.snippetCharacters < flat.length ? '…' : ''}`,
      ...(score ? { score: Math.round(score * 100) / 100 } : {}),
    };
  }

  return store;
}

// The agent's tools. Results are plain data; errors explain themselves.
export function collectionTools(store) {
  // Fields travel as a list of name/value pairs (tool schemas allow no free-form maps).
  const fieldsSchema = {
    type: 'array', maxItems: COLLECTION_LIMITS.fields,
    items: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 32 }, value: { type: 'string', maxLength: COLLECTION_LIMITS.fieldValueCharacters } }, required: ['name', 'value'], additionalProperties: false },
    description: 'Short facts, like [{"name": "water", "value": "weekly"}].',
  };
  const asObject = pairs => Object.fromEntries((Array.isArray(pairs) ? pairs : []).map(pair => [pair.name, pair.value]));
  const shortTarget = value => {
    const characters = [...String(value)];
    return characters.length > 70 ? `${characters.slice(0, 69).join('')}…` : String(value);
  };
  return [{
    name: 'list_collections',
    description: 'List your collections (little databases kept as folders of markdown in your notebook): what each is for, its usual fields, and how many entries it has.',
    effect: 'read-only',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() { return { collections: await store.list() }; },
  }, {
    name: 'make_collection',
    description: 'Start a new collection: a little database of entries you can search later, kept as a folder of markdown files in your notebook (collections/<name>/). Say what it is for and, if you like, the fields its entries usually have.',
    permissionSummary: ({ name, fields = [] }) => `Create collection ${name} with ${fields.length} usual field${fields.length === 1 ? '' : 's'}.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40, description: 'Lowercase, like "plants" or "dream-log".' },
        description: { type: 'string', maxLength: COLLECTION_LIMITS.descriptionCharacters },
        fields: { type: 'array', maxItems: COLLECTION_LIMITS.fields, items: { type: 'string', maxLength: 32 } },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute({ name, description = '', fields = [] }) { return { made: await store.make({ name, description, fields }) }; },
  }, {
    name: 'save_entry',
    description: 'Add an entry to a collection, or replace the entry with the same title (the newest ten previous versions are retained). merge_fields keeps fields you do not mention and, with empty text, the old text.',
    permissionSummary: ({ collection, title, fields = [], text = '', merge_fields: mergeFields = false }) => `Save ${shortTarget(title)} in collection ${collection} (${fields.length} field${fields.length === 1 ? '' : 's'}, ${[...text].length} text characters${mergeFields ? ', merge existing fields' : ''}); if replacing it, retain the previous value among the newest ten versions.`,
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', maxLength: 40 },
        title: { type: 'string', minLength: 1, maxLength: COLLECTION_LIMITS.titleCharacters },
        fields: fieldsSchema,
        text: { type: 'string', maxLength: 24_000, description: 'Markdown.' },
        merge_fields: { type: 'boolean' },
      },
      required: ['collection', 'title'],
      additionalProperties: false,
    },
    async execute({ collection, title, fields = [], text = '', merge_fields: mergeFields = false }) {
      return { saved: await store.save({ collection, title, fields: asObject(fields), text, mergeFields, by: 'agent' }) };
    },
  }, {
    name: 'read_entry',
    description: 'Read one entry from a collection, by its title or file name.',
    effect: 'read-only',
    inputSchema: { type: 'object', properties: { collection: { type: 'string', maxLength: 40 }, entry: { type: 'string', maxLength: COLLECTION_LIMITS.titleCharacters } }, required: ['collection', 'entry'], additionalProperties: false },
    async execute({ collection, entry }) { return { entry: await store.read({ collection, entry }) }; },
  }, {
    name: 'search_collections',
    description: 'Search your collections by words (titles count most, then fields, then text), filter by exact field values with where (like [{"name": "water", "value": "weekly"}]), or leave both empty to see the newest entries. Optionally only one collection.',
    effect: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 500 },
        collection: { type: 'string', maxLength: 40 },
        where: fieldsSchema,
        limit: { type: 'integer', minimum: 1, maximum: COLLECTION_LIMITS.results },
      },
      required: [],
      additionalProperties: false,
    },
    async execute({ query = '', collection, where = [], limit = 10 }) { return { results: await store.search({ query, collection: collection || null, where: asObject(where), limit }) }; },
  }, {
    name: 'remove_entry',
    description: 'Remove an entry from a collection. It is moved aside (kept in .removed/), not destroyed.',
    permissionSummary: ({ collection, entry }) => `Move ${shortTarget(entry)} out of collection ${collection}; keep it in removed history.`,
    inputSchema: { type: 'object', properties: { collection: { type: 'string', maxLength: 40 }, entry: { type: 'string', maxLength: COLLECTION_LIMITS.titleCharacters } }, required: ['collection', 'entry'], additionalProperties: false },
    async execute({ collection, entry }) { return await store.remove({ collection, entry }); },
  }];
}
