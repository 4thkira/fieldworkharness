import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  AGENT_COMMAND_FORMAT,
  applyAgentCommand,
  ensureAgentHome,
  FIELDWORK_EXPERT_PRESET_ID,
  loadManagedSettingsSnapshot,
  saveManagedSettings,
} from '../src/agent-management.mjs';
import {
  MODEL_CONNECTION_COMMAND_FORMAT,
  applyModelConnectionCommand,
  effectiveModelApiKey,
  loadFieldworkSecrets,
  secretsFileFor,
} from '../src/model-connection.mjs';
import {
  BRIDGE_COMMAND_FORMAT,
  applyBridgeCommand,
  bridgeSecretsFileFor,
  bridgeSettingsFileFor,
  loadBridgeSecrets,
  loadBridgeSettings,
} from '../src/bridge-management.mjs';
import { openBrowser } from '../src/browser-launch.mjs';
import { readRoomSecret } from '../src/room-secret.mjs';
import { FIELDWORK_RESTART_EXIT_CODE } from './restart-protocol.mjs';

// One-step start: remembers your choices in fieldwork.local.json (ignored by
// git), makes an agent home from the template the first time, starts the room,
// and opens it in your browser. Run with --setup to answer the questions again.
// API keys are never saved in ordinary settings or agent homes. The room may
// ask this supervisor to keep one in a separate ignored secret store;
// FIELDWORK_API_KEY remains an environment fallback.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsFile = process.env.FIELDWORK_SETTINGS
  ? path.resolve(process.env.FIELDWORK_SETTINGS)
  : path.join(repo, 'fieldwork.local.json');
const roomSecretFile = `${settingsFile}.room-secret`;
const secretsFile = secretsFileFor(settingsFile);
const bridgeSecretsFile = bridgeSecretsFileFor(settingsFile);
const TOOL_KITS = ['memory', 'notebook', 'clock', 'web', 'meaning'];
const DEFAULT_TOOL_KITS = ['memory', 'notebook', 'clock'];
const OLLAMA = 'http://127.0.0.1:11434/v1';
const defaults = {
  agentHome: path.join(os.homedir(), 'Fieldwork', 'agent'),
  tools: DEFAULT_TOOL_KITS.join(','),
  port: 4317,
};

function questioner() {
  // In a real terminal, readline needs an output to echo typing into. Piped
  // answers can arrive before a question is asked, so read those line by line.
  const typed = Boolean(process.stdin.isTTY);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: typed, crlfDelay: Infinity });
  const lines = typed ? null : prompt[Symbol.asyncIterator]();
  const ask = async (question, fallback = '') => {
    const label = fallback === '' ? `${question}: ` : `${question} [${fallback}]: `;
    let answer = '';
    if (typed) {
      answer = await new Promise(resolve => prompt.question(label, resolve));
    } else {
      process.stdout.write(label);
      const { value, done } = await lines.next();
      process.stdout.write('\n');
      answer = done ? '' : value;
    }
    return answer.trim() || String(fallback);
  };
  return { ask, close: () => prompt.close() };
}

// The models a ChatGPT subscription offers, if Codex is signed in.
async function subscriptionModels() {
  const { codexAuth } = await import('../src/chatgpt-subscription-provider.mjs');
  const auth = codexAuth();
  if (!(await auth.signedIn())) return { signedIn: false, models: [] };
  try { return { signedIn: true, models: await auth.models() }; }
  catch { return { signedIn: true, models: [] }; }
}

