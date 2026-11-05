import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FIELDWORK_SECRETS_FORMAT,
  MODEL_CONNECTION_COMMAND_FORMAT,
  MODEL_CONNECTION_FORMAT,
  MODEL_CONNECTION_LIMITS,
  applyModelConnectionCommand,
  effectiveModelApiKey,
  loadFieldworkSecrets,
  publicModelConnection,
  saveFieldworkSecrets,
  secretsFileFor,
} from '../src/model-connection.mjs';
import { loadManagedSettings, saveManagedSettings } from '../src/agent-management.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-model-connection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settingsFile = path.join(directory, 'fieldwork.local.json');
  const settings = await saveManagedSettings(settingsFile, {
    agentHome: path.join(directory, 'agent'),
    service: 'openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'synthetic/local',
    tools: '',
    port: 4317,
  });
  return { directory, settingsFile, secretsFile: secretsFileFor(settingsFile), settings };
}

test('the supervisor secret store is separate, strict and removable', async t => {
  const data = await fixture(t);
  assert.equal(data.secretsFile, path.join(data.directory, 'fieldwork.local.secrets.json'));
  assert.deepEqual(await loadFieldworkSecrets(data.secretsFile), {
    format: FIELDWORK_SECRETS_FORMAT,
    baseURL: null,
    apiKey: null,
  });

  await saveFieldworkSecrets(data.secretsFile, {
    baseURL: 'https://models.example.invalid/v1/',
    apiKey: 'synthetic-key-123',
  });
  assert.deepEqual(await loadFieldworkSecrets(data.secretsFile), {
    format: FIELDWORK_SECRETS_FORMAT,
    baseURL: 'https://models.example.invalid/v1',
    apiKey: 'synthetic-key-123',
  });
  assert.doesNotMatch(await fs.readFile(data.settingsFile, 'utf8'), /synthetic-key-123/);

  await fs.writeFile(data.secretsFile, '{"format":"fieldwork-supervisor-secrets/v1","baseURL":"https://models.example.invalid/v1","apiKey":"a","extra":true}\n');
  await assert.rejects(loadFieldworkSecrets(data.secretsFile), {
    message: 'Model connection: secret store has invalid data',
  });
  await saveFieldworkSecrets(data.secretsFile, {
    baseURL: 'https://models.example.invalid/v1',
    apiKey: 'replacement-key',
  });
  await saveFieldworkSecrets(data.secretsFile, { apiKey: null });
  await assert.rejects(fs.stat(data.secretsFile), error => error.code === 'ENOENT');
});

test('malformed supervisor secret JSON never echoes source text or a raw parser cause', async t => {
  const data = await fixture(t);
  const sentinel = 'DO_NOT_ECHO_MODEL_SECRET_123456789';
  await fs.writeFile(data.secretsFile, `{"apiKey":${sentinel}}\n`);

  let failure;
  try { await loadFieldworkSecrets(data.secretsFile); }
  catch (error) { failure = error; }

  assert.ok(failure instanceof Error);
  assert.equal(failure.message, 'Model connection: secret store is not valid JSON');
  assert.equal(failure.cause, undefined);
  assert.doesNotMatch(String(failure.stack), /DO_NOT_ECH/);
});

test('invalid supervisor secret data never echoes property names from the file', async t => {
  const data = await fixture(t);
  const sentinel = 'DO_NOT_ECHO_MODEL_KEY_NAME_123456789';
  await fs.writeFile(data.secretsFile, JSON.stringify({
    format: FIELDWORK_SECRETS_FORMAT,
    baseURL: null,
    apiKey: null,
    [sentinel]: true,
  }));

  let failure;
  try { await loadFieldworkSecrets(data.secretsFile); }
  catch (error) { failure = error; }

  assert.ok(failure instanceof Error);
  assert.equal(failure.message, 'Model connection: secret store has invalid data');
  assert.equal(failure.cause, undefined);
  assert.doesNotMatch(String(failure.stack), /DO_NOT_ECH/);
});

test('the model secret store uses a bounded no-follow stable-file read', async t => {
  const data = await fixture(t);
  await fs.writeFile(data.secretsFile, Buffer.alloc(MODEL_CONNECTION_LIMITS.secretFileBytes + 1, 0x61));
  await assert.rejects(loadFieldworkSecrets(data.secretsFile), /secret store is too large/);

  await t.test('a linked model secret store is refused when symlinks are available', async t => {
    await fs.unlink(data.secretsFile);
    const target = path.join(data.directory, 'model-secret-target.json');
    await saveFieldworkSecrets(target, {
      baseURL: 'https://models.example.invalid/v1',
      apiKey: 'synthetic-linked-key',
    });
    try { await fs.symlink(target, data.secretsFile, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
        t.skip(`Windows did not permit a file symlink (${error.code})`);
        return;
      }
      throw error;
    }
    await assert.rejects(loadFieldworkSecrets(data.secretsFile), /linked or is not a regular file/);
  });
});

test('a saved key is used only for the endpoint it was saved for', async t => {
  const data = await fixture(t);
  const secrets = {
    format: FIELDWORK_SECRETS_FORMAT,
    baseURL: 'https://one.example.invalid/v1',
    apiKey: 'synthetic-bound-key',
  };
  const first = { ...data.settings, baseURL: 'https://one.example.invalid/v1/' };
  assert.deepEqual(effectiveModelApiKey(first, secrets, 'synthetic-environment-key'), {
    key: 'synthetic-bound-key', source: 'saved',
  });
  const second = { ...data.settings, baseURL: 'https://two.example.invalid/v1' };
  assert.deepEqual(effectiveModelApiKey(second, secrets), { key: null, source: 'none' });
  assert.deepEqual(effectiveModelApiKey(second, secrets, 'synthetic-environment-key'), {
    key: 'synthetic-environment-key', source: 'environment',
  });
});

