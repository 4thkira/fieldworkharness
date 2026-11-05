import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_COMMAND_FORMAT,
  AGENT_MANAGEMENT_LIMITS,
  applyAgentCommand,
  ensureAgentHome,
  loadManagedSettings,
  loadManagedSettingsSnapshot,
  normalizeManagedSettings,
  publicAgentBackups,
  publicAgentRegistry,
  saveManagedSettings,
} from '../src/agent-management.mjs';
import { PORTABLE_AGENT_FORMAT, PORTABLE_AGENT_INCOMPLETE_MARKER } from '../src/agent-portability.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templateDir = path.join(repo, 'templates', 'agent-home');
const expertTemplateDir = path.join(repo, 'templates', 'fieldwork-expert');
const clock = () => new Date('2035-04-05T06:07:08.000Z');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-agents-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'original-agent');
  await ensureAgentHome(home, templateDir);
  const settingsFile = path.join(directory, 'fieldwork.local.json');
  const settings = await saveManagedSettings(settingsFile, {
    agentHome: home,
    service: 'openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen3.5:4b',
    tools: '',
    port: 4317,
  });
  return { directory, home, settingsFile, settings };
}

test('live managed-settings snapshots use the bounded stable-file reader', async t => {
  const data = await fixture(t);
  const snapshot = await loadManagedSettingsSnapshot(data.settingsFile);
  assert.equal(snapshot.raw.model, 'qwen3.5:4b');
  assert.equal(snapshot.settings.agentHome, data.home);

  await fs.writeFile(data.settingsFile, Buffer.alloc(AGENT_MANAGEMENT_LIMITS.settingsFileBytes + 1, 0x61));
  await assert.rejects(loadManagedSettings(data.settingsFile), /65536-byte settings limit/);
  await saveManagedSettings(data.settingsFile, data.settings);

  await t.test('a linked live settings file is refused when symlinks are available', async t => {
    const target = path.join(data.directory, 'settings-target.json');
    await fs.rename(data.settingsFile, target);
    try { await fs.symlink(target, data.settingsFile, 'file'); }
    catch (error) {
      await fs.rename(target, data.settingsFile);
      if (process.platform === 'win32' && ['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
        t.skip(`Windows did not permit a file symlink (${error.code})`);
        return;
      }
      throw error;
    }
    await assert.rejects(loadManagedSettings(data.settingsFile), /linked or is not a regular file/);
  });
});

test('a live managed-settings snapshot refuses a file replaced after opening', async () => {
  const source = Buffer.from(JSON.stringify({
    agentHome: path.join(os.tmpdir(), 'synthetic-live-agent'),
    service: 'openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'synthetic/live',
    tools: '',
    port: 4317,
  }));
  const stat = ino => ({
    dev: 1n, ino: BigInt(ino), size: BigInt(source.length), mtimeNs: 2n, ctimeNs: 3n,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const opened = stat(20);
  const replacement = stat(21);
  let pathStats = 0;
  let reads = 0;
  const handle = {
    stat: async () => opened,
    async read(buffer, offset) {
      if (reads++) return { bytesRead: 0 };
      source.copy(buffer, offset);
      return { bytesRead: source.length };
    },
    close: async () => {},
  };
  const io = {
    lstat: async () => (++pathStats === 1 ? opened : replacement),
    open: async () => handle,
  };
  await assert.rejects(
    loadManagedSettings(path.resolve('synthetic-live-settings.json'), { io }),
    /changed while it was read/,
  );
});

const command = value => ({ format: AGENT_COMMAND_FORMAT, ...value });

test('agent-home setup fills an empty directory but refuses an incomplete non-empty one', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-agent-home-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const empty = path.join(directory, 'empty');
  await fs.mkdir(empty);
  const filled = await ensureAgentHome(empty, templateDir);
  assert.equal(filled.home, path.resolve(empty));
  assert.equal(filled.created, true);
  assert.equal(filled.origin, 'empty-directory');
  assert.equal(typeof filled.identity.ino, 'string');
  assert.equal(await fs.readFile(path.join(empty, 'profile.json'), 'utf8'), await fs.readFile(path.join(templateDir, 'profile.json'), 'utf8'));
  assert.deepEqual(await ensureAgentHome(empty, templateDir), {
    home: path.resolve(empty), created: false, origin: 'existing-agent-home', identity: null,
  });

  await assert.rejects(
    ensureAgentHome(empty, templateDir, { allowExisting: false }),
    /refusing to adopt or replace an unregistered agent home/,
  );

  const incomplete = path.join(directory, 'incomplete');
  await fs.mkdir(incomplete);
  await fs.writeFile(path.join(incomplete, 'keep.txt'), 'do not merge over this');
  await assert.rejects(ensureAgentHome(incomplete, templateDir), /profile\.json is missing/);
  assert.equal(await fs.readFile(path.join(incomplete, 'keep.txt'), 'utf8'), 'do not merge over this');

  const malformedTemplate = path.join(directory, 'malformed-template');
  const failedTarget = path.join(directory, 'failed-target');
  await fs.mkdir(malformedTemplate);
  await fs.writeFile(path.join(malformedTemplate, 'partial.txt'), 'copy begins, validation fails');
  await assert.rejects(ensureAgentHome(failedTarget, malformedTemplate), /profile\.json/);
  await assert.rejects(fs.access(failedTarget), /ENOENT/);
  assert.deepEqual(
    (await fs.readdir(directory)).filter(entry => entry.startsWith('.failed-target.fieldwork-create-')),
    [],
    'a failed staged copy leaves no partial target or staging directory',
  );
  const emptyFailedTarget = path.join(directory, 'empty-failed-target');
  await fs.mkdir(emptyFailedTarget);
  await assert.rejects(ensureAgentHome(emptyFailedTarget, malformedTemplate), /profile\.json/);
  assert.deepEqual(await fs.readdir(emptyFailedTarget), [], 'a failed staged copy restores a pre-existing empty target');
});

test('legacy single-agent settings migrate, then create, rename and switch without sharing homes', async t => {
  const data = await fixture(t);
  const registry = publicAgentRegistry(data.settings);
  assert.equal(registry.agents.length, 1);
  assert.equal(registry.agents[0].home, data.home);
  assert.equal(registry.agents[0].active, true);

  const created = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'create', name: 'Moss Friend' }),
  });
  assert.equal(created.settings.activeAgentId, 'moss-friend');
  assert.equal(created.settings.agents.length, 2);
  assert.notEqual(created.settings.agentHome, data.home);
  assert.equal(await fs.readFile(path.join(created.settings.agentHome, 'profile.json'), 'utf8'), await fs.readFile(path.join(templateDir, 'profile.json'), 'utf8'));

  const renamed = await applyAgentCommand({
    settings: created.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'rename', id: 'moss-friend', name: 'Moss, Revised' }),
  });
  assert.equal(renamed.settings.agents.find(agent => agent.id === 'moss-friend').name, 'Moss, Revised');

  const originalId = renamed.settings.agents.find(agent => agent.home === data.home).id;
  const switched = await applyAgentCommand({
    settings: renamed.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'switch', id: originalId }),
  });
  assert.equal(switched.settings.agentHome, data.home);
  assert.equal(normalizeManagedSettings(JSON.parse(await fs.readFile(data.settingsFile, 'utf8'))).activeAgentId, originalId);
});

