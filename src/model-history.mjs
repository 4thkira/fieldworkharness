import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deepFreeze, isPlainObject } from './json-data.mjs';

// Which model the agent has been thinking with, and since when. A model is
// recorded the first time it actually answers, so the agent can be told
// plainly when its model changed instead of the switch passing in silence.

export const MODEL_HISTORY_LIMITS = Object.freeze({ entries: 50, mentioned: 3, modelCharacters: 200 });

function historyError(message, status = 400) {
  const error = new Error(`Model history: ${message}`);
  Object.defineProperty(error, 'status', { value: status, enumerable: true });
  return error;
}

export async function createModelHistory({ file, clock = () => new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw historyError('file must be an absolute path', 500);
  const now = () => { const value = clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); };
  let entries = [];
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    entries = (Array.isArray(saved?.entries) ? saved.entries : [])
      .filter(row => isPlainObject(row) && typeof row.model === 'string' && row.model && typeof row.since === 'string' && !Number.isNaN(Date.parse(row.since)))
      .slice(-MODEL_HISTORY_LIMITS.entries);
  } catch { /* no history yet */ }
  let queue = Promise.resolve();
  const day = iso => new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));

  return Object.freeze({
    view: () => deepFreeze(entries.map(row => ({ ...row }))),
    current: () => entries.at(-1)?.model ?? null,

    // Records the model that is about to answer; true when it changed.
    note(model) {
      const name = String(model ?? '').trim().slice(0, MODEL_HISTORY_LIMITS.modelCharacters);
      if (!name || entries.at(-1)?.model === name) return Promise.resolve(false);
      const task = queue.then(async () => {
        if (entries.at(-1)?.model === name) return false;
        entries = [...entries, { model: name, since: now() }].slice(-MODEL_HISTORY_LIMITS.entries);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
        await fs.writeFile(temporary, `${JSON.stringify({ format: 'fieldwork-model-history/v1', entries })}\n`, { flag: 'wx' });
        try { await fs.rename(temporary, file); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
        return true;
      });
      queue = task.then(() => undefined, () => undefined);
      return task;
    },

    // A short, host-written note for the agent; empty until it has run on
    // more than one model.
    contextText() {
      if (entries.length < 2) return '';
      const latest = entries.at(-1);
      const earlier = entries.slice(-1 - MODEL_HISTORY_LIMITS.mentioned, -1).reverse()
        .map((row, index, list) => {
          const until = index === 0 ? latest.since : list[index - 1].since;
          return `${row.model} (${day(row.since)}–${day(until)})`;
        });
      return [
        `[Fieldwork model note] You are thinking with ${latest.model} since ${day(latest.since)}. Before that: ${earlier.join('; ')}.`,
        'Earlier replies in your conversations and notes may have been written while you ran on an earlier model. Your home, roots, memories and history are the same; only the model changed.',
      ].join(' ');
    },
  });
}
