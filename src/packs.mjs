import { createHash } from 'node:crypto';
import { isFieldworkConfig, PACK_NAME_PATTERN } from './config.mjs';
import { boundedJson, deepFreeze, isPlainObject } from './json-data.mjs';

export const PACK_API_VERSION = 1;
export const PACK_HOST_RECEIPT_FORMAT = 'fieldwork-pack-host/v1';
export const PACK_LIFECYCLE_LIMITS = Object.freeze({ loadTimeoutMs: 30_000, setupTimeoutMs: 30_000, cleanupTimeoutMs: 10_000 });

const numericIdentifier = '(?:0|[1-9]\\d*)';
const prereleaseIdentifier = `(?:${numericIdentifier}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const serviceName = /^[a-z][a-z0-9-]{0,63}$/;
const registries = new WeakMap();
const serviceCatalogs = new WeakMap();
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function packError(message, cause) {
  return new Error(`Packs: ${message}`, cause === undefined ? undefined : { cause });
}

function reasonOf(error) {
  try {
    if (error instanceof Error) return String(error.message || error.name || 'Error');
    return String(error);
  } catch {
    return 'a thrown value that could not be rendered';
  }
}

function errorOf(error) {
  if (error instanceof Error) return error;
  return new Error(reasonOf(error));
}

function exactFields(value, allowed, where) {
  if (!isPlainObject(value)) throw packError(`${where} must be an object`);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw packError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw packError(`${where}.${key} must be an enumerable data property`);
    fields[key] = descriptor.value;
  }
  return fields;
}

function apiVersion(value, where) {
  if (!Number.isSafeInteger(value) || value < 1) throw packError(`${where} must be a positive whole number`);
  return value;
}

export function createPackRegistry(loaders) {
  if (!isPlainObject(loaders)) throw packError('registry entries must be an object of loader functions');
  const entries = new Map();
  for (const key of Reflect.ownKeys(loaders)) {
    if (typeof key !== 'string' || !PACK_NAME_PATTERN.test(key)) throw packError(`invalid registry pack name ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(loaders, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      throw packError(`registry entry ${key} must be an enumerable loader function`);
    }
    entries.set(key, descriptor.value);
  }
  if (entries.size > 128) throw packError('registry contains more than 128 packs');
  const names = Object.freeze([...entries.keys()].sort());
  const registry = Object.freeze({ names });
  registries.set(registry, { entries, resolved: new Map() });
  return registry;
}

