import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseJsonNoDuplicates } from './json-data.mjs';
import { readStableFile } from './stable-file-read.mjs';

// Meaning-based recall: one extra seat beside automatic memory's word matches.
//
// Automatic memory finds a memory when the newest message shares its words. A
// message that says the same thing differently ("my dog" for a memory about
// "the puppy") shares none and finds nothing. A small embedding model reached
// through a loopback service reads for meaning instead.
//
// Measured in a private predecessor: blending a meaning ranking into the word
// ranking made recall worse (it is poor at quotes and dates), while giving its
// single best pick a seat of its own beside the word matches made recall
// better. So it gets a seat, never a vote on the word matches' order, and only
// above a similarity floor so a greeting does not drag in a random memory.
//
// Fieldwork sends memory text only to the configured loopback endpoint. That
// constrains Fieldwork's first hop; the operator still has to trust what the
// local service itself does. Vectors are cached by text hash in the agent's
// state folder, so each lookup embeds only the message and a few memories that
// are new since last time. A service failure gives no seat; an explicit caller
// cancellation remains cancellation of the surrounding work.

export const MEANING_RECALL_FORMAT = 'fieldwork-meaning-recall/v2';
const CACHE_NAMESPACE_FORMAT = 'fieldwork-meaning-cache-namespace/v1';
const SPACE_SIGNATURE_FORMAT = 'fieldwork-meaning-space-signature/q15-v1';
const SPACE_PROBES = Object.freeze([
  'Fieldwork embedding-space probe: a puppy carrying a biscuit.',
  'Fieldwork embedding-space probe: smoky lapsang tea in a blue cup.',
  'Fieldwork embedding-space probe: tomatoes growing beside a garden fence.',
]);
const CACHE_HEADER_RESERVE = 2_048;
export const MEANING_RECALL_DEFAULTS = Object.freeze({
  baseURL: 'http://127.0.0.1:11434/v1',
  model: 'qwen3-embedding:0.6b',
  // On synthetic pairs with qwen3-embedding:0.6b, paraphrases scored 0.45–0.54
  // and the best match for unrelated questions 0.28–0.37 (2026-11-05).
  floor: 0.42,
  seats: 1,
  newPerLookup: 16,
  batch: 8,
  timeoutMs: 10_000,
  textCharacters: 4_000,
  cacheEntries: 20_000,
  cacheBytes: 128 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  maxDimensions: 8_192,
});

const recalls = new WeakSet();
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const hashPattern = /^[0-9a-f]{64}$/u;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function meaningError(message, cause) {
  return new Error(`Meaning recall: ${message}`, cause === undefined ? undefined : { cause });
}

function loopbackBase(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw meaningError('baseURL must be an absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw meaningError('baseURL must use http or https');
  if (!loopbackHosts.has(url.hostname)) {
    throw meaningError('baseURL must be a loopback endpoint (127.0.0.1, localhost or [::1])');
  }
  if (url.username || url.password || url.search || url.hash) throw meaningError('baseURL must not carry credentials, a query or a fragment');
  return url.href.replace(/\/+$/u, '');
}

function bounded(value, fallback, minimum, maximum, name) {
  const number = value === undefined ? fallback : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < minimum || number > maximum) {
    throw meaningError(`${name} must be a number from ${minimum} to ${maximum}`);
  }
  return number;
}

function whole(value, fallback, minimum, maximum, name) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw meaningError(`${name} must be a whole number from ${minimum} to ${maximum}`);
  }
  return number;
}

function optionalSignal(value, where) {
  if (value !== undefined && (typeof value !== 'object' || typeof value.throwIfAborted !== 'function')) {
    throw meaningError(`${where} must be an AbortSignal when present`);
  }
  return value;
}

function timedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function rethrowCallerCancellation(signal) {
  if (signal?.aborted) signal.throwIfAborted();
}

