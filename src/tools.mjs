import { createHash } from 'node:crypto';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject } from './json-data.mjs';

export const TOOL_LIMITS = Object.freeze({
  definitions: 128,
  schemaBytes: 64 * 1024,
  argumentBytes: 64 * 1024,
  schemaDepth: 8,
  schemaProperties: 256,
  stringCharacters: 24_000,
  arrayItems: 256,
});

const toolName = /^[a-z][a-z0-9_]{0,63}$/;
const propertyName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const schemaTypes = new Set(['string', 'boolean', 'integer', 'number', 'array', 'object']);
const registries = new WeakMap();
const preparedCalls = new WeakMap();
const consumedPreparedCalls = new WeakSet();

function toolError(message, cause) {
  return new Error(`Tools: ${message}`, cause === undefined ? undefined : { cause });
}

function exactFields(value, allowed, where) {
  if (!isPlainObject(value)) throw toolError(`${where} must be an object`);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw toolError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw toolError(`${where}.${key} must be an enumerable data property`);
    fields[key] = descriptor.value;
  }
  return fields;
}

function whole(value, where, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw toolError(`${where} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined;

function checkSchema(schema, where, state, depth = 0) {
  if (depth > TOOL_LIMITS.schemaDepth) throw toolError(`${where} exceeds the schema depth limit of ${TOOL_LIMITS.schemaDepth}`);
  const fields = exactFields(schema, [
    'type', 'description', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum',
    'items', 'minItems', 'maxItems', 'properties', 'required', 'additionalProperties',
  ], where);
  if (!schemaTypes.has(fields.type)) throw toolError(`${where}.type must be string, boolean, integer, number, array or object`);
  if (fields.description !== undefined && (typeof fields.description !== 'string' || !fields.description.trim() || fields.description.length > 1000)) {
    throw toolError(`${where}.description must be 1-1000 characters when present`);
  }
  if (fields.enum !== undefined) {
    if (!Array.isArray(fields.enum) || !fields.enum.length) throw toolError(`${where}.enum must be a nonempty array`);
    if (['array', 'object'].includes(fields.type)) throw toolError(`${where}.enum is supported only for scalar schemas`);
    const seen = new Set();
    for (const [index, value] of fields.enum.entries()) {
      const valid = fields.type === 'string' ? typeof value === 'string'
        : fields.type === 'boolean' ? typeof value === 'boolean'
        : fields.type === 'integer' ? Number.isInteger(value)
        : typeof value === 'number' && Number.isFinite(value);
      if (!valid) throw toolError(`${where}.enum[${index}] does not match type ${fields.type}`);
      const key = canonicalJson(value);
      if (seen.has(key)) throw toolError(`${where}.enum repeats ${key}`);
      seen.add(key);
    }
  }

  if (fields.type === 'string') {
    const min = fields.minLength === undefined ? 0 : whole(fields.minLength, `${where}.minLength`, { maximum: TOOL_LIMITS.stringCharacters });
    const max = fields.maxLength === undefined ? TOOL_LIMITS.stringCharacters : whole(fields.maxLength, `${where}.maxLength`, { maximum: TOOL_LIMITS.stringCharacters });
    if (min > max) throw toolError(`${where}.minLength may not exceed maxLength`);
  } else if (fields.minLength !== undefined || fields.maxLength !== undefined) {
    throw toolError(`${where} length bounds require type string`);
  }

  if (fields.type === 'number' || fields.type === 'integer') {
    for (const key of ['minimum', 'maximum']) if (fields[key] !== undefined && (typeof fields[key] !== 'number' || !Number.isFinite(fields[key]))) {
      throw toolError(`${where}.${key} must be a finite number`);
    }
    if (fields.minimum !== undefined && fields.maximum !== undefined && fields.minimum > fields.maximum) {
      throw toolError(`${where}.minimum may not exceed maximum`);
    }
  } else if (fields.minimum !== undefined || fields.maximum !== undefined) {
    throw toolError(`${where} numeric bounds require type number or integer`);
  }

  if (fields.type === 'array') {
    if (!fields.items) throw toolError(`${where}.items is required for an array`);
    const min = fields.minItems === undefined ? 0 : whole(fields.minItems, `${where}.minItems`, { maximum: TOOL_LIMITS.arrayItems });
    const max = fields.maxItems === undefined ? TOOL_LIMITS.arrayItems : whole(fields.maxItems, `${where}.maxItems`, { maximum: TOOL_LIMITS.arrayItems });
    if (min > max) throw toolError(`${where}.minItems may not exceed maxItems`);
    checkSchema(fields.items, `${where}.items`, state, depth + 1);
  } else if (fields.items !== undefined || fields.minItems !== undefined || fields.maxItems !== undefined) {
    throw toolError(`${where} item fields require type array`);
  }

  if (fields.type === 'object') {
    if (!isPlainObject(fields.properties)) throw toolError(`${where}.properties must be an object`);
    if (fields.additionalProperties !== false) throw toolError(`${where}.additionalProperties must be false`);
    const names = Object.keys(fields.properties);
    state.properties += names.length;
    if (state.properties > TOOL_LIMITS.schemaProperties) throw toolError(`schema contains more than ${TOOL_LIMITS.schemaProperties} properties`);
    for (const name of names) {
      if (!propertyName.test(name)) throw toolError(`${where}.properties has invalid name ${JSON.stringify(name)}`);
      checkSchema(fields.properties[name], `${where}.properties.${name}`, state, depth + 1);
    }
    if (!Array.isArray(fields.required)) throw toolError(`${where}.required must be an array, [] for none`);
    const required = new Set();
    for (const [index, name] of fields.required.entries()) {
      if (typeof name !== 'string' || !Object.hasOwn(fields.properties, name)) throw toolError(`${where}.required[${index}] must name one declared property`);
      if (required.has(name)) throw toolError(`${where}.required repeats ${JSON.stringify(name)}`);
      required.add(name);
    }
  } else if (fields.properties !== undefined || fields.required !== undefined || fields.additionalProperties !== undefined) {
    throw toolError(`${where} property fields require type object`);
  }
}

function typeDescription(schema) {
  const enumeration = own(schema, 'enum');
  return enumeration ? `one of ${enumeration.map(value => JSON.stringify(value)).join(', ')}` : own(schema, 'type');
}

function validateValue(value, schema, where) {
  const type = own(schema, 'type');
  const enumeration = own(schema, 'enum');
  const validType = type === 'integer' ? Number.isInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : type === 'array' ? Array.isArray(value)
    : type === 'object' ? isPlainObject(value)
    : typeof value === type;
  if (!validType) throw toolError(`${where} must be ${typeDescription(schema)}`);
  if (enumeration && !enumeration.some(candidate => Object.is(candidate, value))) throw toolError(`${where} must be ${typeDescription(schema)}`);
  if (typeof value === 'string') {
    const characters = [...value].length;
    const min = own(schema, 'minLength') ?? 0, max = own(schema, 'maxLength') ?? TOOL_LIMITS.stringCharacters;
    if (characters < min) throw toolError(`${where} must contain at least ${min} characters`);
    if (characters > max) throw toolError(`${where} contains ${characters} characters; the limit is ${max}`);
  }
  if (typeof value === 'number') {
    const minimum = own(schema, 'minimum'), maximum = own(schema, 'maximum');
    if (minimum !== undefined && value < minimum) throw toolError(`${where} must be at least ${minimum}`);
    if (maximum !== undefined && value > maximum) throw toolError(`${where} must be at most ${maximum}`);
  }
  if (Array.isArray(value)) {
    const min = own(schema, 'minItems') ?? 0, max = own(schema, 'maxItems') ?? TOOL_LIMITS.arrayItems;
    if (value.length < min) throw toolError(`${where} must contain at least ${min} items`);
    if (value.length > max) throw toolError(`${where} contains ${value.length} items; the limit is ${max}`);
    value.forEach((item, index) => validateValue(item, own(schema, 'items'), `${where}[${index}]`));
  }
  if (type === 'object') {
    const properties = own(schema, 'properties'), required = own(schema, 'required');
    const unexpected = Object.keys(value).filter(key => !Object.hasOwn(properties, key));
    if (unexpected.length) throw toolError(`${where} has unknown field ${JSON.stringify(unexpected[0])}`);
    const missing = required.filter(key => !Object.hasOwn(value, key));
    if (missing.length) throw toolError(`${where} is missing required field ${JSON.stringify(missing[0])}`);
    for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(value, key)) validateValue(value[key], child, `${where}.${key}`);
  }
}

function boundedPermissionSummary(value, where) {
  if (typeof value !== 'string') throw toolError(`${where} must be text`);
  // Permission copy is rendered for a person to make an authorization choice.
  // Keep ordinary Unicode (including emoji joiners), but neutralize line breaks,
  // C0/C1 controls and Unicode bidi controls that can reorder visible targets.
  const normalized = value.replace(/[\u0000-\u0020\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]+/gu, ' ').trim();
  if (!normalized) throw toolError(`${where} must contain displayable text`);
  const characters = [...normalized];
  return characters.length > 240 ? `${characters.slice(0, 239).join('')}…` : normalized;
}

function defaultPermissionSummary(record, args) {
  const fields = Object.keys(args).sort();
  const description = record.description.replace(/\s+/gu, ' ').trim();
  const text = `${description}${fields.length ? ` Inputs: ${fields.join(', ')}.` : ' No inputs.'}`;
  const characters = [...text];
  return characters.length > 240 ? `${characters.slice(0, 239).join('')}…` : text;
}

const sources = new WeakMap();

export function createToolRegistry(definitions = []) {
  if (!Array.isArray(definitions)) throw toolError('definitions must be an array');
  if (definitions.length > TOOL_LIMITS.definitions) throw toolError(`definitions has ${definitions.length} entries; the limit is ${TOOL_LIMITS.definitions}`);
  const records = new Map();
  const providerTools = [];
  const normalizedDefinitions = [];
  for (let index = 0; index < definitions.length; index++) {
    const where = `definitions[${index}]`;
    const definition = definitions[index];
    const fields = exactFields(definition, ['name', 'description', 'inputSchema', 'permission', 'permissionSummary', 'effect', 'execute'], where);
    if (typeof fields.name !== 'string' || !toolName.test(fields.name)) throw toolError(`${where}.name must be lowercase letters, digits and underscores, beginning with a letter`);
    if (records.has(fields.name)) throw toolError(`definitions repeats tool ${JSON.stringify(fields.name)}`);
    if (typeof fields.description !== 'string' || fields.description.trim().length < 10 || fields.description.length > 4000) {
      throw toolError(`${fields.name}.description must be 10-4000 characters`);
    }
    if (typeof fields.execute !== 'function') throw toolError(`${fields.name}.execute must be a function`);
    const permission = fields.permission === undefined ? 'configurable' : fields.permission;
    if (!['configurable', 'internal'].includes(permission)) throw toolError(`${fields.name}.permission must be configurable or internal`);
    const effect = fields.effect === undefined ? 'tracked' : fields.effect;
    if (!['tracked', 'read-only'].includes(effect)) throw toolError(`${fields.name}.effect must be tracked or read-only`);
    if (fields.permissionSummary !== undefined && typeof fields.permissionSummary !== 'function') {
      throw toolError(`${fields.name}.permissionSummary must be a function when present`);
    }
    let schema;
    try { schema = boundedJson(fields.inputSchema, { where: `${fields.name}.inputSchema`, object: true, maxBytes: TOOL_LIMITS.schemaBytes }).value; }
    catch (error) { throw toolError(error.message, error); }
    checkSchema(schema, `${fields.name}.inputSchema`, { properties: 0 });
    if (own(schema, 'type') !== 'object') throw toolError(`${fields.name}.inputSchema must have type object`);
    const description = fields.description.trim();
    const record = Object.freeze({
      name: fields.name, description, schema, permission, effect,
      permissionSummary: fields.permissionSummary ?? null,
      execute: fields.execute,
    });
    records.set(fields.name, record);
    normalizedDefinitions.push(Object.freeze({
      name: record.name,
      description: record.description,
      inputSchema: record.schema,
      permission: record.permission,
      effect: record.effect,
      ...(record.permissionSummary ? { permissionSummary: record.permissionSummary } : {}),
      execute: record.execute,
    }));
    providerTools.push({
      type: 'function',
      function: { name: fields.name, description, parameters: schema },
    });
  }
  const registry = Object.freeze({
    names: Object.freeze([...records.keys()]),
    providerTools: deepFreeze(providerTools),
  });
  registries.set(registry, records);
  sources.set(registry, Object.freeze(normalizedDefinitions));
  return registry;
}

// A new registry with only the tools whose names pass `keep`.
export function onlyTools(registry, keep) {
  if (!registries.has(registry)) throw toolError('registry must be the result of createToolRegistry()');
  return createToolRegistry(sources.get(registry).filter(definition => keep(definition.name)));
}

// A new registry with every tool of this one plus a few more (for example,
// tools a check-in turn may use that ordinary chat does not get). A second
// registry is also accepted so already-normalized definitions can be combined
// without exposing or rereading their executors.
export function withTools(registry, extra = []) {
  if (!registries.has(registry)) throw toolError('registry must be the result of createToolRegistry()');
  const additions = registries.has(extra) ? sources.get(extra) : extra;
  return createToolRegistry([...sources.get(registry), ...additions]);
}

export function isToolRegistry(value) {
  return Boolean(value) && registries.has(value);
}

export function permissionOfTool(registry, name) {
  const records = registries.get(registry);
  if (!records) throw toolError('registry must be the result of createToolRegistry()');
  const record = records.get(name);
  if (!record) throw toolError(`unknown tool ${JSON.stringify(name)}`);
  return record.permission;
}

const checkSignal = signal => {
  if (signal !== undefined && (!signal || typeof signal !== 'object' || typeof signal.throwIfAborted !== 'function')) {
    throw toolError('signal must be an AbortSignal when present');
  }
  return signal;
};

export function prepareToolCall(registry, name, args, options = {}) {
  const rawOptions = exactFields(options, ['signal', 'callId', 'step'], 'prepare options');
  const signal = rawOptions.signal;
  const callId = rawOptions.callId ?? '';
  const step = rawOptions.step ?? 0;
  const records = registries.get(registry);
  if (!records) throw toolError('registry must be the result of createToolRegistry()');
  const record = records.get(name);
  if (!record) throw toolError(`unknown tool ${JSON.stringify(name)}`);
  let bounded;
  try { bounded = boundedJson(args, { where: `${name} arguments`, object: true, maxBytes: TOOL_LIMITS.argumentBytes }); }
  catch (error) { throw toolError(error.message, error); }
  validateValue(bounded.value, record.schema, `${name} arguments`);
  checkSignal(signal);
  signal?.throwIfAborted();
  let permissionSummary;
  try {
    permissionSummary = boundedPermissionSummary(
      record.permissionSummary
        ? record.permissionSummary(bounded.value)
        : defaultPermissionSummary(record, bounded.value),
      `${name}.permissionSummary result`,
    );
  } catch (error) {
    if (String(error?.message ?? '').startsWith('Tools:')) throw error;
    throw toolError(`${name}.permissionSummary failed: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  if (typeof callId !== 'string' || callId.length > 128) throw toolError('callId must be at most 128 characters');
  if (!Number.isSafeInteger(step) || step < 0) throw toolError('step must be a nonnegative whole number');
  signal?.throwIfAborted();
  const prepared = Object.freeze({
    name: record.name,
    argumentsSha256: createHash('sha256').update(bounded.canonical).digest('hex'),
    permission: record.permission,
    effect: record.effect,
    permissionSummary,
  });
  preparedCalls.set(prepared, {
    args: bounded.value,
    execute: record.execute,
    signal,
    callId,
    step,
  });
  return prepared;
}

export async function executePreparedTool(prepared, options = {}) {
  const rawOptions = exactFields(options, ['signal'], 'execute options');
  const signal = rawOptions.signal;
  if (consumedPreparedCalls.has(prepared)) throw toolError('prepared tool call has already been executed');
  const state = preparedCalls.get(prepared);
  if (!state) throw toolError('prepared must be the result of prepareToolCall()');
  checkSignal(signal);
  consumedPreparedCalls.add(prepared);
  preparedCalls.delete(prepared);
  state.signal?.throwIfAborted();
  signal?.throwIfAborted();
  const executionSignal = signal ?? state.signal;
  return state.execute(state.args, Object.freeze({ signal: executionSignal, callId: state.callId, step: state.step }));
}

export async function executeTool(registry, name, args, options = {}) {
  return executePreparedTool(prepareToolCall(registry, name, args, options));
}
