import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { startBrowserView } from '../src/browser-view.mjs';
import { createConversationArchive } from '../src/conversation-archive.mjs';
import { createReplyContextStore } from '../src/reply-context.mjs';
import { createMemoryLedger } from '../src/memory-ledger.mjs';
import { OPENCODE_CLIENT_VERSION, validateOpenCodeServiceEndpoint } from '../src/opencode-service-endpoint.mjs';
import { createOpenCodeTextProvider, parseOpenCodeModel } from '../src/opencode-text-provider.mjs';
import { loadProfile } from '../src/profile.mjs';

const usage = `Usage:
  node scripts/browser-opencode.mjs --agent-home <directory> --model <provider/model[#variant]>

The host discovers an already-running OpenCode V2 service and uses its active provider account.
It never asks Fieldwork for an API key. The compatibility bridge is text-only and grants no tools.`;

function argumentsFrom(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--help' || name === '-h') return { help: true };
    if (!['--agent-home', '--model', '--runtime-root'].includes(name)) throw new Error(`Unknown argument: ${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`Argument was repeated: ${name}`);
    const value = argv[++index];
    if (typeof value !== 'string' || !value) throw new Error(`Argument needs a value: ${name}`);
    values[name] = value;
  }
  if (!values['--agent-home'] || !values['--model']) throw new Error('Both --agent-home and --model are required.');
  return {
    help: false,
    agentHome: path.resolve(values['--agent-home']),
    modelSelector: values['--model'],
    runtimeRoot: path.resolve(values['--runtime-root'] ?? os.tmpdir()),
  };
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
  let archive = null;
  let replyContexts = null;
  let ledger = null;
  let runtime = null;
  let closing = false;

  async function close() {
    if (closing) return;
    closing = true;
    const failures = [];
    for (const operation of [
      () => browserView?.close(),
      () => replyContexts?.close(),
      () => archive?.close(),
      () => ledger?.close(),
      () => runtime && fs.rm(runtime, { recursive: true, force: true }),
    ]) {
      try { await operation(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Fieldwork OpenCode browser shutdown failed');
  }

  try {
    const model = parseOpenCodeModel(options.modelSelector);
    const profile = await loadProfile(options.agentHome);
    const discoveredEndpoint = await Service.discover({ version: OPENCODE_CLIENT_VERSION });
    if (!discoveredEndpoint) {
      throw new Error(`No compatible OpenCode V2 ${OPENCODE_CLIENT_VERSION} service is running. Start or update OpenCode Desktop, then try again.`);
    }
    const endpoint = validateOpenCodeServiceEndpoint(discoveredEndpoint);
    const client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
    });
    const provider = createOpenCodeTextProvider({
      model,
      generateText: (request, requestOptions) => client.experimental.generate.text(request, requestOptions),
    });

    await fs.mkdir(options.runtimeRoot, { recursive: true });
    runtime = await fs.mkdtemp(path.join(options.runtimeRoot, 'fieldwork-browser-opencode-'));
    ledger = await createMemoryLedger(path.join(runtime, 'memory.jsonl'), { ledgerId: 'fieldwork-opencode-memory' });
    archive = await createConversationArchive(path.join(runtime, 'conversation.jsonl'), { archiveId: 'fieldwork-opencode-archive' });
    replyContexts = await createReplyContextStore(path.join(runtime, 'reply-context.jsonl'), { id: 'fieldwork-opencode-reply-contexts' });
    browserView = await startBrowserView({
      profile,
      provider,
      ledger,
      archive,
      replyContexts,
      onError(error, receipt) {
        console.error(`[Fieldwork browser ${receipt.id}] ${error instanceof Error ? error.message : String(error)}`);
      },
    });

    console.log(`Fieldwork OpenCode browser: ${browserView.url}`);
    console.log(`Model selected at host startup: ${options.modelSelector}`);
    console.log('Provider credentials remain in OpenCode. This compatibility bridge is text-only and grants no tools.');
    console.log('Press Ctrl+C to stop and remove the temporary runtime state.');

    const stop = () => {
      close().then(
        () => process.exit(0),
        error => { console.error(error); process.exit(1); },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await new Promise(() => {});
  } catch (error) {
    try { await close(); } catch (closeError) { console.error(closeError); }
    throw error;
  }
}