test('the optional Fieldwork Expert uses its closed preset and cleans up a failed registration', async t => {
  const data = await fixture(t);
  await assert.rejects(applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, expertTemplateDir, clock,
    command: command({ action: 'create-expert', name: 'not accepted' }),
  }), /does not accept name/);
  await assert.rejects(fs.access(path.join(data.directory, 'agents', 'fieldwork-expert')), /ENOENT/);

  const created = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, expertTemplateDir, clock,
    command: command({ action: 'create-expert' }),
  });
  assert.equal(created.settings.activeAgentId, 'fieldwork-expert');
  assert.deepEqual(created.settings.agents.find(agent => agent.id === 'fieldwork-expert'), {
    id: 'fieldwork-expert',
    name: 'Fieldwork Expert',
    home: path.join(data.directory, 'agents', 'fieldwork-expert'),
    preset: 'fieldwork-expert',
  });
  assert.match(await fs.readFile(path.join(created.settings.agentHome, 'roots', 'identity.md'), 'utf8'), /packaged documentation/);
  assert.equal(JSON.parse(await fs.readFile(path.join(created.settings.agentHome, 'state', 'tool-groups.json'), 'utf8')).modes.help, 'resident');
  assert.equal(JSON.parse(await fs.readFile(path.join(created.settings.agentHome, 'state', 'tool-groups.json'), 'utf8')).modes.web, 'off');
  assert.equal(JSON.parse(await fs.readFile(path.join(created.settings.agentHome, 'state', 'look.json'), 'utf8')).agent.name, 'Fieldwork Expert');
  assert.match(await fs.readFile(path.join(templateDir, 'roots', 'identity.md'), 'utf8'), /profile-authored content/);
  const persisted = await loadManagedSettings(data.settingsFile);
  assert.equal(persisted.agents.find(agent => agent.id === 'fieldwork-expert').preset, 'fieldwork-expert');
  assert.throws(() => normalizeManagedSettings({
    ...created.settings,
    agents: created.settings.agents.map(agent => agent.id === 'fieldwork-expert'
      ? agent
      : { ...agent, preset: 'fieldwork-expert' }),
  }), /only one Fieldwork Expert preset/);

  const original = created.settings.agents.find(agent => agent.id !== 'fieldwork-expert');
  const away = await applyAgentCommand({
    settings: created.settings, settingsFile: data.settingsFile, templateDir, expertTemplateDir, clock,
    command: command({ action: 'switch', id: original.id }),
  });
  await fs.rm(created.settings.agentHome, { recursive: true, force: true });
  const returned = await applyAgentCommand({
    settings: away.settings, settingsFile: data.settingsFile, templateDir, expertTemplateDir, clock,
    command: command({ action: 'create-expert' }),
  });
  assert.equal(returned.expertDisposition, 'existing');
  assert.equal(returned.settings.activeAgentId, 'fieldwork-expert');
  assert.equal(returned.settings.agents.length, created.settings.agents.length, 'the preset action is idempotent');
  assert.match(await fs.readFile(path.join(returned.settings.agentHome, 'roots', 'identity.md'), 'utf8'), /packaged documentation/);

  await fs.writeFile(path.join(returned.settings.agentHome, 'roots', 'identity.md'), '# replaced locally\n');
  await fs.writeFile(path.join(returned.settings.agentHome, 'state', 'tool-groups.json'), JSON.stringify({
    format: 'fieldwork-tool-groups/v3', modes: { help: 'off', web: 'resident' }, order: [],
  }));
  const reset = await applyAgentCommand({
    settings: returned.settings, settingsFile: data.settingsFile, templateDir, expertTemplateDir, clock,
    command: command({ action: 'reset-agent', id: 'fieldwork-expert', confirmation: 'RESET AGENT' }),
  });
  assert.equal(reset.settings.agents.find(agent => agent.id === 'fieldwork-expert').preset, 'fieldwork-expert');
  assert.match(await fs.readFile(path.join(reset.settings.agentHome, 'roots', 'identity.md'), 'utf8'), /packaged documentation/);
  assert.equal(JSON.parse(await fs.readFile(path.join(reset.settings.agentHome, 'state', 'tool-groups.json'), 'utf8')).modes.help, 'resident');
  assert.equal(JSON.parse(await fs.readFile(path.join(reset.settings.agentHome, 'state', 'tool-groups.json'), 'utf8')).modes.web, 'off');

  await fs.writeFile(path.join(reset.settings.agentHome, 'state', 'tool-groups.json'), JSON.stringify({
    format: 'fieldwork-tool-groups/v3',
    modes: {
      help: 'on-demand', memory: 'resident', notebook: 'resident', collections: 'on-demand', shelf: 'on-demand',
      web: 'resident', clock: 'resident', expression: 'on-demand', self: 'on-demand', other: 'on-demand',
    },
  }));
  const changedLook = JSON.parse(await fs.readFile(path.join(reset.settings.agentHome, 'state', 'look.json'), 'utf8'));
  changedLook.agent.name = 'Not the preset';
  await fs.writeFile(path.join(reset.settings.agentHome, 'state', 'look.json'), JSON.stringify(changedLook));
  const cleared = await applyAgentCommand({
    settings: reset.settings, settingsFile: data.settingsFile, templateDir, expertTemplateDir, clock,
    command: command({ action: 'clear-state', id: 'fieldwork-expert', confirmation: 'CLEAR STATE' }),
  });
  assert.ok(cleared.backup);
  assert.equal(JSON.parse(await fs.readFile(path.join(cleared.settings.agentHome, 'state', 'tool-groups.json'), 'utf8')).modes.help, 'resident');
  assert.equal(JSON.parse(await fs.readFile(path.join(cleared.settings.agentHome, 'state', 'tool-groups.json'), 'utf8')).modes.web, 'off');
  assert.equal(JSON.parse(await fs.readFile(path.join(cleared.settings.agentHome, 'state', 'look.json'), 'utf8')).agent.name, 'Fieldwork Expert');

  const malformedExpertTemplate = path.join(data.directory, 'malformed-expert-template');
  await fs.cp(expertTemplateDir, malformedExpertTemplate, { recursive: true });
  await fs.rm(path.join(malformedExpertTemplate, 'state', 'tool-groups.json'));
  const stateBeforeFailedClear = await fs.readFile(path.join(cleared.settings.agentHome, 'state', 'tool-groups.json'));
  await assert.rejects(applyAgentCommand({
    settings: cleared.settings,
    settingsFile: data.settingsFile,
    templateDir,
    expertTemplateDir: malformedExpertTemplate,
    clock,
    command: command({ action: 'clear-state', id: 'fieldwork-expert', confirmation: 'CLEAR STATE' }),
  }), /tool-groups\.json/);
  assert.deepEqual(
    await fs.readFile(path.join(cleared.settings.agentHome, 'state', 'tool-groups.json')),
    stateBeforeFailedClear,
    'a failed Expert-state seed restores the exact state that was moved aside',
  );

  const fresh = await fixture(t);
  const blockedSettings = path.join(fresh.directory, 'blocked-settings');
  await fs.mkdir(blockedSettings);
  await assert.rejects(applyAgentCommand({
    settings: fresh.settings, settingsFile: blockedSettings, templateDir, expertTemplateDir, clock,
    command: command({ action: 'create-expert' }),
  }));
  await assert.rejects(fs.access(path.join(fresh.directory, 'agents', 'fieldwork-expert')), /ENOENT/);

  const cleanupBlocked = await fixture(t);
  const cleanupBlockedSettings = path.join(cleanupBlocked.directory, 'blocked-settings');
  await fs.mkdir(cleanupBlockedSettings);
  await assert.rejects(applyAgentCommand({
    settings: cleanupBlocked.settings,
    settingsFile: cleanupBlockedSettings,
    templateDir,
    expertTemplateDir,
    clock,
    removeCreatedHome: async () => { throw new Error('synthetic cleanup refusal'); },
    command: command({ action: 'create-expert' }),
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /unregistered home/);
    assert.equal(error.errors.length, 2);
    return true;
  });
  await fs.access(path.join(cleanupBlocked.directory, 'agents', 'fieldwork-expert'));

  const occupied = await fixture(t);
  const occupiedHome = path.join(occupied.directory, 'agents', 'fieldwork-expert');
  await ensureAgentHome(occupiedHome, templateDir);
  await fs.mkdir(path.join(occupiedHome, 'workspace'), { recursive: true });
  await fs.writeFile(path.join(occupiedHome, 'workspace', 'owned-by-someone.txt'), 'keep this home');
  let occupiedCleanupCalls = 0;
  await assert.rejects(applyAgentCommand({
    settings: occupied.settings,
    settingsFile: occupied.settingsFile,
    templateDir,
    expertTemplateDir,
    clock,
    removeCreatedHome: async () => { occupiedCleanupCalls += 1; },
    command: command({ action: 'create-expert' }),
  }), /refusing to adopt or replace an unregistered agent home/);
  assert.equal(occupiedCleanupCalls, 0, 'a target this transaction did not create is never offered for rollback');
  assert.equal(await fs.readFile(path.join(occupiedHome, 'workspace', 'owned-by-someone.txt'), 'utf8'), 'keep this home');

  const occupiedEmpty = await fixture(t);
  const occupiedEmptyHome = path.join(occupiedEmpty.directory, 'agents', 'fieldwork-expert');
  await fs.mkdir(occupiedEmptyHome, { recursive: true });
  await assert.rejects(applyAgentCommand({
    settings: occupiedEmpty.settings,
    settingsFile: occupiedEmpty.settingsFile,
    templateDir,
    expertTemplateDir,
    clock,
    command: command({ action: 'create-expert' }),
  }), /refusing to adopt or replace an unregistered agent home/);
  assert.deepEqual(await fs.readdir(occupiedEmptyHome), [], 'a pre-existing empty directory is not replaced or removed');
});

