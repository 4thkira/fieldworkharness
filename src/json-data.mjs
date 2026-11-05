const encoder = new TextEncoder();

export const isPlainObject = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export function deepFreeze(value, seen = new WeakSet()) {
  if ((!value || typeof value !== 'object') && typeof value !== 'function') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value, seen);
  }
  if (!Object.isFrozen(value)) Object.freeze(value);
  return value;
}

function cloneJson(value, where, limits, state, depth = 0) {
  if (depth > limits.maxDepth) throw new Error(`${where} exceeds the maximum JSON depth of ${limits.maxDepth}`);
  state.nodes++;
  if (state.nodes > limits.maxNodes) throw new Error(`${where} exceeds the maximum JSON value count of ${limits.maxNodes}`);

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${where} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new Error(`${where} contains a value that JSON cannot represent`);
  if (state.ancestors.has(value)) throw new Error(`${where} contains a cycle`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0) throw new Error(`${where} has an invalid array length`);
      const keys = Reflect.ownKeys(value).filter(key => key !== 'length');
      if (keys.length !== length || keys.some(key => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length)) {
        throw new Error(`${where} arrays may contain only their contiguous indexed JSON values`);
      }
      const clone = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new Error(`${where} arrays may not contain holes or accessors`);
        }
        clone.push(cloneJson(descriptor.value, `${where}[${index}]`, limits, state, depth + 1));
      }
      return clone;
    }
    if (!isPlainObject(value)) throw new Error(`${where} contains a non-JSON object`);
    const clone = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error(`${where} may not contain symbol keys`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`${where}.${key} must be an enumerable data property`);
      }
      Object.defineProperty(clone, key, {
        value: cloneJson(descriptor.value, `${where}.${key}`, limits, state, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return clone;
  } finally {
    state.ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainObject(value)) throw new Error('canonical JSON requires JSON data');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function parseJsonNoDuplicates(source, options = {}) {
  if (!isPlainObject(options)) throw new Error('JSON parser options must be an object');
  const optionKeys = Reflect.ownKeys(options);
  if (optionKeys.some(key => typeof key !== 'string' || !['where', 'maxDepth'].includes(key))) throw new Error('JSON parser options contain an unknown field');
  for (const key of optionKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(`JSON parser option ${String(key)} must be an enumerable data property`);
  }
  const where = Object.hasOwn(options, 'where') ? options.where : 'JSON source';
  const maxDepth = Object.hasOwn(options, 'maxDepth') ? options.maxDepth : 512;
  if (typeof where !== 'string' || !where) throw new Error('JSON parser where must be nonempty text');
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1024) throw new Error('JSON parser maxDepth must be a whole number from 1 to 1024');
  if (typeof source !== 'string') throw new Error(`${where} must be text`);

  // JSON.parse() constructs the complete value before a post-parse depth walk can
  // reject it. This allocation-free lexical pass enforces the depth ceiling first.
  // Grammar and delimiter pairing remain JSON.parse()'s job below.
  let lexicalDepth = 0;
  let inString = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (inString) {
      if (character === '\\') index++;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      lexicalDepth++;
      if (lexicalDepth > maxDepth) throw new Error(`${where} exceeds the maximum JSON depth of ${maxDepth}`);
    } else if (character === '}' || character === ']') {
      lexicalDepth--;
    }
  }

  let value;
  try { value = JSON.parse(source); }
  catch (error) { throw new Error(`${where} is not valid JSON: ${error.message}`, { cause: error }); }

  let at = 0;
  const whitespace = () => { while (/\s/u.test(source[at] || '')) at++; };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') { at += 2; continue; }
      if (source[at++] === '"') return JSON.parse(source.slice(start, at));
    }
    throw new Error(`${where} contains an unterminated string`);
  };
  const scan = (path, depth = 0) => {
    if (depth > maxDepth) throw new Error(`${where} exceeds the maximum JSON depth of ${maxDepth}`);
    whitespace();
    if (source[at] === '{') {
      at++;
      whitespace();
      const keys = new Set();
      if (source[at] === '}') { at++; return; }
      while (at < source.length) {
        const key = string();
        if (keys.has(key)) throw new Error(`${where} repeats object key ${JSON.stringify(key)} at ${path}`);
        keys.add(key);
        whitespace();
        at++; // colon; JSON.parse already validated the grammar.
        scan(`${path}.${key}`, depth + 1);
        whitespace();
        if (source[at] === '}') { at++; return; }
        at++; // comma
        whitespace();
      }
      return;
    }
    if (source[at] === '[') {
      at++;
      whitespace();
      if (source[at] === ']') { at++; return; }
      let index = 0;
      while (at < source.length) {
        scan(`${path}[${index++}]`, depth + 1);
        whitespace();
        if (source[at] === ']') { at++; return; }
        at++; // comma
      }
      return;
    }
    if (source[at] === '"') { string(); return; }
    while (at < source.length && !/[\s,}\]]/u.test(source[at])) at++;
  };
  scan('$');
  return value;
}

export function boundedJson(value, {
  where = 'value',
  object = false,
  maxBytes = 64 * 1024,
  maxDepth = 32,
  maxNodes = 10_000,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive whole number');
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new Error('maxDepth must be a positive whole number');
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new Error('maxNodes must be a positive whole number');
  const clone = cloneJson(value, where, { maxDepth, maxNodes }, { nodes: 0, ancestors: new Set() });
  if (object && !isPlainObject(clone)) throw new Error(`${where} must be a JSON object`);
  const canonical = canonicalJson(clone);
  const bytes = encoder.encode(canonical).length;
  if (bytes > maxBytes) throw new Error(`${where} is ${bytes} JSON bytes; the limit is ${maxBytes}`);
  return Object.freeze({ value: deepFreeze(clone), bytes, canonical });
}
