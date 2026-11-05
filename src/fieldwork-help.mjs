import fs from 'node:fs/promises';
import path from 'node:path';
import { readStableFile } from './stable-file-read.mjs';

// A deliberately closed reading surface over the documentation shipped with
// this exact Fieldwork checkout. It is not a general filesystem tool, and the
// returned prose describes the packaged build rather than the live room.
export const FIELDWORK_HELP_DOCUMENTS = Object.freeze([
  Object.freeze({ id: 'readme', title: 'Fieldwork README', path: 'README.md' }),
  Object.freeze({ id: 'how-it-works', title: 'How Fieldwork works', path: 'docs/how-fieldwork-works.md' }),
  Object.freeze({ id: 'limitations', title: 'Limitations and trust boundaries', path: 'docs/limitations.md' }),
  Object.freeze({ id: 'writing-roots', title: "Writing your agent's roots", path: 'docs/writing-roots.md' }),
  Object.freeze({ id: 'principles', title: 'Fieldwork principles', path: 'docs/principles.md' }),
  Object.freeze({ id: 'security', title: 'Security policy', path: 'SECURITY.md' }),
  Object.freeze({ id: 'changelog', title: 'Change log', path: 'CHANGELOG.md' }),
  Object.freeze({ id: 'release-notes', title: 'Current release notes', path: 'docs/releases/0.1.0-alpha.1.md' }),
]);

export const FIELDWORK_HELP_LIMITS = Object.freeze({
  documentBytes: 512 * 1024,
  queryCharacters: 120,
  searchLimit: 12,
  excerptCharacters: 360,
  sectionCharacters: 160,
  searchResultBytes: 32 * 1024,
  readCharacters: 12_000,
  readResultBytes: 52 * 1024,
});

const byId = new Map(FIELDWORK_HELP_DOCUMENTS.map(document => [document.id, document]));
const utf8 = new TextDecoder('utf-8', { fatal: true });

function helpError(message) {
  return new Error(`Fieldwork help: ${message}`);
}

function boundedText(value, where, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw helpError(`${where} must not be empty`);
  if (!value.isWellFormed()) throw helpError(`${where} must be well-formed Unicode`);
  const text = value.trim();
  if ([...text].length > maximum) throw helpError(`${where} is at most ${maximum} characters`);
  if (/\p{Cc}/u.test(text)) throw helpError(`${where} contains control characters`);
  return text;
}

function headingAt(lines, lineIndex) {
  for (let index = Math.min(lineIndex, lines.length - 1); index >= 0; index -= 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(lines[index]);
    if (match) return excerpt(match[2], FIELDWORK_HELP_LIMITS.sectionCharacters);
  }
  return 'Document start';
}

function excerpt(value, maximum = FIELDWORK_HELP_LIMITS.excerptCharacters) {
  const flat = value.replace(/\s+/gu, ' ').trim();
  const characters = [...flat];
  return characters.length <= maximum
    ? flat
    : `${characters.slice(0, maximum - 1).join('')}…`;
}

function boundedResult(value, maximum, where) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) {
    throw helpError(`${where} exceeded its ${maximum}-byte result bound`);
  }
  return value;
}

