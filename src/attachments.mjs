import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deepFreeze, isPlainObject } from './json-data.mjs';

// Attachments: pictures and text files a person adds to a message.
//
// Pictures are stored once as files in the agent's state folder, named by their
// SHA-256, and a message keeps only a small reference
// (`fieldwork-attachment:<hash>`). The reference becomes the real picture only at
// the moment a message goes to the model, so transcripts stay small and the
// archive never holds image bytes. Text files are read and placed in the message
// as text, labelled with their name. Other kinds are refused plainly.

export const ATTACHMENT_SCHEME = 'fieldwork-attachment:';
export const FILE_ATTACHMENT_FORMAT = 'fieldwork-file-attachment/v1';
export const ATTACHMENT_LIMITS = Object.freeze({
  perMessage: 4,
  imageBytes: 4 * 1024 * 1024,
  textBytes: 200 * 1024,
  totalBytes: 4 * 1024 * 1024,
  requestImageBytes: 4 * 1024 * 1024,
  nameCharacters: 120,
});

const IMAGE_TYPES = {
  'image/png': { extension: 'png', check: bytes => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
  'image/jpeg': { extension: 'jpg', check: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 },
  'image/webp': { extension: 'webp', check: bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP' },
  'image/gif': { extension: 'gif', check: bytes => bytes.subarray(0, 4).toString('latin1') === 'GIF8' },
};
// Files read as text. The list is by extension because browsers report many
// text formats with no type or a generic one.
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'ps1', 'bat', 'sql', 'lua', 'r', 'swift', 'log', 'srt', 'vtt', 'tex', 'rst', 'org',
]);
const hashPattern = /^[0-9a-f]{64}$/;