export function createHostServices(entries = {}) {
  if (!isPlainObject(entries)) throw packError('host services must be an object');
  const services = new Map();
  for (const key of Reflect.ownKeys(entries)) {
    if (typeof key !== 'string' || !serviceName.test(key)) throw packError(`invalid host service name ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(entries, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw packError(`host service ${key} must be an enumerable data property`);
    const fields = exactFields(descriptor.value, ['apiVersion', 'value'], `host service ${key}`);
    const version = apiVersion(fields.apiVersion, `host service ${key}.apiVersion`);
    if (fields.value === undefined) throw packError(`host service ${key}.value may not be undefined`);
    services.set(key, { apiVersion: version, value: fields.value });
  }
  if (services.size > 128) throw packError('more than 128 host services were supplied');
  const names = Object.freeze([...services.keys()].sort());
  const catalog = Object.freeze({
    names,
    receipt: deepFreeze(names.map(name => ({ name, apiVersion: services.get(name).apiVersion }))),
  });
  serviceCatalogs.set(catalog, services);
  return catalog;
}

function serviceRequirements(value, where) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) throw packError(`${where} must be an object of exact API versions`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !serviceName.test(key)) throw packError(`${where} has invalid service name ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw packError(`${where}.${key} must be an enumerable data property`);
    result[key] = apiVersion(descriptor.value, `${where}.${key}`);
  }
  if (Object.keys(result).length > 32) throw packError(`${where} names more than 32 services`);
  return Object.freeze(result);
}

function validateDefinition(raw, expectedName) {
  const fields = exactFields(raw, ['apiVersion', 'name', 'version', 'requiredServices', 'optionalServices', 'configure', 'setup'], `pack ${expectedName}`);
  if (fields.apiVersion !== PACK_API_VERSION) throw packError(`pack ${expectedName}.apiVersion must be ${PACK_API_VERSION}`);
  if (fields.name !== expectedName) throw packError(`pack loaded as ${expectedName} must declare that same name`);
  if (typeof fields.version !== 'string' || fields.version.length > 256 || !semver.test(fields.version)) throw packError(`pack ${expectedName}.version must be SemVer text such as 0.1.0`);
  const requiredServices = serviceRequirements(fields.requiredServices, `pack ${expectedName}.requiredServices`);
  const optionalServices = serviceRequirements(fields.optionalServices, `pack ${expectedName}.optionalServices`);
  const overlap = Object.keys(requiredServices).find(name => Object.hasOwn(optionalServices, name));
  if (overlap) throw packError(`pack ${expectedName} lists ${overlap} as both required and optional`);
  if (fields.configure !== undefined && typeof fields.configure !== 'function') throw packError(`pack ${expectedName}.configure must be a function`);
  if (fields.setup !== undefined && typeof fields.setup !== 'function') throw packError(`pack ${expectedName}.setup must be a function`);
  return Object.freeze({
    apiVersion: PACK_API_VERSION,
    name: expectedName,
    version: fields.version,
    requiredServices,
    optionalServices,
    configure: fields.configure ?? null,
    setup: fields.setup ?? null,
  });
}

async function loadDefinition(registryRecord, name, { signal, loadTimeoutMs }) {
  if (!registryRecord.resolved.has(name)) {
    const promise = Promise.resolve()
      .then(() => registryRecord.entries.get(name)())
      .then(loaded => {
        if (!isPlainObject(loaded) || !Object.hasOwn(loaded, 'default')) return validateDefinition(loaded, name);
        const descriptor = Object.getOwnPropertyDescriptor(loaded, 'default');
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw packError(`pack ${name} module default must be an enumerable data property`);
        return validateDefinition(descriptor.value, name);
      })
      .catch(error => {
        registryRecord.resolved.delete(name);
        throw packError(`could not load pack ${name}: ${reasonOf(error)}`, error);
      });
    registryRecord.resolved.set(name, promise);
  }
  const promise = registryRecord.resolved.get(name);
  let detachAbort = () => {};
  const aborted = new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(errorOf(signal.reason ?? new Error('Pack loading was aborted')));
    else {
      const stop = () => reject(errorOf(signal.reason ?? new Error('Pack loading was aborted')));
      signal.addEventListener('abort', stop, { once: true });
      detachAbort = () => signal.removeEventListener('abort', stop);
    }
  });
  try {
    return await withTimeout(
      Promise.race([promise, aborted]),
      loadTimeoutMs,
      `pack ${name} loader timed out after ${loadTimeoutMs}ms`,
      () => { if (registryRecord.resolved.get(name) === promise) registryRecord.resolved.delete(name); },
    );
  } finally {
    detachAbort();
    if (signal?.aborted && registryRecord.resolved.get(name) === promise) registryRecord.resolved.delete(name);
  }
}

function negotiateServices(definition, available) {
  const values = Object.create(null);
  const versions = Object.create(null);
  const required = [];
  const optional = [];
  for (const name of Object.keys(definition.requiredServices).sort()) {
    const expected = definition.requiredServices[name];
    const actual = available.get(name);
    if (!actual) throw packError(`pack ${definition.name} requires host service ${name} API ${expected}, but it is unavailable`);
    if (actual.apiVersion !== expected) {
      throw packError(`pack ${definition.name} requires host service ${name} API ${expected}, but the host provides API ${actual.apiVersion}`);
    }
    values[name] = actual.value;
    versions[name] = actual.apiVersion;
    required.push({ name, apiVersion: expected });
  }
  for (const name of Object.keys(definition.optionalServices).sort()) {
    const expected = definition.optionalServices[name];
    const actual = available.get(name);
    if (!actual) {
      optional.push({ name, apiVersion: expected, status: 'unavailable' });
      continue;
    }
    if (actual.apiVersion !== expected) {
      optional.push({ name, apiVersion: expected, status: 'version-mismatch', hostApiVersion: actual.apiVersion });
      continue;
    }
    values[name] = actual.value;
    versions[name] = actual.apiVersion;
    optional.push({ name, apiVersion: expected, status: 'available' });
  }
  return {
    values: Object.freeze(values),
    versions: Object.freeze(versions),
    receipt: deepFreeze({ required, optional }),
  };
}