// Qwen3-Embedding is trained with an instruction in front of a query, while
// documents go in bare; other models get the query as it is.
export function meaningQuery(model, text) {
  return /^qwen3-embedding/iu.test(model)
    ? `Instruct: Given a query, retrieve the passages that best match it\nQuery: ${text}`
    : text;
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function vectorNorm(vector) {
  let scale = 0;
  let sum = 0;
  for (const value of vector) {
    const absolute = Math.abs(value);
    if (!absolute) continue;
    if (absolute > scale) {
      const ratio = scale / absolute;
      sum = 1 + sum * ratio * ratio;
      scale = absolute;
    } else {
      const ratio = absolute / scale;
      sum += ratio * ratio;
    }
  }
  return scale ? scale * Math.sqrt(sum) : 0;
}

function normalizedVector(values, maximum) {
  if (!Array.isArray(values) || !values.length || values.length > maximum
      || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw meaningError('the embedding service returned an invalid vector');
  }
  const norm = vectorNorm(values);
  if (!Number.isFinite(norm) || norm === 0) throw meaningError('the embedding service returned a zero or invalid vector');
  const vector = Float32Array.from(values, value => value / norm);
  const floatNorm = vectorNorm(vector);
  if (!Number.isFinite(floatNorm) || floatNorm === 0) throw meaningError('the embedding service returned an unusable vector');
  for (let index = 0; index < vector.length; index++) vector[index] /= floatNorm;
  return vector;
}

function dot(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += left[index] * right[index];
  return sum;
}

function encodeVector(vector) {
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index++) bytes.writeFloatLE(vector[index], index * 4);
  return bytes.toString('base64');
}

function decodeVector(text, dims) {
  const expectedBytes = dims * 4;
  const expectedCharacters = 4 * Math.ceil(expectedBytes / 3);
  if (typeof text !== 'string' || text.length !== expectedCharacters || !base64Pattern.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== text) return null;
  const vector = new Float32Array(dims);
  for (let index = 0; index < dims; index++) {
    const value = bytes.readFloatLE(index * 4);
    if (!Number.isFinite(value)) return null;
    vector[index] = value;
  }
  const norm = vectorNorm(vector);
  return Number.isFinite(norm) && Math.abs(norm - 1) <= 0.001 ? vector : null;
}

function spaceSignature(vectors) {
  const digest = createHash('sha256');
  digest.update(`${SPACE_SIGNATURE_FORMAT}\0${vectors[0].length}\0`, 'utf8');
  for (let probe = 0; probe < vectors.length; probe++) {
    digest.update(`${SPACE_PROBES[probe]}\0`, 'utf8');
    const quantized = Buffer.allocUnsafe(vectors[probe].length * 2);
    for (let index = 0; index < vectors[probe].length; index++) {
      const value = Math.max(-1, Math.min(1, vectors[probe][index]));
      quantized.writeInt16LE(Math.round(value * 32_767), index * 2);
    }
    digest.update(quantized);
  }
  return digest.digest('hex');
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

async function boundedResponseJson(response, maximum, signal) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    throw meaningError('the embedding service returned no readable response body');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw meaningError('the embedding service returned an invalid response body');
      bytes += value.byteLength;
      if (bytes > maximum) {
        try { await reader.cancel(); } catch { /* The size refusal is the useful failure. */ }
        throw meaningError(`the embedding service response exceeds ${maximum} bytes`);
      }
      if (chunks.length >= 4_096) {
        try { await reader.cancel(); } catch { /* The fragmentation refusal is the useful failure. */ }
        throw meaningError('the embedding service response is too fragmented');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* A completed or cancelled reader needs no further action. */ }
  }
  const body = Buffer.allocUnsafe(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let source;
  try { source = utf8.decode(body); } catch (error) { throw meaningError('the embedding service returned invalid UTF-8', error); }
  try { return parseJsonNoDuplicates(source, { where: 'embedding response', maxDepth: 8 }); }
  catch (error) { throw meaningError('the embedding service returned invalid JSON', error); }
}

export function isMeaningRecall(value) {
  return Boolean(value) && recalls.has(value);
}

