import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { conversationSearchTools } from './conversation-search.mjs';
import { isMemoryLedger } from './memory-ledger.mjs';
import { MEMORY_LIFECYCLE_TYPES, memoryLifecycle, memoryLifecycleStatus, normalizeMemoryLifecycle } from './memory-lifecycle.mjs';
import { createMemoryRecord, MEMORY_CONFIDENCE } from './provenance.mjs';
import { recentMemories, searchCurrentMemories, searchDueMemories, searchMemoryHistory } from './retrieval.mjs';
import { parseTimeCues, resolveTimeZone, timeCuesMatchInstant } from './time-cues.mjs';

// Standard tool kits a host may grant an agent. Each factory returns plain tool
// definitions for createToolRegistry(); nothing is granted unless the host
// passes them in. Kits: memory, notebook, clock, web.

export const AGENT_TOOL_LIMITS = Object.freeze({
  memoryText: 4000,
  recallResults: 20,
  notebookReadCharacters: 20_000,
  notebookFileBytes: 1024 * 1024,
  notebookListEntries: 200,
  notebookPathCharacters: 240,
  webBytes: 2 * 1024 * 1024,
  webCharacters: 20_000,
  webRedirects: 5,
  webTimeoutMs: 20_000,
});

function toolKitError(message) {
  return new Error(`Agent tools: ${message}`);
}

function agentActor(agentId) {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId)) {
    throw toolKitError('agentId must be a portable identifier');
  }
  return Object.freeze({ kind: 'agent', id: agentId });
}

function nowFrom(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw toolKitError('clock returned an invalid time');
  return date;
}