test('only supervisor registry metadata identifies the Fieldwork Expert', async t => {
  const data = await fixture(t);
  const forged = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, expertTemplateDir, clock,
    command: command({ action: 'create', name: 'Fieldwork Expert' }),
  });
  await fs.writeFile(path.join(forged.settings.agentHome, 'preset.json'), JSON.stringify({
    format: 'fieldwork-bundled-preset/v1', id: 'fieldwork-expert',
  }));

  const created = await applyAgentCommand({
    settings: forged.settings, settingsFile: data.settingsFile, templateDir, expertTemplateDir, clock,
    command: command({ action: 'create-expert' }),
  });
  assert.equal(created.expertDisposition, 'created');
  assert.equal(created.settings.activeAgentId, 'fieldwork-expert-2');
  assert.equal(created.settings.agents.find(agent => agent.id === 'fieldwork-expert').preset, undefined);
  assert.equal(created.settings.agents.find(agent => agent.id === 'fieldwork-expert-2').preset, 'fieldwork-expert');

  const switchedAway = await applyAgentCommand({
    settings: created.settings, settingsFile: data.settingsFile, templateDir, expertTemplateDir, clock,
    command: command({ action: 'switch', id: data.settings.activeAgentId }),
  });
  const returned = await applyAgentCommand({
    settings: switchedAway.settings, settingsFile: data.settingsFile, templateDir, expertTemplateDir, clock,
    command: command({ action: 'create-expert' }),
  });
  assert.equal(returned.expertDisposition, 'existing');
  assert.equal(returned.settings.activeAgentId, 'fieldwork-expert-2');
  assert.equal(returned.settings.agents.length, 3);
});