export async function fieldworkHelpTools({ root } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw helpError('root must be an absolute directory');
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw helpError('root must be a real directory, not a link');
  const realRoot = await fs.realpath(root);

  const load = async id => {
    const document = byId.get(id);
    if (!document) throw helpError('document id is not in the packaged help catalog');
    const file = path.resolve(realRoot, ...document.path.split('/'));
    const relative = path.relative(realRoot, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw helpError('document escaped the package root');
    let cursor = realRoot;
    const components = document.path.split('/');
    for (let index = 0; index < components.length; index += 1) {
      cursor = path.join(cursor, components[index]);
      const info = await fs.lstat(cursor);
      if (info.isSymbolicLink()) throw helpError(`packaged document ${document.id} crosses a linked path`);
      if (index < components.length - 1 && !info.isDirectory()) {
        throw helpError(`packaged document ${document.id} has a non-directory path component`);
      }
      if (index === components.length - 1 && !info.isFile()) {
        throw helpError(`packaged document ${document.id} is not a regular file`);
      }
    }
    const canonicalFile = await fs.realpath(file);
    const canonicalRelative = path.relative(realRoot, canonicalFile);
    if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      throw helpError(`packaged document ${document.id} resolved outside the package root`);
    }
    const bytes = await readStableFile(canonicalFile, {
      maxBytes: FIELDWORK_HELP_LIMITS.documentBytes,
      label: `packaged Fieldwork document ${document.id}`,
    });
    let text;
    try { text = utf8.decode(bytes); }
    catch { throw helpError(`packaged document ${document.id} is not valid UTF-8`); }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
      throw helpError(`packaged document ${document.id} contains unsupported control characters`);
    }
    return { document, text };
  };

  const ids = FIELDWORK_HELP_DOCUMENTS.map(document => document.id);
  return [
    {
      name: 'search_fieldwork_docs',
      description: 'Search the closed set of documentation packaged with this Fieldwork build. Results are documentation evidence, not proof of the live room state. Cite the returned document id and section when answering.',
      effect: 'read-only',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: FIELDWORK_HELP_LIMITS.queryCharacters, description: 'Literal words to find in the packaged Fieldwork documentation.' },
          limit: { type: 'integer', minimum: 1, maximum: FIELDWORK_HELP_LIMITS.searchLimit, description: 'Maximum matches. Default: 8.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute({ query, limit = 8 }) {
        const wanted = boundedText(query, 'query', FIELDWORK_HELP_LIMITS.queryCharacters)
          .normalize('NFKC').toLocaleLowerCase('en-US').split(/\s+/u);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > FIELDWORK_HELP_LIMITS.searchLimit) {
          throw helpError(`limit must be 1-${FIELDWORK_HELP_LIMITS.searchLimit}`);
        }
        const matches = [];
        let total = 0;
        for (const document of FIELDWORK_HELP_DOCUMENTS) {
          const loaded = await load(document.id);
          const lines = loaded.text.split(/\r?\n/u);
          for (let index = 0; index < lines.length; index += 1) {
            const normalized = lines[index].normalize('NFKC').toLocaleLowerCase('en-US');
            if (!wanted.every(term => normalized.includes(term))) continue;
            total += 1;
            if (matches.length >= limit) continue;
            const section = headingAt(lines, index);
            matches.push({
              id: document.id,
              title: document.title,
              section,
              line: index + 1,
              excerpt: excerpt(lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join(' ')),
              citation: `[${document.id} > ${section}]`,
            });
          }
        }
        return boundedResult({
          query: query.trim(),
          matches,
          omitted: Math.max(0, total - matches.length),
          note: 'These are packaged-document matches, not observations of the live room.',
        }, FIELDWORK_HELP_LIMITS.searchResultBytes, 'search');
      },
    },
    {
      name: 'read_fieldwork_doc',
      description: 'Read a bounded passage from one allowlisted document packaged with this Fieldwork build. It cannot read arbitrary paths. Cite the returned document id and section, and do not treat documentation as live health or configuration evidence.',
      effect: 'read-only',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', enum: ids, description: 'Packaged document id returned by search_fieldwork_docs.' },
          line: { type: 'integer', minimum: 1, description: 'First line to read. Default: 1.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async execute({ id, line = 1 }) {
        if (!Number.isSafeInteger(line) || line < 1) throw helpError('line must be a positive whole number');
        const { document, text } = await load(id);
        const lines = text.split(/\r?\n/u);
        if (line > lines.length) throw helpError(`line exceeds the ${lines.length}-line document`);
        let characters = 0;
        const selected = [];
        let index = line - 1;
        while (index < lines.length) {
          if ([...lines[index]].length > FIELDWORK_HELP_LIMITS.readCharacters) {
            throw helpError(`document ${id} has a line too long for a bounded help result`);
          }
          const next = `${selected.length ? '\n' : ''}${lines[index]}`;
          const width = [...next].length;
          if (selected.length && characters + width > FIELDWORK_HELP_LIMITS.readCharacters) break;
          selected.push(lines[index]);
          characters += width;
          index += 1;
          if (characters >= FIELDWORK_HELP_LIMITS.readCharacters) break;
        }
        const section = headingAt(lines, line - 1);
        return boundedResult({
          id: document.id,
          title: document.title,
          source: document.path,
          section,
          citation: `[${document.id} > ${section}]`,
          fromLine: line,
          toLine: index,
          totalLines: lines.length,
          text: selected.join('\n'),
          ...(index < lines.length ? { nextLine: index + 1 } : {}),
          note: 'Packaged documentation is not proof of the live room state.',
        }, FIELDWORK_HELP_LIMITS.readResultBytes, 'read');
      },
    },
  ];
}
