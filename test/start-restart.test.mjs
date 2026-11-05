import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPortableAgent } from '../src/agent-portability.mjs';
import { STATE_TRANSACTION_LOCK_FORMAT } from '../src/cooperative-state-lock.mjs';
import { canonicalJson } from '../src/json-data.mjs';
import { DURABLE_WRITER_LOCK_FORMAT } from '../src/stale-state-locks.mjs';
import { createToolEffectStore } from '../src/tool-effects.mjs';
import { createToolGroupSettings, NEW_AGENT_TOOL_GROUP_MODES, startingToolGroupModes } from '../src/tool-groups.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitUntil(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function staleLockSource(format, pid) {
  return `${canonicalJson({
    format,
    token: randomUUID(),
    pid,
    createdAt: '2030-01-02T03:04:05.000Z',
  })}\n`;
}

async function exitedProcessId() {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  await once(child, 'exit');
  for (const candidate of [pid, 2_147_483_647, 2_147_483_646]) {
    try { process.kill(candidate, 0); }
    catch (error) {
      if (error?.code === 'ESRCH') return candidate;
      throw error;
    }
  }
  throw new Error('the stale-lock fixture could not find a definitely absent local process id');
}

test('browser launcher exposes and retries live bridge bindings without losing archive fences', async () => {
  const source = await fs.readFile(path.join(repo, 'scripts', 'browser-chat.mjs'), 'utf8');
  assert.match(source, /const bridgeManager = bridgeSettings\s*\?\s*\{/);
  assert.match(source, /createBridgeBindingCoordinator\(\{[\s\S]*?bindBridgeConversation\(bridgeSettingsFile, request\)/);
  assert.match(source, /async snapshot\(\) \{[\s\S]*?await bridgeBindings\.drain\(\);[\s\S]*?live-unsaved[\s\S]*?ensureBridgeBinding\(platform\)[\s\S]*?settingsWithLiveBridgeBindings\(\)/);
  assert.equal((source.match(/conversationId: liveRoute\.conversationId/g) ?? []).length, 2);
  assert.match(source, /ensureBridgeBinding\('telegram'\)[\s\S]*?bridgeBindings\.adopt\('telegram', response\.conversationId\);[\s\S]*?ensureBridgeBinding\('telegram'\)/);
  assert.match(source, /ensureBridgeBinding\('discord'\)[\s\S]*?bridgeBindings\.adopt\('discord', response\.conversationId\);[\s\S]*?ensureBridgeBinding\('discord'\)/);
  assert.match(source, /const checkInBridge = bridgeBindings[\s\S]*?proactiveTarget\(platform\)[\s\S]*?binding\.state !== 'saved'/);
  assert.match(source, /async deliverProactive\(input\)[\s\S]*?await loadBridgeSettings\(bridgeSettingsFile\)[\s\S]*?route\.conversationId !== input\.conversationId/);
  assert.match(source, /input\.sourceMessageId !== input\.output\?\.source\?\.messageId/);
  assert.match(source, /checkIns && checkInBridge \? \{ checkInBridge \} : \{\}/);
});

async function within(promise, timeout, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a failed first launch saves light tool modes before its new ledgers make the retry look established', { timeout: 20_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-first-launch-tools-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const agentHome = path.join(directory, 'agent');
  await fs.cp(path.join(repo, 'templates', 'agent-home'), agentHome, { recursive: true });
  const stateDir = path.join(agentHome, 'state');
  await fs.mkdir(stateDir, { recursive: true });
  // This fails after the launcher has opened its ledgers, but before the room
  // can start. The new-agent tool choice must already be durable by then.
  await fs.writeFile(path.join(stateDir, 'guides.json'), '{not valid json');

  const childEnvironment = { ...process.env, FIELDWORK_NO_BROWSER: '1' };
  delete childEnvironment.FIELDWORK_API_KEY;
  const child = spawn(process.execPath, [
    path.join(repo, 'scripts', 'browser-chat.mjs'),
    '--agent-home', agentHome,
    '--base-url', 'http://127.0.0.1:1/v1',
    '--model', 'synthetic/first-launch',
    '--port', String(await unusedPort()),
  ], {
    cwd: repo,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });

  const [code] = await within(once(child, 'exit'), 10_000, `failed first launch did not exit:\n${output}`);
  assert.equal(code, 1, `malformed guide state unexpectedly started a room:\n${output}`);
  for (const name of ['memory.jsonl', 'conversation.jsonl']) {
    assert.equal((await fs.stat(path.join(stateDir, name))).isFile(), true, `${name} proves store initialization began`);
  }
  const saved = JSON.parse(await fs.readFile(path.join(stateDir, 'tool-groups.json'), 'utf8'));
  assert.deepEqual(saved.modes, { ...NEW_AGENT_TOOL_GROUP_MODES });
  assert.equal(await startingToolGroupModes(stateDir), null, 'the created ledgers make a later detector see established state');
  const reopened = await createToolGroupSettings({ file: path.join(stateDir, 'tool-groups.json') });
  assert.deepEqual({ ...reopened.modes() }, { ...NEW_AGENT_TOOL_GROUP_MODES }, 'the saved first-launch choice wins on retry');
});

async function lifecycleRequest(origin, token, route, body = {}) {
  const response = await fetch(`${origin}${route}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin,
      'x-fieldwork-token': token,
    },
    body: JSON.stringify(body),
  });
  return { response, value: await response.json() };
}

async function bootstrap(origin, token) {
  const response = await fetch(`${origin}/api/bootstrap`, { headers: { 'x-fieldwork-token': token } });
  return { response, value: await response.json() };
}

function firstJsonlEvent(text) {
  return JSON.parse(text.split(/\r?\n/u).find(Boolean));
}

async function temporaryRoomForPid(pid) {
  for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('fieldwork-browser-chat-')) continue;
    const directory = path.join(os.tmpdir(), entry.name);
    try {
      const lock = JSON.parse(await fs.readFile(path.join(directory, 'tool-effects.jsonl.lock'), 'utf8'));
      if (lock.pid === pid) return directory;
    } catch { /* A different temporary room may be opening or closing. */ }
  }
  return null;
}

test('temporary launcher lets an active effect run settle before deleting its room', { timeout: 60_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-active-close-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const agentHome = path.join(directory, 'agent');
  await fs.cp(path.join(repo, 'templates', 'agent-home'), agentHome, { recursive: true });

  let providerCalls = 0;
  const providerSockets = new Set();
  const provider = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      providerCalls++;
      request.resume();
      // Keep the model call open until browser shutdown aborts its active run.
      response.on('error', () => {});
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  provider.on('connection', socket => {
    providerSockets.add(socket);
    socket.once('close', () => providerSockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    for (const socket of providerSockets) socket.destroy();
    provider.close(() => resolve());
  }));

  const childEnvironment = { ...process.env, FIELDWORK_NO_BROWSER: '1' };
  delete childEnvironment.FIELDWORK_API_KEY;
  const child = spawn(process.execPath, [
    path.join(repo, 'scripts', 'browser-chat.mjs'),
    '--agent-home', agentHome,
    '--base-url', `http://127.0.0.1:${provider.address().port}/v1`,
    '--model', 'synthetic/active-close',
    '--port', String(await unusedPort()),
    '--temporary',
  ], {
    cwd: repo,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await within(exited, 5_000, `temporary room could not be killed:\n${stdout}\n${stderr}`);
    }
  });

  await waitUntil(() => /^Open Fieldwork: \S+$/m.test(stdout), `temporary room did not start:\n${stdout}\n${stderr}`);
  const launch = stdout.match(/^Open Fieldwork: (\S+)$/m)[1];
  const page = new URL(launch);
  const token = new URLSearchParams(page.hash.slice(1)).get('token');
  const runtime = await (async () => {
    let found = null;
    await waitUntil(async () => {
      found = await temporaryRoomForPid(child.pid);
      return Boolean(found);
    }, `temporary room state was not found:\n${stdout}\n${stderr}`);
    return found;
  })();

  const activeChat = fetch(`${page.origin}/api/chat`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: page.origin,
      'x-fieldwork-token': token,
    },
    body: JSON.stringify({ text: 'Keep this model turn open until shutdown.' }),
  }).then(response => response.text()).catch(error => error);
  await waitUntil(() => providerCalls === 1, `active turn never reached the provider:\n${stdout}\n${stderr}`);

  const exited = once(child, 'exit');
  const stopping = await lifecycleRequest(page.origin, token, '/api/shutdown');
  assert.deepEqual([stopping.response.status, stopping.value.stopping], [200, true]);
  const [exitCode] = await within(exited, 10_000, `temporary room shutdown hung:\n${stdout}\n${stderr}`);
  await within(activeChat, 5_000, `active chat connection remained open after shutdown:\n${stdout}\n${stderr}`);
  assert.equal(exitCode, 0, `temporary room did not close cleanly:\n${stdout}\n${stderr}`);
  await assert.rejects(
    fs.access(runtime),
    error => error?.code === 'ENOENT',
    'the active run should settle during browser close, allowing normal temporary cleanup',
  );
});