async function askSettings(previous) {
  const { ask, close } = questioner();
  console.log(previous
    ? 'Changing settings. Press Enter to keep the value in brackets.\n'
    : 'First start: a few questions. Press Enter to accept the suggestion in brackets.\n');
  const agentHome = previous?.agentHome ?? path.resolve(await ask('Where should your agent live?', defaults.agentHome));
  if (previous) console.log(`Active agent home: ${agentHome}\nMove or switch agents from the room's Settings menu.`);

  console.log('\nWhich model should your agent think with?');
  console.log('  1) Ollama, running on this computer (free and private; install it from ollama.com)');
  console.log('  2) Your ChatGPT subscription, through the Codex app you are signed in to');
  console.log('  3) Another service: OpenRouter, OpenAI, LM Studio, or anything OpenAI-compatible');
  const before = previous?.service === 'chatgpt-subscription' ? '2' : previous?.baseURL && previous.baseURL !== OLLAMA ? '3' : '1';
  let choice = '';
  while (!['1', '2', '3'].includes(choice)) choice = await ask('Choose 1, 2 or 3', before);

  const registry = previous?.agents ? {
    agentRoot: previous.agentRoot,
    activeAgentId: previous.activeAgentId,
    agents: previous.agents.map(agent => agent.id === previous.activeAgentId ? { ...agent, home: agentHome } : agent),
  } : {};
  const settings = { ...registry, agentHome, service: 'openai-compatible' };
  if (choice === '1') {
    settings.baseURL = OLLAMA;
    settings.model = await ask('Model ID (run "ollama list" to see yours)', previous?.baseURL === OLLAMA ? previous.model : 'qwen3.5:4b');
  } else if (choice === '2') {
    settings.service = 'chatgpt-subscription';
    console.log('\nChecking your Codex sign-in…');
    const { signedIn, models } = await subscriptionModels();
    if (!signedIn) {
      console.log('No ChatGPT sign-in was found. Open the Codex app (or run "codex login"), sign in with ChatGPT,');
      console.log('then run Fieldwork Settings again. Saving your other answers for now.');
    } else if (models.length) {
      console.log(`Your subscription offers: ${models.map(row => row.id).join(', ')}`);
    }
    const suggested = previous?.service === 'chatgpt-subscription' ? previous.model : models.find(row => row.default)?.id ?? models[0]?.id ?? '';
    settings.model = await ask('Model ID', suggested);
    console.log('Note: this uses the same private endpoint as Codex, not a public API. It can change without notice.');
  } else {
    settings.baseURL = await ask('Service URL (for example https://openrouter.ai/api/v1)', previous?.baseURL && previous.baseURL !== OLLAMA ? previous.baseURL : 'https://openrouter.ai/api/v1');
    settings.model = await ask('Model ID', previous?.service !== 'chatgpt-subscription' && previous?.baseURL === settings.baseURL ? previous.model : '');
    console.log('If this service needs a key, add it from Settings → Connection after the room opens, or set FIELDWORK_API_KEY (see the README).');
  }
  console.log('\nYou can switch models later from the Settings panel in the room.\n');

  if (!previous) {
    console.log('Web reading starts off. To keep the defaults and add it, enter memory,notebook,clock,web.');
    console.log('Add "meaning" so memory also finds things said in other words, using a small model on this');
    console.log('computer (with Ollama, run: ollama pull qwen3-embedding:0.6b).');
  }
  const tools = await ask(`Tool kits to grant (${TOOL_KITS.join(', ')}, or none)`, previous?.tools ?? defaults.tools);
  settings.tools = tools.trim().toLowerCase() === 'none' ? '' : tools;
  settings.port = Number(await ask('Room port', previous?.port ?? defaults.port));
  close();
  const saved = await saveManagedSettings(settingsFile, settings);
  console.log(`\nSaved to ${settingsFile}. Run "Fieldwork Settings" to change these later.\n`);
  return saved;
}

const setup = process.argv.includes('--setup');
const savedSnapshot = await loadManagedSettingsSnapshot(settingsFile, { allowMissing: true });
const rawSaved = savedSnapshot?.raw ?? null;
const saved = savedSnapshot?.settings ?? null;
let settings = setup || !saved ? await askSettings(saved) : saved;
if (rawSaved && !setup && JSON.stringify(rawSaved) !== JSON.stringify(saved)) {
  settings = await saveManagedSettings(settingsFile, saved);
}
if (setup && process.argv.includes('--no-start')) process.exit(0);
if (!settings.model) {
  console.log('No model is chosen yet. Run "Fieldwork Settings" to pick one.');
  process.exit(1);
}
let storedSecrets = await loadFieldworkSecrets(secretsFile);
let storedBridgeSecrets = await loadBridgeSecrets(bridgeSecretsFile);
const environmentApiKey = process.env.FIELDWORK_API_KEY || null;
const environmentBridgeTokens = Object.freeze({
  telegram: process.env.FIELDWORK_TELEGRAM_TOKEN || null,
  discord: process.env.FIELDWORK_DISCORD_TOKEN || null,
});
function modelApiKey() {
  return effectiveModelApiKey(settings, storedSecrets, environmentApiKey);
}
function bridgeToken(platform) {
  const saved = storedBridgeSecrets[`${platform}Token`];
  return saved
    ? { token: saved, source: 'saved' }
    : environmentBridgeTokens[platform]
      ? { token: environmentBridgeTokens[platform], source: 'environment' }
      : { token: null, source: 'none' };
}

