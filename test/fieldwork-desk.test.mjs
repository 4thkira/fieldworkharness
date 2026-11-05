import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFieldworkDesk, fieldworkSteps } from '../src/fieldwork-desk.mjs';

async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-desk-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const transcript = [
  { role: 'system', content: 'frame' },
  { role: 'user', content: 'Count the notes.' },
  { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_files', arguments: '{"path":"notes"}' } }] },
  { role: 'tool', tool_call_id: 'a', content: '{"ok":true,"value":{"entries":[]}}' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"path":"missing.md"}' } }] },
  { role: 'tool', tool_call_id: 'b', content: '{"ok":false,"error":"No file"}' },
  { role: 'assistant', content: 'There are no notes yet.' },
];

test('steps list each tool, what it was asked, and whether it worked', () => {
  assert.deepEqual(fieldworkSteps(transcript), [
    { kind: 'note', text: 'Let me look.' },
    { kind: 'tool', tool: 'list_files', detail: 'path: notes', ok: true },
    { kind: 'tool', tool: 'read_file', detail: 'path: missing.md', ok: false },
  ]);
});

test('a Fieldwork runs in the background, records its write-up, and survives a restart', async t => {
  const dir = await folder(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = [];
  const run = async request => { seen.push(request); await gate; return { status: 'completed', answer: 'There are no notes yet.', messages: transcript }; };
  const desk = await createFieldworkDesk({ dir, run });
  const started = await desk.start({ prompt: '  Count the notes.  ', maxSteps: 5, model: 'synthetic-model' });
  assert.equal(started.status, 'running');
  assert.equal(started.prompt, 'Count the notes.');
  assert.equal(desk.activeId, started.id);
  await assert.rejects(desk.start({ prompt: 'another' }), /still running/);
  assert.equal(seen[0].id, started.id);
  assert.equal(seen[0].maxSteps, 5);

  release();
  await desk.settle();
  const done = desk.get(started.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.answer, 'There are no notes yet.');
  assert.equal(done.steps.length, 3);
  assert.equal(desk.activeId, null);

  const reopened = await createFieldworkDesk({ dir, run });
  assert.deepEqual(reopened.list().map(row => [row.prompt, row.status, row.stepCount]), [['Count the notes.', 'completed', 3]]);
  assert.equal(reopened.record(started.id).messages.length, transcript.length, 'the full transcript stays on disk for the host');
});

test('concurrent starts raise the active fence before the first record save can yield', async t => {
  const dir = await folder(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const desk = await createFieldworkDesk({
    dir,
    run: async () => {
      await gate;
      return { status: 'completed', answer: 'one winner', messages: [] };
    },
  });
  const results = await Promise.allSettled([
    desk.start({ prompt: 'first contender' }),
    desk.start({ prompt: 'second contender' }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.match(String(results.find(result => result.status === 'rejected').reason?.message), /still running/);
  assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.json')).length, 1);
  release();
  await desk.settle();
  assert.equal(desk.list().length, 1);
});

test('stopping aborts the run and is recorded as stopped', async t => {
  const dir = await folder(t);
  const run = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const desk = await createFieldworkDesk({ dir, run });
  const { id } = await desk.start({ prompt: 'Take forever.' });
  desk.stop(id);
  await desk.settle();
  assert.equal(desk.get(id).status, 'stopped');
  assert.throws(() => desk.stop(id), /not running/);
});

test('a failure is recorded with its reason, and a run left mid-way is marked interrupted on restart', async t => {
  const dir = await folder(t);
  const failing = await createFieldworkDesk({ dir, run: async () => { throw new Error('the model went away'); } });
  const { id } = await failing.start({ prompt: 'Try something.' });
  await failing.settle();
  assert.equal(failing.get(id).status, 'failed');
  assert.match(failing.get(id).error, /model went away/);

  const stuck = { format: 'fieldwork-inquiry/v1', id: 'fw-00000000-0000-4000-8000-000000000000', prompt: 'Half done', maxSteps: 4, status: 'running', startedAt: '2030-01-01T00:00:00.000Z', steps: [] };
  await fs.writeFile(path.join(dir, `${stuck.id}.json`), JSON.stringify(stuck));
  const reopened = await createFieldworkDesk({ dir, run: async () => ({}) });
  assert.equal(reopened.get(stuck.id).status, 'interrupted');
});

test('questions and step budgets are checked', async t => {
  const desk = await createFieldworkDesk({ dir: await folder(t), run: async () => ({ answer: 'x', messages: [] }) });
  await assert.rejects(desk.start({ prompt: '   ' }), /must not be empty/);
  await assert.rejects(desk.start({ prompt: 'ok', maxSteps: 0 }), /from 1 to 32/);
  await assert.rejects(desk.start({ prompt: 'ok', maxSteps: 99 }), /from 1 to 32/);
  assert.throws(() => desk.get('fw-nope'), /no Fieldwork has that id/);
  await assert.rejects(createFieldworkDesk({ dir: await folder(t), run: async () => ({}), onPersist: true }), /onPersist must be a function/);
});

test('the persistence hook runs after the final save and remains part of the active settlement', async t => {
  const dir = await folder(t);
  let releaseHook;
  let hookEntered;
  const hookGate = new Promise(resolve => { releaseHook = resolve; });
  const entered = new Promise(resolve => { hookEntered = resolve; });
  let receipt;
  let desk;
  desk = await createFieldworkDesk({
    dir,
    run: async () => ({ status: 'completed', answer: 'Persisted answer.', messages: [] }),
    onPersist: async value => {
      receipt = value;
      const saved = JSON.parse(await fs.readFile(path.join(dir, `${value.id}.json`), 'utf8'));
      assert.equal(saved.status, 'completed', 'the final record is already durable when the hook begins');
      assert.equal(desk.activeId, value.id, 'the desk stays active through host finalization');
      hookEntered();
      await hookGate;
    },
  });
  const started = await desk.start({ prompt: 'Finish and persist.' });
  await entered;
  assert.equal(desk.get(started.id).status, 'running', 'completion stays hidden until host finalization settles');
  assert.equal(desk.list()[0].status, 'running', 'the list uses the same settlement boundary');
  let settled = false;
  const settlement = desk.settle().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(Object.keys(receipt), ['id', 'status', 'saved', 'error']);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(receipt, { id: started.id, status: 'completed', saved: true, error: null });
  releaseHook();
  await settlement;
  assert.equal(desk.activeId, null);
  assert.equal(desk.get(started.id).status, 'completed');
});

test('the Fieldwork persistence hook reports run and save failures without replaying work', async t => {
  const failedReceipts = [];
  let failedRuns = 0;
  const failed = await createFieldworkDesk({
    dir: await folder(t),
    run: async () => { failedRuns += 1; throw new Error('synthetic runner failure'); },
    onPersist: value => failedReceipts.push(value),
  });
  await failed.start({ prompt: 'Fail once.' });
  await failed.settle();
  assert.equal(failedRuns, 1);
  assert.equal(failedReceipts.length, 1);
  assert.deepEqual(failedReceipts[0], {
    id: failedReceipts[0].id, status: 'failed', saved: true, error: null,
  });

  const dir = await folder(t);
  let releaseRun;
  let runEntered;
  const runGate = new Promise(resolve => { releaseRun = resolve; });
  const entered = new Promise(resolve => { runEntered = resolve; });
  const saveReceipts = [];
  let saveRuns = 0;
  const unsavable = await createFieldworkDesk({
    dir,
    run: async () => {
      saveRuns += 1;
      runEntered();
      await runGate;
      return { status: 'completed', answer: 'Only in memory.', messages: [] };
    },
    onPersist: value => saveReceipts.push(value),
  });
  await unsavable.start({ prompt: 'Lose the final save.' });
  await entered;
  await fs.rm(dir, { recursive: true, force: true });
  await fs.writeFile(dir, 'this file blocks the final record directory');
  releaseRun();
  await unsavable.settle();
  assert.equal(saveRuns, 1);
  assert.equal(saveReceipts.length, 1);
  assert.equal(saveReceipts[0].status, 'completed');
  assert.equal(saveReceipts[0].saved, false);
  assert.ok(saveReceipts[0].error instanceof Error);

  let hookRuns = 0;
  let runnerRuns = 0;
  const throwingHook = await createFieldworkDesk({
    dir: await folder(t),
    run: async () => { runnerRuns += 1; return { status: 'completed', answer: 'Once.', messages: [] }; },
    onPersist: () => { hookRuns += 1; throw new Error('synthetic hook failure'); },
  });
  await throwingHook.start({ prompt: 'Do not replay me.' });
  await throwingHook.settle();
  assert.equal(runnerRuns, 1);
  assert.equal(hookRuns, 1);
});
