import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deepFreeze } from './json-data.mjs';

// Fieldworks: a question or task the agent works on by itself, in the
// background, with a step budget. Each one is a record on disk: what was asked,
// how it went, the write-up it ended with, and the steps it took to get there.
// One runs at a time. The desk does not know how to run an agent; the host
// passes `run`, which receives the question and returns the run loop's result.

export const FIELDWORK_FORMAT = 'fieldwork-inquiry/v1';
export const FIELDWORK_LIMITS = Object.freeze({
  promptCharacters: 8000,
  defaultSteps: 12,
  maxSteps: 32,
  kept: 500,
  answerCharacters: 200_000,
});

const STATUSES = ['running', 'completed', 'exhausted', 'stopped', 'failed', 'interrupted'];
const idPattern = /^fw-[0-9a-f-]{36}$/;

function deskError(message, status) {
  const error = new Error(`Fieldwork: ${message}`);
  if (status) Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

// What happened, step by step, from the run's transcript: each tool the agent
// called and whether it worked. Tool results themselves stay on disk only.
export function fieldworkSteps(messages) {
  const steps = [];
  const outcomes = new Map();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    let ok = null;
    try { ok = JSON.parse(message.content)?.ok ?? null; } catch { /* Unreadable results count as unknown. */ }
    outcomes.set(message.tool_call_id, ok);
  }
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    // What the agent said first, then the tools it called.
    if (text && Array.isArray(message.tool_calls) && message.tool_calls.length) steps.push({ kind: 'note', text: text.slice(0, 400) });
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      let detail = '';
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        detail = Object.entries(args).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(', ');
      } catch { detail = ''; }
      steps.push({ kind: 'tool', tool: String(call.function.name).slice(0, 64), detail: detail.slice(0, 200), ok: outcomes.get(call.id) ?? null });
    }
  }
  return steps;
}

export async function createFieldworkDesk({ dir, run, clock = () => new Date(), onPersist } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw deskError('dir must be an absolute directory');
  if (typeof run !== 'function') throw deskError('run must be a function');
  if (onPersist !== undefined && typeof onPersist !== 'function') throw deskError('onPersist must be a function');
  await fs.mkdir(dir, { recursive: true });
  const records = new Map();
  let active = null; // { id, controller }

  const now = () => (clock() instanceof Date ? clock() : new Date(clock())).toISOString();
  const fileFor = id => path.join(dir, `${id}.json`);
  const save = async record => {
    const temporary = `${fileFor(record.id)}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx' });
    await fs.rename(temporary, fileFor(record.id));
  };

  // Load what is on disk. Anything still marked running belonged to a process
  // that ended, so it is marked interrupted rather than left spinning forever.
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    let record;
    try { record = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')); } catch { continue; }
    if (record?.format !== FIELDWORK_FORMAT || !idPattern.test(record.id) || !STATUSES.includes(record.status)) continue;
    if (record.status === 'running') {
      record.status = 'interrupted';
      record.finishedAt = record.finishedAt ?? now();
      record.error = 'Fieldwork stopped before this finished.';
      await save(record);
    }
    records.set(record.id, record);
  }

  const summary = record => deepFreeze({
    // The final record is saved before the host persistence hook runs, but the
    // work is not externally settled until that hook finishes. Keep projecting
    // it as running so callers cannot observe "completed" while related durable
    // effects are still being finalized.
    id: record.id, prompt: record.prompt, status: active?.id === record.id ? 'running' : record.status, maxSteps: record.maxSteps, model: record.model ?? null,
    startedAt: record.startedAt, finishedAt: record.finishedAt ?? null, stepCount: record.steps?.length ?? 0,
    startedBy: record.startedBy === 'agent' ? 'agent' : 'person',
  });
  const detail = record => deepFreeze({
    ...summary(record),
    answer: record.answer ?? '',
    steps: record.steps ?? [],
    error: record.error ?? null,
  });
  const find = id => {
    const record = typeof id === 'string' ? records.get(id) : undefined;
    if (!record) throw deskError('no Fieldwork has that id', 404);
    return record;
  };

  async function execute(record, controller) {
    try {
      const result = await run({ id: record.id, prompt: record.prompt, maxSteps: record.maxSteps, signal: controller.signal });
      record.status = result.status === 'exhausted' ? 'exhausted' : 'completed';
      record.answer = String(result.answer ?? '').slice(0, FIELDWORK_LIMITS.answerCharacters);
      record.steps = fieldworkSteps(result.messages ?? []);
      record.messages = result.messages ?? [];
    } catch (error) {
      record.status = controller.signal.aborted ? 'stopped' : 'failed';
      record.error = controller.signal.aborted ? 'Stopped before it finished.' : String(error?.message ?? error).slice(0, 500);
      if (Array.isArray(error?.partialMessages)) record.steps = fieldworkSteps(error.partialMessages);
    } finally {
      record.finishedAt = now();
      let persistError = null;
      try { await save(record); }
      catch (error) { persistError = error; /* The in-memory record still shows the outcome. */ }
      try {
        await onPersist?.(Object.freeze({
          id: record.id,
          status: record.status,
          saved: persistError === null,
          error: persistError,
        }));
      } catch { /* A host hook is diagnostic; it must not restart completed work. */ }
      active = null;
    }
  }

  return Object.freeze({
    list() {
      return deepFreeze([...records.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map(summary));
    },

    get(id) { return detail(find(id)); },

    // The agent's full record, including tool results, for hosts that need it
    // (bringing a Fieldwork into a conversation). Never sent to the browser.
    record(id) { return deepFreeze(structuredClone(find(id))); },

    get activeId() { return active?.id ?? null; },

    async start({ prompt, maxSteps = FIELDWORK_LIMITS.defaultSteps, model = null, startedBy = 'person' } = {}) {
      const text = String(prompt ?? '').trim();
      if (!text) throw deskError('the question must not be empty', 400);
      if ([...text].length > FIELDWORK_LIMITS.promptCharacters) throw deskError(`the question is at most ${FIELDWORK_LIMITS.promptCharacters} characters`, 400);
      if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > FIELDWORK_LIMITS.maxSteps) {
        throw deskError(`steps must be a whole number from 1 to ${FIELDWORK_LIMITS.maxSteps}`, 400);
      }
      if (active) throw deskError('another Fieldwork is still running; stop it or wait for it to finish', 409);
      if (records.size >= FIELDWORK_LIMITS.kept) throw deskError(`at most ${FIELDWORK_LIMITS.kept} Fieldworks are kept`, 409);
      const record = { format: FIELDWORK_FORMAT, id: `fw-${randomUUID()}`, prompt: text, maxSteps, model, status: 'running', startedAt: now(), steps: [], startedBy: startedBy === 'agent' ? 'agent' : 'person' };
      records.set(record.id, record);
      const controller = new AbortController();
      active = { id: record.id, controller };
      try { await save(record); }
      catch (error) {
        active = null;
        records.delete(record.id);
        throw error;
      }
      void execute(record, controller);
      return detail(record);
    },

    stop(id) {
      const record = find(id);
      if (!active || active.id !== record.id) throw deskError('that Fieldwork is not running', 409);
      active.controller.abort(deskError('stopped by the person running Fieldwork'));
      return detail(record);
    },

    // Waits for the running Fieldwork, if any (tests and shutdown).
    async settle() {
      while (active) await new Promise(resolve => setTimeout(resolve, 20));
    },

    async close() {
      active?.controller.abort(deskError('Fieldwork is shutting down'));
      await this.settle();
    },
  });
}
