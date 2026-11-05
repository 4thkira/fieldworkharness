import { createHash } from 'node:crypto';
import { boundedJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';

export const FIELDWORK_CONFIG_FORMAT = 'fieldwork-config/v1';
export const PACK_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const CONFIG_LIMITS = Object.freeze({
  packs: 32,
  sourceBytes: 256 * 1024,
  optionBytes: 64 * 1024,
  totalOptionBytes: 256 * 1024,
});

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const validated = new WeakSet();
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function configError(message) {
  return new Error(`Configuration: ${message}`);
}

function exactKeys(value, allowed, where) {
  if (!isPlainObject(value)) throw configError(`${where} must be an object`);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw configError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw configError(`${where}.${key} must be an enumerable data property`);
    fields[key] = descriptor.value;
  }
  return fields;
}

function positiveLimit(value, fallback, name) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < 1) throw configError(`${name} must be a positive whole number`);
  return number;
}

function limitsFrom(options) {
  if (!isPlainObject(options)) throw configError('normalizer options must be an object');
  const fields = exactKeys(options, ['maxPacks', 'maxSourceBytes', 'maxOptionBytes', 'maxTotalOptionBytes'], 'normalizer options');
  return Object.freeze({
    packs: positiveLimit(fields.maxPacks, CONFIG_LIMITS.packs, 'maxPacks'),
    sourceBytes: positiveLimit(fields.maxSourceBytes, CONFIG_LIMITS.sourceBytes, 'maxSourceBytes'),
    optionBytes: positiveLimit(fields.maxOptionBytes, CONFIG_LIMITS.optionBytes, 'maxOptionBytes'),
    totalOptionBytes: positiveLimit(fields.maxTotalOptionBytes, CONFIG_LIMITS.totalOptionBytes, 'maxTotalOptionBytes'),
  });
}

export function isFieldworkConfig(value) {
  return Boolean(value) && validated.has(value);
}

export function normalizeFieldworkConfig(input, options = {}) {
  const limits = limitsFrom(options);
  if (isFieldworkConfig(input) && Reflect.ownKeys(options).length === 0) return input;
  if (isFieldworkConfig(input)) input = { format: input.format, packs: input.packs.map(pack => ({ name: pack.name, options: pack.options })) };
  try { input = boundedJson(input, { where: 'configuration', object: true, maxBytes: limits.sourceBytes }).value; }
  catch (error) { throw configError(error.message); }
  const configuration = exactKeys(input, ['format', 'packs'], 'configuration');
  if (configuration.format !== FIELDWORK_CONFIG_FORMAT) throw configError(`format must be ${FIELDWORK_CONFIG_FORMAT}`);
  if (!Array.isArray(configuration.packs)) throw configError('packs must be an array');
  if (configuration.packs.length > limits.packs) throw configError(`packs has ${configuration.packs.length} entries; the limit is ${limits.packs}`);

  const names = new Set();
  const packs = [];
  let totalOptionBytes = 0;
  for (let index = 0; index < configuration.packs.length; index++) {
    const where = `packs[${index}]`;
    const row = exactKeys(configuration.packs[index], ['name', 'options'], where);
    if (typeof row.name !== 'string' || !PACK_NAME_PATTERN.test(row.name)) {
      throw configError(`${where}.name must be lowercase letters, digits and hyphens, beginning with a letter`);
    }
    if (names.has(row.name)) throw configError(`packs repeats ${JSON.stringify(row.name)}`);
    names.add(row.name);
    let normalized;
    try {
      normalized = boundedJson(row.options === undefined ? {} : row.options, { where: `${where}.options`, object: true, maxBytes: limits.optionBytes });
    } catch (error) {
      throw configError(error.message);
    }
    totalOptionBytes += normalized.bytes;
    if (totalOptionBytes > limits.totalOptionBytes) {
      throw configError(`pack options total ${totalOptionBytes} JSON bytes; the limit is ${limits.totalOptionBytes}`);
    }
    packs.push({ name: row.name, options: normalized.value, optionBytes: normalized.bytes });
  }

  const semantic = {
    format: FIELDWORK_CONFIG_FORMAT,
    packs: packs.map(pack => ({ name: pack.name, options: pack.options })),
  };
  const canonical = boundedJson(semantic, { where: 'configuration', maxBytes: limits.sourceBytes }).canonical;
  const config = {
    format: FIELDWORK_CONFIG_FORMAT,
    packs: packs.map(({ name, options: packOptions }) => ({ name, options: packOptions })),
    receipt: {
      format: FIELDWORK_CONFIG_FORMAT,
      packs: packs.map(pack => ({ name: pack.name, optionBytes: pack.optionBytes })),
      totals: { packs: packs.length, optionBytes: totalOptionBytes },
      fingerprint: sha256(canonical),
    },
  };
  deepFreeze(config);
  validated.add(config);
  return config;
}

export function parseFieldworkConfig(source, options = {}) {
  const limits = limitsFrom(options);
  let bytes;
  if (typeof source === 'string') bytes = encoder.encode(source);
  else if (ArrayBuffer.isView(source) && source.BYTES_PER_ELEMENT === 1 && !(source instanceof DataView)) {
    bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  else throw configError('source must be text or UTF-8 bytes');
  if (bytes.length > limits.sourceBytes) throw configError(`source is ${bytes.length} bytes; the limit is ${limits.sourceBytes}`);
  let text;
  try { text = decoder.decode(bytes); }
  catch { throw configError('source must be valid UTF-8'); }
  let value;
  try { value = parseJsonNoDuplicates(text, { where: 'source' }); }
  catch (error) { throw configError(error.message); }
  return normalizeFieldworkConfig(value, options);
}
