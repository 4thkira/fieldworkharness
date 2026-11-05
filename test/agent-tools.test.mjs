import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AGENT_TOOL_LIMITS, clockTools, htmlToText, isPrivateAddress, memoryTools, notebookTools, pinnedWebRequestOptions, webTools } from '../src/agent-tools.mjs';
import { createConversationArchive } from '../src/conversation-archive.mjs';
import { createMemoryLedger } from '../src/memory-ledger.mjs';
import { createToolRegistry, executeTool, prepareToolCall } from '../src/tools.mjs';

const fixedClock = () => new Date('2026-11-01T12:00:00.000Z');

function webResponse(text, { status = 200, headers = {} } = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
  const body = text === null ? null : Readable.from([Buffer.from(text)]);
  return {
    status,
    header: name => normalized[String(name).toLowerCase()] ?? null,
    body,
    cancel: () => body?.destroy(),
  };
}

async function temporary(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// Close the ledger before its directory is removed, or the writer lock vanishes underneath it.
async function ledgerIn(t, prefix, ledgerId) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const ledger = await createMemoryLedger(path.join(directory, 'memory.jsonl'), { ledgerId });
  t.after(async () => { await ledger.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, ledger };
}

async function memoryKit(t) {
  const { ledger } = await ledgerIn(t, 'fieldwork-agent-memory-', 'synthetic-memory');
  const registry = createToolRegistry(memoryTools({ ledger, agentId: 'synthetic-agent', clock: fixedClock }));
  return { ledger, run: (name, args) => executeTool(registry, name, args) };
}

test('every kit builds a valid registry', async t => {
  const { directory, ledger } = await ledgerIn(t, 'fieldwork-agent-all-', 'synthetic-all');
  const archiveDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-agent-conversations-'));
  const archive = await createConversationArchive(path.join(archiveDirectory, 'conversation.jsonl'), { archiveId: 'synthetic-conversations' });
  t.after(async () => { await archive.close(); await fs.rm(archiveDirectory, { recursive: true, force: true }); });
  const registry = createToolRegistry([
    ...memoryTools({ ledger, agentId: 'synthetic-agent', conversationArchive: archive }),
    ...await notebookTools({ root: path.join(directory, 'workspace') }),
    ...clockTools({ timeZone: 'UTC' }),
    ...webTools({ transport: async () => {} }),
  ]);
  assert.deepEqual([...registry.names].sort(), [
    'forget', 'inspect_memory', 'list_files', 'read_file', 'read_web_page', 'recall', 'remember', 'review_due_memories', 'revise_memory',
    'search_conversations', 'update_memory_lifecycle', 'what_time_is_it', 'write_file',
  ]);
  const memorySummary = prepareToolCall(registry, 'remember', { text: 'PRIVATE SYNTHETIC MEMORY BODY' }).permissionSummary;
  assert.match(memorySummary, /fact memory/);
  assert.doesNotMatch(memorySummary, /PRIVATE SYNTHETIC MEMORY BODY/);
  const fileSummary = prepareToolCall(registry, 'write_file', {
    path: 'notes/orchard.md', text: 'PRIVATE SYNTHETIC NOTEBOOK BODY', mode: 'append',
  }).permissionSummary;
  assert.match(fileSummary, /Append to notebook file notes\/orchard\.md/);
  assert.doesNotMatch(fileSummary, /PRIVATE SYNTHETIC NOTEBOOK BODY/);
});

test('remember, recall, revise, and forget keep the full lineage in the ledger', async t => {
  const { ledger, run } = await memoryKit(t);
  const { id } = await run('remember', { text: 'The operator likes moss gardens.' });
  assert.match(id, /^memory:/);
  let found = await run('recall', { query: 'moss' });
  assert.equal(found.returned, 1);
  assert.equal(found.memories[0].text, 'The operator likes moss gardens.');
  assert.equal(found.memories[0].author, 'agent');
  assert.equal(found.memories[0].basis, 'self-authored');

  await run('revise_memory', { id, text: 'The operator likes moss and fern gardens.', reason: 'They mentioned ferns too.' });
  let inspected = await run('inspect_memory', { id, history: true });
  assert.equal(inspected.active, true);
  assert.equal(inspected.state, 'current');
  assert.equal(inspected.record.text, 'The operator likes moss and fern gardens.');
  assert.equal(inspected.record.fingerprint, inspected.revisions[0].record.fingerprint);
  assert.deepEqual(inspected.revisions.map(revision => revision.state), ['current', 'superseded']);
  assert.equal(inspected.omittedRevisions, 0);
  found = await run('recall', { query: 'fern' });
  assert.equal(found.memories[0].id, id);
  const history = await run('recall', { query: 'moss', history: true });
  assert.deepEqual(history.memories.map(memory => memory.state).sort(), ['current', 'superseded']);

  const broadened = await run('recall', { query: 'favorite moss' });
  assert.equal(broadened.matched, 0);
  assert.match(broadened.broadened, /at least one/);
  assert.deepEqual(broadened.memories.map(memory => [memory.id, memory.matchedWords]), [[id, ['moss']]]);
  assert.equal((await run('recall', { query: 'favorite' })).returned, 0);

  await run('forget', { id, reason: 'Testing forgetting.' });
  assert.equal((await run('recall', { query: 'moss' })).returned, 0);
  inspected = await run('inspect_memory', { id });
  assert.equal(inspected.active, false);
  assert.equal(inspected.state, 'retracted');
  assert.equal(inspected.record.text, 'The operator likes moss and fern gardens.');
  const entry = await ledger.get(id);
  assert.equal(entry.active, false);
  assert.equal(entry.revisions.length, 2);
  await assert.rejects(run('forget', { id, reason: 'again' }), /already forgotten/);
  await assert.rejects(run('revise_memory', { id, text: 'x', reason: 'y' }), /forgotten/);
  await assert.rejects(run('forget', { id: 'memory:nope', reason: 'y' }), /No memory has that id/);
});

test('memory tools distinguish facts, reminders, obligations, verdicts, and clock gates', async t => {
  const { ledger, run } = await memoryKit(t);
  const future = await run('remember', {
    text: 'The synthetic orchid should be checked after December begins.',
    type: 'reminder',
    not_before: '2026-12-01T00:00:00.000Z',
  });
  assert.equal(future.lifecycle.type, 'reminder');
  assert.equal(future.status.phase, 'scheduled');
  assert.equal((await run('recall', { query: 'synthetic orchid' })).returned, 0);
  const futureHistory = await run('recall', { query: 'synthetic orchid', history: true });
  assert.equal(futureHistory.memories[0].status.phase, 'scheduled');
  assert.equal((await run('review_due_memories', {})).returned, 0);

  const opened = await run('update_memory_lifecycle', {
    id: future.id,
    reason: 'The synthetic review window opened.',
    type: 'obligation',
    not_before: '2026-11-01T12:00:00.000Z',
  });
  assert.equal(opened.lifecycle.type, 'obligation');
  assert.deepEqual(opened.status.attention, ['ready']);
  let due = await run('review_due_memories', { query: 'synthetic orchid' });
  assert.equal(due.returned, 1);
  assert.equal(due.memories[0].lifecycle.type, 'obligation');

  await run('revise_memory', {
    id: future.id,
    text: 'The synthetic orchid check is an explicitly chosen obligation.',
    reason: 'Clarified the commitment without changing its clock.',
  });
  const revised = await run('recall', { query: 'orchid obligation' });
  assert.equal(revised.memories[0].lifecycle.type, 'obligation');
  assert.equal(revised.memories[0].lifecycle.notBefore, '2026-11-01T12:00:00.000Z');

  const verdict = await run('remember', {
    text: 'The synthetic account is currently not useful.',
    type: 'verdict',
    expires_at: '2026-10-31T00:00:00.000Z',
    evidence: 'Three synthetic visits had no relevant changes.',
    change_criteria: 'A new relevant change appears.',
    review_prompt: 'Has a relevant change appeared?',
  });
  assert.equal(verdict.status.phase, 'expired');
  assert.equal((await run('recall', { query: 'account' })).returned, 0);
  due = await run('review_due_memories', {});
  assert.deepEqual(due.memories.map(memory => memory.id).sort(), [future.id, verdict.id].sort());

  await assert.rejects(run('remember', {
    text: 'Incomplete synthetic verdict.', type: 'verdict', review_at: '2026-12-01T00:00:00.000Z',
  }), /must state their evidence/);
  await assert.rejects(run('update_memory_lifecycle', {
    id: future.id, reason: 'Contradictory edit.', not_before: '2026-12-01T00:00:00.000Z', clear: ['not_before'],
  }), /cannot be supplied and cleared/);

  const entry = await ledger.get(future.id);
  assert.equal(entry.revisions.length, 3, 'the original reminder, lifecycle change, and text revision all remain inspectable');
});

test('recall prefers subject-matching memories written in the requested calendar range', async t => {
  const { ledger } = await ledgerIn(t, 'fieldwork-agent-memory-time-', 'synthetic-memory-time');
  const instants = [
    '2026-10-30T12:00:00.000Z',
    '2026-10-31T12:00:00.000Z',
    '2026-11-01T12:00:00.000Z',
  ];
  let clockCalls = 0;
  const clock = () => new Date(instants[Math.min(clockCalls++, instants.length - 1)]);
  const registry = createToolRegistry(memoryTools({ ledger, agentId: 'synthetic-agent', clock, timeZone: 'UTC' }));
  const run = (name, args) => executeTool(registry, name, args);
  const older = await run('remember', { text: 'The cobalt gate uses the older brass latch.' });
  const yesterday = await run('remember', { text: 'The cobalt gate uses the newer blue latch.' });

  const found = await run('recall', { query: 'cobalt gate', when: 'yesterday' });
  assert.equal(found.when.basis, 'memory-record-createdAt');
  assert.deepEqual(found.when.interpretation.ranges, [{
    from: '2026-10-31T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z',
    kind: 'day', relation: 'yesterday',
  }]);
  assert.equal(found.when.returnedMatching, 1);
  assert.deepEqual(found.memories.map(memory => [memory.id, memory.matchesWhen]), [
    [yesterday.id, true],
    [older.id, false],
  ]);
  await assert.rejects(run('recall', { query: 'cobalt', when: 'sometime soon' }), /when must name a calendar date/);
});

test('the notebook writes, appends, lists, and reads inside its root', async t => {
  const root = path.join(await temporary(t, 'fieldwork-agent-notebook-'), 'workspace');
  const registry = createToolRegistry(await notebookTools({ root }));
  const run = (name, args) => executeTool(registry, name, args);
  await run('write_file', { path: 'ideas/plants.md', text: '# Plants\n' });
  await run('write_file', { path: 'ideas/plants.md', text: 'moss\n', mode: 'append' });
  assert.equal((await run('list_files', { path: 'ideas/' })).entries[0].name, 'plants.md', 'a trailing slash still names the folder');
  assert.equal(await fs.readFile(path.join(root, 'ideas', 'plants.md'), 'utf8'), '# Plants\nmoss\n');
  assert.deepEqual((await run('list_files', {})).entries, [{ name: 'ideas/', kind: 'folder' }]);
  const listed = await run('list_files', { path: 'ideas' });
  assert.equal(listed.entries[0].name, 'plants.md');
  const read = await run('read_file', { path: 'ideas/plants.md' });
  assert.equal(read.text, '# Plants\nmoss\n');
  assert.ok(!('nextOffset' in read));
  assert.deepEqual((await fs.readdir(path.join(root, 'ideas'))), ['plants.md'], 'no temporary files remain');
});

test('the notebook refuses escapes, hidden names, and symbolic links', async t => {
  const base = await temporary(t, 'fieldwork-agent-escape-');
  const root = path.join(base, 'workspace');
  const registry = createToolRegistry(await notebookTools({ root }));
  const run = (name, args) => executeTool(registry, name, args);
  for (const bad of ['../outside.md', '/etc/passwd', 'C:\\x.md', 'a/../../b.md', '.secret', 'ideas/.git/config', 'a\\b.md']) {
    await assert.rejects(run('write_file', { path: bad, text: 'x' }), /path/, bad);
  }
  await assert.rejects(run('read_file', { path: 'missing.md' }), /No file at that path/);
  await fs.writeFile(path.join(base, 'secret.txt'), 'outside');
  try { await fs.symlink(path.join(base, 'secret.txt'), path.join(root, 'link.txt')); }
  catch (error) { t.skip(`symbolic links unavailable: ${error.code}`); return; }
  await assert.rejects(run('read_file', { path: 'link.txt' }), /symbolic link/);
  await assert.rejects(run('write_file', { path: 'link.txt', text: 'overwrite' }), /symbolic link/);
  assert.equal(await fs.readFile(path.join(base, 'secret.txt'), 'utf8'), 'outside');
});

test('long notebook files read in pages', async t => {
  const root = path.join(await temporary(t, 'fieldwork-agent-pages-'), 'workspace');
  const registry = createToolRegistry(await notebookTools({ root }));
  await fs.writeFile(path.join(root, 'long.txt'), 'é'.repeat(25_000));
  const first = await executeTool(registry, 'read_file', { path: 'long.txt' });
  assert.equal([...first.text].length, 20_000);
  assert.equal(first.nextOffset, 20_000);
  const second = await executeTool(registry, 'read_file', { path: 'long.txt', offset: first.nextOffset });
  assert.equal([...second.text].length, 5000);
  assert.ok(!('nextOffset' in second));
});

test('the clock reports the injected time in the configured zone', async () => {
  const registry = createToolRegistry(clockTools({ clock: fixedClock, timeZone: 'America/Chicago' }));
  const now = await executeTool(registry, 'what_time_is_it', {});
  assert.equal(now.iso, '2026-11-01T12:00:00.000Z');
  assert.equal(now.timeZone, 'America/Chicago');
  assert.match(now.local, /Sunday, November 1, 2026/);
  assert.throws(() => clockTools({ timeZone: 'Not/AZone' }), /not a valid IANA/);
});

test('private and loopback addresses are recognized, including canonical IPv4-mapped IPv6', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', 'fd00::1', 'fe80::1', 'fec0::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:6440:1',
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700::1111', '::ffff:5db8:d822', '::ffff:93.184.216.34']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('pinned web request options preserve the origin authority and TLS identity', () => {
  const secure = pinnedWebRequestOptions(new URL('https://public.test:8443/a?b=1'), '93.184.216.34', 4);
  assert.equal(secure.hostname, '93.184.216.34');
  assert.equal(secure.family, 4);
  assert.equal(secure.port, '8443');
  assert.equal(secure.path, '/a?b=1');
  assert.equal(secure.headers.host, 'public.test:8443');
  assert.equal(secure.servername, 'public.test');
  assert.equal(secure.rejectUnauthorized, true);
  assert.equal(secure.headers['accept-encoding'], 'identity');
  assert.equal(secure.agent, false);

  const literal = pinnedWebRequestOptions(new URL('http://[2606:4700::1111]/x'), '2606:4700::1111', 6);
  assert.equal(literal.hostname, '2606:4700::1111');
  assert.equal(literal.headers.host, '[2606:4700::1111]');
  assert.ok(!('servername' in literal));
});