async function knownPortableSecrets() {
  const values = [
    storedSecrets.apiKey,
    environmentApiKey,
    storedBridgeSecrets.telegramToken,
    storedBridgeSecrets.discordToken,
    environmentBridgeTokens.telegram,
    environmentBridgeTokens.discord,
  ];
  for (const [file, label] of [
    [roomSecretFile, 'supervisor'],
    [path.join(settings.agentHome, 'state', 'room-secret'), 'legacy agent'],
  ]) {
    const bearer = await readRoomSecret(file, { label });
    if (bearer) values.push(bearer);
  }
  return values.filter(value => typeof value === 'string' && value);
}

// If a Fieldwork room already answers on this port (say its window was closed
// while it kept running), open it instead of starting a second one.
async function runningRoom(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    const page = await response.text();
    return /<title>Fieldwork<\/title>/.test(page) ? 'fieldwork' : 'other';
  } catch { return null; }
}

if (settings.port) {
  const found = await runningRoom(settings.port);
  if (found === 'fieldwork') {
    let link = `http://127.0.0.1:${settings.port}/`;
    try {
      const secret = await readRoomSecret(roomSecretFile, { label: 'supervisor' })
        ?? await readRoomSecret(path.join(settings.agentHome, 'state', 'room-secret'), { label: 'legacy agent' });
      if (secret) link += `#token=${secret}`;
    } catch { /* The plain address still works in a browser that has opened it before. */ }
    console.log('Fieldwork is already running, so this opens it instead of starting another.');
    console.log(`Open Fieldwork: ${link}`);
    console.log('To stop it, use the ⏻ button in the top-right corner of the room.');
    openBrowser(link);
    process.exit(0);
  }
  if (found === 'other') {
    console.log(`Something else is already using port ${settings.port}. Run "Fieldwork Settings" and choose another port.`);
    process.exit(1);
  }
}

const agentTemplate = path.join(repo, 'templates', 'agent-home');
const expertTemplate = path.join(repo, 'templates', 'fieldwork-expert');
const activeAgent = settings.agents.find(agent => agent.id === settings.activeAgentId);
const activeTemplate = activeAgent?.preset === FIELDWORK_EXPERT_PRESET_ID ? expertTemplate : agentTemplate;
const homeReceipt = await ensureAgentHome(settings.agentHome, activeTemplate);
if (homeReceipt.created) {
  console.log(`Made a new agent home at ${settings.agentHome}`);
  if (activeAgent?.preset === FIELDWORK_EXPERT_PRESET_ID) {
    console.log('Restored the registered Fieldwork Expert from its packaged starting template.\n');
  } else {
    console.log('Its roots/ files are blank prompts: fill them in to give your agent an identity and voice.');
    console.log('For tips and a worked example, see docs/writing-roots.md in the Fieldwork folder.\n');
  }
}
const subscription = settings.service === 'chatgpt-subscription';
const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(settings.baseURL ?? '');
if (!subscription && !local && !modelApiKey().key) {
  console.log('Note: this model service is not on this machine, and no API key is available.');
  console.log('Open Settings → Connection in the room to save one, or double-click "Set Fieldwork API Key.cmd".\n');
}

function roomArguments(current, startupNotice = null) {
  const usesSubscription = current.service === 'chatgpt-subscription';
  return [
    path.join(repo, 'scripts', 'browser-chat.mjs'),
    '--agent-home', current.agentHome,
    '--settings-file', settingsFile,
    '--room-secret-file', roomSecretFile,
    '--api-key-source', modelApiKey().source,
    '--telegram-token-source', bridgeToken('telegram').source,
    '--discord-token-source', bridgeToken('discord').source,
    ...(storedSecrets.apiKey ? ['--saved-key-present'] : []),
    ...(usesSubscription ? ['--chatgpt-subscription'] : ['--base-url', current.baseURL]),
    '--model', current.model,
    ...(current.tools ? ['--tools', current.tools] : []),
    ...(current.port ? ['--port', String(current.port)] : []),
    ...(current.agentId ? ['--agent-id', current.agentId] : []),
    ...(current.maxOutputTokens ? ['--max-output-tokens', String(current.maxOutputTokens)] : []),
    ...(startupNotice ? [
      '--startup-notice-kind', startupNotice.kind,
      '--startup-notice', startupNotice.message,
    ] : []),
    '--restartable',
  ];
}
let opened = false;
let pendingAgentCommand = null;
let pendingConnectionCommand = null;
let pendingBridgeCommand = null;
let pendingStartupNotice = null;

function browserNotice(message) {
  const suffix = ' … [receipt shortened; exact details remain in the launcher terminal]';
  return message.length <= 4096 ? message : `${message.slice(0, 4096 - suffix.length)}${suffix}`;
}