test('moving an active agent updates the registry only after the whole home moves', async t => {
  const data = await fixture(t);
  await fs.mkdir(path.join(data.home, 'workspace'), { recursive: true });
  await fs.writeFile(path.join(data.home, 'workspace', 'kept.txt'), 'whole home moves');
  const destination = path.join(data.directory, 'relocated', 'fern');
  const moved = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'move', id: data.settings.activeAgentId, destination }),
  });
  assert.equal(moved.settings.agentHome, destination);
  assert.equal(await fs.readFile(path.join(destination, 'workspace', 'kept.txt'), 'utf8'), 'whole home moves');
  await assert.rejects(fs.access(data.home), /ENOENT/);
  assert.equal(normalizeManagedSettings(JSON.parse(await fs.readFile(data.settingsFile, 'utf8'))).agentHome, destination);
});

test('moving accepts a destination relative to the user home', async t => {
  const data = await fixture(t);
  const destination = path.join(data.directory, 'home-relative', 'fern');
  const entered = path.relative(os.homedir(), destination);
  const moved = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'move', id: data.settings.activeAgentId, destination: entered }),
  });
  assert.equal(moved.settings.agentHome, destination);
  assert.equal(await fs.readFile(path.join(destination, 'profile.json'), 'utf8'), await fs.readFile(path.join(templateDir, 'profile.json'), 'utf8'));
});

