import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BRIDGE_COMMAND_FORMAT,
  BRIDGE_LIMITS,
  BRIDGE_PUBLIC_FORMAT,
  BRIDGE_SECRETS_FORMAT,
  BRIDGE_SETTINGS_FORMAT,
  applyBridgeCommand,
  bindBridgeConversation,
  bridgeSecretsFileFor,
  bridgeSettingsFileFor,
  createBridgeBindingCoordinator,
  loadBridgeSecrets,
  loadBridgeSettings,
  publicBridgeSettings,
  saveBridgeSecrets,
} from '../src/bridge-management.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-bridges-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const agentHome = path.join(directory, 'agent');
  const launcherSettings = path.join(directory, 'fieldwork.local.json');
  return {
    directory,
    agentHome,
    settingsFile: bridgeSettingsFileFor(agentHome),
    secretsFile: bridgeSecretsFileFor(launcherSettings),
  };
}

test('bridge routes and bot tokens have separate default-deny stores', async t => {
  const data = await fixture(t);
  assert.equal(data.settingsFile, path.join(data.agentHome, 'state', 'bridges.json'));
  assert.equal(data.secretsFile, path.join(data.directory, 'fieldwork.local.bridges.secrets.json'));
  assert.deepEqual(await loadBridgeSettings(data.settingsFile), {
    format: BRIDGE_SETTINGS_FORMAT,
    telegram: null,
    discord: null,
  });
  assert.deepEqual(await loadBridgeSecrets(data.secretsFile), {
    format: BRIDGE_SECRETS_FORMAT,
    telegramToken: null,
    discordToken: null,
  });

  await saveBridgeSecrets(data.secretsFile, {
    format: BRIDGE_SECRETS_FORMAT,
    telegramToken: '123456:synthetic_telegram_token_value_12345',
    discordToken: null,
  });
  assert.equal((await loadBridgeSecrets(data.secretsFile)).telegramToken, '123456:synthetic_telegram_token_value_12345');
  await assert.rejects(fs.stat(data.settingsFile), error => error.code === 'ENOENT');
});

test('malformed bridge secret JSON never echoes source text or a raw parser cause', async t => {
  const data = await fixture(t);
  const sentinel = 'DO_NOT_ECHO_BRIDGE_TOKEN_123456789';
  await fs.writeFile(data.secretsFile, `{"telegramToken":${sentinel}}\n`);

  let failure;
  try { await loadBridgeSecrets(data.secretsFile); }
  catch (error) { failure = error; }

  assert.ok(failure instanceof Error);
  assert.equal(failure.message, 'Bridge management: bridge secret store is not valid JSON');
  assert.equal(failure.cause, undefined);
  assert.doesNotMatch(String(failure.stack), /DO_NOT_ECH/);
});

test('invalid bridge secret data never echoes property names from the file', async t => {
  const data = await fixture(t);
  const sentinel = 'DO_NOT_ECHO_BRIDGE_KEY_NAME_123456789';
  await fs.writeFile(data.secretsFile, JSON.stringify({
    format: BRIDGE_SECRETS_FORMAT,
    telegramToken: null,
    discordToken: null,
    [sentinel]: true,
  }));

  let failure;
  try { await loadBridgeSecrets(data.secretsFile); }
  catch (error) { failure = error; }

  assert.ok(failure instanceof Error);
  assert.equal(failure.message, 'Bridge management: bridge secret store has invalid data');
  assert.equal(failure.cause, undefined);
  assert.doesNotMatch(String(failure.stack), /DO_NOT_ECH/);
});

test('the bridge secret store uses a bounded no-follow stable-file read', async t => {
  const data = await fixture(t);
  await fs.writeFile(data.secretsFile, Buffer.alloc(BRIDGE_LIMITS.fileBytes + 1, 0x61));
  await assert.rejects(loadBridgeSecrets(data.secretsFile), /bridge secret store is too large/);

  await t.test('a linked bridge secret store is refused when symlinks are available', async t => {
    await fs.unlink(data.secretsFile);
    const target = path.join(data.directory, 'bridge-secret-target.json');
    await saveBridgeSecrets(target, {
      format: BRIDGE_SECRETS_FORMAT,
      telegramToken: '123456:synthetic_linked_telegram_token',
      discordToken: null,
    });
    try { await fs.symlink(target, data.secretsFile, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
        t.skip(`Windows did not permit a file symlink (${error.code})`);
        return;
      }
      throw error;
    }
    await assert.rejects(loadBridgeSecrets(data.secretsFile), /linked or is not a regular file/);
  });
});