test('the public connection projection never contains a credential', async t => {
  const data = await fixture(t);
  assert.deepEqual(publicModelConnection(data.settings), {
    format: MODEL_CONNECTION_FORMAT,
    service: 'openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'synthetic/local',
    access: { kind: 'none', status: 'not-needed', source: 'none', canSave: true, canForget: false },
  });

  const hosted = publicModelConnection({
    ...data.settings,
    baseURL: 'https://models.example.invalid/v1',
    model: 'synthetic/hosted',
  }, { apiKeySource: 'saved' });
  assert.deepEqual(hosted.access, {
    kind: 'api-key', status: 'ready', source: 'saved', canSave: true, canForget: true,
  });
  assert.doesNotMatch(JSON.stringify(hosted), /synthetic-key/);

  const subscription = publicModelConnection({
    ...data.settings,
    service: 'chatgpt-subscription',
    model: 'synthetic/subscription',
  }, { apiKeySource: 'environment' });
  assert.deepEqual(subscription, {
    format: MODEL_CONNECTION_FORMAT,
    service: 'chatgpt-subscription',
    model: 'synthetic/subscription',
    access: { kind: 'subscription', status: 'ready', source: 'codex', canSave: false, canForget: false },
  });

  const dormant = publicModelConnection({
    ...data.settings,
    baseURL: 'https://other.example.invalid/v1',
  }, { apiKeySource: 'none', savedKeyPresent: true });
  assert.deepEqual(dormant.access, {
    kind: 'api-key', status: 'missing', source: 'none', canSave: true, canForget: true,
  });
});

test('a supervised connection update saves non-secrets and the key in separate stores', async t => {
  const data = await fixture(t);
  const result = await applyModelConnectionCommand({
    ...data,
    command: {
      format: MODEL_CONNECTION_COMMAND_FORMAT,
      action: 'configure',
      service: 'openai-compatible',
      baseURL: 'https://models.example.invalid/v1/',
      model: 'synthetic/hosted',
      apiKey: 'synthetic-key-456',
    },
  });
  assert.equal(result.action, 'configure');
  assert.equal(result.secretChanged, true);
  assert.equal(result.settings.baseURL, 'https://models.example.invalid/v1');
  assert.deepEqual(await loadFieldworkSecrets(data.secretsFile), {
    format: FIELDWORK_SECRETS_FORMAT,
    baseURL: 'https://models.example.invalid/v1',
    apiKey: 'synthetic-key-456',
  });
  const settingsText = await fs.readFile(data.settingsFile, 'utf8');
  assert.match(settingsText, /synthetic\/hosted/);
  assert.doesNotMatch(settingsText, /synthetic-key-456|apiKey/);

  await applyModelConnectionCommand({
    settings: result.settings,
    settingsFile: data.settingsFile,
    secretsFile: data.secretsFile,
    command: {
      format: MODEL_CONNECTION_COMMAND_FORMAT,
      action: 'forget-api-key',
      confirmation: 'FORGET API KEY',
    },
  });
  assert.equal((await loadFieldworkSecrets(data.secretsFile)).apiKey, null);
});

test('subscription selection is checked before settings change and key write failure rolls settings back', async t => {
  const data = await fixture(t);
  await assert.rejects(applyModelConnectionCommand({
    ...data,
    subscriptionReady: async () => false,
    command: {
      format: MODEL_CONNECTION_COMMAND_FORMAT,
      action: 'configure',
      service: 'chatgpt-subscription',
      model: 'synthetic/subscription',
    },
  }), /no ChatGPT sign-in/);
  assert.equal((await loadManagedSettings(data.settingsFile)).service, 'openai-compatible');

  const blocker = path.join(data.directory, 'not-a-directory');
  await fs.writeFile(blocker, 'block');
  await assert.rejects(applyModelConnectionCommand({
    settings: data.settings,
    settingsFile: data.settingsFile,
    secretsFile: path.join(blocker, 'secret.json'),
    command: {
      format: MODEL_CONNECTION_COMMAND_FORMAT,
      action: 'configure',
      service: 'openai-compatible',
      baseURL: 'https://new.example.invalid/v1',
      model: 'synthetic/new',
      apiKey: 'synthetic-key-789',
    },
  }));
  const rolledBack = await loadManagedSettings(data.settingsFile);
  assert.equal(rolledBack.baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(rolledBack.model, 'synthetic/local');
});

test('connection commands reject hidden fields and mismatched service inputs', async t => {
  const data = await fixture(t);
  await assert.rejects(applyModelConnectionCommand({
    ...data,
    command: {
      format: MODEL_CONNECTION_COMMAND_FORMAT,
      action: 'configure',
      service: 'chatgpt-subscription',
      baseURL: 'https://models.example.invalid/v1',
      model: 'synthetic/subscription',
    },
  }), /does not accept baseURL/);
  await assert.rejects(applyModelConnectionCommand({
    ...data,
    command: {
      format: MODEL_CONNECTION_COMMAND_FORMAT,
      action: 'forget-api-key',
      confirmation: 'almost',
    },
  }), /FORGET API KEY/);
});