function configurePack(definition, options) {
  if (!definition.configure) {
    if (Object.keys(options).length) throw packError(`pack ${definition.name} has options but does not declare configure()`);
    return Object.freeze({ config: Object.freeze({}), fingerprint: sha256('{}') });
  }
  let answer;
  try { answer = definition.configure(options); }
  catch (error) { throw packError(`pack ${definition.name} configure() failed: ${reasonOf(error)}`, error); }
  if (answer instanceof Promise) throw packError(`pack ${definition.name} configure() must be synchronous`);
  let normalized;
  try { normalized = boundedJson(answer, { where: `pack ${definition.name} configure() result`, object: true }); }
  catch (error) { throw packError(error.message, error); }
  return Object.freeze({ config: normalized.value, fingerprint: sha256(normalized.canonical) });
}

function timeoutValue(value, fallback, name) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < 10 || number > 300_000) throw packError(`${name} must be a whole number from 10 to 300000`);
  return number;
}

async function withTimeout(promise, milliseconds, message, onTimeout = () => {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = packError(message);
      onTimeout(error);
      reject(error);
    }, milliseconds);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

async function settleRuntime(runtime, reason) {
  if (runtime.settled) return runtime.settled;
  runtime.settled = (async () => {
    runtime.acceptingDefers = false;
    runtime.controller.abort(packError(reason));
    runtime.detachExternal?.();
    const errors = [];
    const cleanups = [runtime.stop, ...[...runtime.deferred].reverse()].filter(Boolean);
    runtime.stop = null;
    runtime.deferred.length = 0;
    for (const cleanup of cleanups) {
      try { await withTimeout(Promise.resolve().then(cleanup), runtime.cleanupTimeoutMs, `pack ${runtime.name} cleanup timed out after ${runtime.cleanupTimeoutMs}ms`); }
      catch (error) { errors.push(errorOf(error)); }
    }
    return errors;
  })();
  return runtime.settled;
}

async function activate(prepared, { externalSignal, setupTimeoutMs, cleanupTimeoutMs }) {
  const runtime = {
    name: prepared.definition.name,
    controller: new AbortController(),
    deferred: [],
    acceptingDefers: true,
    stop: null,
    settled: null,
    cleanupTimeoutMs,
    detachExternal: null,
  };
  if (externalSignal) {
    const stop = () => runtime.controller.abort(errorOf(externalSignal.reason ?? new Error('Pack host start was aborted')));
    if (externalSignal.aborted) stop();
    else {
      externalSignal.addEventListener('abort', stop, { once: true });
      runtime.detachExternal = () => externalSignal.removeEventListener('abort', stop);
    }
  }
  const defer = cleanup => {
    if (!runtime.acceptingDefers) throw packError(`pack ${runtime.name} called defer() after setup`);
    if (typeof cleanup !== 'function') throw packError(`pack ${runtime.name} defer() requires a cleanup function`);
    runtime.deferred.push(cleanup);
    return cleanup;
  };
  let live;
  try {
    const setupPromise = prepared.definition.setup
      ? Promise.resolve().then(() => prepared.definition.setup({
          config: prepared.config,
          services: prepared.services.values,
          serviceVersions: prepared.services.versions,
          signal: runtime.controller.signal,
          defer,
        }))
      : Promise.resolve(undefined);
    let detachSetupAbort = () => {};
    const aborted = new Promise((_, reject) => {
      const signal = runtime.controller.signal;
      if (signal.aborted) reject(errorOf(signal.reason));
      else {
        const stop = () => reject(errorOf(signal.reason));
        signal.addEventListener('abort', stop, { once: true });
        detachSetupAbort = () => signal.removeEventListener('abort', stop);
      }
    });
    try {
      live = await withTimeout(
        Promise.race([setupPromise, aborted]),
        setupTimeoutMs,
        `pack ${runtime.name} setup timed out after ${setupTimeoutMs}ms`,
        error => runtime.controller.abort(error),
      );
    } finally {
      detachSetupAbort();
    }
    runtime.acceptingDefers = false;
    if (live === undefined) live = {};
    if (isPlainObject(live)) {
      const descriptor = Object.getOwnPropertyDescriptor(live, 'stop');
      if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function') runtime.stop = descriptor.value.bind(live);
    }
    const fields = exactFields(live, ['stop'], `pack ${runtime.name} setup() result`);
    if (fields.stop !== undefined && typeof fields.stop !== 'function') throw packError(`pack ${runtime.name} setup().stop must be a function`);
    return runtime;
  } catch (error) {
    runtime.acceptingDefers = false;
    const cleanupErrors = await settleRuntime(runtime, `Pack ${runtime.name} setup failed`);
    const failure = packError(`pack ${runtime.name} setup() failed: ${reasonOf(error)}`, error);
    Object.defineProperty(failure, 'cleanupErrors', {
      value: Object.freeze(cleanupErrors), enumerable: true, configurable: true,
    });
    throw failure;
  }
}