test('Telegram configuration is strict, public, and never projects its token', async t => {
  const data = await fixture(t);
  const result = await applyBridgeCommand({
    ...data,
    command: {
      format: BRIDGE_COMMAND_FORMAT,
      action: 'configure',
      platform: 'telegram',
      token: '123456:synthetic_telegram_token_value_12345',
      destinationId: '123456789',
      allowedUserId: '987654321',
      scope: 'direct',
    },
  });
  assert.equal(result.secretChanged, true);
  assert.deepEqual(result.settings.telegram, {
    chatId: '123456789',
    allowedUserId: '987654321',
    scope: 'direct',
    respondTo: 'all',
    conversationId: null,
  });
  const routeText = await fs.readFile(data.settingsFile, 'utf8');
  assert.doesNotMatch(routeText, /synthetic_telegram_token_value|Token/);

  const projected = publicBridgeSettings(result.settings, {
    sources: { telegram: 'saved' },
    live: { telegram: 'connected' },
  });
  assert.equal(projected.format, BRIDGE_PUBLIC_FORMAT);
  assert.equal(projected.telegram.state, 'connected');
  assert.equal(projected.telegram.binding, 'unbound');
  assert.deepEqual(projected.telegram.token, {
    source: 'saved', available: true, canSave: true, canForget: true,
  });
  assert.doesNotMatch(JSON.stringify(projected), /synthetic_telegram_token_value/);
});

test('group listening and destructive bridge changes need exact confirmations', async t => {
  const data = await fixture(t);
  const group = {
    format: BRIDGE_COMMAND_FORMAT,
    action: 'configure',
    platform: 'telegram',
    token: '123456:synthetic_group_token_value_123456',
    destinationId: '-1001234567890',
    allowedUserId: '123456789',
    scope: 'group',
  };
  await assert.rejects(applyBridgeCommand({ ...data, command: group }), /ALLOW GROUP LISTENING/);
  await applyBridgeCommand({ ...data, command: { ...group, groupConfirmation: 'ALLOW GROUP LISTENING' } });
  assert.equal((await loadBridgeSettings(data.settingsFile)).telegram.respondTo, 'mention');

  await assert.rejects(applyBridgeCommand({
    ...data,
    command: { format: BRIDGE_COMMAND_FORMAT, action: 'disconnect', platform: 'telegram', confirmation: 'disconnect' },
  }), /DISCONNECT TELEGRAM/);
  await applyBridgeCommand({
    ...data,
    command: { format: BRIDGE_COMMAND_FORMAT, action: 'disconnect', platform: 'telegram', confirmation: 'DISCONNECT TELEGRAM' },
  });
  assert.equal((await loadBridgeSettings(data.settingsFile)).telegram, null);
  assert.equal((await loadBridgeSecrets(data.secretsFile)).telegramToken, '123456:synthetic_group_token_value_123456');

  await applyBridgeCommand({
    ...data,
    command: { format: BRIDGE_COMMAND_FORMAT, action: 'forget-token', platform: 'telegram', confirmation: 'FORGET TELEGRAM TOKEN' },
  });
  await assert.rejects(fs.stat(data.secretsFile), error => error.code === 'ENOENT');

  const withoutToken = await applyBridgeCommand({
    ...data,
    command: {
      format: BRIDGE_COMMAND_FORMAT,
      action: 'configure',
      platform: 'telegram',
      destinationId: '123456789',
      allowedUserId: '123456789',
      scope: 'direct',
    },
  });
  assert.equal(publicBridgeSettings(withoutToken.settings).telegram.state, 'missing-token');
});

