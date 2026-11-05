import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startBrowserView } from '../src/browser-view.mjs';
import { loadManagedSettings, publicAgentBackups, publicAgentRegistry } from '../src/agent-management.mjs';
import { clockTools, memoryTools, notebookTools, webTools } from '../src/agent-tools.mjs';
import { createConversationArchive, openConversationArchive } from '../src/conversation-archive.mjs';
import { createReplyContextStore, openReplyContextStore } from '../src/reply-context.mjs';
import {
  BRIDGE_OUTPUT_FORMAT,
  createExternalDeliveryCoordinator,
  createExternalDeliveryStore,
  openExternalDeliveryStore,
} from '../src/external-delivery.mjs';
import { createMemoryLedger, openMemoryLedger } from '../src/memory-ledger.mjs';
import { codexAuth, createChatGPTSubscriptionProvider } from '../src/chatgpt-subscription-provider.mjs';
import { createOpenAIChatProvider, listOpenAIModels } from '../src/openai-chat-provider.mjs';
import { loadProfile } from '../src/profile.mjs';
import { createRoomPreferences, roomServiceFingerprint } from '../src/room-preferences.mjs';
import { createToolRegistry } from '../src/tools.mjs';
import { createExpressionStore, expressionTools } from '../src/expression.mjs';
import { createAttachmentStore } from '../src/attachments.mjs';
import { createCheckInStore, restTools } from '../src/check-ins.mjs';
import { createTaskHeartbeatStore } from '../src/task-heartbeats.mjs';
import { createOutsideReaderStore } from '../src/outside-readers.mjs';
import { createGoalRegister, goalRegisterTools } from '../src/goal-register.mjs';
import { createChangeLog } from '../src/change-log.mjs';
import { createShelf } from '../src/shelf.mjs';
import { collectionTools, createCollections } from '../src/collections.mjs';
import { createToolGroupSettings, startingToolGroupModes } from '../src/tool-groups.mjs';
import { createMeaningRecall } from '../src/meaning-recall.mjs';
import { createToolPermissionStore } from '../src/tool-permissions.mjs';
import { createToolEffectStore, openToolEffectStore } from '../src/tool-effects.mjs';
import { builderNoteTools, createBuilderNotes } from '../src/builder-notes.mjs';
import { createModelHistory } from '../src/model-history.mjs';
import { agentGuideTools, createAgentGuideStore } from '../src/agent-guides.mjs';
import { fieldworkHelpTools } from '../src/fieldwork-help.mjs';
import { publicModelConnection } from '../src/model-connection.mjs';
import { OPENAI_CHAT_REASONING_EFFORT_OPTIONS } from '../src/model-effort.mjs';
import { readRoomSecret } from '../src/room-secret.mjs';
import {
  bindBridgeConversation,
  bridgeSettingsFileFor,
  createBridgeBindingCoordinator,
  loadBridgeSettings,
  publicBridgeSettings,
} from '../src/bridge-management.mjs';
import { createTelegramBridge } from '../src/telegram-bridge.mjs';
import { createDiscordBridge } from '../src/discord-bridge.mjs';
import {
  isStateLockFailure,
  recoverAbandonedStateLocks,
  stateLockAdvice,
} from '../src/stale-state-locks.mjs';
import { FIELDWORK_RESTART_EXIT_CODE } from './restart-protocol.mjs';

// "meaning" grants no tool: it adds a meaning seat to the memory kit's
// automatic memory, using an embedding model on this computer.
const TOOL_KITS = ['memory', 'notebook', 'clock', 'web', 'meaning'];
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

const usage = `Usage:
  node scripts/browser-chat.mjs --agent-home <directory> --base-url <url> --model <model-id>
  node scripts/browser-chat.mjs --agent-home <directory> --chatgpt-subscription --model <model-id>
                                [--tools memory,notebook,clock,web,meaning] [--agent-id <id>]
                                [--port <n>] [--max-output-tokens <n>] [--temporary]

Connects the browser room to any OpenAI-compatible Chat Completions service,
or (opt-in) to a ChatGPT subscription through the sign-in the Codex app holds.
The model can be changed later from the room's Settings dialog.

Examples of --base-url:
  http://127.0.0.1:11434/v1      Ollama on this machine (no key needed)
  https://openrouter.ai/api/v1   OpenRouter
  https://api.openai.com/v1      OpenAI

--tools grants tool kits to the agent; none are granted unless named:
  memory     remember, date-aware recall, conversation search, revise_memory, forget, and a small relevant memory foreground
  notebook   list_files, read_file, write_file inside <agent-home>/workspace/
  clock      what_time_is_it
  web        read_web_page (public web only)
  meaning    add one automatic-memory seat chosen by meaning (local Ollama; requires memory)

Memory, conversations, derived context, and non-secret room preferences live in
<agent-home>/state/ and survive restarts. --temporary uses a throwaway folder
instead, removed on exit.

If the service needs a key, put it in the FIELDWORK_API_KEY environment variable.
It is never accepted as a command-line argument, because arguments are visible to
other local processes.`;