test('the default web transport opens the validated numeric address, not the DNS name', async t => {
  let options;
  t.mock.method(http, 'request', (received, callback) => {
    options = received;
    const response = Readable.from([Buffer.from('pinned body')]);
    response.statusCode = 200;
    response.headers = { 'content-type': 'text/plain' };
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => callback(response));
    return request;
  });
  const registry = createToolRegistry(webTools({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  }));
  const page = await executeTool(registry, 'read_web_page', { url: 'http://public.test:8080/path?q=1' });
  assert.equal(page.text, 'pinned body');
  assert.equal(options.hostname, '93.184.216.34');
  assert.equal(options.headers.host, 'public.test:8080');
  assert.equal(options.path, '/path?q=1');
  assert.equal(options.agent, false);
});

test('the default web transport destroys protocol upgrades', async t => {
  let responseDestroyed = false;
  let socketDestroyed = false;
  t.mock.method(http, 'request', (_options, _callback) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = Readable.from([]);
      response.statusCode = 101;
      response.headers = {};
      const destroy = response.destroy.bind(response);
      response.destroy = (...args) => { responseDestroyed = true; return destroy(...args); };
      request.emit('upgrade', response, { destroy: () => { socketDestroyed = true; } });
    });
    return request;
  });
  const registry = createToolRegistry(webTools({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  }));
  await assert.rejects(executeTool(registry, 'read_web_page', { url: 'http://upgrade.test/' }), /switched protocols/);
  assert.equal(responseDestroyed, true);
  assert.equal(socketDestroyed, true);
});