test('a route keeps its bound conversation only while the complete participant identity is unchanged', async t => {
  const data = await fixture(t);
  const configure = {
    format: BRIDGE_COMMAND_FORMAT,
    action: 'configure',
    platform: 'telegram',
    token: '123456:synthetic_bind_token_value_1234567',
    destinationId: '111222333',
    allowedUserId: '444555666',
    scope: 'direct',
  };
  await applyBridgeCommand({ ...data, command: configure });
  const conversationId = `conv-${randomUUID()}`;
  const telegramBinding = {
    platform: 'telegram',
    destinationId: configure.destinationId,
    allowedUserId: configure.allowedUserId,
    scope: configure.scope,
    conversationId,
  };
  await bindBridgeConversation(data.settingsFile, telegramBinding);
  assert.equal((await loadBridgeSettings(data.settingsFile)).telegram.conversationId, conversationId);
  assert.equal((await bindBridgeConversation(data.settingsFile, telegramBinding)).telegram.conversationId, conversationId,
    'repeating the exact bind is idempotent');
  await assert.rejects(bindBridgeConversation(data.settingsFile, {
    ...telegramBinding, conversationId: `conv-${randomUUID()}`,
  }), /already bound to a different conversation/);
  assert.equal((await loadBridgeSettings(data.settingsFile)).telegram.conversationId, conversationId,
    'an observed existing binding is refused rather than overwritten');

  await applyBridgeCommand({ ...data, command: { ...configure, token: undefined } });
  assert.equal((await loadBridgeSettings(data.settingsFile)).telegram.conversationId, conversationId);
  await applyBridgeCommand({
    ...data,
    command: { ...configure, token: undefined, allowedUserId: '777888999' },
  });
  assert.equal((await loadBridgeSettings(data.settingsFile)).telegram.conversationId, null,
    'a newly allowed person must not inherit the former person\'s conversation');
  await assert.rejects(bindBridgeConversation(data.settingsFile, telegramBinding), /route identity changed/,
    'a delayed bind from the former participant cannot reattach after the route changes');
  assert.equal((await loadBridgeSettings(data.settingsFile)).telegram.conversationId, null);

  await applyBridgeCommand({ ...data, command: { ...configure, token: undefined } });
  await bindBridgeConversation(data.settingsFile, telegramBinding);
  await applyBridgeCommand({ ...data, command: { ...configure, token: undefined, destinationId: '999888777' } });
  assert.equal((await loadBridgeSettings(data.settingsFile)).telegram.conversationId, null);

  const discord = {
    format: BRIDGE_COMMAND_FORMAT,
    action: 'configure',
    platform: 'discord',
    token: 'synthetic_discord_bind_token_value_1234567',
    destinationId: '111222333444555666',
    guildId: '222333444555666777',
    allowedUserId: '333444555666777888',
    scope: 'guild',
    groupConfirmation: 'ALLOW GROUP LISTENING',
  };
  await applyBridgeCommand({ ...data, command: discord });
  const discordBinding = {
    platform: 'discord',
    destinationId: discord.destinationId,
    guildId: discord.guildId,
    allowedUserId: discord.allowedUserId,
    scope: discord.scope,
    conversationId,
  };
  await bindBridgeConversation(data.settingsFile, discordBinding);
  await applyBridgeCommand({ ...data, command: { ...discord, token: undefined } });
  assert.equal((await loadBridgeSettings(data.settingsFile)).discord.conversationId, conversationId,
    'a token-only refresh keeps the same conversation');
  await applyBridgeCommand({
    ...data,
    command: { ...discord, token: undefined, guildId: '444555666777888999' },
  });
  assert.equal((await loadBridgeSettings(data.settingsFile)).discord.conversationId, null,
    'a different server must not inherit the former server conversation');

  await applyBridgeCommand({ ...data, command: { ...discord, token: undefined } });
  await bindBridgeConversation(data.settingsFile, discordBinding);
  await applyBridgeCommand({
    ...data,
    command: {
      format: BRIDGE_COMMAND_FORMAT,
      action: 'configure',
      platform: 'discord',
      destinationId: discord.destinationId,
      allowedUserId: discord.allowedUserId,
      scope: 'direct',
    },
  });
  assert.equal((await loadBridgeSettings(data.settingsFile)).discord.conversationId, null,
    'a scope change must start a separate conversation');
});