test('the launcher preserves room choices across restart and supervises separate agents', { timeout: 90_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-restart-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let providerAuthorization = null;
  const provider = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      providerAuthorization = request.headers.authorization ?? null;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [
        { id: 'synthetic/alpha', name: 'Alpha' },
        { id: 'synthetic/beta', name: 'Beta' },
      ] }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve())));
  const providerPort = provider.address().port;
  const agentHome = path.join(directory, 'agent');
  await fs.cp(path.join(repo, 'templates', 'agent-home'), agentHome, { recursive: true });
  const seededState = path.join(agentHome, 'state');
  const seededToolEffectFile = path.join(seededState, 'tool-effects.jsonl');
  await fs.mkdir(seededState, { recursive: true });
  const seededToolEffects = await createToolEffectStore(seededToolEffectFile, { id: 'fieldwork-tool-effects' });
  const seededRun = await seededToolEffects.beginRun({ runId: 'run-before-launch', origin: 'local-chat' });
  const seededOrphan = await seededToolEffects.prepare({
    run: seededRun,
    tool: 'tell_my_builder',
    argumentsSha256: 'a'.repeat(64),
    summary: 'Leave a synthetic note before launcher recovery.',
    permission: { mode: 'always', reason: 'policy-always' },
    callIdHash: 'b'.repeat(64),
  });
  await seededToolEffects.beginAttempt({
    run: seededRun,
    actionId: seededOrphan.actionId,
    expectedRevision: seededOrphan.revision,
  });
  await seededToolEffects.forceClose();
  const stalePid = await exitedProcessId();
  const seededLocks = [
    [`${seededToolEffectFile}.lock`, DURABLE_WRITER_LOCK_FORMAT],
    ...['check-ins.json.lock', 'task-heartbeats.json.lock', 'outside-readers.json.lock']
      .map(name => [path.join(seededState, name), STATE_TRANSACTION_LOCK_FORMAT]),
  ];
  const seededLockSources = new Map();
  for (const [file, format] of seededLocks) {
    const source = staleLockSource(format, stalePid);
    seededLockSources.set(file, source);
    await fs.writeFile(file, source);
  }
  const settingsFile = path.join(directory, 'settings.json');
  await fs.writeFile(settingsFile, `${JSON.stringify({
    agentHome,
    baseURL: `http://127.0.0.1:${providerPort}/v1`,
    model: 'synthetic/alpha',
    tools: '',
    port: await unusedPort(),
  })}\n`);

  const childEnvironment = { ...process.env, FIELDWORK_SETTINGS: settingsFile, FIELDWORK_NO_BROWSER: '1' };
  delete childEnvironment.FIELDWORK_API_KEY;
  const child = spawn(process.execPath, [path.join(repo, 'scripts', 'start.mjs')], {
    cwd: repo,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });

  await waitUntil(() => /^Open Fieldwork: \S+$/m.test(stdout), `room did not start:\n${stdout}\n${stderr}`);
  assert.match(stdout, /safely recovered stale state locks:/);
  for (const [file, format] of seededLocks) {
    assert.match(stdout, new RegExp(path.basename(file).replaceAll('.', '\\.')));
    if (format === DURABLE_WRITER_LOCK_FORMAT) {
      const reopened = await fs.readFile(file, 'utf8');
      assert.notEqual(reopened, seededLockSources.get(file), 'the stale durable lock was replaced by the live room owner');
      const metadata = JSON.parse(reopened);
      assert.equal(metadata.format, DURABLE_WRITER_LOCK_FORMAT);
      assert.notEqual(metadata.pid, stalePid);
    } else {
      await assert.rejects(fs.access(file), { code: 'ENOENT' });
    }
    await assert.rejects(fs.access(`${file}.recovery`), { code: 'ENOENT' });
  }
  const migratedSettings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(migratedSettings.service, 'openai-compatible', 'legacy settings gain the explicit service discriminator');
  const launch = stdout.match(/^Open Fieldwork: (\S+)$/m)[1];
  const page = new URL(launch);
  const token = new URLSearchParams(page.hash.slice(1)).get('token');
  const origin = page.origin;

  let boot = await bootstrap(origin, token);
  assert.equal(boot.response.status, 200);
  assert.equal(boot.value.model.current, 'synthetic/alpha');
  assert.equal(boot.value.model.persistent, true);
  assert.equal(boot.value.toolRecovery.count, 1);
  assert.equal(boot.value.toolRecovery.items[0].id, seededOrphan.actionId);
  assert.equal(boot.value.toolRecovery.items[0].state, 'attempted-unsettled');
  const originalAgentId = boot.value.agents.activeAgentId;
  const originalToolEffectFile = path.join(agentHome, 'state', 'tool-effects.jsonl');
  const originalToolEffects = await fs.readFile(originalToolEffectFile, 'utf8');
  assert.equal(firstJsonlEvent(originalToolEffects).toolEffectStoreId, 'fieldwork-tool-effects');
  const builderPolicy = view => view.permissions.policies.find(row => row.tool === 'tell_my_builder');
  let toolView = await lifecycleRequest(origin, token, '/api/tools/view');
  assert.equal(toolView.response.status, 200);
  assert.deepEqual(builderPolicy(toolView.value), {
    tool: 'tell_my_builder', mode: 'always', explicit: false,
    revision: 0, updatedAt: null, actor: null,
  });
  toolView = await lifecycleRequest(origin, token, '/api/tools/permission', {
    tool: 'tell_my_builder', mode: 'ask', expectedRevision: toolView.value.permissions.revision,
  });
  assert.equal(toolView.response.status, 200);
  assert.equal(builderPolicy(toolView.value).mode, 'ask');

  const appearance = await lifecycleRequest(origin, token, '/api/appearance', {
    expectedRevision: 0,
    changes: {
      palette: 'amber', density: 'relaxed',
      interfaceTypeface: 'shantell', technicalTypeface: 'cozette',
    },
  });
  assert.equal(appearance.response.status, 200);
  const model = await lifecycleRequest(origin, token, '/api/model', { id: 'synthetic/beta' });
  assert.equal(model.response.status, 200);
  assert.equal(model.value.model.current, 'synthetic/beta');
  const effort = await lifecycleRequest(origin, token, '/api/model/effort', { effort: 'high' });
  assert.equal(effort.response.status, 200);
  assert.equal(effort.value.model.effort, 'high');

  const restarted = await lifecycleRequest(origin, token, '/api/restart');
  assert.deepEqual([restarted.response.status, restarted.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 2,
    `supervisor did not relaunch the room:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try {
      const response = await bootstrap(origin, token);
      return response.response.ok && response.value.health.status === 'ready';
    } catch { return false; }
  }, `restarted room did not become ready:\n${stdout}\n${stderr}`);

  boot = await bootstrap(origin, token);
  assert.equal(boot.value.model.current, 'synthetic/beta');
  assert.equal(boot.value.model.effort, 'high');
  assert.equal(boot.value.appearance.revision, 1);
  assert.equal(boot.value.appearance.settings.palette, 'amber');
  assert.equal(boot.value.appearance.settings.interfaceTypeface, 'shantell');
  assert.equal(boot.value.appearance.settings.technicalTypeface, 'cozette');
  assert.equal(boot.value.toolRecovery.items[0].id, seededOrphan.actionId, 'restart preserves a recoverable orphan');
  toolView = await lifecycleRequest(origin, token, '/api/tools/view');
  assert.equal(builderPolicy(toolView.value).mode, 'ask', 'tool permission survives a room restart');
  const preferences = await fs.readFile(path.join(agentHome, 'state', 'room-preferences.json'), 'utf8');
  assert.doesNotMatch(preferences, /api.?key|authorization|bearer|secret/i);
  const permissionState = await fs.readFile(path.join(agentHome, 'state', 'tool-permissions.json'), 'utf8');
  assert.doesNotMatch(permissionState, /argument|result|api.?key|authorization|bearer|secret/i);
  assert.equal(
    await fs.readFile(originalToolEffectFile, 'utf8'),
    originalToolEffects,
    'a normal room restart reopens the same agent-scoped effect ledger',
  );

  const created = await lifecycleRequest(origin, token, '/api/agents/action', { action: 'create', name: 'Moss' });
  assert.deepEqual([created.response.status, created.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 3,
    `supervisor did not create and switch agent:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try { return (await bootstrap(origin, token)).value.health.status === 'ready'; } catch { return false; }
  }, `new agent room did not become ready:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  assert.equal(boot.value.agents.agents.length, 2);
  const mossAgent = boot.value.agents.agents.find(row => row.active);
  assert.equal(mossAgent.name, 'Moss');
  assert.notEqual(mossAgent.home, agentHome);
  const mossToolEffects = await fs.readFile(path.join(mossAgent.home, 'state', 'tool-effects.jsonl'), 'utf8');
  assert.equal(firstJsonlEvent(mossToolEffects).toolEffectStoreId, 'fieldwork-tool-effects');
  assert.equal(await fs.readFile(originalToolEffectFile, 'utf8'), originalToolEffects, 'agents keep separate effect ledgers');
  assert.deepEqual(boot.value.startupNotice, { kind: 'success', message: 'Created and switched to the new agent.' });
  assert.equal(boot.value.model.current, 'synthetic/alpha', 'model preferences are scoped per agent');
  assert.equal(boot.value.model.effort, null, 'reasoning-effort preferences are scoped per agent');
  assert.equal(boot.value.appearance.revision, 0, 'appearance preferences are scoped per agent');
  assert.equal(boot.value.toolRecovery.count, 0, 'a new agent does not inherit another agent effect orphan');
  toolView = await lifecycleRequest(origin, token, '/api/tools/view');
  assert.equal(builderPolicy(toolView.value).mode, 'always', 'a new agent does not inherit another agent permission');

  const switched = await lifecycleRequest(origin, token, '/api/agents/action', { action: 'switch', id: originalAgentId });
  assert.deepEqual([switched.response.status, switched.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 4,
    `supervisor did not switch back:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try {
      const current = await bootstrap(origin, token);
      return current.value.health.status === 'ready' && current.value.agents.activeAgentId === originalAgentId;
    } catch { return false; }
  }, `original agent room did not return:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  assert.equal(boot.value.model.current, 'synthetic/beta');
  assert.equal(boot.value.appearance.settings.palette, 'amber');
  assert.equal(boot.value.toolRecovery.items[0].id, seededOrphan.actionId);
  assert.deepEqual(boot.value.startupNotice, { kind: 'success', message: 'Switched agents.' });
  toolView = await lifecycleRequest(origin, token, '/api/tools/view');
  assert.equal(builderPolicy(toolView.value).mode, 'ask', 'switching back restores the original agent permission');
  assert.equal(await fs.readFile(originalToolEffectFile, 'utf8'), originalToolEffects, 'switching back reopens the original effect ledger');

  const cleared = await lifecycleRequest(origin, token, '/api/agents/action', {
    action: 'clear-state', id: originalAgentId, confirmation: 'CLEAR STATE',
  });
  assert.deepEqual([cleared.response.status, cleared.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 5,
    `supervisor did not clear and relaunch the agent state:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try { return (await bootstrap(origin, token)).value.health.status === 'ready'; } catch { return false; }
  }, `fresh state room did not become ready:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  assert.equal(boot.value.model.current, 'synthetic/alpha');
  assert.equal(boot.value.appearance.revision, 0);
  assert.equal(boot.value.toolRecovery.count, 0, 'clearing state starts a fresh effect ledger');
  toolView = await lifecycleRequest(origin, token, '/api/tools/view');
  assert.equal(builderPolicy(toolView.value).mode, 'always', 'clearing state resets tool permission to its default');
  const freshToolEffects = await fs.readFile(originalToolEffectFile, 'utf8');
  assert.equal(firstJsonlEvent(freshToolEffects).toolEffectStoreId, 'fieldwork-tool-effects');
  const stateCopy = boot.value.agentBackups.backups.find(row => row.kind === 'state');
  assert.ok(stateCopy, 'clear-state recovery copy was not projected into the room');
  assert.equal(
    await fs.readFile(path.join(stateCopy.location, 'tool-effects.jsonl'), 'utf8'),
    originalToolEffects,
    'clearing state preserves the prior effect ledger in its recovery copy',
  );
  await assert.rejects(
    fs.access(path.join(stateCopy.location, 'tool-effects.jsonl.lock')),
    error => error?.code === 'ENOENT',
    'a clean restart must not preserve the writer lock in the recovery copy',
  );

  const restored = await lifecycleRequest(origin, token, '/api/agents/action', {
    action: 'restore-state', id: originalAgentId, backupId: stateCopy.id, confirmation: 'RESTORE STATE',
  });
  assert.deepEqual([restored.response.status, restored.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 6,
    `supervisor did not restore and relaunch the agent state:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try {
      const current = await bootstrap(origin, token);
      return current.value.health.status === 'ready' && current.value.model.current === 'synthetic/beta';
    } catch { return false; }
  }, `restored state room did not become ready:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  assert.equal(boot.value.appearance.settings.palette, 'amber');
  assert.equal(boot.value.toolRecovery.items[0].id, seededOrphan.actionId, 'state restore brings back its unresolved effect');
  toolView = await lifecycleRequest(origin, token, '/api/tools/view');
  assert.equal(builderPolicy(toolView.value).mode, 'ask', 'restoring state restores the saved tool permission');
  assert.equal(
    await fs.readFile(originalToolEffectFile, 'utf8'),
    originalToolEffects,
    'restoring state restores the preserved effect ledger',
  );
  assert.equal(boot.value.startupNotice.kind, 'success');
  assert.match(boot.value.startupNotice.message, /^Restored the agent state\. Restored from:/);
  assert.match(boot.value.startupNotice.message, /Previous version backup:/);
  assert.ok(boot.value.agentBackups.backups.some(row => row.id === stateCopy.id), 'the selected recovery copy was consumed');
  assert.ok(boot.value.agentBackups.backups.filter(row => row.kind === 'state').length >= 2, 'the replaced state was not backed up');

  const existingDestination = path.join(directory, 'existing-destination');
  await fs.mkdir(existingDestination);
  const failedMove = await lifecycleRequest(origin, token, '/api/agents/action', {
    action: 'move', id: originalAgentId, destination: existingDestination,
  });
  assert.deepEqual([failedMove.response.status, failedMove.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 7,
    `supervisor did not recover from a rejected move:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try {
      const current = await bootstrap(origin, token);
      return current.response.ok && current.value.health.status === 'ready';
    } catch { return false; }
  }, `original room did not recover from a rejected move:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  assert.equal(boot.value.agents.activeAgentId, originalAgentId);
  assert.equal(boot.value.agents.agents.find(row => row.active).home, agentHome);
  assert.equal(boot.value.startupNotice.kind, 'error');
  assert.match(boot.value.startupNotice.message, /destination already exists/);
  assert.match(boot.value.startupNotice.message, /Nothing changed\. The previous room reopened\./);
  assert.deepEqual(await fs.readdir(existingDestination), []);

  const connected = await lifecycleRequest(origin, token, '/api/connection', {
    action: 'configure',
    service: 'openai-compatible',
    baseURL: `http://127.0.0.1:${providerPort}/v1`,
    model: 'synthetic/alpha',
    apiKey: 'synthetic-supervisor-key',
  });
  assert.deepEqual([connected.response.status, connected.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 8,
    `supervisor did not apply the model connection:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try { return (await bootstrap(origin, token)).value.health.status === 'ready'; } catch { return false; }
  }, `updated model connection did not become ready:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  assert.equal(boot.value.capabilities.manageConnection, true);
  assert.equal(boot.value.connection.access.source, 'saved');
  assert.equal(boot.value.health.provider.access.source, 'saved');
  assert.deepEqual(boot.value.startupNotice, {
    kind: 'success', message: 'Updated the model connection. The new connection is active now.',
  });
  const listed = await lifecycleRequest(origin, token, '/api/models');
  assert.equal(listed.response.status, 200);
  assert.equal(providerAuthorization, 'Bearer synthetic-supervisor-key');
  assert.doesNotMatch(await fs.readFile(settingsFile, 'utf8'), /synthetic-supervisor-key|apiKey/);
  assert.match(await fs.readFile(path.join(directory, 'settings.secrets.json'), 'utf8'), /synthetic-supervisor-key/);

  const portableBundle = path.join(directory, 'portable-original-agent');
  const exported = await lifecycleRequest(origin, token, '/api/agents/action', {
    action: 'export-agent', id: originalAgentId, destination: portableBundle,
  });
  assert.deepEqual([exported.response.status, exported.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 9,
    `supervisor did not export and reopen the agent:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try { return (await bootstrap(origin, token)).value.health.status === 'ready'; } catch { return false; }
  }, `room did not return after portable export:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  assert.equal(boot.value.agents.activeAgentId, originalAgentId);
  assert.equal(boot.value.startupNotice.kind, 'success');
  assert.match(boot.value.startupNotice.message, /^Exported a portable copy to /);
  const portableManifest = await fs.readFile(path.join(portableBundle, 'manifest.json'), 'utf8');
  assert.doesNotMatch(portableManifest, /synthetic-supervisor-key/);
  assert.equal(JSON.parse(portableManifest).format, 'fieldwork-portable-agent/v1');
  await assert.rejects(
    fs.access(path.join(portableBundle, 'agent', 'backups')),
    error => error?.code === 'ENOENT',
    'local recovery copies must stay out of a portable bundle',
  );

  const imported = await lifecycleRequest(origin, token, '/api/agents/action', {
    action: 'import-agent', source: portableBundle,
  });
  assert.deepEqual([imported.response.status, imported.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 10,
    `supervisor did not import and reopen the prior agent:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try {
      const current = await bootstrap(origin, token);
      return current.value.health.status === 'ready' && current.value.agents.agents.length === 3;
    } catch { return false; }
  }, `room did not return after portable import:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  assert.equal(boot.value.agents.activeAgentId, originalAgentId, 'portable import remains dormant');
  const importedAgent = boot.value.agents.agents.find(row => !row.active && row.name === 'Agent');
  assert.ok(importedAgent, 'the imported agent was not registered separately');
  assert.equal(await fs.readFile(path.join(importedAgent.home, 'roots', 'identity.md'), 'utf8'), await fs.readFile(path.join(agentHome, 'roots', 'identity.md'), 'utf8'));
  assert.match(boot.value.startupNotice.message, /Imported Agent as a separate dormant agent/);

  const openedExpert = await lifecycleRequest(origin, token, '/api/agents/action', { action: 'create-expert' });
  assert.deepEqual([openedExpert.response.status, openedExpert.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 11,
    `supervisor did not open the Fieldwork Expert:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try { return (await bootstrap(origin, token)).value.agents.agents.some(row => row.active && row.name === 'Fieldwork Expert'); }
    catch { return false; }
  }, `Fieldwork Expert room did not become ready:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  const expertAgent = boot.value.agents.agents.find(row => row.active);
  assert.equal(boot.value.agents.agents.length, 4);
  assert.deepEqual(boot.value.startupNotice, { kind: 'success', message: 'Added and switched to the Fieldwork Expert.' });
  toolView = await lifecycleRequest(origin, token, '/api/tools/view');
  assert.equal(toolView.value.groups.find(group => group.id === 'help').mode, 'resident');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(expertAgent.home, 'state', 'tool-groups.json'), 'utf8')).modes.web,
    'off',
  );

  const awayFromExpert = await lifecycleRequest(origin, token, '/api/agents/action', { action: 'switch', id: originalAgentId });
  assert.deepEqual([awayFromExpert.response.status, awayFromExpert.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 12,
    `supervisor did not switch away from the Fieldwork Expert:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try { return (await bootstrap(origin, token)).value.agents.activeAgentId === originalAgentId; }
    catch { return false; }
  }, `original agent did not return after expert test:\n${stdout}\n${stderr}`);

  await fs.rm(expertAgent.home, { recursive: true, force: true });
  const reopenedExpert = await lifecycleRequest(origin, token, '/api/agents/action', { action: 'create-expert' });
  assert.deepEqual([reopenedExpert.response.status, reopenedExpert.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 13,
    `supervisor did not reopen the Fieldwork Expert:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try { return (await bootstrap(origin, token)).value.agents.activeAgentId === expertAgent.id; }
    catch { return false; }
  }, `existing Fieldwork Expert did not return:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  assert.equal(boot.value.agents.agents.length, 4, 'opening the expert twice does not create a duplicate');
  assert.deepEqual(boot.value.startupNotice, { kind: 'success', message: 'Switched to the existing Fieldwork Expert.' });

  const clearedExpert = await lifecycleRequest(origin, token, '/api/agents/action', {
    action: 'clear-state', id: expertAgent.id, confirmation: 'CLEAR STATE',
  });
  assert.deepEqual([clearedExpert.response.status, clearedExpert.value.restarting], [200, true]);
  await waitUntil(
    () => (stdout.match(/Fieldwork is running!/g) || []).length >= 14,
    `supervisor did not reopen the cleared Fieldwork Expert:\n${stdout}\n${stderr}`,
  );
  await waitUntil(async () => {
    try { return (await bootstrap(origin, token)).value.health.status === 'ready'; }
    catch { return false; }
  }, `cleared Fieldwork Expert room did not become ready:\n${stdout}\n${stderr}`);
  boot = await bootstrap(origin, token);
  assert.equal(boot.value.agents.activeAgentId, expertAgent.id);
  assert.equal(boot.value.look.agent.name, 'Fieldwork Expert');
  assert.equal(boot.value.look.agent.icon.value, '🧭');
  assert.equal(boot.value.startupNotice.kind, 'success');
  assert.match(boot.value.startupNotice.message, /^Cleared the agent state\. Recovery backup: /);
  toolView = await lifecycleRequest(origin, token, '/api/tools/view');
  assert.equal(toolView.value.groups.find(group => group.id === 'help').mode, 'resident');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(expertAgent.home, 'state', 'tool-groups.json'), 'utf8')).modes.web,
    'off',
  );

  const stopped = await lifecycleRequest(origin, token, '/api/shutdown');
  assert.deepEqual([stopped.response.status, stopped.value.stopping], [200, true]);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);

  await fs.rm(expertAgent.home, { recursive: true, force: true });
  const recreatedLauncher = spawn(process.execPath, [path.join(repo, 'scripts', 'start.mjs')], {
    cwd: repo,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let restartedStdout = '';
  let restartedStderr = '';
  recreatedLauncher.stdout.on('data', chunk => { restartedStdout += chunk.toString('utf8'); });
  recreatedLauncher.stderr.on('data', chunk => { restartedStderr += chunk.toString('utf8'); });
  t.after(async () => {
    if (recreatedLauncher.exitCode === null) {
      recreatedLauncher.kill();
      await once(recreatedLauncher, 'exit');
    }
  });
  await waitUntil(
    () => /^Open Fieldwork: \S+$/m.test(restartedStdout),
    `registered Expert home was not recreated:\n${restartedStdout}\n${restartedStderr}`,
  );
  const restartedLaunch = restartedStdout.match(/^Open Fieldwork: (\S+)$/m)[1];
  const restartedPage = new URL(restartedLaunch);
  const restartedToken = new URLSearchParams(restartedPage.hash.slice(1)).get('token');
  await waitUntil(async () => {
    try { return (await bootstrap(restartedPage.origin, restartedToken)).value.health.status === 'ready'; }
    catch { return false; }
  }, `recreated Fieldwork Expert room did not become ready:\n${restartedStdout}\n${restartedStderr}`);
  const recreated = await bootstrap(restartedPage.origin, restartedToken);
  assert.equal(recreated.value.agents.activeAgentId, expertAgent.id);
  assert.equal(recreated.value.look.agent.name, 'Fieldwork Expert');
  assert.match(await fs.readFile(path.join(expertAgent.home, 'roots', 'identity.md'), 'utf8'), /packaged documentation/);
  const recreatedTools = await lifecycleRequest(restartedPage.origin, restartedToken, '/api/tools/view');
  assert.equal(recreatedTools.value.groups.find(group => group.id === 'help').mode, 'resident');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(expertAgent.home, 'state', 'tool-groups.json'), 'utf8')).modes.web,
    'off',
  );
  const restopped = await lifecycleRequest(restartedPage.origin, restartedToken, '/api/shutdown');
  assert.deepEqual([restopped.response.status, restopped.value.stopping], [200, true]);
  const [restartedCode] = await once(recreatedLauncher, 'exit');
  assert.equal(restartedCode, 0, restartedStderr);
});

test('a live queued-state lock fails closed with concise launcher advice', { timeout: 20_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-live-state-lock-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const agentHome = path.join(directory, 'agent');
  await fs.cp(path.join(repo, 'templates', 'agent-home'), agentHome, { recursive: true });
  const stateDir = path.join(agentHome, 'state');
  await fs.mkdir(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, 'check-ins.json.lock');
  const source = staleLockSource(STATE_TRANSACTION_LOCK_FORMAT, process.pid);
  await fs.writeFile(lockFile, source);
  const childEnvironment = { ...process.env };
  delete childEnvironment.FIELDWORK_API_KEY;
  const child = spawn(process.execPath, [
    path.join(repo, 'scripts', 'browser-chat.mjs'),
    '--agent-home', agentHome,
    '--base-url', 'http://127.0.0.1:1/v1',
    '--model', 'synthetic/alpha',
    '--port', String(await unusedPort()),
  ], {
    cwd: repo,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1, `launcher unexpectedly succeeded:\n${stdout}\n${stderr}`);
  assert.match(stderr, /This agent home's state is locked:/);
  assert.ok(stderr.includes(lockFile), stderr);
  assert.match(stderr, new RegExp(`held by process ${process.pid}, which is still running`));
  assert.match(stderr, /Do not remove a lock held by a running process/);
  assert.equal(await fs.readFile(lockFile, 'utf8'), source);
  await assert.rejects(fs.access(`${lockFile}.recovery`), { code: 'ENOENT' });
});

test('portable actions refuse unsafe legacy room bearers without affecting other agent actions', { timeout: 90_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-portable-bearer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const agentHome = path.join(directory, 'agent');
  await fs.cp(path.join(repo, 'templates', 'agent-home'), agentHome, { recursive: true });
  const importSource = path.join(directory, 'portable-import-source');
  await exportPortableAgent({ home: agentHome, agentName: 'Import Source', destination: importSource });

  const legacyBearer = path.join(agentHome, 'state', 'room-secret');
  await fs.mkdir(path.dirname(legacyBearer), { recursive: true });
  await fs.writeFile(legacyBearer, 'x'.repeat(129));

  const provider = http.createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve())));

  const settingsFile = path.join(directory, 'settings.json');
  await fs.writeFile(settingsFile, `${JSON.stringify({
    agentHome,
    service: 'openai-compatible',
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`,
    model: 'synthetic/portable-bearer',
    tools: '',
    port: await unusedPort(),
  })}\n`);

  const childEnvironment = { ...process.env, FIELDWORK_SETTINGS: settingsFile, FIELDWORK_NO_BROWSER: '1' };
  delete childEnvironment.FIELDWORK_API_KEY;
  const child = spawn(process.execPath, [path.join(repo, 'scripts', 'start.mjs')], {
    cwd: repo,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });

  await waitUntil(() => /^Open Fieldwork: \S+$/m.test(stdout), `room did not start:\n${stdout}\n${stderr}`);
  const launch = stdout.match(/^Open Fieldwork: (\S+)$/m)[1];
  const page = new URL(launch);
  const token = new URLSearchParams(page.hash.slice(1)).get('token');
  const origin = page.origin;
  let boot = await bootstrap(origin, token);
  assert.equal(boot.response.status, 200);
  const originalAgentId = boot.value.agents.activeAgentId;

  async function awaitRelaunch(count, message) {
    await waitUntil(
      () => (stdout.match(/Fieldwork is running!/g) || []).length >= count,
      `${message}:\n${stdout}\n${stderr}`,
    );
    await waitUntil(async () => {
      try {
        const current = await bootstrap(origin, token);
        return current.response.ok && current.value.health.status === 'ready';
      } catch { return false; }
    }, `room did not become ready after ${message}:\n${stdout}\n${stderr}`);
    return (await bootstrap(origin, token)).value;
  }

  const renamed = await lifecycleRequest(origin, token, '/api/agents/action', {
    action: 'rename', id: originalAgentId, name: 'Bearer Reader Negative Control',
  });
  assert.deepEqual([renamed.response.status, renamed.value.restarting], [200, true]);
  boot = { value: await awaitRelaunch(2, 'renaming with an oversized legacy bearer present') };
  assert.deepEqual(boot.value.startupNotice, { kind: 'success', message: 'Renamed the agent.' });
  assert.equal(boot.value.agents.agents.find(agent => agent.id === originalAgentId).name, 'Bearer Reader Negative Control');

  const refusedExport = path.join(directory, 'must-not-export');
  const exported = await lifecycleRequest(origin, token, '/api/agents/action', {
    action: 'export-agent', id: originalAgentId, destination: refusedExport,
  });
  assert.deepEqual([exported.response.status, exported.value.restarting], [200, true]);
  boot = { value: await awaitRelaunch(3, 'refusing an oversized legacy bearer during export') };
  assert.equal(boot.value.startupNotice.kind, 'error');
  assert.match(boot.value.startupNotice.message, /refused an unsafe room credential file/);
  assert.match(boot.value.startupNotice.message, /Nothing changed\. The previous room reopened\./);
  await assert.rejects(
    fs.access(refusedExport),
    error => error?.code === 'ENOENT',
    'the rejected export must not publish a bundle',
  );

  await fs.writeFile(legacyBearer, 'not-a-room-bearer\n');
  const imported = await lifecycleRequest(origin, token, '/api/agents/action', {
    action: 'import-agent', source: importSource,
  });
  assert.deepEqual([imported.response.status, imported.value.restarting], [200, true]);
  boot = { value: await awaitRelaunch(4, 'refusing a malformed legacy bearer during import') };
  assert.equal(boot.value.startupNotice.kind, 'error');
  assert.match(boot.value.startupNotice.message, /Room credential file has an invalid shape/);
  assert.match(boot.value.startupNotice.message, /Nothing changed\. The previous room reopened\./);
  assert.equal(boot.value.agents.agents.length, 1, 'the rejected import must not register an agent');
  assert.equal(boot.value.agents.activeAgentId, originalAgentId);
  assert.equal(JSON.parse(await fs.readFile(path.join(importSource, 'manifest.json'), 'utf8')).format, 'fieldwork-portable-agent/v1');

  await t.test('a linked legacy bearer is refused when file symlinks are available', async t => {
    await fs.unlink(legacyBearer);
    const linkedBearer = path.join(directory, 'linked-room-secret');
    await fs.writeFile(linkedBearer, `${'a'.repeat(43)}\n`);
    try {
      await fs.symlink(linkedBearer, legacyBearer, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
        t.skip(`Windows did not permit a file symlink (${error.code})`);
        return;
      }
      throw error;
    }
    const refusedLinkedExport = path.join(directory, 'must-not-export-link');
    const linked = await lifecycleRequest(origin, token, '/api/agents/action', {
      action: 'export-agent', id: originalAgentId, destination: refusedLinkedExport,
    });
    assert.deepEqual([linked.response.status, linked.value.restarting], [200, true]);
    boot = { value: await awaitRelaunch(5, 'refusing a linked legacy bearer during export') };
    assert.equal(boot.value.startupNotice.kind, 'error');
    assert.match(boot.value.startupNotice.message, /refused an unsafe room credential file/);
    await assert.rejects(
      fs.access(refusedLinkedExport),
      error => error?.code === 'ENOENT',
      'the linked bearer must not allow a portable bundle to be published',
    );
  });

  const stopped = await lifecycleRequest(origin, token, '/api/shutdown');
  assert.deepEqual([stopped.response.status, stopped.value.stopping], [200, true]);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
});