test('html becomes readable text without scripts or styles', () => {
  const text = htmlToText('<html><head><title>T</title><style>p{}</style></head><body><h1>Moss</h1><script>evil()</script><p>Grows &amp; spreads&#33;</p><ul><li>one</li><li>two</li></ul></body></html>');
  assert.equal(text, 'Moss\nGrows & spreads!\n\n• one\n• two');
});

test('read_web_page reads public pages and re-checks every redirect', async () => {
  const lookup = async host => [{ address: host === 'evil.test' ? '127.0.0.1' : '93.184.216.34', family: 4 }];
  const seen = [];
  const transport = async (url, pinned) => {
    seen.push({ url: String(url), address: pinned.address, family: pinned.family });
    if (String(url) === 'https://public.test/start') return webResponse(null, { status: 302, headers: { location: '/page' } });
    if (String(url) === 'https://public.test/page') {
      return webResponse('<title>Moss Facts</title><p>Moss has no roots.</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (String(url) === 'https://public.test/bounce') return webResponse(null, { status: 301, headers: { location: 'http://evil.test/admin' } });
    throw new Error(`unexpected ${url}`);
  };
  const registry = createToolRegistry(webTools({ transport, lookup }));
  const page = await executeTool(registry, 'read_web_page', { url: 'https://public.test/start#frag' });
  assert.equal(page.url, 'https://public.test/page');
  assert.equal(page.title, 'Moss Facts');
  assert.match(page.text, /Moss has no roots\./);
  assert.deepEqual(seen.slice(0, 2), [
    { url: 'https://public.test/start', address: '93.184.216.34', family: 4 },
    { url: 'https://public.test/page', address: '93.184.216.34', family: 4 },
  ]);
  await assert.rejects(executeTool(registry, 'read_web_page', { url: 'https://public.test/bounce' }), /private network/);
  await assert.rejects(executeTool(registry, 'read_web_page', { url: 'http://127.0.0.1:11434/' }), /private network/);
  await assert.rejects(executeTool(registry, 'read_web_page', { url: 'file:///etc/passwd' }), /http or https/);
  assert.ok(!seen.some(entry => entry.url.includes('evil.test')), 'the private redirect target was never requested');
});

test('read_web_page rejects normalized mapped-private literals and unsafe DNS answer sets before requesting', async () => {
  let requests = 0;
  const transport = async () => {
    requests++;
    return webResponse('unexpected');
  };
  const privateAnswers = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '::ffff:7f00:1', family: 6 },
  ];
  const registry = createToolRegistry(webTools({ transport, lookup: privateAnswers }));
  for (const url of [
    'http://[::ffff:127.0.0.1]:11434/',
    'http://[::ffff:7f00:1]:11434/',
    'http://127.1/',
    'http://0x7f000001/',
    'http://2130706433/',
    'https://mixed.test/',
  ]) {
    await assert.rejects(executeTool(registry, 'read_web_page', { url }), /private network/, url);
  }
  assert.equal(requests, 0);
});

