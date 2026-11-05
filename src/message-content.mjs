import { deepFreeze, isPlainObject } from './json-data.mjs';

export const MESSAGE_TEXT_PROJECTION_FORMAT = 'fieldwork-message-text-projection/v1';

function contentError(message) {
  return new Error(`Message content: ${message}`);
}

function optionsFrom(options) {
  if (!isPlainObject(options)) throw contentError('options must be an object');
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !['where', 'nullable'].includes(key)) throw contentError(`options has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw contentError(`options.${key} must be an enumerable data property`);
    fields[key] = descriptor.value;
  }
  const where = fields.where === undefined ? 'content' : fields.where;
  const nullable = fields.nullable === undefined ? false : fields.nullable;
  if (typeof where !== 'string' || !where) throw contentError('options.where must be nonempty text');
  if (typeof nullable !== 'boolean') throw contentError('options.nullable must be true or false');
  return { where, nullable };
}

export function projectMessageText(content, options = {}) {
  const { where, nullable } = optionsFrom(options);
  if (content === null && nullable) {
    return deepFreeze({ format: MESSAGE_TEXT_PROJECTION_FORMAT, blocks: [] });
  }
  if (typeof content === 'string') {
    return deepFreeze({
      format: MESSAGE_TEXT_PROJECTION_FORMAT,
      blocks: [{ index: 0, path: '', text: content }],
    });
  }
  if (!Array.isArray(content)) throw contentError(`${where} must be text${nullable ? ', null' : ''}, or an array of content parts`);
  const length = Object.getOwnPropertyDescriptor(content, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0) throw contentError(`${where} has an invalid array length`);
  const keys = Reflect.ownKeys(content).filter(key => key !== 'length');
  if (keys.length !== length || keys.some(key => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length)) {
    throw contentError(`${where} must contain only contiguous indexed content parts`);
  }
  const blocks = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(content, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw contentError(`${where}[${index}] must be an enumerable data content part`);
    const part = descriptor.value;
    if (!isPlainObject(part)) throw contentError(`${where}[${index}] must be a content-part object with a type`);
    const type = Object.getOwnPropertyDescriptor(part, 'type');
    if (!type?.enumerable || !Object.hasOwn(type, 'value') || typeof type.value !== 'string' || !type.value) {
      throw contentError(`${where}[${index}] must be a content-part object with an own data type`);
    }
    if (type.value !== 'text') continue;
    const text = Object.getOwnPropertyDescriptor(part, 'text');
    if (!text?.enumerable || !Object.hasOwn(text, 'value') || typeof text.value !== 'string') {
      throw contentError(`${where}[${index}].text must be own data text`);
    }
    blocks.push({ index: blocks.length, path: `[${index}].text`, text: text.value });
  }
  return deepFreeze({ format: MESSAGE_TEXT_PROJECTION_FORMAT, blocks });
}