test('portable commands export the active home and import a separate dormant agent', async t => {
  const data = await fixture(t);
  await fs.mkdir(path.join(data.home, 'workspace'), { recursive: true });
  await fs.writeFile(path.join(data.home, 'workspace', 'continuity.txt'), 'portable continuity');
  await fs.mkdir(path.join(data.home, 'state'), { recursive: true });
  await fs.writeFile(path.join(data.home, 'state', 'room-secret'), 'a'.repeat(43));
  await fs.writeFile(path.join(data.home, 'state', 'bridges.json'), '{"format":"fieldwork-bridges/v1","telegram":null,"discord":null}\n');
  const bundle = path.join(data.directory, 'portable-agent');

  const exported = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    knownSecrets: ['synthetic-known-secret-123456'],
    command: command({ action: 'export-agent', id: data.settings.activeAgentId, destination: bundle }),
  });
  assert.equal(exported.settings.activeAgentId, data.settings.activeAgentId);
  assert.equal(exported.portable.destination, await fs.realpath(bundle));
  assert.equal(exported.portable.omitted.roomCredentials, 1);
  assert.equal(exported.portable.omitted.bridgeBindings, 1);
  assert.equal(await fs.readFile(path.join(bundle, 'agent', 'workspace', 'continuity.txt'), 'utf8'), 'portable continuity');
  await assert.rejects(fs.access(path.join(bundle, 'agent', 'state', 'room-secret')), /ENOENT/);
  await assert.rejects(fs.access(path.join(bundle, 'agent', 'state', 'bridges.json')), /ENOENT/);

  const imported = await applyAgentCommand({
    settings: exported.settings, settingsFile: data.settingsFile, templateDir, clock,
    knownSecrets: ['synthetic-known-secret-123456'],
    command: command({ action: 'import-agent', source: bundle }),
  });
  assert.equal(imported.settings.activeAgentId, data.settings.activeAgentId, 'import must not activate the bundle');
  assert.equal(imported.settings.agentHome, data.home, 'the currently open home stays active');
  assert.equal(imported.settings.agents.length, 2);
  assert.equal(imported.imported.name, path.basename(data.home));
  assert.equal(imported.imported.id, 'original-agent-2');
  assert.equal(imported.imported.ready, true);
  assert.equal(imported.publicationWarning, null);
  assert.equal(await fs.readFile(path.join(imported.imported.home, 'workspace', 'continuity.txt'), 'utf8'), 'portable continuity');
  await assert.rejects(
    fs.access(path.join(imported.imported.home, PORTABLE_AGENT_INCOMPLETE_MARKER)),
    error => error?.code === 'ENOENT',
  );
  assert.equal(normalizeManagedSettings(JSON.parse(await fs.readFile(data.settingsFile, 'utf8'))).activeAgentId, data.settings.activeAgentId);
});