export async function createMeaningRecall({
  stateDir, baseURL = MEANING_RECALL_DEFAULTS.baseURL, model = MEANING_RECALL_DEFAULTS.model,
  floor, seats, newPerLookup, timeoutMs, cacheEntries, cacheBytes, responseBytes, maxDimensions,
  fetch = globalThis.fetch,
} = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw meaningError('stateDir must be an absolute path');
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model)) throw meaningError('model must be a portable model id');
  if (typeof fetch !== 'function') throw meaningError('fetch must be a function');
  const base = loopbackBase(baseURL);
  const settings = Object.freeze({
    floor: bounded(floor, MEANING_RECALL_DEFAULTS.floor, 0, 1, 'floor'),
    seats: whole(seats, MEANING_RECALL_DEFAULTS.seats, 1, 3, 'seats'),
    newPerLookup: whole(newPerLookup, MEANING_RECALL_DEFAULTS.newPerLookup, 0, 256, 'newPerLookup'),
    timeoutMs: whole(timeoutMs, MEANING_RECALL_DEFAULTS.timeoutMs, 100, 120_000, 'timeoutMs'),
    cacheEntries: whole(cacheEntries, MEANING_RECALL_DEFAULTS.cacheEntries, 1, 100_000, 'cacheEntries'),
    cacheBytes: whole(cacheBytes, MEANING_RECALL_DEFAULTS.cacheBytes, 4_096, 512 * 1024 * 1024, 'cacheBytes'),
    responseBytes: whole(responseBytes, MEANING_RECALL_DEFAULTS.responseBytes, 1_024, 64 * 1024 * 1024, 'responseBytes'),
    maxDimensions: whole(maxDimensions, MEANING_RECALL_DEFAULTS.maxDimensions, 1, 65_536, 'maxDimensions'),
  });
  const endpointSha256 = sha256(base);
  const namespace = sha256(`${CACHE_NAMESPACE_FORMAT}\0${base}\0${model}`);
  const file = path.join(stateDir, `meaning-vectors-${namespace.slice(0, 32)}.json`);

  let dims = 0;
  let cachedSpaceSignature = null;
  let verifiedSpaceSignature = null;
  let cacheRevision = 0;
  let savedRevision = 0;
  const vectors = new Map();

  const effectiveEntryLimit = dimension => {
    if (!Number.isSafeInteger(dimension) || dimension < 1) return 1;
    const encodedCharacters = 4 * Math.ceil((dimension * 4) / 3);
    const byBytes = Math.floor((settings.cacheBytes - CACHE_HEADER_RESERVE) / (encodedCharacters + 128));
    return Math.max(1, Math.min(settings.cacheEntries, byBytes));
  };

  const trimVectors = () => {
    const limit = effectiveEntryLimit(dims);
    while (vectors.size > limit) {
      vectors.delete(vectors.keys().next().value);
      cacheRevision++;
    }
  };

  const rememberVector = (hash, vector) => {
    if (vectors.has(hash)) vectors.delete(hash);
    vectors.set(hash, vector);
    cacheRevision++;
    trimVectors();
  };

  let cacheObserved = false;
  try {
    const cacheInfo = await fs.lstat(file, { bigint: true });
    cacheObserved = true;
    if (cacheInfo.size > BigInt(settings.cacheBytes)) throw meaningError('the vector cache is too large');
    const bytes = await readStableFile(file, {
      // readStableFile allocates its declared ceiling. Use the already-bounded
      // observed size; its identity checks still refuse a replacement or growth.
      maxBytes: Math.max(1, Number(cacheInfo.size)),
      label: 'meaning vector cache',
    });
    const saved = parseJsonNoDuplicates(utf8.decode(bytes), { where: 'meaning vector cache', maxDepth: 6 });
    if (!plainObject(saved) || saved.format !== MEANING_RECALL_FORMAT || saved.namespace !== namespace
        || saved.endpointSha256 !== endpointSha256 || saved.model !== model
        || !Number.isSafeInteger(saved.dims) || saved.dims < 1 || saved.dims > settings.maxDimensions
        || !plainObject(saved.space) || saved.space.format !== SPACE_SIGNATURE_FORMAT
        || !hashPattern.test(saved.space.signature) || saved.space.probes !== SPACE_PROBES.length
        || !plainObject(saved.vectors)) throw meaningError('the vector cache has invalid metadata');
    const keys = Object.keys(saved.vectors);
    if (keys.length > effectiveEntryLimit(saved.dims)) throw meaningError('the vector cache has too many entries');
    const loaded = new Map();
    for (const hash of keys) {
      if (!hashPattern.test(hash)) throw meaningError('the vector cache has an invalid text hash');
      const vector = decodeVector(saved.vectors[hash], saved.dims);
      if (!vector) throw meaningError('the vector cache has an invalid vector');
      loaded.set(hash, vector);
    }
    dims = saved.dims;
    cachedSpaceSignature = saved.space.signature;
    for (const [hash, vector] of loaded) vectors.set(hash, vector);
  } catch {
    dims = 0;
    cachedSpaceSignature = null;
    vectors.clear();
    // Missing is the ordinary first run. A file that existed but failed any
    // v2 bound or semantic check is derived state and should be replaced after
    // the service verifies its current embedding space.
    if (cacheObserved) cacheRevision++;
  }

  const cacheBody = () => {
    if (!dims || !verifiedSpaceSignature) throw meaningError('the embedding space is not verified');
    trimVectors();
    while (true) {
      const encoded = Object.create(null);
      for (const [hash, vector] of vectors) encoded[hash] = encodeVector(vector);
      const body = JSON.stringify({
        format: MEANING_RECALL_FORMAT,
        namespace,
        endpointSha256,
        model,
        dims,
        space: { format: SPACE_SIGNATURE_FORMAT, signature: verifiedSpaceSignature, probes: SPACE_PROBES.length },
        vectors: encoded,
      });
      if (Buffer.byteLength(body, 'utf8') <= settings.cacheBytes) return body;
      if (!vectors.size) throw meaningError(`the vector cache metadata exceeds ${settings.cacheBytes} bytes`);
      vectors.delete(vectors.keys().next().value);
      cacheRevision++;
    }
  };

  let persistTail = Promise.resolve();
  const persist = signal => {
    const operation = persistTail.then(async () => {
      signal?.throwIfAborted();
      // Build inside the queue: a later writer sees every vector remembered by
      // an earlier concurrent check or pick and cannot publish an older view.
      const body = cacheBody();
      const revision = cacheRevision;
      await fs.mkdir(stateDir, { recursive: true });
      const temporary = path.join(stateDir, `.${path.basename(file)}.${randomUUID()}.tmp`);
      let published = false;
      try {
        await fs.writeFile(temporary, body, { flag: 'wx', ...(signal ? { signal } : {}) });
        signal?.throwIfAborted();
        await fs.rename(temporary, file);
        published = true;
        savedRevision = revision;
      } finally {
        if (!published) await fs.rm(temporary, { force: true });
      }
    });
    persistTail = operation.catch(() => {});
    return operation;
  };

  const requestEmbeddings = async (inputs, signal) => {
    signal.throwIfAborted();
    const response = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: inputs }),
      signal,
      redirect: 'error',
    });
    if (!response || typeof response.ok !== 'boolean') throw meaningError('the embedding service returned an invalid response');
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* The status is the useful failure. */ }
      throw meaningError(`the embedding service answered ${response.status}`);
    }
    const json = await boundedResponseJson(response, settings.responseBytes, signal);
    const rows = Array.isArray(json?.data) ? json.data : [];
    if (rows.length !== inputs.length) throw meaningError(`the embedding service answered without ${inputs.length} embeddings`);
    const ordered = new Array(inputs.length);
    for (const row of rows) {
      if (!plainObject(row) || !Number.isSafeInteger(row.index) || row.index < 0 || row.index >= inputs.length
          || ordered[row.index] !== undefined) {
        throw meaningError('the embedding service returned duplicate or invalid indices');
      }
      ordered[row.index] = normalizedVector(row.embedding, settings.maxDimensions);
    }
    const dimension = ordered[0]?.length ?? 0;
    if (!dimension || ordered.some(vector => vector.length !== dimension)) {
      throw meaningError('the embedding service returned inconsistent vector sizes');
    }
    return ordered;
  };

  const invalidateSpace = () => {
    vectors.clear();
    dims = 0;
    cachedSpaceSignature = null;
    verifiedSpaceSignature = null;
    cacheRevision++;
  };

  const ensureSpace = async signal => {
    signal.throwIfAborted();
    if (verifiedSpaceSignature) return { invalidated: false };
    const probes = await requestEmbeddings(SPACE_PROBES, signal);
    const nextDims = probes[0].length;
    const signature = spaceSignature(probes);
    const hadCache = dims > 0;
    const invalidated = hadCache && (dims !== nextDims || cachedSpaceSignature !== signature);
    if (invalidated) {
      vectors.clear();
      cacheRevision++;
    }
    dims = nextDims;
    cachedSpaceSignature = signature;
    verifiedSpaceSignature = signature;
    trimVectors();
    return { invalidated };
  };

  const acceptDimensions = made => {
    if (made.some(vector => vector.length !== dims)) {
      invalidateSpace();
      throw meaningError('the embedding service changed vector size; the cache was reset');
    }
  };

  // The ids of the closest memories above the floor, skipping `taken`. Memories
  // without a vector yet are not candidates this time; a few are embedded per call.
  const pick = async ({ message, items, taken = [], signal: callerSignal } = {}) => {
    const started = Date.now();
    const caller = optionalSignal(callerSignal, 'signal');
    const deadline = timedSignal(caller, settings.timeoutMs);
    const { signal } = deadline;
    const trace = { model, floorPpm: Math.round(settings.floor * 1_000_000), picked: 0, embedded: 0, waiting: 0, ms: 0 };
    try {
      caller?.throwIfAborted();
      if (typeof message !== 'string' || !message.trim()) throw meaningError('message must be text');
      if (!Array.isArray(items)) throw meaningError('items must be a list');
      const skip = new Set(taken);
      const pool = items
        .filter(item => typeof item?.id === 'string' && typeof item.text === 'string' && !skip.has(item.id))
        .map(item => {
          const text = [...item.text].slice(0, MEANING_RECALL_DEFAULTS.textCharacters).join('');
          return { id: item.id, text, hash: sha256(text) };
        });
      const space = await ensureSpace(signal);
      if (space.invalidated) trace.cacheInvalidated = true;
      const missing = [...new Map(pool.filter(item => !vectors.has(item.hash)).map(item => [item.hash, item])).values()]
        .slice(0, settings.newPerLookup);
      for (let index = 0; index < missing.length; index += MEANING_RECALL_DEFAULTS.batch) {
        const chunk = missing.slice(index, index + MEANING_RECALL_DEFAULTS.batch);
        const made = await requestEmbeddings(chunk.map(item => item.text), signal);
        acceptDimensions(made);
        chunk.forEach((item, position) => rememberVector(item.hash, made[position]));
        trace.embedded += chunk.length;
      }
      if (trace.embedded || cacheRevision !== savedRevision) {
        try { await persist(signal); } catch {
          rethrowCallerCancellation(caller);
          trace.cacheSaved = false;
        }
      }
      trace.waiting = pool.filter(item => !vectors.has(item.hash)).length;
      const [query] = await requestEmbeddings([
        meaningQuery(model, [...message].slice(0, MEANING_RECALL_DEFAULTS.textCharacters).join('')),
      ], signal);
      acceptDimensions([query]);
      const scored = pool
        .filter(item => vectors.has(item.hash))
        .map(item => ({ id: item.id, similarity: dot(query, vectors.get(item.hash)) }));
      if (scored.some(row => !Number.isFinite(row.similarity))) throw meaningError('a cached vector produced an invalid similarity');
      scored.sort((left, right) => right.similarity - left.similarity || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      if (scored.length) trace.bestPpm = Math.round(scored[0].similarity * 1_000_000);
      const picks = [];
      const seen = new Set();
      for (const row of scored) {
        if (picks.length >= settings.seats || row.similarity < settings.floor) break;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        picks.push({ id: row.id, similarityPpm: Math.round(row.similarity * 1_000_000) });
      }
      trace.picked = picks.length;
      trace.ms = Date.now() - started;
      caller?.throwIfAborted();
      return { picks, trace };
    } catch (error) {
      rethrowCallerCancellation(caller);
      trace.ms = Date.now() - started;
      trace.error = String(error?.message ?? error).slice(0, 200);
      return { picks: [], trace };
    } finally {
      deadline.clear();
    }
  };

  // Fixed probes warm the model and bind a persisted cache to the embedding
  // space observed by this process. A changed space is rebuilt, never mixed.
  const check = async ({ timeoutMs: limit = 30_000, signal: callerSignal } = {}) => {
    const caller = optionalSignal(callerSignal, 'check.signal');
    const duration = whole(limit, 30_000, 100, 120_000, 'check.timeoutMs');
    const deadline = timedSignal(caller, duration);
    const { signal } = deadline;
    try {
      const space = await ensureSpace(signal);
      if (space.invalidated || cacheRevision !== savedRevision) await persist(signal);
      caller?.throwIfAborted();
      return { ok: true };
    } catch (error) {
      rethrowCallerCancellation(caller);
      return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
    } finally {
      deadline.clear();
    }
  };

  const recall = Object.freeze({ model, baseURL: base, settings, pick, check });
  recalls.add(recall);
  return recall;
}