const flags = [
  '--agent-home', '--base-url', '--model', '--max-output-tokens', '--tools', '--agent-id', '--port',
  '--settings-file', '--room-secret-file', '--api-key-source', '--startup-notice-kind', '--startup-notice',
  '--telegram-token-source', '--discord-token-source',
];
const switches = ['--temporary', '--chatgpt-subscription', '--restartable', '--saved-key-present'];

function argumentsFrom(argv) {
  const values = Object.create(null);
  const on = new Set();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--help' || name === '-h') return { help: true };
    if (name === '--api-key') throw new Error('--api-key is not accepted; set FIELDWORK_API_KEY instead.');
    if (switches.includes(name)) { on.add(name); continue; }
    if (!flags.includes(name)) throw new Error(`Unknown argument: ${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`Argument was repeated: ${name}`);
    const value = argv[++index];
    if (typeof value !== 'string' || !value) throw new Error(`Argument needs a value: ${name}`);
    values[name] = value;
  }
  const subscription = on.has('--chatgpt-subscription');
  if (subscription && values['--base-url']) throw new Error('--chatgpt-subscription and --base-url cannot be used together.');
  for (const required of ['--agent-home', '--model', ...(subscription ? [] : ['--base-url'])]) {
    if (!values[required]) throw new Error(subscription ? '--agent-home and --model are required.' : '--agent-home, --base-url, and --model are required.');
  }
  let maxOutputTokens;
  if (values['--max-output-tokens'] !== undefined) {
    maxOutputTokens = Number(values['--max-output-tokens']);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('--max-output-tokens must be a positive whole number.');
  }
  const tools = values['--tools'] === undefined ? [] : [...new Set(values['--tools'].split(',').map(name => name.trim()).filter(Boolean))];
  for (const kit of tools) if (!TOOL_KITS.includes(kit)) throw new Error(`Unknown tool kit "${kit}"; choose from ${TOOL_KITS.join(', ')}.`);
  let port = 0;
  if (values['--port'] !== undefined) {
    port = Number(values['--port']);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new Error('--port must be a whole number from 1024 to 65535.');
  }
  const agentId = values['--agent-id'] ?? 'agent';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId)) throw new Error('--agent-id must be letters, digits, and . _ : -');
  let startupNotice = null;
  if (values['--startup-notice-kind'] !== undefined && values['--startup-notice'] === undefined) {
    throw new Error('--startup-notice-kind needs --startup-notice.');
  }
  if (values['--startup-notice'] !== undefined) {
    const kind = values['--startup-notice-kind'] ?? 'info';
    const message = values['--startup-notice'];
    if (!['info', 'success', 'error'].includes(kind)) throw new Error('--startup-notice-kind must be info, success, or error.');
    if (!message.trim() || message.length > 4096 || message.includes('\0')) {
      throw new Error('--startup-notice must be 1-4096 characters of displayable text.');
    }
    startupNotice = Object.freeze({ kind, message });
  }
  const apiKeySource = values['--api-key-source'] ?? null;
  if (apiKeySource !== null && !['none', 'saved', 'environment'].includes(apiKeySource)) {
    throw new Error('--api-key-source must be none, saved, or environment.');
  }
  const telegramTokenSource = values['--telegram-token-source'] ?? (process.env.FIELDWORK_TELEGRAM_TOKEN ? 'environment' : 'none');
  const discordTokenSource = values['--discord-token-source'] ?? (process.env.FIELDWORK_DISCORD_TOKEN ? 'environment' : 'none');
  for (const [name, source] of [['--telegram-token-source', telegramTokenSource], ['--discord-token-source', discordTokenSource]]) {
    if (!['none', 'saved', 'environment'].includes(source)) throw new Error(`${name} must be none, saved, or environment.`);
  }
  return {
    help: false,
    agentHome: path.resolve(values['--agent-home']),
    baseURL: values['--base-url'],
    model: values['--model'],
    maxOutputTokens,
    tools,
    agentId,
    port,
    temporary: on.has('--temporary'),
    restartable: on.has('--restartable'),
    settingsFile: values['--settings-file'] === undefined ? null : path.resolve(values['--settings-file']),
    roomSecretFile: values['--room-secret-file'] === undefined ? null : path.resolve(values['--room-secret-file']),
    apiKeySource,
    telegramTokenSource,
    discordTokenSource,
    savedKeyPresent: on.has('--saved-key-present'),
    startupNotice,
    subscription,
  };
}

const TOOL_EFFECT_STORE_ID = 'fieldwork-tool-effects';
const TOOL_EFFECT_SHUTDOWN_GRACE_MS = 5_000;

// The room's bearer secret, kept beside the state so the launch URL survives a
// restart. Created once with exclusive, owner-only permissions where supported.
async function roomSecret(file, legacyFile = null) {
  const saved = await readRoomSecret(file, { label: 'supervisor' });
  if (saved) return saved;
  if (legacyFile && path.resolve(legacyFile) !== path.resolve(file)) {
    // Legacy state is only a migration source. An unsafe or malformed legacy
    // file is never followed or read past the bound, but it must not prevent a
    // fresh supervisor-owned credential from replacing that old location.
    let legacy = null;
    try { legacy = await readRoomSecret(legacyFile, { label: 'legacy agent' }); }
    catch { /* Ignore an unusable migration source and create a fresh secret. */ }
    if (legacy) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${legacy}\n`, { flag: 'wx', mode: 0o600 });
      return legacy;
    }
  }
  const secret = randomBytes(32).toString('base64url');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${secret}\n`, { flag: 'wx', mode: 0o600 });
  return secret;
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function openAIProviderAccess(baseURL, apiKey, source) {
  const target = new URL(baseURL);
  const local = target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  const label = target.host;
  if (apiKey) {
    return Object.freeze({
      kind: 'api-key', status: 'ready', source, label,
      help: source === 'saved'
        ? 'A supervisor-saved API key is available to this Fieldwork process. The key itself is never returned to the browser.'
        : 'FIELDWORK_API_KEY is available to this Fieldwork process. The key itself is never returned to the browser.',
    });
  }
  if (local) {
    return Object.freeze({
      kind: 'none', status: 'not-needed', source: 'none', label,
      help: 'This model service is on this machine, so Fieldwork will try it without an API key.',
    });
  }
  return Object.freeze({
    kind: 'api-key', status: 'missing', source: 'none', label,
    help: 'This hosted model service needs an API key. Open Settings → Connection to save one, or use “Set Fieldwork API Key.cmd”.',
  });
}

let options;
try { options = argumentsFrom(process.argv.slice(2)); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exitCode = 2;
}

if (options?.help) {
  console.log(usage);
} else if (options) {
  let browserView = null;
  let telegramBridge = null;
  let telegramBridgeFailure = null;
  let discordBridge = null;
  let discordBridgeFailure = null;
  let archive = null;
  let replyContexts = null;
  let externalDeliveries = null;
  let toolEffects = null;
  let ledger = null;
  let runtime = null;
  let closePromise = null;
  let finishPromise = null;

  function finish(code) {
    if (finishPromise) return finishPromise;
    finishPromise = close().then(
      () => process.exit(code),
      error => { console.error(error); process.exit(1); },
    );
    return finishPromise;
  }

  const stop = () => finish(0);
  const restart = () => finish(FIELDWORK_RESTART_EXIT_CODE);

  function close() {
    if (!closePromise) closePromise = closeRoom();
    return closePromise;
  }

  async function closeRoom() {
    const failures = [];
    const settle = async operation => {
      try {
        await operation();
        return null;
      } catch (error) {
        return error;
      }
    };

    // Stop accepting bridge work before asking the room to abort its active
    // turns. The tool-effect store stays open while those turns report their
    // final durable boundaries.
    for (const operation of [() => telegramBridge?.close(), () => discordBridge?.close()]) {
      const failure = await settle(operation);
      if (failure) failures.push(failure);
    }

    let gracefulSettled = false;
    let gracefulErrors = [];
    const gracefulClosing = (async () => {
      // The room owns the active run capabilities. Let its abort/finalization
      // path write every disposition before asking the store to drain.
      const browserFailure = await settle(() => browserView?.close());
      const effectsFailure = await settle(() => toolEffects?.close());
      return [browserFailure, effectsFailure].filter(Boolean);
    })().then(errors => {
      gracefulSettled = true;
      gracefulErrors = errors;
      return errors;
    });
    let graceTimer;
    const gracefulResult = await Promise.race([
      gracefulClosing.then(errors => ({ timedOut: false, errors })),
      new Promise(resolve => {
        graceTimer = setTimeout(() => resolve({ timedOut: true }), TOOL_EFFECT_SHUTDOWN_GRACE_MS);
      }),
    ]);
    let preserveTemporaryRuntime = false;
    if (gracefulResult.timedOut) {
      preserveTemporaryRuntime = true;
      clearTimeout(graceTimer);
      const failure = await settle(() => toolEffects?.forceClose());
      if (failure) failures.push(failure);
      // The room may contain provider or executor code that ignored abort. It
      // no longer owns an effect capability after forceClose, so do not let it
      // hold restart/reset open. Keep its eventual error observable if this
      // process remains alive long enough to receive it.
      if (gracefulSettled) {
        failures.push(...gracefulErrors);
      } else {
        void gracefulClosing.then(errors => {
          if (errors.length) console.error(new AggregateError(errors, 'Fieldwork browser shutdown completed late with an error'));
        });
      }
    } else {
      clearTimeout(graceTimer);
      failures.push(...gracefulResult.errors);
    }

    for (const operation of [
      () => replyContexts?.close(),
      () => externalDeliveries?.close(),
      () => archive?.close(),
      () => ledger?.close(),
    ]) {
      const failure = await settle(operation);
      if (failure) failures.push(failure);
    }
    // A forced room may still have late code holding paths below its temporary
    // runtime. Preserve that directory rather than racing it with recursive
    // deletion; the operating system's temporary-file cleanup can reclaim it.
    if (runtime && options.temporary && !preserveTemporaryRuntime) {
      const failure = await settle(() => fs.rm(runtime, { recursive: true, force: true }));
      if (failure) failures.push(failure);
    }
    if (failures.length) throw new AggregateError(failures, 'Fieldwork browser shutdown failed');
  }

  try {
    const profile = await loadProfile(options.agentHome);

    if (options.temporary) {
      runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-browser-chat-'));
    } else {
      runtime = path.join(options.agentHome, 'state');
      await fs.mkdir(runtime, { recursive: true });
    }
    // Decided before any store creates its files: only an agent that has never
    // held a conversation or memory here starts with the light tool set.
    const startingToolModes = await startingToolGroupModes(runtime);
    if (!options.temporary) {
      const recovery = await recoverAbandonedStateLocks(runtime);
      if (recovery.recovered.length) {
        const names = recovery.recovered.map(row => path.basename(row.file));
        console.log(`Fieldwork did not shut down cleanly last time; safely recovered stale state ${names.length === 1 ? 'lock' : 'locks'}: ${names.join(', ')}.`);
      }
    }
    // Save the one-time new-agent choice before opening ledgers and archives.
    // If a later setup step fails, their newly created files must not make the
    // retry look like an established all-resident room.
    const toolGroups = await createToolGroupSettings({
      file: path.join(runtime, 'tool-groups.json'),
      initialModes: startingToolModes,
    });
    const preferences = await createRoomPreferences({ file: path.join(runtime, 'room-preferences.json') });
    const apiKey = process.env.FIELDWORK_API_KEY || undefined;
    const apiKeySource = apiKey ? (options.apiKeySource ?? 'environment') : 'none';
    const providerAccess = options.subscription
      ? Object.freeze({
        kind: 'subscription', status: 'ready', source: 'codex', label: 'ChatGPT subscription',
        help: 'Fieldwork is using the ChatGPT sign-in held by Codex; no FIELDWORK_API_KEY is needed.',
      })
      : openAIProviderAccess(options.baseURL, apiKey, apiKeySource);
    const service = roomServiceFingerprint(options.subscription
      ? { kind: 'chatgpt-subscription' }
      : { kind: 'openai-compatible', endpoint: new URL(options.baseURL).href });
    const initialModel = preferences.selectedModel({ service, configuredModel: options.model });
    const initialEffort = preferences.selectedReasoningEffort({ service, configuredModel: options.model });

    // One way to build a provider for any model the service offers, so the room
    // can switch models without a restart.
    const auth = options.subscription ? codexAuth() : null;
    if (auth && !(await auth.signedIn())) {
      throw new Error('No ChatGPT sign-in was found. Open the Codex app (or run "codex login"), sign in with ChatGPT, then start Fieldwork again.');
    }
    const providerFor = (model, reasoningEffort = null) => options.subscription
      ? createChatGPTSubscriptionProvider({ model, auth, ...(reasoningEffort ? { reasoningEffort } : {}) })
      : createOpenAIChatProvider({
        baseURL: options.baseURL, model, apiKey, maxOutputTokens: options.maxOutputTokens,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
    const provider = providerFor(initialModel, initialEffort);
    let cachedModels = null;
    const modelRows = async () => {
      if (cachedModels && Date.now() - cachedModels.at < 60_000) return cachedModels.rows;
      const discovered = options.subscription ? await auth.models() : await listOpenAIModels({ baseURL: options.baseURL, apiKey });
      const rows = options.subscription ? discovered : discovered.map(row => ({
        ...row,
        efforts: OPENAI_CHAT_REASONING_EFFORT_OPTIONS,
        effortSource: 'generic',
      }));
      cachedModels = { at: Date.now(), rows };
      return rows;
    };
    const models = {
      current: initialModel,
      effort: initialEffort,
      persistent: !options.temporary,
      list: modelRows,
      async choose(model) {
        const next = providerFor(model, null);
        await preferences.saveModel({ service, configuredModel: options.model, selectedModel: model, reasoningEffort: null });
        models.current = model;
        models.effort = null;
        return next;
      },
      async chooseEffort(reasoningEffort) {
        const row = (await modelRows()).find(candidate => candidate.id === models.current);
        if (reasoningEffort !== null && !row?.efforts?.some(option => option.id === reasoningEffort)) {
          throw new Error(`Reasoning effort ${JSON.stringify(reasoningEffort)} is not offered for model ${JSON.stringify(models.current)}.`);
        }
        const next = providerFor(models.current, reasoningEffort);
        await preferences.saveModel({
          service,
          configuredModel: options.model,
          selectedModel: models.current,
          reasoningEffort,
        });
        models.effort = reasoningEffort;
        return next;
      },
    };
    const ledgerFile = path.join(runtime, 'memory.jsonl');
    const archiveFile = path.join(runtime, 'conversation.jsonl');
    const replyContextFile = path.join(runtime, 'reply-context.jsonl');
    const externalDeliveryFile = path.join(runtime, 'external-delivery.jsonl');
    const toolEffectFile = path.join(runtime, 'tool-effects.jsonl');
    ledger = await exists(ledgerFile)
      ? await openMemoryLedger(ledgerFile)
      : await createMemoryLedger(ledgerFile, { ledgerId: 'fieldwork-memory' });
    archive = await exists(archiveFile)
      ? await openConversationArchive(archiveFile)
      : await createConversationArchive(archiveFile, { archiveId: 'fieldwork-archive' });
    replyContexts = await exists(replyContextFile)
      ? await openReplyContextStore(replyContextFile)
      : await createReplyContextStore(replyContextFile, { id: 'fieldwork-reply-contexts' });
    externalDeliveries = await exists(externalDeliveryFile)
      ? await openExternalDeliveryStore(externalDeliveryFile)
      : await createExternalDeliveryStore(externalDeliveryFile, { id: 'fieldwork-external-deliveries' });
    toolEffects = await exists(toolEffectFile)
      ? await openToolEffectStore(toolEffectFile, { expectedId: TOOL_EFFECT_STORE_ID })
      : await createToolEffectStore(toolEffectFile, { id: TOOL_EFFECT_STORE_ID });

    const definitions = [];
    // Closed, read-only help for the exact documentation shipped with this
    // build. It is available without web or notebook access and remains under
    // its own contextual tool-group switch.
    definitions.push(...await fieldworkHelpTools({ root: packageRoot }));
    // Check-ins, and the agent's own rest from them (not in a temporary room).
    const checkIns = options.temporary ? null : await createCheckInStore({ file: path.join(runtime, 'check-ins.json') });
    const heartbeats = options.temporary ? null : await createTaskHeartbeatStore({ file: path.join(runtime, 'task-heartbeats.json') });
    const goals = options.temporary ? null : await createGoalRegister({ file: path.join(runtime, 'goals.json') });
    const outsideReaders = options.temporary ? null : await createOutsideReaderStore({ file: path.join(runtime, 'outside-readers.json') });
    if (checkIns) definitions.push(...restTools(checkIns));
    if (goals) definitions.push(...goalRegisterTools(goals));
    // Notes from the agent about the room itself, to the person who runs it.
    const builderNotes = await createBuilderNotes({ file: path.join(runtime, 'builder-notes.json') });
    definitions.push(...builderNoteTools(builderNotes));
    if (options.tools.includes('memory')) definitions.push(...memoryTools({ ledger, agentId: options.agentId, conversationArchive: archive }));
    let collections = null;
    if (options.tools.includes('notebook')) {
      definitions.push(...await notebookTools({ root: path.join(options.agentHome, 'workspace') }));
      // Collections live inside the notebook, so they come with it.
      collections = await createCollections({ root: path.join(options.agentHome, 'workspace', 'collections') });
      definitions.push(...collectionTools(collections));
    }
    if (options.tools.includes('clock')) definitions.push(...clockTools());
    if (options.tools.includes('web')) definitions.push(...webTools());
    // The meaning kit: one extra seat for automatic memory, chosen by meaning
    // through a configured loopback service. Fieldwork's request stays local;
    // the operator still has to trust what that service does with the text.
    let meaningRecall = null;
    if (options.tools.includes('meaning')) {
      if (!options.tools.includes('memory')) {
        console.log('The meaning kit works together with the memory kit; add memory to use it.');
      } else {
        meaningRecall = await createMeaningRecall({
          stateDir: runtime,
          ...(process.env.FIELDWORK_MEANING_URL ? { baseURL: process.env.FIELDWORK_MEANING_URL } : {}),
          ...(process.env.FIELDWORK_MEANING_MODEL ? { model: process.env.FIELDWORK_MEANING_MODEL } : {}),
        });
        void meaningRecall.check().then(result => {
          if (!result.ok) {
            console.log(`Meaning recall can't reach ${meaningRecall.model} at ${meaningRecall.baseURL} yet (${result.error}).`);
            console.log(`Start Ollama and run "ollama pull ${meaningRecall.model}". Until then, memory keeps matching words.`);
          }
        });
      }
    }
    // Moods and custom emoji: the agent can always pick a mood the person has
    // defined; with none defined, the tool says so and the room shows nothing.
    const expression = await createExpressionStore({ file: path.join(runtime, 'expression.json') });
    definitions.push(...expressionTools(expression));
    const guides = await createAgentGuideStore({ file: path.join(runtime, 'guides.json') });
    definitions.push(...agentGuideTools(guides, { agentId: options.agentId }));

    const supervisorPerform = options.settingsFile && typeof process.send === 'function'
      ? command => new Promise((resolve, reject) => {
        if (!process.connected || typeof process.send !== 'function') {
          reject(new Error('The Fieldwork supervisor is not connected.'));
          return;
        }
        process.send(command, error => error ? reject(error) : resolve());
      })
      : null;
    const agentManager = supervisorPerform
      ? {
        async snapshot() {
          return publicAgentRegistry(await loadManagedSettings(options.settingsFile));
        },
        async backups() {
          return publicAgentBackups(await loadManagedSettings(options.settingsFile));
        },
        perform: supervisorPerform,
      }
      : null;
    const connectionManager = supervisorPerform
      ? {
        async snapshot() {
          return publicModelConnection(await loadManagedSettings(options.settingsFile), {
            apiKeySource,
            savedKeyPresent: options.savedKeyPresent,
          });
        },
        perform: supervisorPerform,
      }
      : null;
    const bridgeSettingsFile = bridgeSettingsFileFor(options.agentHome);
    let bridgeSettings = options.temporary ? null : await loadBridgeSettings(bridgeSettingsFile);
    const bridgeBindings = bridgeSettings
      ? createBridgeBindingCoordinator({
        settings: bridgeSettings,
        bind: request => bindBridgeConversation(bridgeSettingsFile, request),
      })
      : null;
    const ensureBridgeBinding = async platform => {
      if (!bridgeBindings) return true;
      try {
        const saved = await bridgeBindings.ensure(platform);
        if (saved) bridgeSettings = saved;
        return true;
      } catch (error) {
        const diagnosticId = randomUUID();
        console.error(`[Fieldwork ${platform} binding ${diagnosticId}] ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    const bridgeSources = Object.freeze({
      telegram: options.telegramTokenSource,
      discord: options.discordTokenSource,
    });
    const settingsWithLiveBridgeBindings = () => {
      let effective = bridgeSettings;
      for (const platform of ['telegram', 'discord']) {
        const live = bridgeBindings?.view(platform);
        const route = effective?.[platform];
        if (!live || live.conversationId === null || !route) continue;
        const destinationId = platform === 'telegram' ? route.chatId : route.channelId;
        if (destinationId !== live.destinationId
          || route.allowedUserId !== live.allowedUserId
          || route.scope !== live.scope
          || (platform === 'discord' && route.guildId !== live.guildId)
          || (route.conversationId !== null && route.conversationId !== live.conversationId)) {
          throw new Error(`${platform} live bridge binding differs from saved settings; restart before changing conversation state`);
        }
        if (route.conversationId === null) {
          effective = { ...effective, [platform]: { ...route, conversationId: live.conversationId } };
        }
      }
      return effective;
    };
    const liveBridge = platform => platform === 'telegram' ? telegramBridge : discordBridge;
    // A configured reply bridge does not grant unsolicited-send permission.
    // The person's check-in destination setting selects a platform; this host
    // contract contributes only a durably bound target and revalidates that
    // same route immediately before the durable proactive send fence.
    const checkInBridge = bridgeBindings
      ? Object.freeze({
        proactiveTarget(platform) {
          if (!['telegram', 'discord'].includes(platform)) return null;
          const binding = bridgeBindings.view(platform);
          const bridge = liveBridge(platform);
          if (!bridge || bridge.snapshot().state !== 'connected' || binding.state !== 'saved') return null;
          return Object.freeze({ conversationId: binding.conversationId });
        },
        async deliverProactive(input) {
          if (!input || !['telegram', 'discord'].includes(input.platform)) {
            throw new Error('check-in delivery platform is invalid');
          }
          const bridge = liveBridge(input.platform);
          if (!bridge || bridge.snapshot().state !== 'connected') {
            throw new Error(`${input.platform} is not connected for check-in delivery`);
          }
          await bridgeBindings.drain();
          bridgeSettings = await loadBridgeSettings(bridgeSettingsFile);
          const settings = settingsWithLiveBridgeBindings();
          const binding = bridgeBindings.view(input.platform);
          const route = settings[input.platform];
          if (!route || binding.state !== 'saved'
            || binding.conversationId !== input.conversationId
            || route.conversationId !== input.conversationId) {
            throw new Error(`${input.platform} check-in route changed before delivery`);
          }
          if (input.sourceMessageId !== input.output?.source?.messageId) {
            throw new Error('check-in delivery source does not match its saved reply');
          }
          return bridge.deliverProactive(input.output);
        },
      })
      : null;
    const bridgeManager = bridgeSettings
      ? {
        async snapshot() {
          // A first bridge turn binds its newly created conversation just after
          // the reply is saved. Dependency checks (including conversation
          // archiving) must see that binding rather than a stale pre-bind file.
          await bridgeBindings.drain();
          bridgeSettings = await loadBridgeSettings(bridgeSettingsFile);
          for (const platform of ['telegram', 'discord']) {
            if (bridgeBindings.view(platform).state === 'live-unsaved') await ensureBridgeBinding(platform);
          }
          const telegramStatus = telegramBridge?.snapshot();
          const discordStatus = discordBridge?.snapshot();
          return publicBridgeSettings(settingsWithLiveBridgeBindings(), {
            sources: bridgeSources,
            bindings: {
              telegram: bridgeBindings.view('telegram').state,
              discord: bridgeBindings.view('discord').state,
            },
            live: {
              ...(telegramStatus ? {
                telegram: {
                  state: telegramStatus.state,
                  ...(telegramStatus.lastError ? { detail: telegramStatus.lastError.message } : {}),
                },
              } : telegramBridgeFailure ? {
                telegram: { state: 'failed', detail: telegramBridgeFailure },
              } : {}),
              ...(discordStatus ? {
                discord: {
                  state: discordStatus.state,
                  ...(discordStatus.lastError ? { detail: discordStatus.lastError.message } : {}),
                },
              } : discordBridgeFailure ? {
                discord: { state: 'failed', detail: discordBridgeFailure },
              } : {}),
            },
          });
        },
        ...(supervisorPerform ? { perform: supervisorPerform } : {}),
      }
      : null;

    browserView = await startBrowserView({
      profile,
      provider,
      providerAccess,
      tools: createToolRegistry(definitions),
      models,
      appearanceState: preferences.snapshot().appearance,
      onAppearanceChange: receipt => preferences.saveAppearance({
        revision: receipt.revision,
        settings: receipt.settings,
      }),
      ...(agentManager ? { agentManager } : {}),
      ...(connectionManager ? { connectionManager } : {}),
      ...(bridgeManager ? { bridgeManager } : {}),
      fieldworkDir: path.join(runtime, 'fieldworks'),
      rootHistoryDir: path.join(runtime, 'root-history'),
      lookFile: path.join(runtime, 'look.json'),
      expression,
      guides,
      attachments: await createAttachmentStore({ dir: path.join(runtime, 'attachments') }),
      // A temporary room has no schedule worth keeping.
      ...(checkIns ? { checkIns } : {}),
      ...(checkIns && checkInBridge ? { checkInBridge } : {}),
      ...(heartbeats ? { heartbeats } : {}),
      ...(goals ? { goals } : {}),
      ...(outsideReaders ? { outsideReaders } : {}),
      changeLog: await createChangeLog({ file: path.join(runtime, 'changes.json') }),
      shelf: await createShelf({ dir: path.join(runtime, 'shelf') }),
      ...(options.tools.includes('notebook') ? { notebookRoot: path.join(options.agentHome, 'workspace') } : {}),
      ...(collections ? { collections } : {}),
      toolGroups,
      toolPermissions: await createToolPermissionStore({ file: path.join(runtime, 'tool-permissions.json') }),
      toolEffects,
      builderNotes,
      modelHistory: await createModelHistory({ file: path.join(runtime, 'model-history.json') }),
      compactionDir: path.join(runtime, 'compactions'),
      ...(options.startupNotice ? { startupNotice: options.startupNotice } : {}),
      onRestart: options.restartable ? () => {
        console.log('Restarting Fieldwork (asked from the room)…');
        restart();
      } : undefined,
      onShutdown: () => {
        console.log('Stopping Fieldwork (asked from the room)…');
        stop();
      },
      ledger,
      archive,
      replyContexts,
      externalDeliveries,
      memoryForeground: options.tools.includes('memory'),
      ...(meaningRecall ? { meaningRecall } : {}),
      port: options.port,
      ...(options.temporary ? {} : {
        secret: await roomSecret(options.roomSecretFile ?? path.join(runtime, 'room-secret'), path.join(runtime, 'room-secret')),
      }),
      onError(error, receipt) {
        console.error(`[Fieldwork browser ${receipt.id}] ${error instanceof Error ? error.message : String(error)}`);
      },
    });

    const telegramToken = process.env.FIELDWORK_TELEGRAM_TOKEN || null;
    if (bridgeSettings?.telegram && telegramToken) {
      try {
        const delivery = createExternalDeliveryCoordinator(externalDeliveries, {
          platform: 'telegram',
          destinationId: bridgeSettings.telegram.chatId,
          sourceUserId: bridgeSettings.telegram.allowedUserId,
        }, {
          onError(error) { console.error(`[Fieldwork Telegram delivery receipt] ${error instanceof Error ? error.message : String(error)}`); },
        });
        telegramBridge = createTelegramBridge({
          token: telegramToken,
          route: bridgeSettings.telegram,
          delivery,
          async onMessage(message) {
            try {
              await ensureBridgeBinding('telegram');
              const liveRoute = bridgeBindings.view('telegram');
              const response = await browserView.receiveExternalMessage({
                ...message,
                conversationId: liveRoute.conversationId,
              });
              if (response.saved === false) throw new Error('the bridge reply could not be saved');
              if (!response.replyReference) throw new Error('the saved bridge reply has no stable message reference');
              bridgeBindings.adopt('telegram', response.conversationId);
              await ensureBridgeBinding('telegram');
              return {
                format: BRIDGE_OUTPUT_FORMAT,
                text: response.reply,
                source: { kind: 'conversation-reply', ...response.replyReference },
              };
            } catch (error) {
              const diagnosticId = randomUUID();
              console.error(`[Fieldwork Telegram ${diagnosticId}] ${error instanceof Error ? error.message : String(error)}`);
              return {
                format: BRIDGE_OUTPUT_FORMAT,
                text: 'Fieldwork could not complete that message. Please try again.',
                source: { kind: 'fieldwork-fallback', diagnosticId },
              };
            }
          },
          onStatus(status) {
            if (status.state === 'failed' && status.lastError) console.error(`[Fieldwork Telegram] ${status.lastError.message}`);
          },
        });
        telegramBridge.start();
      } catch (error) {
        telegramBridgeFailure = String(error instanceof Error ? error.message : error)
          .split(telegramToken).join('[redacted]').replace(/[\r\n]+/g, ' ').slice(0, 500);
        console.error(`[Fieldwork Telegram] ${telegramBridgeFailure}`);
      }
    }

    const discordToken = process.env.FIELDWORK_DISCORD_TOKEN || null;
    if (bridgeSettings?.discord && discordToken) {
      try {
        const delivery = createExternalDeliveryCoordinator(externalDeliveries, {
          platform: 'discord',
          destinationId: bridgeSettings.discord.channelId,
          sourceUserId: bridgeSettings.discord.allowedUserId,
        }, {
          onError(error) { console.error(`[Fieldwork Discord delivery receipt] ${error instanceof Error ? error.message : String(error)}`); },
        });
        discordBridge = createDiscordBridge({
          token: discordToken,
          route: bridgeSettings.discord,
          delivery,
          async onMessage(message) {
            try {
              await ensureBridgeBinding('discord');
              const liveRoute = bridgeBindings.view('discord');
              const response = await browserView.receiveExternalMessage({
                ...message,
                conversationId: liveRoute.conversationId,
              });
              if (response.saved === false) throw new Error('the bridge reply could not be saved');
              if (!response.replyReference) throw new Error('the saved bridge reply has no stable message reference');
              bridgeBindings.adopt('discord', response.conversationId);
              await ensureBridgeBinding('discord');
              return {
                format: BRIDGE_OUTPUT_FORMAT,
                text: response.reply,
                source: { kind: 'conversation-reply', ...response.replyReference },
              };
            } catch (error) {
              const diagnosticId = randomUUID();
              console.error(`[Fieldwork Discord ${diagnosticId}] ${error instanceof Error ? error.message : String(error)}`);
              return {
                format: BRIDGE_OUTPUT_FORMAT,
                text: 'Fieldwork could not complete that message. Please try again.',
                source: { kind: 'fieldwork-fallback', diagnosticId },
              };
            }
          },
          onStatus(status) {
            if (status.state === 'failed' && status.lastError) console.error(`[Fieldwork Discord] ${status.lastError.message}`);
          },
        });
        discordBridge.start();
      } catch (error) {
        discordBridgeFailure = String(error instanceof Error ? error.message : error)
          .split(discordToken).join('[redacted]').replace(/[\r\n]+/g, ' ').slice(0, 500);
        console.error(`[Fieldwork Discord] ${discordBridgeFailure}`);
      }
    }

    console.log('Fieldwork is running!\n');
    console.log(`Open Fieldwork: ${browserView.url}`);
    console.log(options.subscription
      ? `  Model:  ${initialModel} through your ChatGPT subscription (Codex sign-in)`
      : `  Model:  ${initialModel} at ${options.baseURL}${apiKey ? ` (using ${apiKeySource === 'saved' ? 'a supervisor-saved API key' : 'FIELDWORK_API_KEY'})` : ''}`);
    console.log(`  Tools:  ${options.tools.length ? options.tools.join(', ') : 'none'}`);
    console.log(`  Saved:  ${options.temporary ? 'nothing (temporary session)' : runtime}`);
    if (bridgeSettings?.telegram) {
      console.log(`  Telegram: ${telegramBridge ? 'listening on the configured route' : telegramBridgeFailure ? 'configured, but the listener could not start' : 'configured, but no bot token is available'}`);
    }
    if (bridgeSettings?.discord) {
      console.log(`  Discord: ${discordBridge ? 'listening on the configured route' : discordBridgeFailure ? 'configured, but the listener could not start' : 'configured, but no bot token is available'}`);
    }
    console.log('');
    console.log('The end of that link is the room\'s password, so keep it private. Open it once and this');
    console.log(options.port && !options.temporary
      ? `browser remembers it; after that, http://127.0.0.1:${options.port}/ is enough, even after a restart.`
      : 'browser remembers it for this address. Use --port to keep the same address across restarts.');
    console.log('\nTo stop Fieldwork, press Ctrl+C in this window.');

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    // Closing the terminal window sends SIGHUP on Windows (and on other systems
    // when the terminal goes away); Ctrl+Break sends SIGBREAK. Close cleanly so
    // the agent's locks are released instead of left behind.
    process.once('SIGHUP', stop);
    if (process.platform === 'win32') process.once('SIGBREAK', stop);
    await new Promise(() => {});
  } catch (error) {
    try { await close(); } catch (closeError) { console.error(closeError); }
    const advice = !options.temporary && isStateLockFailure(error)
      ? await stateLockAdvice(path.join(options.agentHome, 'state'))
      : '';
    if (!advice) throw error;
    console.error(advice);
    process.exit(1);
  }
}