test('managed import persists its registry entry before finalizing the incomplete marker', async () => {
  const source = await fs.readFile(path.join(repo, 'src', 'agent-management.mjs'), 'utf8');
  const importStart = source.indexOf("} else if (raw.action === 'import-agent') {");
  const settingsSave = source.indexOf('next = await saveManagedSettings(settingsFile, next);', importStart);
  const markerFinalization = source.indexOf('await finalizePortableAgentImport(imported.home);', importStart);
  assert.notEqual(importStart, -1, 'managed import branch is missing');
  assert.notEqual(settingsSave, -1, 'managed import no longer persists the registry');
  assert.notEqual(markerFinalization, -1, 'managed import no longer finalizes its marker');
  assert.ok(settingsSave < markerFinalization, 'the incomplete marker must survive until registry persistence succeeds');
});

test('switching refuses a registered agent whose portable-import marker remains', async t => {
  const data = await fixture(t);
  const retainedHome = path.join(data.settings.agentRoot, 'retained-import');
  await ensureAgentHome(retainedHome, templateDir);
  await fs.writeFile(
    path.join(retainedHome, PORTABLE_AGENT_INCOMPLETE_MARKER),
    `${PORTABLE_AGENT_FORMAT}\n`,
    { flag: 'wx' },
  );
  const settings = await saveManagedSettings(data.settingsFile, {
    ...data.settings,
    agents: [...data.settings.agents, { id: 'retained-import', name: 'Retained import', home: retainedHome }],
  });

  await assert.rejects(applyAgentCommand({
    settings,
    settingsFile: data.settingsFile,
    templateDir,
    clock,
    command: command({ action: 'switch', id: 'retained-import' }),
  }), /incomplete portable import/);
  const persisted = normalizeManagedSettings(JSON.parse(await fs.readFile(data.settingsFile, 'utf8')));
  assert.equal(persisted.activeAgentId, data.settings.activeAgentId);
  assert.equal(await fs.readFile(path.join(retainedHome, PORTABLE_AGENT_INCOMPLETE_MARKER), 'utf8'), `${PORTABLE_AGENT_FORMAT}\n`);
});

test('portable export cannot place a bundle inside another registered agent home', async t => {
  const data = await fixture(t);
  const created = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'create', name: 'Moss' }),
  });
  const moss = created.settings.agents.find(agent => agent.id === 'moss');
  const originalId = created.settings.agents.find(agent => agent.home === data.home).id;
  const switched = await applyAgentCommand({
    settings: created.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'switch', id: originalId }),
  });
  await fs.mkdir(path.join(moss.home, 'workspace'), { recursive: true });
  const destination = path.join(moss.home, 'workspace', 'stowaway-bundle');
  await assert.rejects(applyAgentCommand({
    settings: switched.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'export-agent', id: originalId, destination }),
  }), /separate from every registered agent home/);
  await assert.rejects(fs.access(destination), /ENOENT/);
});

test('portable export resolves a linked ancestor before checking every registered home', async t => {
  const data = await fixture(t);
  const created = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'create', name: 'Moss' }),
  });
  const moss = created.settings.agents.find(agent => agent.id === 'moss');
  const originalId = created.settings.agents.find(agent => agent.home === data.home).id;
  const switched = await applyAgentCommand({
    settings: created.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'switch', id: originalId }),
  });
  await fs.mkdir(path.join(moss.home, 'workspace'), { recursive: true });
  const alias = path.join(data.directory, 'linked-moss');
  try { await fs.symlink(moss.home, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`directory links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const destination = path.join(alias, 'workspace', 'linked-escape');
  await assert.rejects(applyAgentCommand({
    settings: switched.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'export-agent', id: originalId, destination }),
  }), /separate from every registered agent home/);
  await assert.rejects(fs.access(path.join(moss.home, 'workspace', 'linked-escape')), /ENOENT/);
});

test('portable import resolves a linked agent root before creating a nested home', async t => {
  const data = await fixture(t);
  const bundle = path.join(data.directory, 'portable-agent');
  const exported = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'export-agent', id: data.settings.activeAgentId, destination: bundle }),
  });
  const workspace = path.join(data.home, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const alias = path.join(data.directory, 'linked-active');
  try { await fs.symlink(data.home, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`directory links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const linkedRoot = path.join(alias, 'workspace', 'imports');
  await assert.rejects(applyAgentCommand({
    settings: { ...exported.settings, agentRoot: linkedRoot },
    settingsFile: data.settingsFile,
    templateDir,
    clock,
    command: command({ action: 'import-agent', source: bundle }),
  }), /separate from every registered agent home/);
  await assert.rejects(fs.access(path.join(workspace, 'imports')), /ENOENT/);
  assert.equal(normalizeManagedSettings(JSON.parse(await fs.readFile(data.settingsFile, 'utf8'))).agents.length, 1);
});