function attachmentError(message, status = 400) {
  const error = new Error(`Attachments: ${message}`);
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

function cleanName(value) {
  const name = String(value ?? '').replace(/[\p{Cc}\\/:*?"<>|]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return 'attachment';
  const characters = [...name];
  return characters.length > ATTACHMENT_LIMITS.nameCharacters ? characters.slice(0, ATTACHMENT_LIMITS.nameCharacters).join('') : name;
}

function decodeDataUrl(value) {
  const match = /^data:([a-z0-9.+/-]*)(;charset=[a-z0-9-]+)?;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(String(value ?? ''));
  if (!match) throw attachmentError('an attachment must be sent as a base64 data URL');
  return { type: match[1].toLowerCase(), bytes: Buffer.from(match[3], 'base64') };
}

const extensionOf = name => (/\.([a-z0-9]{1,10})$/i.exec(name)?.[1] || '').toLowerCase();

function fileAttachment(part) {
  if (!isPlainObject(part) || part.type !== 'text' || typeof part.text !== 'string') return null;
  const marker = part.fieldworkAttachment;
  if (!isPlainObject(marker)) return null;
  const keys = Reflect.ownKeys(marker);
  if (keys.length !== 3 || !keys.every(key => typeof key === 'string' && ['format', 'kind', 'name'].includes(key))) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(marker, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
  }
  if (marker.format !== FILE_ATTACHMENT_FORMAT || marker.kind !== 'file' || typeof marker.name !== 'string' || cleanName(marker.name) !== marker.name) return null;
  return marker;
}

export function isFileAttachmentPart(part) {
  return Boolean(fileAttachment(part));
}

export async function createAttachmentStore({ dir } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw attachmentError('dir must be an absolute directory', 500);
  await fs.mkdir(dir, { recursive: true });

  const fileFor = (hash, extension) => path.join(dir, `${hash}.${extension}`);
  async function findImage(hash) {
    if (!hashPattern.test(hash)) throw attachmentError('that is not an attachment reference', 400);
    for (const [type, { extension }] of Object.entries(IMAGE_TYPES)) {
      try { return { type, bytes: await fs.readFile(fileFor(hash, extension)) }; } catch { /* try the next type */ }
    }
    throw attachmentError('that picture is no longer in this agent\'s folder', 404);
  }

  async function saveImage(type, bytes) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = fileFor(hash, IMAGE_TYPES[type].extension);
    try { await fs.access(file); }
    catch {
      const temporary = path.join(dir, `.${hash}.${randomUUID()}.tmp`);
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      try { await fs.rename(temporary, file); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    }
    return hash;
  }

  return Object.freeze({
    // Turns what the browser sent into message content parts, saving pictures.
    // Returns { parts, summary } where summary lists what was attached.
    async accept(attachments) {
      if (attachments === undefined) return { parts: [], summary: [] };
      if (!Array.isArray(attachments)) throw attachmentError('attachments must be a list');
      if (attachments.length > ATTACHMENT_LIMITS.perMessage) throw attachmentError(`at most ${ATTACHMENT_LIMITS.perMessage} attachments per message`);
      const accepted = [];
      let total = 0;
      for (const item of attachments) {
        if (!isPlainObject(item)) throw attachmentError('each attachment must be an object');
        const name = cleanName(item.name);
        const { type: declared, bytes } = decodeDataUrl(item.dataUrl);
        total += bytes.length;
        if (total > ATTACHMENT_LIMITS.totalBytes) throw attachmentError(`attachments on one message can total at most ${ATTACHMENT_LIMITS.totalBytes / 1024 / 1024} MB`);
        const imageType = Object.keys(IMAGE_TYPES).find(type => IMAGE_TYPES[type].check(bytes));
        if (imageType) {
          if (bytes.length > ATTACHMENT_LIMITS.imageBytes) throw attachmentError(`"${name}" is ${Math.ceil(bytes.length / 1024 / 1024)} MB; pictures can be at most ${ATTACHMENT_LIMITS.imageBytes / 1024 / 1024} MB`);
          accepted.push({ kind: 'image', name, imageType, bytes });
          continue;
        }
        if (declared.startsWith('image/')) throw attachmentError(`"${name}" is not a picture type Fieldwork can show; use PNG, JPEG, WebP or GIF`);
        const extension = extensionOf(name);
        if (TEXT_EXTENSIONS.has(extension) || declared.startsWith('text/') || declared === 'application/json') {
          if (bytes.length > ATTACHMENT_LIMITS.textBytes) throw attachmentError(`"${name}" is ${Math.ceil(bytes.length / 1024)} KB; text files can be at most ${ATTACHMENT_LIMITS.textBytes / 1024} KB`);
          let text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
          catch { throw attachmentError(`"${name}" is not readable text`); }
          accepted.push({ kind: 'file', name, text, bytes: bytes.length });
          continue;
        }
        throw attachmentError(`"${name}" is a kind of file Fieldwork cannot read yet. Pictures and text files work; PDFs and documents are planned`);
      }
      const parts = [], summary = [];
      for (const item of accepted) {
        if (item.kind === 'image') {
          const hash = await saveImage(item.imageType, item.bytes);
          parts.push({ type: 'image_url', image_url: { url: `${ATTACHMENT_SCHEME}${hash}` } });
          summary.push({ kind: 'image', name: item.name, ref: hash });
          continue;
        }
        parts.push({
          type: 'text',
          text: `[Attached file: ${item.name}]\n${item.text}\n[End of ${item.name}]`,
          fieldworkAttachment: { format: FILE_ATTACHMENT_FORMAT, kind: 'file', name: item.name },
        });
        summary.push({ kind: 'file', name: item.name, bytes: item.bytes });
      }
      return { parts, summary };
    },

    // The picture's bytes and type, for sending it to the page as an image.
    async read(hash) {
      return findImage(hash);
    },

    async dataUrl(hash) {
      const { type, bytes } = await findImage(hash);
      return `data:${type};base64,${bytes.toString('base64')}`;
    },

    // Swaps stored references for the real pictures in a provider request.
    async expand(messages, options = {}) {
      if (!isPlainObject(options) || Reflect.ownKeys(options).some(key => key !== 'maxImageBytes')) throw attachmentError('expand options may contain only maxImageBytes', 500);
      const maximum = options.maxImageBytes === undefined ? ATTACHMENT_LIMITS.requestImageBytes : options.maxImageBytes;
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32 * 1024 * 1024) throw attachmentError('expand maxImageBytes must be a positive whole number at most 32 MB', 500);
      const out = messages.map(message => {
        if (!Array.isArray(message?.content) || !message.content.some(part => part?.type === 'image_url' && String(part.image_url?.url).startsWith(ATTACHMENT_SCHEME))) return message;
        return { ...message, content: [...message.content] };
      });
      let used = 0;
      // The newest turns keep their pictures. Older pictures remain archived,
      // but become an honest note once this request's image budget is full.
      for (let messageIndex = out.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = out[messageIndex];
        if (!Array.isArray(message?.content)) continue;
        for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
          const part = message.content[partIndex];
          const url = part?.type === 'image_url' ? String(part.image_url?.url) : '';
          if (!url.startsWith(ATTACHMENT_SCHEME)) continue;
          try {
            const { type, bytes } = await findImage(url.slice(ATTACHMENT_SCHEME.length));
            if (used + bytes.length > maximum) {
              message.content[partIndex] = { type: 'text', text: `[A picture attached here was not sent to the model because this conversation's pictures exceed the ${maximum} byte request budget. It remains saved in the conversation.]` };
              continue;
            }
            used += bytes.length;
            message.content[partIndex] = { type: 'image_url', image_url: { url: `data:${type};base64,${bytes.toString('base64')}` } };
          } catch {
            message.content[partIndex] = { type: 'text', text: '[A picture was attached here, but it is no longer in the agent\'s folder.]' };
          }
        }
      }
      return out;
    },
  });
}

// What the browser shows for a message's attachments: names and picture refs.
export function attachmentSummary(content) {
  if (!Array.isArray(content)) return [];
  const rows = [];
  for (const part of content) {
    if (part?.type === 'image_url' && String(part.image_url?.url).startsWith(ATTACHMENT_SCHEME)) {
      rows.push({ kind: 'image', ref: String(part.image_url.url).slice(ATTACHMENT_SCHEME.length) });
    } else {
      const marker = fileAttachment(part);
      if (marker) {
        // The file's own text, for the browser's preview.
        const start = `[Attached file: ${marker.name}]\n`;
        const end = `\n[End of ${marker.name}]`;
        const body = part.text.startsWith(start) ? part.text.slice(start.length) : part.text;
        rows.push({ kind: 'file', name: marker.name, text: body.endsWith(end) ? body.slice(0, -end.length) : body });
      }
    }
  }
  return deepFreeze(rows);
}
