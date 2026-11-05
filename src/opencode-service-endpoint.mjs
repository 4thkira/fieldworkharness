import { deepFreeze, isPlainObject } from './json-data.mjs';

export const OPENCODE_CLIENT_VERSION = '2.2.5';

function endpointError(message) {
  return new Error(`OpenCode service endpoint: ${message}`);
}

function exactFields(value, allowed, where) {
  if (!isPlainObject(value)) throw endpointError(`${where} must be an object`);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw endpointError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw endpointError(`${where}.${key} must be an enumerable data property`);
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

export function validateOpenCodeServiceEndpoint(endpoint) {
  const raw = exactFields(endpoint, ['url', 'auth'], 'endpoint');
  if (typeof raw.url !== 'string') throw endpointError('endpoint.url must be text');

  let url;
  try { url = new URL(raw.url); }
  catch { throw endpointError('endpoint.url must be an absolute URL'); }

  if (url.protocol !== 'http:') throw endpointError('endpoint.url must use http');
  if (url.hostname !== '127.0.0.1') throw endpointError('endpoint.url must use the exact loopback host 127.0.0.1');
  if (!url.port || !Number.isSafeInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65_535) {
    throw endpointError('endpoint.url must include an explicit valid port');
  }
  if (url.username || url.password) throw endpointError('endpoint.url must not contain URL credentials');
  if (url.pathname !== '/' || url.search || url.hash) throw endpointError('endpoint.url must be a bare origin without a path, query, or fragment');
  if (raw.url !== url.origin && raw.url !== `${url.origin}/`) throw endpointError('endpoint.url must use canonical loopback origin syntax');

  const auth = exactFields(raw.auth, ['type', 'username', 'password'], 'endpoint.auth');
  if (auth.type !== 'basic') throw endpointError('endpoint.auth.type must be basic');
  if (auth.username !== 'opencode') throw endpointError('endpoint.auth.username must be opencode');
  if (typeof auth.password !== 'string' || auth.password.length < 16 || auth.password.length > 512 || auth.password !== auth.password.toWellFormed()) {
    throw endpointError('endpoint.auth.password must be 16-512 well-formed Unicode characters');
  }
  if (/\p{Cc}/u.test(auth.password)) throw endpointError('endpoint.auth.password must not contain control characters');

  return deepFreeze({
    url: url.origin,
    auth: { type: 'basic', username: 'opencode', password: auth.password },
  });
}