function limitedText(value, maximum, what) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${what} must not be empty`);
  if ([...text].length > maximum) throw new Error(`${what} is at most ${maximum} characters`);
  return text;
}

function memoryRow(record, extra = {}) {
  return {
    id: record.id,
    text: record.text,
    kind: record.kind,
    basis: record.basis,
    confidence: record.confidence,
    author: record.author.kind,
    createdAt: record.createdAt,
    lifecycle: memoryLifecycle(record.lifecycle),
    ...extra,
  };
}

const lifecycleTypeSchema = {
  type: 'string', enum: [...MEMORY_LIFECYCLE_TYPES],
  description: 'What kind of note this is. A reminder is informational; an obligation is an explicitly chosen commitment. Default: fact.',
};
const lifecycleInstantSchema = description => ({ type: 'string', minLength: 24, maxLength: 24, description });
const lifecycleTextSchema = (description, maxLength = 2000) => ({ type: 'string', minLength: 1, maxLength, description });
const lifecycleArgumentFields = Object.freeze({
  type: 'type',
  not_before: 'notBefore',
  review_at: 'reviewAt',
  expires_at: 'expiresAt',
  evidence: 'evidence',
  change_criteria: 'changeCriteria',
  review_prompt: 'reviewPrompt',
});

function lifecycleInputProperties() {
  return {
    type: lifecycleTypeSchema,
    not_before: lifecycleInstantSchema('Do not offer this memory before this exact UTC instant, formatted YYYY-MM-DDTHH:mm:ss.sssZ.'),
    review_at: lifecycleInstantSchema('Bring this memory to the due-review tool at this exact UTC instant, formatted YYYY-MM-DDTHH:mm:ss.sssZ.'),
    expires_at: lifecycleInstantSchema('Stop offering this memory as current at this exact UTC instant, formatted YYYY-MM-DDTHH:mm:ss.sssZ. It remains in history.'),
    evidence: lifecycleTextSchema('For a verdict: the evidence the judgment currently rests on.'),
    change_criteria: lifecycleTextSchema('For a verdict: what evidence or event could change the judgment.'),
    review_prompt: lifecycleTextSchema('For a verdict: the concrete question to answer when reopening it.', 1000),
  };
}

function lifecycleFromArguments(input, base = null) {
  const next = base === null
    ? { type: input.type ?? 'fact' }
    : Object.fromEntries(Object.entries(memoryLifecycle(base)).filter(([key]) => key !== 'format'));
  if (input.type !== undefined) next.type = input.type;
  for (const [argument, field] of Object.entries(lifecycleArgumentFields)) {
    if (argument !== 'type' && Object.hasOwn(input, argument)) next[field] = input[argument];
  }
  for (const field of input.clear ?? []) delete next[lifecycleArgumentFields[field]];
  return normalizeMemoryLifecycle(next);
}

// ---- memory -------------------------------------------------------------------

export function memoryTools({ ledger, agentId, clock = () => new Date(), timeZone, conversationArchive = null } = {}) {
  if (!isMemoryLedger(ledger)) throw toolKitError('memoryTools needs a live memory ledger');
  const author = agentActor(agentId);
  const zone = resolveTimeZone(timeZone);
  const confidence = { type: 'string', enum: [...MEMORY_CONFIDENCE], description: 'How sure you are. Default: asserted.' };

  async function current(id) {
    const entry = await ledger.get(limitedText(id, 128, 'id'));
    if (!entry) throw new Error('No memory has that id; recall shows ids');
    return entry;
  }

  const definitions = [
    {
      name: 'remember',
      description: 'Write a durable memory in your own words. Name whether it is a fact, possibility, reminder, chosen obligation, or current verdict. Optional exact dates can delay resurfacing, request review, or expire its influence without deleting history. Verdicts require evidence, change criteria, and a review or expiry date. Returns the memory id.',
      permissionSummary: input => `Write one ${input.type ?? 'fact'} memory (${[...input.text].length} characters).`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: AGENT_TOOL_LIMITS.memoryText, description: 'The memory, in your own words.' },
          confidence,
          ...lifecycleInputProperties(),
        },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(input) {
        const { text, confidence: sure = 'asserted' } = input;
        const createdAt = nowFrom(clock).toISOString();
        const lifecycle = lifecycleFromArguments(input);
        const record = createMemoryRecord({
          id: `memory:${randomUUID()}`,
          kind: 'authored-memory',
          text: limitedText(text, AGENT_TOOL_LIMITS.memoryText, 'text'),
          author,
          createdAt,
          basis: 'self-authored',
          confidence: sure,
          lifecycle,
        });
        await ledger.record(record);
        return { remembered: true, id: record.id, lifecycle, status: memoryLifecycleStatus(lifecycle, createdAt) };
      },
    },
    {
      name: 'recall',
      description: 'Search your memories. Use one to three distinctive subject words. Optional when accepts calendar language such as yesterday, last week, or 2026-10-10 and prefers memories written then. Set history to true to also see memories you revised or forgot.',
      effect: 'read-only',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: 'A few distinctive words.' },
          when: { type: 'string', minLength: 1, maxLength: 100, description: 'Optional calendar phrase, such as yesterday, last week, October 10, or 2026-10-10.' },
          history: { type: 'boolean', description: 'Include superseded and forgotten versions. Default: false.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute({ query, when, history = false }) {
        const searchFn = history ? searchMemoryHistory : searchCurrentMemories;
        const limit = AGENT_TOOL_LIMITS.recallResults;
        const asOf = nowFrom(clock).toISOString();
        const time = when === undefined ? null : parseTimeCues(limitedText(when, 100, 'when'), {
          now: asOf, timeZone: zone,
        });
        if (time && !time.receipt.ranges.length) throw new Error('when must name a calendar date or relative time such as yesterday or last week');
        const searchLimit = time ? 50 : limit;
        const rankedByTime = results => results.map((result, index) => ({
          result, index, timeMatch: time ? timeCuesMatchInstant(time, result.record.createdAt) : false,
        })).sort((left, right) => Number(right.timeMatch) - Number(left.timeMatch) || left.index - right.index);
        const timeReceipt = rows => time ? {
          basis: 'memory-record-createdAt',
          interpretation: time.receipt,
          returnedMatching: rows.filter(row => row.timeMatch).length,
        } : null;
        const row = item => memoryRow(item.result.record, {
          ...(history ? { state: item.result.state } : {}),
          status: item.result.lifecycleStatus,
          ...(time ? { matchesWhen: item.timeMatch } : {}),
        });
        const search = await searchFn(ledger, { query, limit: searchLimit }, { now: asOf });
        if (search.results.length) {
          const ranked = rankedByTime(search.results).slice(0, limit);
          return {
            matched: search.receipt.matched,
            returned: ranked.length,
            ...(time ? { when: timeReceipt(ranked) } : {}),
            memories: ranked.map(row),
          };
        }
        // Search is exact and every word must match, so one variant spelling
        // ("favorite" for "favourite") hides everything. Try each word alone.
        const words = [...new Set(query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
        if (words.length < 2) return {
          matched: 0,
          returned: 0,
          ...(time ? { when: timeReceipt([]) } : {}),
          memories: [],
        };
        const seen = new Map();
        for (const word of words.slice(0, 8)) {
          for (const result of (await searchFn(ledger, { query: word, limit: searchLimit }, { now: asOf })).results) {
            const key = `${result.logicalId}\0${result.record.fingerprint}`;
            const hit = seen.get(key) ?? { result, words: [], index: seen.size };
            hit.words.push(word);
            seen.set(key, hit);
          }
        }
        const ranked = [...seen.values()].map(hit => ({
          ...hit,
          timeMatch: time ? timeCuesMatchInstant(time, hit.result.record.createdAt) : false,
        })).sort((left, right) => (
          Number(right.timeMatch) - Number(left.timeMatch)
          || right.words.length - left.words.length
          || left.index - right.index
        )).slice(0, limit);
        return {
          matched: 0,
          broadened: 'No memory contained every word, so these each match at least one of them. Check that they are relevant.',
          returned: ranked.length,
          ...(time ? { when: timeReceipt(ranked) } : {}),
          memories: ranked.map(hit => ({ ...row(hit), matchedWords: hit.words })),
        };
      },
    },
    {
      name: 'inspect_memory',
      description: 'Read one exact live memory record by the id returned from remember, revise_memory, update_memory_lifecycle, or forget. Use this after a persistent memory change when you need to compare what landed with what you meant to write. Set history to include a bounded newest-first revision lineage; retraction and restoration state is shown separately from record text.',
      effect: 'read-only',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          history: { type: 'boolean', description: 'Include retained record revisions. Default: false.' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Newest revisions to include when history is true. Default: 5.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async execute({ id, history = false, limit = 5 }) {
        const entry = await current(id);
        const asOf = nowFrom(clock).toISOString();
        const stateOf = fingerprint => fingerprint === entry.currentFingerprint
          ? (entry.active ? 'current' : 'retracted')
          : 'superseded';
        const result = {
          asOf,
          id: entry.id,
          active: entry.active,
          lastSequence: entry.lastSequence,
          state: stateOf(entry.currentFingerprint),
          status: memoryLifecycleStatus(entry.current.lifecycle, asOf),
          record: entry.current,
          revisionCount: entry.revisions.length,
        };
        if (!history) return result;
        const revisions = [...entry.revisions].sort((left, right) => right.sequence - left.sequence).slice(0, limit);
        return {
          ...result,
          revisions: revisions.map(revision => ({
            state: stateOf(revision.fingerprint),
            sequence: revision.sequence,
            record: revision.record,
          })),
          omittedRevisions: Math.max(0, entry.revisions.length - revisions.length),
        };
      },
    },
    {
      name: 'revise_memory',
      description: 'Replace a memory with a corrected version. The old version stays in history, so nothing is lost. Give the reason you are changing it; inspect_memory reads back the exact live record by id.',
      permissionSummary: ({ id, text }) => `Revise memory ${id} with ${[...text].length} characters; keep its earlier version.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          text: { type: 'string', minLength: 1, maxLength: AGENT_TOOL_LIMITS.memoryText, description: 'The corrected memory, complete.' },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
          confidence,
        },
        required: ['id', 'text', 'reason'],
        additionalProperties: false,
      },
      async execute({ id, text, reason, confidence: sure = 'asserted' }) {
        const entry = await current(id);
        if (!entry.active) throw new Error('That memory was forgotten; it cannot be revised');
        const replacement = createMemoryRecord({
          id: entry.id,
          kind: 'authored-memory',
          text: limitedText(text, AGENT_TOOL_LIMITS.memoryText, 'text'),
          author,
          createdAt: nowFrom(clock).toISOString(),
          basis: 'self-authored',
          confidence: sure,
          ...(entry.current.lifecycle === undefined ? {} : { lifecycle: entry.current.lifecycle }),
        });
        await ledger.supersede({
          id: entry.id, expectedFingerprint: entry.currentFingerprint, expectedSequence: entry.lastSequence,
          replacement, reason: limitedText(reason, 500, 'reason'), actor: author,
        });
        return { revised: true, id: entry.id };
      },
    },
    {
      name: 'review_due_memories',
      description: 'List memories that now need attention: reminders or obligations whose do-not-resurface date has arrived, records whose review date is due, and records whose influence has expired. This does not silently renew or dismiss anything; use revise_memory, update_memory_lifecycle, or forget after reviewing it.',
      effect: 'read-only',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional exact subject words to search within due memories.' },
          limit: { type: 'integer', minimum: 1, maximum: AGENT_TOOL_LIMITS.recallResults, description: 'Maximum results. Default: 20.' },
        },
        required: [],
        additionalProperties: false,
      },
      async execute({ query, limit = AGENT_TOOL_LIMITS.recallResults }) {
        const asOf = nowFrom(clock).toISOString();
        const found = query === undefined
          ? await recentMemories(ledger, { mode: 'due', limit, now: asOf })
          : await searchDueMemories(ledger, { query, limit }, { now: asOf });
        return {
          asOf,
          returned: found.results.length,
          memories: found.results.map(result => memoryRow(result.record, {
            state: result.state,
            status: result.lifecycleStatus,
          })),
        };
      },
    },
    {
      name: 'update_memory_lifecycle',
      description: 'Change the type or clock rules of one of your authored memories without changing its text. The previous lifecycle stays in ledger history. Omitted fields are preserved; name fields in clear to remove them. Give a reason. Verdicts must retain evidence, change criteria, and a review or expiry date.',
      permissionSummary: input => {
        const changed = Object.keys(lifecycleArgumentFields).filter(field => Object.hasOwn(input, field));
        const cleared = input.clear ?? [];
        return `Change memory ${input.id} lifecycle metadata (${changed.length} field${changed.length === 1 ? '' : 's'} set, ${cleared.length} cleared).`;
      },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
          ...lifecycleInputProperties(),
          clear: {
            type: 'array',
            items: { type: 'string', enum: ['not_before', 'review_at', 'expires_at', 'evidence', 'change_criteria', 'review_prompt'] },
            maxItems: 6,
            description: 'Lifecycle fields to remove. A field cannot be both supplied and cleared.',
          },
        },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
      async execute(input) {
        const entry = await current(input.id);
        if (!entry.active) throw new Error('That memory was forgotten; its lifecycle cannot be changed');
        if (entry.current.kind !== 'authored-memory' || entry.current.basis !== 'self-authored' || entry.current.author.id !== author.id) {
          throw new Error('You may change lifecycle metadata only on memories you authored yourself');
        }
        if (entry.current.sources.length || entry.current.evidence.length) {
          throw new Error('A source-citing memory needs operator review before its lifecycle can be changed');
        }
        const clear = input.clear ?? [];
        if (new Set(clear).size !== clear.length) throw new Error('clear must not repeat a lifecycle field');
        const repeated = clear.find(field => Object.hasOwn(input, field));
        if (repeated) throw new Error(`${repeated} cannot be supplied and cleared in the same change`);
        const supplied = Object.keys(lifecycleArgumentFields).some(field => Object.hasOwn(input, field));
        if (!supplied && !clear.length) throw new Error('Name at least one lifecycle field to change or clear');
        const lifecycle = lifecycleFromArguments(input, entry.current.lifecycle);
        const previousLifecycle = memoryLifecycle(entry.current.lifecycle);
        if (JSON.stringify(lifecycle) === JSON.stringify(previousLifecycle)) throw new Error('That lifecycle is already current');
        const createdAt = nowFrom(clock).toISOString();
        const replacement = createMemoryRecord({
          id: entry.id,
          kind: entry.current.kind,
          text: entry.current.text,
          author,
          createdAt,
          basis: entry.current.basis,
          confidence: entry.current.confidence,
          lifecycle,
        });
        await ledger.supersede({
          id: entry.id,
          expectedFingerprint: entry.currentFingerprint,
          expectedSequence: entry.lastSequence,
          replacement,
          reason: limitedText(input.reason, 500, 'reason'),
          actor: author,
        });
        return { updated: true, id: entry.id, lifecycle, status: memoryLifecycleStatus(lifecycle, createdAt) };
      },
    },
    {
      name: 'forget',
      description: 'Retract a memory that is wrong or no longer wanted. It leaves your current memories but stays visible in history, and an operator can restore it.',
      permissionSummary: ({ id }) => `Retract memory ${id}; retain it in history.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
      async execute({ id, reason }) {
        const entry = await current(id);
        if (!entry.active) throw new Error('That memory is already forgotten');
        await ledger.retract({
          id: entry.id, expectedFingerprint: entry.currentFingerprint, expectedSequence: entry.lastSequence,
          reason: limitedText(reason, 500, 'reason'), actor: author,
        });
        return { forgotten: true, id: entry.id };
      },
    },
  ];
  if (conversationArchive) definitions.push(...conversationSearchTools({ archive: conversationArchive, clock }));
  return definitions;
}

// ---- notebook -----------------------------------------------------------------

const notebookPathPattern = /^[A-Za-z0-9 ._()-]+(?:\/[A-Za-z0-9 ._()-]+)*$/;

// Resolves an agent-supplied relative path inside the notebook root. Refuses
// absolute paths, traversal, hidden names, and any symbolic link on the way.
// Exported for the room's shelf, which can take a file from the notebook.
export async function resolveNotebookPath(root, relative, options) {
  return notebookPath(await fs.realpath(root), relative, options);
}

async function notebookPath(root, relative, { allowRoot = false } = {}) {
  // Models often write folders as "notes/" or "./notes"; both mean "notes".
  const text = String(relative ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!text) {
    if (allowRoot) return root;
    throw new Error('path must name a file inside the notebook');
  }
  if (text.length > AGENT_TOOL_LIMITS.notebookPathCharacters || !notebookPathPattern.test(text)) {
    throw new Error('path must be relative, use forward slashes, and contain only letters, digits, spaces, and . _ ( ) -');
  }
  const parts = text.split('/');
  if (parts.some(part => part === '.' || part === '..' || part.startsWith('.') || part.endsWith(' ') || part.endsWith('.'))) {
    throw new Error('path parts must not be . or .., start with a dot, or end with a space or dot');
  }
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = await fs.lstat(cursor); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink()) throw new Error('path passes through a symbolic link, which the notebook refuses');
  }
  const resolved = path.join(root, ...parts);
  if (path.relative(root, resolved).startsWith('..')) throw new Error('path leaves the notebook');
  return resolved;
}

export async function notebookTools({ root } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw toolKitError('notebookTools needs an absolute root directory');
  await fs.mkdir(root, { recursive: true });
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw toolKitError('notebook root must be a real directory');
  const realRoot = await fs.realpath(root);
  const pathField = { type: 'string', maxLength: AGENT_TOOL_LIMITS.notebookPathCharacters, description: 'Relative path inside your notebook, like "ideas/plants.md".' };

  return [
    {
      name: 'list_files',
      description: 'List the files and folders in your notebook, or inside one folder of it.',
      effect: 'read-only',
      inputSchema: { type: 'object', properties: { path: { ...pathField, description: 'Folder to list. Empty for the top.' } }, required: [], additionalProperties: false },
      async execute({ path: relative = '' }) {
        const folder = await notebookPath(realRoot, relative, { allowRoot: true });
        let entries;
        try { entries = await fs.readdir(folder, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') throw new Error('No folder at that path'); throw error; }
        const visible = entries.filter(entry => !entry.name.startsWith('.') && (entry.isFile() || entry.isDirectory()))
          .sort((a, b) => a.name.localeCompare(b.name, 'en'));
        const rows = [];
        for (const entry of visible.slice(0, AGENT_TOOL_LIMITS.notebookListEntries)) {
          const stat = await fs.lstat(path.join(folder, entry.name));
          rows.push(entry.isDirectory()
            ? { name: `${entry.name}/`, kind: 'folder' }
            : { name: entry.name, kind: 'file', bytes: stat.size, modified: stat.mtime.toISOString() });
        }
        return { entries: rows, omitted: Math.max(0, visible.length - rows.length) };
      },
    },
    {
      name: 'read_file',
      description: `Read a text file from your notebook. Long files come back ${AGENT_TOOL_LIMITS.notebookReadCharacters} characters at a time; pass offset to continue.`,
      effect: 'read-only',
      inputSchema: {
        type: 'object',
        properties: { path: pathField, offset: { type: 'integer', minimum: 0, description: 'Character to start from. Default: 0.' } },
        required: ['path'],
        additionalProperties: false,
      },
      async execute({ path: relative, offset = 0 }) {
        const file = await notebookPath(realRoot, relative);
        let stat;
        try { stat = await fs.lstat(file); }
        catch (error) { if (error.code === 'ENOENT') throw new Error('No file at that path; list_files shows what exists'); throw error; }
        if (!stat.isFile()) throw new Error('That path is not a file');
        if (stat.size > AGENT_TOOL_LIMITS.notebookFileBytes) throw new Error(`That file is ${stat.size} bytes; the notebook reads files up to ${AGENT_TOOL_LIMITS.notebookFileBytes}`);
        const text = new TextDecoder('utf-8', { fatal: false }).decode(await fs.readFile(file));
        const characters = [...text];
        const slice = characters.slice(offset, offset + AGENT_TOOL_LIMITS.notebookReadCharacters).join('');
        const next = offset + AGENT_TOOL_LIMITS.notebookReadCharacters;
        return { path: relative, text: slice, characters: characters.length, ...(next < characters.length ? { nextOffset: next } : {}) };
      },
    },
    {
      name: 'write_file',
      description: 'Write a text file in your notebook, creating folders as needed. mode "overwrite" replaces the file; "append" adds to its end. Use read_file on the returned path when you need to compare the live file with what you meant to write.',
      permissionSummary: ({ path: relative, text, mode = 'overwrite' }) => {
        const characters = [...relative];
        const shown = characters.length > 140 ? `${characters.slice(0, 139).join('')}…` : relative;
        return `${mode === 'append' ? 'Append to' : 'Overwrite'} notebook file ${shown} with ${[...text].length} characters.`;
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: pathField,
          text: { type: 'string', maxLength: 24_000 },
          mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Default: overwrite.' },
        },
        required: ['path', 'text'],
        additionalProperties: false,
      },
      async execute({ path: relative, text, mode = 'overwrite' }) {
        const file = await notebookPath(realRoot, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await notebookPath(realRoot, relative); // Re-check after creating folders.
        let existing = '';
        try {
          const stat = await fs.lstat(file);
          if (!stat.isFile()) throw new Error('That path is a folder, not a file');
          if (mode === 'append') existing = await fs.readFile(file, 'utf8');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const content = existing + text;
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > AGENT_TOOL_LIMITS.notebookFileBytes) throw new Error(`The file would be ${bytes} bytes; the limit is ${AGENT_TOOL_LIMITS.notebookFileBytes}`);
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
        await fs.writeFile(temporary, content, { flag: 'wx' });
        try { await fs.rename(temporary, file); }
        catch (error) { await fs.rm(temporary, { force: true }); throw error; }
        return { written: true, path: relative, bytes, mode };
      },
    },
  ];
}

// ---- clock --------------------------------------------------------------------

export function clockTools({ clock = () => new Date(), timeZone } = {}) {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); }
  catch { throw toolKitError(`timeZone ${JSON.stringify(zone)} is not a valid IANA time zone`); }
  return [{
    name: 'what_time_is_it',
    description: 'Get the current date and time. Use this instead of guessing the date.',
    effect: 'read-only',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute() {
      const now = nowFrom(clock);
      return {
        iso: now.toISOString(),
        local: new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }).format(now),
        timeZone: zone,
      };
    },
  }];
}

// ---- web ----------------------------------------------------------------------

const privateWebAddresses = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 16], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 3],
]) privateWebAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) privateWebAddresses.addSubnet(address, prefix, 'ipv6');

// True for addresses that point back into this machine or a private network.
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  return privateWebAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function lookupWithSignal(host, lookup, signal) {
  signal?.throwIfAborted();
  const pending = Promise.resolve().then(() => lookup(host, { all: true, verbatim: true }));
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = action => value => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      action(value);
    };
    const succeeded = finish(resolve);
    const failed = finish(reject);
    const aborted = () => failed(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(succeeded, failed);
    if (signal.aborted) aborted();
  });
}

async function publicURL(value, lookup, signal) {
  signal?.throwIfAborted();
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('url must be an absolute http or https URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('url must use http or https');
  if (url.username || url.password) throw new Error('url must not contain credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const answers = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await lookupWithSignal(host, lookup, signal);
  const addresses = answers.map(entry => ({ address: entry.address, family: net.isIP(entry.address) }));
  if (!addresses.length || addresses.some(entry => !entry.family || isPrivateAddress(entry.address))) {
    throw new Error('That address is on this machine or a private network; read_web_page only reads the public web');
  }
  url.hash = '';
  return { url, addresses };
}

const webRequestHeaders = Object.freeze({
  accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1',
  'accept-encoding': 'identity',
  connection: 'close',
  'user-agent': 'Fieldwork/0 (+read_web_page)',
});

export function pinnedWebRequestOptions(url, address, family) {
  const originHost = url.hostname.replace(/^\[|\]$/g, '');
  return {
    protocol: url.protocol,
    hostname: address,
    family,
    ...(url.port ? { port: url.port } : {}),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { ...webRequestHeaders, host: url.host },
    agent: false,
    ...(url.protocol === 'https:' ? {
      rejectUnauthorized: true,
      ...(!net.isIP(originHost) ? { servername: originHost } : {}),
    } : {}),
  };
}

function incomingResponse(message) {
  return {
    status: message.statusCode ?? 0,
    header(name) {
      const value = message.headers[String(name).toLowerCase()];
      return Array.isArray(value) ? value.join(', ') : value ?? null;
    },
    body: message,
    cancel() { message.destroy(); },
  };
}

function pinnedWebTransport(url, { address, family, signal }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({ ...pinnedWebRequestOptions(url, address, family), signal }, response => {
      resolve(incomingResponse(response));
    });
    request.once('upgrade', (response, socket) => {
      response.destroy();
      socket.destroy();
      reject(new Error('The page switched protocols instead of returning a web page'));
    });
    request.once('error', reject);
    request.end();
  });
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === '#') {
        const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
      }
      return entities[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function boundedText(response, maximum) {
  if (!response.body) return { text: '', truncated: false };
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let bytes = 0, text = '', truncated = false;
  for await (const chunk of response.body) {
    const value = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    if (bytes + value.byteLength > maximum) {
      const remaining = maximum - bytes;
      if (remaining) text += decoder.decode(value.subarray(0, remaining), { stream: true });
      truncated = true;
      response.cancel();
      break;
    }
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated };
}

async function requestFromValidatedAddresses(target, transport, signal) {
  let failure;
  for (const { address, family } of target.addresses) {
    try { return await transport(target.url, { address, family, signal }); }
    catch (error) {
      signal?.throwIfAborted();
      failure = error;
    }
  }
  throw failure ?? new Error('The public address could not be reached');
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export function webTools({ transport = pinnedWebTransport, lookup = dns.lookup } = {}) {
  if (typeof transport !== 'function') throw toolKitError('webTools needs transport');
  if (typeof lookup !== 'function') throw toolKitError('webTools needs lookup');
  return [{
    name: 'read_web_page',
    description: `Read a public web page as plain text. Long pages come back ${AGENT_TOOL_LIMITS.webCharacters} characters at a time; pass offset to continue.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 2048 },
        offset: { type: 'integer', minimum: 0, description: 'Character to start from. Default: 0.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute({ url, offset = 0 }, { signal } = {}) {
      const timeout = AbortSignal.timeout(AGENT_TOOL_LIMITS.webTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let target = await publicURL(url, lookup, combined), response;
      for (let hop = 0; ; hop++) {
        response = await requestFromValidatedAddresses(target, transport, combined);
        if (!redirectStatuses.has(response.status)) break;
        const location = response.header('location');
        response.cancel();
        if (!location) throw new Error(`The page redirected (HTTP ${response.status}) without saying where`);
        if (hop + 1 > AGENT_TOOL_LIMITS.webRedirects) throw new Error(`The page redirected more than ${AGENT_TOOL_LIMITS.webRedirects} times`);
        target = await publicURL(new URL(location, target.url), lookup, combined);
      }
      if (response.status < 200 || response.status > 299) {
        response.cancel();
        throw new Error(`The page answered HTTP ${response.status}`);
      }
      const type = (response.header('content-type') || '').toLowerCase();
      const encoding = (response.header('content-encoding') || '').toLowerCase();
      if (encoding && encoding !== 'identity') {
        response.cancel();
        throw new Error(`That URL answered with unsupported ${encoding} content encoding`);
      }
      if (type && !/^(text\/|application\/(xhtml\+xml|xml|json))/.test(type)) {
        response.cancel();
        throw new Error(`That URL is ${type.split(';')[0]}, not a text page`);
      }
      const body = await boundedText(response, AGENT_TOOL_LIMITS.webBytes);
      const text = /html|xml/.test(type) || /^\s*</.test(body.text) ? htmlToText(body.text) : body.text.trim();
      const title = body.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      const characters = [...text];
      const next = offset + AGENT_TOOL_LIMITS.webCharacters;
      return {
        url: target.url.href,
        ...(title ? { title: htmlToText(title).slice(0, 300) } : {}),
        text: characters.slice(offset, next).join(''),
        characters: characters.length,
        ...(next < characters.length ? { nextOffset: next } : {}),
        ...(body.truncated ? { truncated: `The page was cut at ${AGENT_TOOL_LIMITS.webBytes} bytes` } : {}),
      };
    },
  }];
}