test('read_web_page hands the transport one validated DNS snapshot per hop', async () => {
  let lookups = 0;
  const pins = [];
  const lookup = async () => {
    lookups++;
    return [{ address: lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
  };
  const transport = async (url, pinned) => {
    pins.push({ url: String(url), address: pinned.address });
    return webResponse('safe snapshot', { headers: { 'content-type': 'text/plain' } });
  };
  const registry = createToolRegistry(webTools({ transport, lookup }));
  const page = await executeTool(registry, 'read_web_page', { url: 'https://rebinding.test/' });
  assert.equal(page.text, 'safe snapshot');
  assert.equal(lookups, 1);
  assert.deepEqual(pins, [{ url: 'https://rebinding.test/', address: '93.184.216.34' }]);
});

test('read_web_page falls back only within one fully validated DNS snapshot', async () => {
  let lookups = 0;
  const attempts = [];
  const registry = createToolRegistry(webTools({
    lookup: async () => {
      lookups++;
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ];
    },
    transport: async (_url, pinned) => {
      attempts.push(pinned.address);
      if (attempts.length === 1) throw new Error('synthetic route failure');
      return webResponse('fallback stayed public', { headers: { 'content-type': 'text/plain' } });
    },
  }));
  const page = await executeTool(registry, 'read_web_page', { url: 'https://fallback.test/' });
  assert.equal(page.text, 'fallback stayed public');
  assert.equal(lookups, 1);
  assert.deepEqual(attempts, ['93.184.216.34', '2606:4700::1111']);
});

test('read_web_page cancellation during DNS prevents a late request', async () => {
  let releaseLookup;
  let requests = 0;
  const lookup = () => new Promise(resolve => { releaseLookup = resolve; });
  const transport = async () => {
    requests++;
    return webResponse('too late');
  };
  const registry = createToolRegistry(webTools({ transport, lookup }));
  const controller = new AbortController();
  const pending = executeTool(registry, 'read_web_page', { url: 'https://slow-dns.test/' }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('synthetic stop'));
  await assert.rejects(pending, /synthetic stop/);
  releaseLookup([{ address: '93.184.216.34', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
});

test('read_web_page refuses binary content and reports HTTP errors', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const responses = [
    webResponse('PNG', { headers: { 'content-type': 'image/png' } }),
    webResponse('nope', { status: 404, headers: { 'content-type': 'text/html' } }),
  ];
  const registry = createToolRegistry(webTools({ transport: async () => responses.shift(), lookup }));
  await assert.rejects(executeTool(registry, 'read_web_page', { url: 'https://public.test/a.png' }), /image\/png, not a text page/);
  await assert.rejects(executeTool(registry, 'read_web_page', { url: 'https://public.test/missing' }), /HTTP 404/);
});

test('read_web_page keeps exactly the byte cap and destroys an oversized body', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const exact = Readable.from([Buffer.alloc(AGENT_TOOL_LIMITS.webBytes, 0x61)]);
  const exactRegistry = createToolRegistry(webTools({
    lookup,
    transport: async () => ({
      status: 200,
      header: name => name === 'content-type' ? 'text/plain' : null,
      body: exact,
      cancel: () => exact.destroy(),
    }),
  }));
  const complete = await executeTool(exactRegistry, 'read_web_page', { url: 'https://exact.test/' });
  assert.ok(!('truncated' in complete));

  let cancelled = false;
  const oversized = Readable.from([Buffer.alloc(AGENT_TOOL_LIMITS.webBytes, 0x61), Buffer.from('b')]);
  const oversizedRegistry = createToolRegistry(webTools({
    lookup,
    transport: async () => ({
      status: 200,
      header: name => name === 'content-type' ? 'text/plain' : null,
      body: oversized,
      cancel: () => { cancelled = true; oversized.destroy(); },
    }),
  }));
  const cut = await executeTool(oversizedRegistry, 'read_web_page', { url: 'https://oversized.test/' });
  assert.match(cut.truncated, new RegExp(String(AGENT_TOOL_LIMITS.webBytes)));
  assert.equal(cancelled, true);
});