function completedAgentNotice(result) {
  if (result.action === 'export-agent') {
    const omitted = Object.values(result.portable?.omitted ?? {}).reduce((sum, count) => sum + count, 0);
    return {
      kind: 'success',
      message: browserNotice(`Exported a portable copy to ${result.portable.destination}. ${result.portable.files} files; ${omitted} credential, bridge, or recovery entries stayed behind.`),
    };
  }
  if (result.action === 'import-agent') {
    if (result.publicationWarning) {
      return {
        kind: 'error',
        message: browserNotice(`Imported and registered ${result.imported.name}, but it remains unavailable until its incomplete marker is resolved. ${result.publicationWarning}`),
      };
    }
    return {
      kind: 'success',
      message: browserNotice(`Imported ${result.imported.name} as a separate dormant agent at ${result.imported.home}. Switch explicitly when you want to open it.`),
    };
  }
  if (result.action === 'create-expert' && result.expertDisposition === 'existing') {
    return { kind: 'success', message: 'Switched to the existing Fieldwork Expert.' };
  }
  const messages = {
    create: 'Created and switched to the new agent.',
    'create-expert': 'Added and switched to the Fieldwork Expert.',
    switch: 'Switched agents.',
    rename: 'Renamed the agent.',
    move: 'Moved the agent home.',
    'clear-state': 'Cleared the agent state.',
    'reset-agent': 'Reset the agent from its starting template.',
    'restore-state': 'Restored the agent state.',
    'restore-agent': 'Restored the whole agent home.',
  };
  if (result.restoredFrom) {
    return {
      kind: 'success',
      message: browserNotice(`${messages[result.action]} Restored from: ${result.restoredFrom}.${result.backup ? ` Previous version backup: ${result.backup}` : ''}`),
    };
  }
  return {
    kind: 'success',
    message: browserNotice(`${messages[result.action]}${result.backup ? ` Recovery backup: ${result.backup}` : ''}`),
  };
}

function failedAgentNotice(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AggregateError) {
    return {
      kind: 'error',
      message: browserNotice(`${message} The action and its cleanup or rollback both failed; inspect the reported paths and launcher terminal before retrying.`),
    };
  }
  return {
    kind: 'error',
    message: browserNotice(`${message} Nothing changed. The previous room reopened.`),
  };
}

function completedConnectionNotice(result) {
  return {
    kind: 'success',
    message: result.action === 'forget-api-key'
      ? 'Forgot the supervisor-saved API key. An environment key, if present, remains available.'
      : 'Updated the model connection. The new connection is active now.',
  };
}

function failedConnectionNotice(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AggregateError) {
    return {
      kind: 'error',
      message: browserNotice(`${message} The connection update and its rollback both failed; inspect the launcher settings before retrying.`),
    };
  }
  return {
    kind: 'error',
    message: browserNotice(`${message} Nothing changed. The previous connection reopened.`),
  };
}

function completedBridgeNotice(result) {
  const platform = result.platform === 'telegram' ? 'Telegram' : 'Discord';
  const message = result.action === 'configure'
    ? `${platform} bridge route updated. Its status shows whether the listener connected.`
    : result.action === 'disconnect'
      ? `${platform} bridge disconnected from this agent. Its saved token was left alone.`
      : `Forgot the supervisor-saved ${platform} bot token. An environment token, if present, remains available.`;
  return { kind: 'success', message };
}

function failedBridgeNotice(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AggregateError) {
    return {
      kind: 'error',
      message: browserNotice(`${message} The bridge update and its rollback both failed; inspect the launcher files before retrying.`),
    };
  }
  return {
    kind: 'error',
    message: browserNotice(`${message} Nothing changed. The previous bridge setup reopened.`),
  };
}