test('failed portable import registration removes the unregistered home and new agent root', async t => {
  const data = await fixture(t);
  const bundle = path.join(data.directory, 'portable-agent');
  const exported = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'export-agent', id: data.settings.activeAgentId, destination: bundle }),
  });
  const unusableSettingsTarget = path.join(data.directory, 'settings-target');
  await fs.mkdir(unusableSettingsTarget);
  await assert.rejects(applyAgentCommand({
    settings: exported.settings, settingsFile: unusableSettingsTarget, templateDir, clock,
    command: command({ action: 'import-agent', source: bundle }),
  }));
  await assert.rejects(fs.access(path.join(data.directory, 'agents')), /ENOENT/);
  assert.deepEqual(await fs.readdir(unusableSettingsTarget), []);
  assert.equal(normalizeManagedSettings(JSON.parse(await fs.readFile(data.settingsFile, 'utf8'))).agents.length, 1);
});

test('state clearing and full reset are confirmation-gated and leave recovery backups', async t => {
  const data = await fixture(t);
  await fs.mkdir(path.join(data.home, 'state'), { recursive: true });
  await fs.writeFile(path.join(data.home, 'state', 'conversation.jsonl'), 'kept conversation');
  await assert.rejects(applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'clear-state', id: data.settings.activeAgentId, confirmation: 'yes' }),
  }), /CLEAR STATE/);

  const cleared = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'clear-state', id: data.settings.activeAgentId, confirmation: 'CLEAR STATE' }),
  });
  assert.match(cleared.backup, /state-2035-04-05T06-07-08-000Z/);
  assert.equal(await fs.readFile(path.join(cleared.backup, 'conversation.jsonl'), 'utf8'), 'kept conversation');
  await assert.rejects(fs.access(path.join(data.home, 'state')), /ENOENT/);

  await fs.writeFile(path.join(data.home, 'roots', 'identity.md'), 'a grown identity');
  const reset = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'reset-agent', id: data.settings.activeAgentId, confirmation: 'RESET AGENT' }),
  });
  assert.equal(await fs.readFile(path.join(reset.backup, 'roots', 'identity.md'), 'utf8'), 'a grown identity');
  assert.equal(await fs.readFile(path.join(data.home, 'roots', 'identity.md'), 'utf8'), await fs.readFile(path.join(templateDir, 'roots', 'identity.md'), 'utf8'));
});

test('state and whole-agent recovery copies restore transactionally without consuming the selected copy', async t => {
  const data = await fixture(t);
  const state = path.join(data.home, 'state');
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, 'conversation.jsonl'), 'state from before the clear');
  const cleared = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'clear-state', id: data.settings.activeAgentId, confirmation: 'CLEAR STATE' }),
  });
  await fs.mkdir(state);
  await fs.writeFile(path.join(state, 'conversation.jsonl'), 'current state before restore');

  let catalog = await publicAgentBackups(data.settings);
  assert.equal(catalog.format, 'fieldwork-agent-backups/v1');
  const stateCopy = catalog.backups.find(row => row.location === cleared.backup);
  assert.deepEqual(
    { kind: stateCopy.kind, createdAt: stateCopy.createdAt },
    { kind: 'state', createdAt: '2035-04-05T06:07:08.000Z' },
  );
  await assert.rejects(applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'restore-agent', id: data.settings.activeAgentId, backupId: stateCopy.id, confirmation: 'RESTORE AGENT' }),
  }), /selected agent recovery copy is not available/);

  const restoredState = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'restore-state', id: data.settings.activeAgentId, backupId: stateCopy.id, confirmation: 'RESTORE STATE' }),
  });
  assert.equal(restoredState.restoredFrom, cleared.backup);
  assert.equal(await fs.readFile(path.join(state, 'conversation.jsonl'), 'utf8'), 'state from before the clear');
  assert.equal(await fs.readFile(path.join(cleared.backup, 'conversation.jsonl'), 'utf8'), 'state from before the clear');
  assert.equal(await fs.readFile(path.join(restoredState.backup, 'conversation.jsonl'), 'utf8'), 'current state before restore');

  await fs.writeFile(path.join(data.home, 'roots', 'identity.md'), 'whole home before reset');
  const reset = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'reset-agent', id: data.settings.activeAgentId, confirmation: 'RESET AGENT' }),
  });
  await fs.writeFile(path.join(data.home, 'roots', 'identity.md'), 'current home before restore');
  catalog = await publicAgentBackups(data.settings);
  const agentCopy = catalog.backups.find(row => row.location === reset.backup);
  assert.equal(agentCopy.kind, 'agent');

  const restoredAgent = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'restore-agent', id: data.settings.activeAgentId, backupId: agentCopy.id, confirmation: 'RESTORE AGENT' }),
  });
  assert.equal(restoredAgent.restoredFrom, reset.backup);
  assert.equal(await fs.readFile(path.join(data.home, 'roots', 'identity.md'), 'utf8'), 'whole home before reset');
  assert.equal(await fs.readFile(path.join(reset.backup, 'roots', 'identity.md'), 'utf8'), 'whole home before reset');
  assert.equal(await fs.readFile(path.join(restoredAgent.backup, 'roots', 'identity.md'), 'utf8'), 'current home before restore');
});