test('a failed first binding stays live, visible, and safely retryable without changing conversations', async t => {
  const data = await fixture(t);
  const configure = {
    format: BRIDGE_COMMAND_FORMAT,
    action: 'configure',
    platform: 'telegram',
    token: '123456:synthetic_retry_token_value_1234567',
    destinationId: '111222333',
    allowedUserId: '444555666',
    scope: 'direct',
  };
  const configured = await applyBridgeCommand({ ...data, command: configure });
  const attempts = [];
  let failures = 1;
  const coordinator = createBridgeBindingCoordinator({
    settings: configured.settings,
    async bind(request) {
      attempts.push(request);
      if (failures-- > 0) throw new Error('synthetic binding write failure');
      return { saved: request.conversationId };
    },
  });
  const conversationId = `conv-${randomUUID()}`;
  assert.equal(coordinator.view('telegram').state, 'unbound');
  assert.equal(coordinator.adopt('telegram', conversationId).state, 'live-unsaved');
  await assert.rejects(coordinator.ensure('telegram'), /synthetic binding write failure/);
  assert.deepEqual(coordinator.view('telegram'), {
    state: 'live-unsaved',
    platform: 'telegram',
    destinationId: configure.destinationId,
    allowedUserId: configure.allowedUserId,
    scope: configure.scope,
    conversationId,
  });
  await coordinator.drain();
  assert.deepEqual(await coordinator.ensure('telegram'), { saved: conversationId });
  assert.equal(coordinator.view('telegram').state, 'saved');
  const projected = publicBridgeSettings({
    ...configured.settings,
    telegram: { ...configured.settings.telegram, conversationId },
  }, { bindings: { telegram: 'live-unsaved' } });
  assert.equal(projected.telegram.binding, 'live-unsaved');
  assert.deepEqual(attempts, [
    { platform: 'telegram', destinationId: configure.destinationId, allowedUserId: configure.allowedUserId, scope: 'direct', conversationId },
    { platform: 'telegram', destinationId: configure.destinationId, allowedUserId: configure.allowedUserId, scope: 'direct', conversationId },
  ]);
  await assert.rejects(async () => coordinator.adopt('telegram', `conv-${randomUUID()}`), /already bound/);
  assert.equal(await coordinator.ensure('telegram'), null, 'a saved binding does not perform another write');
  assert.equal(attempts.length, 2);
});

test('bridge inputs reject hidden fields, invalid IDs, and Discord scope mismatches', async t => {
  const data = await fixture(t);
  const base = {
    format: BRIDGE_COMMAND_FORMAT,
    action: 'configure',
    platform: 'telegram',
    token: '123456:synthetic_strict_token_value_12345',
    destinationId: '123',
    allowedUserId: '456',
    scope: 'direct',
  };
  await assert.rejects(applyBridgeCommand({ ...data, command: { ...base, extra: true } }), /unknown field "extra"/);
  await assert.rejects(applyBridgeCommand({ ...data, command: { ...base, destinationId: 'chat-name' } }), /decimal platform identifier/);
  await assert.rejects(applyBridgeCommand({
    ...data,
    command: {
      ...base,
      platform: 'discord',
      destinationId: '123',
      guildId: '456',
      allowedUserId: '789',
      scope: 'direct',
    },
  }), /direct destination does not accept groupConfirmation|does not accept guildId|unknown field/);

  const accessor = { ...base };
  Object.defineProperty(accessor, 'token', { enumerable: true, get() { return 'hidden'; } });
  await assert.rejects(applyBridgeCommand({ ...data, command: accessor }), /must be an enumerable data property/);

  const coordinatorOptions = { settings: await loadBridgeSettings(data.settingsFile) };
  Object.defineProperty(coordinatorOptions, 'bind', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(() => createBridgeBindingCoordinator(coordinatorOptions), /must be an enumerable data property/);
});