async function afterRoomExit(code) {
  if (code !== FIELDWORK_RESTART_EXIT_CODE) {
    process.exit(code ?? 1);
    return;
  }
  pendingStartupNotice = null;
  if (pendingAgentCommand) {
    const command = pendingAgentCommand;
    pendingAgentCommand = null;
    try {
      const result = await applyAgentCommand({
        settings,
        settingsFile,
        templateDir: agentTemplate,
        expertTemplateDir: expertTemplate,
        command,
        knownSecrets: ['export-agent', 'import-agent'].includes(command.action) ? await knownPortableSecrets() : [],
      });
      settings = result.settings;
      pendingStartupNotice = completedAgentNotice(result);
      console.log(`Agent action completed: ${result.action}.`);
      if (result.restoredFrom) console.log(`Restored from: ${result.restoredFrom}`);
      if (result.backup) console.log(`Recovery backup: ${result.backup}`);
      if (result.action === 'export-agent' && result.portable?.destination) console.log(`Portable copy: ${result.portable.destination}`);
      if (result.imported) console.log(`Imported dormant agent: ${result.imported.name} (${result.imported.home})`);
      if (result.publicationWarning) console.error(result.publicationWarning);
      if (!['rename', 'move', 'export-agent', 'import-agent'].includes(result.action)) opened = false;
    } catch (error) {
      pendingStartupNotice = failedAgentNotice(error);
      console.error(error instanceof Error ? error.message : String(error));
      console.error('The requested agent action was not applied; reopening the previous room.');
      opened = false;
    }
  }
  if (pendingConnectionCommand) {
    const command = pendingConnectionCommand;
    pendingConnectionCommand = null;
    try {
      const result = await applyModelConnectionCommand({
        settings,
        settingsFile,
        secretsFile,
        command,
        subscriptionReady: async () => (await subscriptionModels()).signedIn,
      });
      settings = result.settings;
      storedSecrets = await loadFieldworkSecrets(secretsFile);
      pendingStartupNotice = completedConnectionNotice(result);
      console.log(`Model connection action completed: ${result.action}.`);
    } catch (error) {
      pendingStartupNotice = failedConnectionNotice(error);
      console.error(error instanceof Error ? error.message : String(error));
      console.error('The requested model connection change was not applied; reopening the previous room.');
    }
  }
  if (pendingBridgeCommand) {
    const command = pendingBridgeCommand;
    pendingBridgeCommand = null;
    try {
      const result = await applyBridgeCommand({
        settingsFile: bridgeSettingsFileFor(settings.agentHome),
        secretsFile: bridgeSecretsFile,
        command,
      });
      storedBridgeSecrets = await loadBridgeSecrets(bridgeSecretsFile);
      pendingStartupNotice = completedBridgeNotice(result);
      console.log(`Bridge action completed: ${result.platform} ${result.action}.`);
    } catch (error) {
      pendingStartupNotice = failedBridgeNotice(error);
      console.error(error instanceof Error ? error.message : String(error));
      console.error('The requested bridge change was not applied; reopening the previous room.');
    }
  }
  await launchRoom();
}

async function launchRoom() {
  const startupNotice = pendingStartupNotice;
  pendingStartupNotice = null;
  const environment = { ...process.env };
  const access = modelApiKey();
  if (settings.service === 'chatgpt-subscription' || !access.key) delete environment.FIELDWORK_API_KEY;
  else environment.FIELDWORK_API_KEY = access.key;
  const bridgeSettings = await loadBridgeSettings(bridgeSettingsFileFor(settings.agentHome));
  for (const platform of ['telegram', 'discord']) {
    const variable = `FIELDWORK_${platform.toUpperCase()}_TOKEN`;
    const access = bridgeToken(platform);
    if (bridgeSettings[platform] && access.token) environment[variable] = access.token;
    else delete environment[variable];
  }
  const room = spawn(process.execPath, roomArguments(settings, startupNotice), { cwd: repo, env: environment, stdio: ['inherit', 'pipe', 'inherit', 'ipc'] });
  let buffered = '';
  room.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    if (opened) return;
    buffered += chunk.toString('utf8');
    const match = buffered.match(/^Open Fieldwork: (\S+)\r?$/m);
    if (match) { opened = true; openBrowser(match[1]); }
  });
  room.once('error', error => {
    console.error(`Fieldwork could not start: ${error.message}`);
    process.exit(1);
  });
  room.on('message', message => {
    if (!message || typeof message !== 'object'
      || ![AGENT_COMMAND_FORMAT, MODEL_CONNECTION_COMMAND_FORMAT, BRIDGE_COMMAND_FORMAT].includes(message.format)) return;
    if (pendingAgentCommand || pendingConnectionCommand || pendingBridgeCommand) {
      console.error('Ignored a second supervised action while one was already pending.');
      return;
    }
    if (message.format === AGENT_COMMAND_FORMAT) pendingAgentCommand = message;
    else if (message.format === MODEL_CONNECTION_COMMAND_FORMAT) pendingConnectionCommand = message;
    else pendingBridgeCommand = message;
  });
  room.once('exit', code => {
    void afterRoomExit(code).catch(error => {
      console.error(`Fieldwork could not relaunch: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  });
}
// Ctrl+C reaches the room too, which closes its stores cleanly; wait for it.
process.on('SIGINT', () => {});
void launchRoom().catch(error => {
  console.error(`Fieldwork could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