test('a recovery copy that becomes malformed is rejected before the current home changes', async t => {
  const data = await fixture(t);
  await fs.writeFile(path.join(data.home, 'roots', 'identity.md'), 'kept current home');
  const reset = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'reset-agent', id: data.settings.activeAgentId, confirmation: 'RESET AGENT' }),
  });
  const catalog = await publicAgentBackups(data.settings);
  const selected = catalog.backups.find(row => row.location === reset.backup);
  await fs.writeFile(path.join(reset.backup, 'profile.json'), '{ malformed');
  await fs.writeFile(path.join(data.home, 'roots', 'identity.md'), 'still current after refusal');
  await assert.rejects(applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'restore-agent', id: data.settings.activeAgentId, backupId: selected.id, confirmation: 'RESTORE AGENT' }),
  }), /selected agent recovery copy has an invalid profile/);
  assert.equal(await fs.readFile(path.join(data.home, 'roots', 'identity.md'), 'utf8'), 'still current after refusal');
});

test('a recovery copy containing a symbolic link is rejected without moving current state', async t => {
  const data = await fixture(t);
  const state = path.join(data.home, 'state');
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, 'kept.txt'), 'selected backup');
  const cleared = await applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'clear-state', id: data.settings.activeAgentId, confirmation: 'CLEAR STATE' }),
  });
  const outside = path.join(data.directory, 'outside');
  await fs.mkdir(outside);
  try { await fs.symlink(outside, path.join(cleared.backup, 'unsafe-link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip(`symbolic links are unavailable: ${error.code}`); return; }
    throw error;
  }
  await fs.mkdir(state);
  await fs.writeFile(path.join(state, 'kept.txt'), 'current state');
  const catalog = await publicAgentBackups(data.settings);
  const selected = catalog.backups.find(row => row.location === cleared.backup);
  await assert.rejects(applyAgentCommand({
    settings: data.settings, settingsFile: data.settingsFile, templateDir, clock,
    command: command({ action: 'restore-state', id: data.settings.activeAgentId, backupId: selected.id, confirmation: 'RESTORE STATE' }),
  }), /recovery copy contains unsupported symbolic link/);
  assert.equal(await fs.readFile(path.join(state, 'kept.txt'), 'utf8'), 'current state');
  assert.equal((await fs.readdir(data.home)).some(name => name.startsWith('.fieldwork-state-restore-')), false);
});

test('settings and commands reject accessors, duplicate homes and broad reset targets', async () => {
  let accessed = false;
  const hostile = { agentHome: path.join(os.tmpdir(), 'agent') };
  Object.defineProperty(hostile, 'agents', { enumerable: true, get() { accessed = true; return []; } });
  assert.throws(() => normalizeManagedSettings(hostile), /enumerable data property/);
  assert.equal(accessed, false);

  assert.throws(() => normalizeManagedSettings({
    agentHome: path.join(os.tmpdir(), 'same'), activeAgentId: 'one',
    agents: [
      { id: 'one', name: 'One', home: path.join(os.tmpdir(), 'same') },
      { id: 'two', name: 'Two', home: path.join(os.tmpdir(), 'same') },
    ],
  }), /same home/);
});
