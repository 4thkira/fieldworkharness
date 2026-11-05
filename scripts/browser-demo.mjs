import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startBrowserView } from '../src/browser-view.mjs';
import { createConversationArchive } from '../src/conversation-archive.mjs';
import { createReplyContextStore } from '../src/reply-context.mjs';
import { createMemoryLedger } from '../src/memory-ledger.mjs';
import { loadProfile } from '../src/profile.mjs';
import { createMemoryRecord, createRetrievedEvidence, createSourceReference } from '../src/provenance.mjs';
import { createToolRegistry } from '../src/tools.mjs';
import { createTaskHeartbeatStore } from '../src/task-heartbeats.mjs';
import { createOutsideReaderStore } from '../src/outside-readers.mjs';
import { createGoalRegister, goalRegisterTools } from '../src/goal-register.mjs';
import { removeAbandonedDemoFolders } from './demo-leftovers.mjs';

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-browser-demo-'));
const leftovers = await removeAbandonedDemoFolders({ keep: runtime });
if (leftovers.removed.length) {
  console.log(`Removed ${leftovers.removed.length} leftover demo ${leftovers.removed.length === 1 ? 'folder' : 'folders'} from earlier runs that stopped without Ctrl+C.`);
}
const at = new Date().toISOString();
const actor = { kind: 'operator', id: 'fieldwork-demo' };
let browserView = null;
let archive = null;
let replyContexts = null;
let ledger = null;
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
    () => fs.rm(runtime, { recursive: true, force: true }),
  ]) {
    try { await operation(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Fieldwork browser demo shutdown failed');
}

try {
  const profile = await loadProfile(fileURLToPath(new URL('../templates/agent-home/', import.meta.url)));
  ledger = await createMemoryLedger(path.join(runtime, 'memory.jsonl'), { ledgerId: 'fieldwork-demo-memory' });
  archive = await createConversationArchive(path.join(runtime, 'conversation.jsonl'), { archiveId: 'fieldwork-demo-archive' });
  replyContexts = await createReplyContextStore(path.join(runtime, 'reply-context.jsonl'), { id: 'fieldwork-demo-reply-contexts' });

  const source = createSourceReference({
    kind: 'document',
    id: 'fieldwork-demo-route-note',
    locator: 'synthetic-note-1',
    sha256: sha256('synthetic browser demo source'),
    observedThrough: at,
  });
  const amberEvidence = createRetrievedEvidence({
    source,
    excerpt: 'The demonstration route uses the amber gate.',
    retrievedAt: at,
    retrieval: { method: 'manual', queryHash: sha256('amber gate'), rank: 1, score: 1 },
  });
  const amber = createMemoryRecord({
    id: 'observation:demo-route',
    kind: 'observation',
    text: 'The demonstration route uses the amber gate.',
    author: actor,
    createdAt: at,
    basis: 'source-backed',
    confidence: 'supported',
    sources: [source],
    evidence: [amberEvidence],
  });
  const first = await ledger.record(amber);
  const cobaltEvidence = createRetrievedEvidence({
    source,
    excerpt: 'Correction: the demonstration route uses the cobalt gate.',
    retrievedAt: at,
    retrieval: { method: 'manual', queryHash: sha256('cobalt gate'), rank: 1, score: 1 },
  });
  const cobalt = createMemoryRecord({
    id: amber.id,
    kind: 'observation',
    text: 'The demonstration route uses the cobalt gate.',
    author: actor,
    createdAt: at,
    basis: 'source-backed',
    confidence: 'supported',
    sources: [source],
    evidence: [cobaltEvidence],
  });
  await ledger.supersede({
    id: amber.id,
    expectedFingerprint: first.currentFingerprint,
    expectedSequence: first.lastSequence,
    replacement: cobalt,
    reason: 'Demonstrate explicit correction and historical retrieval.',
    actor,
  });

  const goals = await createGoalRegister({ file: path.join(runtime, 'goals.json') });
  const tools = createToolRegistry([{
    name: 'describe_workspace',
    description: 'Return a bounded description of this synthetic demonstration workspace.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ kind: 'synthetic-demo', durableChanges: false }),
  }, ...goalRegisterTools(goals)]);
  const provider = {
    id: 'fieldwork/demo-provider',
    complete(request) {
      const outsideReview = request.tools?.some(tool => tool.function?.name === 'report_outside_review');
      if (outsideReview) {
        const reported = request.messages.some(message => message.role === 'tool');
        if (!reported) {
          return {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'fieldwork-demo-outside-review',
              type: 'function',
              function: { name: 'report_outside_review', arguments: '{"outcome":"no-findings"}' },
            }],
          };
        }
        return { role: 'assistant', content: 'Synthetic outside review recorded.' };
      }
      return {
        role: 'assistant',
        content: 'The injected demonstration provider received this turn. In Memory, search current state for “cobalt gate” or switch to history and search for “amber gate”.',
      };
    },
  };
  const heartbeats = await createTaskHeartbeatStore({ file: path.join(runtime, 'task-heartbeats.json') });
  const outsideReaders = await createOutsideReaderStore({ file: path.join(runtime, 'outside-readers.json') });

  browserView = await startBrowserView({
    profile,
    provider,
    tools,
    ledger,
    archive,
    replyContexts,
    heartbeats,
    goals,
    outsideReaders,
    memoryForeground: true,
    onError(error, receipt) {
      console.error(`[Fieldwork browser ${receipt.id}] ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  console.log(`Fieldwork browser demo: ${browserView.url}`);
  console.log('This is an explicit synthetic demo. Press Ctrl+C to stop and remove its temporary state.');

  const stop = signal => {
    close().then(
      () => process.exit(0),
      error => { console.error(error); process.exit(1); },
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // Windows: closing the console window (SIGHUP) or Ctrl+Break (SIGBREAK).
  process.once('SIGHUP', stop);
  process.once('SIGBREAK', stop);
  await new Promise(() => {});
} catch (error) {
  try { await close(); } catch (closeError) { console.error(closeError); }
  throw error;
}