export async function startPackHost({
  config,
  registry,
  services = createHostServices(),
  signal,
  loadTimeoutMs = PACK_LIFECYCLE_LIMITS.loadTimeoutMs,
  setupTimeoutMs = PACK_LIFECYCLE_LIMITS.setupTimeoutMs,
  cleanupTimeoutMs = PACK_LIFECYCLE_LIMITS.cleanupTimeoutMs,
} = {}) {
  if (!isFieldworkConfig(config)) throw packError('config must be the result of normalizeFieldworkConfig() or parseFieldworkConfig()');
  const registryRecord = registries.get(registry);
  if (!registryRecord) throw packError('registry must be the result of createPackRegistry()');
  const available = serviceCatalogs.get(services);
  if (!available) throw packError('services must be the result of createHostServices()');
  if (signal !== undefined && (typeof signal !== 'object' || typeof signal.throwIfAborted !== 'function')) throw packError('signal must be an AbortSignal when present');
  loadTimeoutMs = timeoutValue(loadTimeoutMs, PACK_LIFECYCLE_LIMITS.loadTimeoutMs, 'loadTimeoutMs');
  setupTimeoutMs = timeoutValue(setupTimeoutMs, PACK_LIFECYCLE_LIMITS.setupTimeoutMs, 'setupTimeoutMs');
  cleanupTimeoutMs = timeoutValue(cleanupTimeoutMs, PACK_LIFECYCLE_LIMITS.cleanupTimeoutMs, 'cleanupTimeoutMs');
  signal?.throwIfAborted();

  const missing = config.packs.find(pack => !registryRecord.entries.has(pack.name));
  if (missing) throw packError(`configured pack ${missing.name} is not in the injected registry`);

  const prepared = [];
  for (const selected of config.packs) {
    signal?.throwIfAborted();
    const definition = await loadDefinition(registryRecord, selected.name, { signal, loadTimeoutMs });
    prepared.push({ definition, options: selected.options });
  }
  for (const row of prepared) row.services = negotiateServices(row.definition, available);
  for (const row of prepared) Object.assign(row, configurePack(row.definition, row.options));

  const runtimes = [];
  try {
    for (const row of prepared) {
      signal?.throwIfAborted();
      runtimes.push(await activate(row, { externalSignal: signal, setupTimeoutMs, cleanupTimeoutMs }));
    }
    for (const runtime of runtimes) {
      runtime.detachExternal?.();
      runtime.detachExternal = null;
    }
  } catch (error) {
    const cleanupErrors = [...(error.cleanupErrors || [])];
    for (const runtime of [...runtimes].reverse()) cleanupErrors.push(...await settleRuntime(runtime, 'Pack host startup rolled back'));
    Object.defineProperty(error, 'cleanupErrors', { value: Object.freeze(cleanupErrors), enumerable: true, configurable: true });
    throw error;
  }

  const receipt = deepFreeze({
    format: PACK_HOST_RECEIPT_FORMAT,
    configuration: config.receipt.fingerprint,
    packs: prepared.map(row => ({
      name: row.definition.name,
      version: row.definition.version,
      config: row.fingerprint,
      services: row.services.receipt,
    })),
  });
  let closePromise = null;
  const close = () => {
    if (!closePromise) {
      closePromise = (async () => {
        const failures = [];
        for (const runtime of [...runtimes].reverse()) failures.push(...await settleRuntime(runtime, 'Pack host stopped'));
        if (failures.length) throw new AggregateError(failures, 'Pack host shutdown failed');
      })();
    }
    return closePromise;
  };
  return Object.freeze({ receipt, close });
}
