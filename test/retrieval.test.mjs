import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createConversationArchive, openConversationArchive,
} from '../src/conversation-archive.mjs';
import { createMemoryLedger, openMemoryLedger } from '../src/memory-ledger.mjs';
import {
  createMemoryRecord, isMemoryRecord, isRetrievedEvidence,
} from '../src/provenance.mjs';
import {
  recentMemories,
  renderRetrievalContext, retrieveConversationEvidence,
  searchCurrentMemories, searchDueMemories, searchMemoryHistory,
} from '../src/retrieval.mjs';

const at = '2035-01-02T03:04:05.000Z';
const clock = () => new Date(at);
const agent = { kind: 'agent', id: 'benchmark-agent' };
const operator = { kind: 'operator', id: 'benchmark-operator' };
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-retrieval-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function authored(id, text, extra = {}) {
  return createMemoryRecord({
    id, kind: 'authored-memory', text, author: agent, createdAt: at,
    basis: 'self-authored', confidence: 'asserted',
    ...extra,
  });
}

async function fixture(t) {
  const directory = await temporary(t);
  const archiveFile = path.join(directory, 'conversation.jsonl');
  const ledgerFile = path.join(directory, 'memory.jsonl');
  let archive = await createConversationArchive(archiveFile, {
    archiveId: 'benchmark-archive', clock, sync: false,
  });
  await archive.append({
    conversationId: 'benchmark-conversation', messageId: 'message-001', observedAt: at,
    message: { role: 'user', content: 'Status report: the atlas route uses the amber gate.' },
  });
  await archive.append({
    conversationId: 'benchmark-conversation', messageId: 'message-002', observedAt: at,
    message: { role: 'user', content: 'Correction: the atlas route uses the cobalt gate.' },
  });
  const amberSearch = await retrieveConversationEvidence(archive, {
    conversationId: 'benchmark-conversation', messageId: 'message-001',
    query: 'atlas route uses the amber gate', retrievedAt: at,
  });
  const cobaltSearch = await retrieveConversationEvidence(archive, {
    conversationId: 'benchmark-conversation', messageId: 'message-002',
    query: 'atlas route uses the cobalt gate', retrievedAt: at,
  });
  const amberEvidence = amberSearch.results[0].evidence;
  const cobaltEvidence = cobaltSearch.results[0].evidence;
  const archiveHead = (await archive.receipt()).head;
  await archive.close();
  archive = await openConversationArchive(archiveFile, {
    expectedArchiveId: 'benchmark-archive', expectedHead: archiveHead, clock, sync: false,
  });

  let ledger = await createMemoryLedger(ledgerFile, {
    ledgerId: 'benchmark-ledger', clock, sync: false,
  });
  const routeAmber = createMemoryRecord({
    id: 'observation:route', kind: 'observation', text: 'The atlas route uses the amber gate.',
    author: agent, createdAt: at, basis: 'source-backed', confidence: 'supported',
    evidence: [amberEvidence],
  });
  const routeCobalt = createMemoryRecord({
    id: 'observation:route', kind: 'observation', text: 'The atlas route uses the cobalt gate.',
    author: agent, createdAt: at, basis: 'source-backed', confidence: 'supported',
    evidence: [cobaltEvidence],
  });
  let view = await ledger.record(routeAmber);
  view = await ledger.supersede({
    id: routeAmber.id, expectedFingerprint: routeAmber.fingerprint, expectedSequence: view.lastSequence,
    replacement: routeCobalt, actor: agent, reason: 'The later source corrected the route.',
  });

  const quiet = authored('memory:mode', 'Workshop mode is quiet.');
  const loud = authored('memory:mode', 'Workshop mode is loud.');
  view = await ledger.record(quiet);
  view = await ledger.supersede({
    id: quiet.id, expectedFingerprint: quiet.fingerprint, expectedSequence: view.lastSequence,
    replacement: loud, actor: agent, reason: 'Synthetic intermediate revision.',
  });
  await ledger.restore({
    id: quiet.id, expectedFingerprint: loud.fingerprint, expectedSequence: view.lastSequence,
    targetFingerprint: quiet.fingerprint, actor: agent, reason: 'Restore the earlier quiet mode.',
  });

  const signal = authored('memory:signal', 'The harbor signal is three bells.');
  view = await ledger.record(signal);
  await ledger.retract({
    id: signal.id, expectedFingerprint: signal.fingerprint, expectedSequence: view.lastSequence,
    actor: operator, reason: 'The signal is no longer valid.',
  });

  const rankA = authored('memory:rank-a', 'Glass orchard protocol.');
  const rankB = authored('memory:rank-b', 'Glass orchard protocol.');
  const rankC = authored('memory:rank-c', 'Glass notes describe an orchard; the protocol follows.');
  const adjacent = authored('memory:adjacent', 'Silver lantern rests near river.');
  const scattered = authored('memory:scattered', 'Silver rests lantern near river.');
  const partial = authored('memory:partial', 'Silver lantern rests nearby.');
  const budgetShort = authored('memory:budget-short', 'Budget marker zephyr.');
  const budgetLong = authored(
    'memory:budget-long',
    `LONG_ONLY_START ${'filler '.repeat(300)}Budget marker zephyr. LONG_ONLY_END`,
  );
  const typedObservation = createMemoryRecord({
    id: 'observation:typed', kind: 'observation', text: 'Typed marker observation.',
    author: agent, createdAt: at, basis: 'source-backed', confidence: 'supported',
    sources: [cobaltEvidence.source],
  });
  const typedMemory = authored('memory:typed', 'Typed marker memory.');
  const typedSummary = createMemoryRecord({
    id: 'summary:typed', kind: 'summary', text: 'Typed marker summary.',
    author: { kind: 'model', id: 'benchmark-summary-model' }, createdAt: at,
    basis: 'source-backed', confidence: 'supported', sources: [cobaltEvidence.source],
  });
  for (const record of [
    rankA, rankB, rankC, adjacent, scattered, partial, budgetShort, budgetLong,
    typedObservation, typedMemory, typedSummary,
  ]) await ledger.record(record);

  const ledgerHead = (await ledger.receipt()).head;
  await ledger.close();
  ledger = await openMemoryLedger(ledgerFile, {
    expectedLedgerId: 'benchmark-ledger', expectedHead: ledgerHead, clock, sync: false,
  });
  t.after(async () => {
    await Promise.allSettled([archive.close(), ledger.close()]);
  });
  return {
    directory, archive, ledger,
    routeAmber, routeCobalt, quiet, loud, signal,
    rankA, rankB, rankC, adjacent, scattered, partial, budgetShort, budgetLong,
    amberEvidence, cobaltEvidence,
  };
}

test('current retrieval follows corrections, restoration and retraction rather than newest history', async t => {
  const data = await fixture(t);
  assert.deepEqual((await searchCurrentMemories(data.ledger, { query: 'amber gate' })).results, []);

  const cobalt = await searchCurrentMemories(data.ledger, { query: 'cobalt gate' });
  assert.equal(cobalt.results.length, 1);
  assert.equal(cobalt.results[0].record.fingerprint, data.routeCobalt.fingerprint);
  assert.deepEqual(cobalt.results[0].record.sources, [data.cobaltEvidence.source]);
  assert.deepEqual(cobalt.results[0].record.evidence, [data.cobaltEvidence.fingerprint]);
  assert.equal(isMemoryRecord(cobalt.results[0].record), true);
  assert.equal(cobalt.results[0].state, 'current');
  assert.doesNotMatch(JSON.stringify(cobalt.receipt), /cobalt gate|atlas route/i);
  const indexedReceipt = await data.ledger.receipt();
  assert.deepEqual(cobalt.receipt.index, {
    kind: 'memory-ledger',
    ledgerId: indexedReceipt.ledgerId,
    events: indexedReceipt.events,
    head: indexedReceipt.head,
  });

  const quiet = await searchCurrentMemories(data.ledger, { query: 'workshop quiet' });
  assert.equal(quiet.results[0].record.fingerprint, data.quiet.fingerprint);
  assert.ok(quiet.results[0].lastSequence > quiet.results[0].revisionSequence);
  assert.deepEqual((await searchCurrentMemories(data.ledger, { query: 'workshop loud' })).results, []);
  assert.deepEqual((await searchCurrentMemories(data.ledger, { query: 'harbor signal' })).results, []);

  const amberHistory = await searchMemoryHistory(data.ledger, { query: 'amber gate' });
  assert.equal(amberHistory.results[0].record.fingerprint, data.routeAmber.fingerprint);
  assert.equal(amberHistory.results[0].state, 'superseded');
  const loudHistory = await searchMemoryHistory(data.ledger, { query: 'workshop loud' });
  assert.equal(loudHistory.results[0].record.fingerprint, data.loud.fingerprint);
  assert.equal(loudHistory.results[0].state, 'superseded');
  const signalHistory = await searchMemoryHistory(data.ledger, { query: 'harbor signal' });
  assert.equal(signalHistory.results[0].record.fingerprint, data.signal.fingerprint);
  assert.equal(signalHistory.results[0].state, 'retracted');
  const quietHistory = await searchMemoryHistory(data.ledger, { query: 'workshop quiet' });
  assert.equal(quietHistory.results[0].state, 'current');
  const currentBytes = cobalt.receipt.corpus.sourceTextBytes;
  const boundedCurrent = await searchCurrentMemories(data.ledger, { query: 'cobalt gate' }, {
    maxIndexBytes: currentBytes,
  });
  assert.equal(boundedCurrent.receipt.corpus.sourceTextBytes, currentBytes);
  await assert.rejects(searchMemoryHistory(data.ledger, { query: 'cobalt gate' }, {
    maxIndexBytes: currentBytes,
  }), /source text exceeds/);
  await assert.rejects(
    searchCurrentMemories(data.ledger, { query: 'amber gate', includeHistory: true }),
    /unknown field "includeHistory"/,
  );
  const savedIndex = structuredClone(cobalt.receipt.index);
  await data.ledger.record(authored('memory:index-advance', 'An unrelated index advance marker.'));
  const advanced = await data.ledger.receipt();
  assert.notEqual(advanced.head, savedIndex.head);
  assert.deepEqual(cobalt.receipt.index, savedIndex, 'a saved retrieval keeps the exact head it indexed');
});

test('current, due, and history retrieval keep lifecycle meanings separate', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-retrieval-lifecycle-'));
  const ledger = await createMemoryLedger(path.join(directory, 'lifecycle.jsonl'), { ledgerId: 'lifecycle-ledger', clock });
  t.after(async () => { await ledger.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const records = [
    authored('memory:legacy-marker', 'Lifecycle marker legacy fact.'),
    authored('memory:ready-marker', 'Lifecycle marker ready reminder.', {
      lifecycle: { type: 'reminder', notBefore: at },
    }),
    authored('memory:future-marker', 'Lifecycle marker future reminder.', {
      lifecycle: { type: 'reminder', notBefore: '2035-02-01T00:00:00.000Z' },
    }),
    authored('memory:expired-marker', 'Lifecycle marker expired verdict.', {
      lifecycle: {
        type: 'verdict', expiresAt: '2035-01-01T00:00:00.000Z',
        evidence: 'A synthetic check failed.', changeCriteria: 'A synthetic check succeeds.',
      },
    }),
  ];
  for (const record of records) await ledger.record(record);

  const current = await searchCurrentMemories(ledger, { query: 'lifecycle marker', limit: 10 }, { now: at });
  assert.deepEqual(current.results.map(result => result.logicalId).sort(), ['memory:legacy-marker', 'memory:ready-marker']);
  assert.equal(current.results.find(result => result.logicalId === 'memory:ready-marker').lifecycleStatus.due, true);
  assert.deepEqual(current.receipt.lifecycle, {
    asOf: at, considered: 4, included: 2, scheduled: 1, expired: 1, due: 2,
  });

  const dueRecords = await searchDueMemories(ledger, { query: 'lifecycle marker', limit: 10 }, { now: at });
  assert.deepEqual(dueRecords.results.map(result => result.logicalId).sort(), ['memory:expired-marker', 'memory:ready-marker']);
  assert.equal(dueRecords.results.find(result => result.logicalId === 'memory:expired-marker').lifecycleStatus.eligible, false);

  const dueRecent = await recentMemories(ledger, { mode: 'due', limit: 10, now: at });
  assert.deepEqual(dueRecent.results.map(result => result.logicalId).sort(), ['memory:expired-marker', 'memory:ready-marker']);
  assert.equal(dueRecent.receipt.index.kind, 'memory-ledger');
  assert.equal(dueRecent.receipt.index.head, (await ledger.receipt()).head);

  const history = await searchMemoryHistory(ledger, { query: 'lifecycle marker', limit: 10 }, { now: at });
  assert.equal(history.results.length, 4);
  assert.equal(history.results.find(result => result.logicalId === 'memory:future-marker').lifecycleStatus.phase, 'scheduled');
});

test('retrieval context refuses a current result after its lifecycle clock crosses', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-retrieval-clock-edge-'));
  const ledger = await createMemoryLedger(path.join(directory, 'clock-edge.jsonl'), { ledgerId: 'clock-edge-ledger', clock });
  t.after(async () => { await ledger.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await ledger.record(authored('memory:clock-edge', 'Clock edge marker verdict.', {
    lifecycle: {
      type: 'verdict', expiresAt: at,
      evidence: 'A synthetic check failed.', changeCriteria: 'A synthetic check succeeds.',
    },
  }));
  const before = '2035-01-02T03:04:04.000Z';
  const search = await searchCurrentMemories(ledger, { query: 'clock edge marker' }, { now: before });
  assert.equal(search.results.length, 1);
  assert.match((await renderRetrievalContext({ memory: [search], asOf: before })).text, /Clock edge marker/);
  await assert.rejects(
    renderRetrievalContext({ memory: [search], asOf: at }),
    /crossed a lifecycle clock/,
  );
});

test('fixed-point ranking is stable across ties, insertion order and restart', async t => {
  const data = await fixture(t);
  const first = await searchCurrentMemories(data.ledger, { query: 'Glass orchard protocol.', limit: 3 });
  assert.deepEqual(first.results.map(result => result.logicalId), [
    'memory:rank-a', 'memory:rank-b', 'memory:rank-c',
  ]);
  assert.deepEqual(first.results.map(result => result.match.method), ['exact', 'exact', 'lexical']);
  assert.equal(first.results[0].match.scorePpm, first.results[1].match.scorePpm);
  assert.equal(first.results[0].match.scorePpm, 999_999);

  const adjacency = await searchCurrentMemories(data.ledger, {
    query: 'silver lantern river', limit: 3,
  });
  assert.deepEqual(adjacency.results.map(result => result.logicalId), [
    'memory:adjacent', 'memory:scattered',
  ]);
  assert.deepEqual(adjacency.results.map(result => result.match.scorePpm), [462_499, 424_999]);

  const secondFile = path.join(data.directory, 'reverse-memory.jsonl');
  let secondLedger = await createMemoryLedger(secondFile, {
    ledgerId: 'reverse-ledger', clock, sync: false,
  });
  for (const record of [data.rankC, data.rankB, data.rankA]) await secondLedger.record(record);
  const liveSecond = await searchCurrentMemories(secondLedger, { query: 'Glass orchard protocol.', limit: 3 });
  const head = (await secondLedger.receipt()).head;
  await secondLedger.close();
  secondLedger = await openMemoryLedger(secondFile, { expectedHead: head, clock, sync: false });
  const second = await searchCurrentMemories(secondLedger, { query: 'Glass orchard protocol.', limit: 3 });
  const project = search => search.results.map(result => ({
    id: result.logicalId,
    fingerprint: result.record.fingerprint,
    method: result.match.method,
    rank: result.match.rank,
    score: result.match.score,
  }));
  assert.deepEqual(project(liveSecond), project(first));
  assert.deepEqual(project(second), project(first));
  await secondLedger.close();
});

test('exact conversation retrieval re-reads verified source text without becoming memory', async t => {
  const data = await fixture(t);
  const query = 'Status report: the atlas route uses the amber gate.';
  const retrievedLater = '2035-01-03T03:04:05.000Z';
  const exact = await retrieveConversationEvidence(data.archive, {
    conversationId: 'benchmark-conversation', messageId: 'message-001', query, retrievedAt: retrievedLater,
  });
  assert.equal(exact.results.length, 1);
  const result = exact.results[0];
  assert.equal(isRetrievedEvidence(result.evidence), true);
  assert.equal(isMemoryRecord(result.evidence), false);
  assert.equal(result.evidence.retrieval.method, 'exact');
  assert.equal(result.evidence.retrieval.queryHash, hash(query));
  assert.equal(result.evidence.source.fingerprint, data.amberEvidence.source.fingerprint);
  assert.equal(result.evidence.source.locator, 'message-001');
  assert.equal(result.evidence.source.sha256, data.amberEvidence.source.sha256);
  assert.equal(result.evidence.source.observedThrough, at);
  assert.equal(result.evidence.retrievedAt, retrievedLater);
  assert.notEqual(result.evidence.source.observedThrough, result.evidence.retrievedAt);
  assert.equal(result.evidence.excerpt, query);
  assert.equal(result.sourceVerification.found, true);
  assert.deepEqual(result.sourceVerification.target, {
    conversationId: 'benchmark-conversation', messageId: 'message-001',
  });
  assert.equal(result.sourceVerification.entry.messageSha256, result.evidence.source.sha256);
  assert.doesNotMatch(JSON.stringify(exact.receipt), /Status report|amber gate/);
  assert.deepEqual((await searchCurrentMemories(data.ledger, { query: 'amber gate' })).results, []);

  const absent = await retrieveConversationEvidence(data.archive, {
    conversationId: 'benchmark-conversation', messageId: 'message-001',
    query: 'violet gate', retrievedAt: at,
  });
  assert.equal(absent.results.length, 0);
  assert.equal(absent.receipt.source.found, true);
  const missing = await retrieveConversationEvidence(data.archive, {
    conversationId: 'benchmark-conversation', messageId: 'message-999',
    query: 'violet gate', retrievedAt: at,
  });
  assert.equal(missing.results.length, 0);
  assert.equal(missing.receipt.source.found, false);
  assert.deepEqual(missing.receipt.source.target, {
    conversationId: 'benchmark-conversation', messageId: 'message-999',
  });
  await assert.rejects(retrieveConversationEvidence(data.archive, {
    conversationId: 'benchmark-conversation', messageId: 'message-001', query,
    retrievedAt: at, source: { forged: true },
  }), /unknown field "source"/);
});

test('versioned message projection is strict, multi-block and Unicode-offset exact', async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'projection.jsonl');
  const archive = await createConversationArchive(file, {
    archiveId: 'projection-archive', clock, sync: false,
  });
  await archive.append({
    conversationId: 'projection', messageId: 'multi', observedAt: at,
    message: {
      role: 'user',
      content: [
        { type: 'synthetic_image', image: { id: 'image-1' } },
        { type: 'text', text: 'AA🧪targetZZ' },
        { type: 'text', text: 'A second target block.' },
      ],
    },
  });
  await archive.append({
    conversationId: 'projection', messageId: 'malformed', observedAt: at,
    message: { role: 'user', content: [{ type: 'text' }] },
  });
  await archive.append({
    conversationId: 'projection', messageId: 'bare', observedAt: at,
    message: { role: 'user', content: ['bare text is not a declared content part'] },
  });

  const limited = await retrieveConversationEvidence(archive, {
    conversationId: 'projection', messageId: 'multi', query: 'target', retrievedAt: at,
  });
  assert.equal(limited.receipt.matchedBlocks, 2);
  assert.equal(limited.receipt.returned, 1);
  assert.equal(limited.receipt.limit, 1);
  assert.equal(limited.receipt.omittedByLimit, 1);

  const both = await retrieveConversationEvidence(archive, {
    conversationId: 'projection', messageId: 'multi', query: 'target', retrievedAt: at, limit: 2,
  });
  assert.deepEqual(both.results.map(result => result.match.path), ['content[1].text', 'content[2].text']);
  assert.deepEqual(both.results.map(result => result.evidence.retrieval.rank), [1, 2]);
  assert.deepEqual(both.receipt.projection, { candidates: 3, textBlocks: 2, sourceBytes: 36 });
  await assert.rejects(retrieveConversationEvidence(archive, {
    conversationId: 'projection', messageId: 'multi', query: 'target', retrievedAt: at,
  }, { maxCandidates: 1 }), /3 projection candidates; the limit is 1/);
  await assert.rejects(retrieveConversationEvidence(archive, {
    conversationId: 'projection', messageId: 'multi', query: 'target', retrievedAt: at,
  }, { maxSourceBytes: 10 }), /10-byte source limit/);
  await assert.rejects(retrieveConversationEvidence(archive, {
    conversationId: 'projection', messageId: 'multi', query: 'target', retrievedAt: at,
  }, { maxIndexBytes: 10 }), /unknown field "maxIndexBytes"/);

  const astral = await retrieveConversationEvidence(archive, {
    conversationId: 'projection', messageId: 'multi', query: '🧪target', retrievedAt: at,
  }, { maxExcerptCharacters: 7 });
  assert.equal(astral.results[0].evidence.excerpt, '🧪target');
  assert.equal(astral.results[0].match.excerptStartCharacter, 2);
  assert.equal(astral.results[0].match.excerptEndCharacter, 9);
  assert.equal(astral.results[0].match.matchStartCharacter, 2);
  assert.equal(astral.results[0].match.matchEndCharacter, 9);

  await assert.rejects(retrieveConversationEvidence(archive, {
    conversationId: 'projection', messageId: 'malformed', query: 'target', retrievedAt: at,
  }), /text must be own data text/);
  await assert.rejects(retrieveConversationEvidence(archive, {
    conversationId: 'projection', messageId: 'bare', query: 'bare', retrievedAt: at,
  }), /must be a content-part object/);
  await archive.close();
});

test('query, candidate and index bounds fail explicitly without silent truncation', async t => {
  const data = await fixture(t);
  const boundary = await searchCurrentMemories(data.ledger, { query: 'xxxxx' }, {
    maxQueryCharacters: 5, maxQueryBytes: 5,
  });
  assert.equal(boundary.receipt.query.characters, 5);
  assert.equal(boundary.receipt.query.unicodeVersion, process.versions.unicode);
  await assert.rejects(searchCurrentMemories(data.ledger, { query: 'xxxxxx' }, {
    maxQueryCharacters: 5,
  }), /6 characters; the limit is 5/);
  await assert.rejects(searchCurrentMemories(data.ledger, { query: 'éé' }, {
    maxQueryCharacters: 2, maxQueryBytes: 3,
  }), /4 UTF-8 bytes; the limit is 3/);
  await assert.rejects(searchCurrentMemories(data.ledger, { query: 'one two three' }, {
    maxQueryTokens: 2,
  }), /3 tokens; the limit is 2/);
  await assert.rejects(searchCurrentMemories(data.ledger, { query: 'x', limit: 3 }, {
    maxResults: 2,
  }), /limit must be a whole number from 1 to 2/);
  await assert.rejects(searchCurrentMemories(data.ledger, { query: 'marker' }, {
    maxCandidates: 2,
  }), /exceeds the 2-candidate limit/);
  await assert.rejects(searchCurrentMemories(data.ledger, { query: 'marker' }, {
    maxIndexBytes: 10,
  }), /source text exceeds|normalized index text exceeds/);
  await assert.rejects(searchCurrentMemories(data.ledger, { query: 'marker' }, {
    maxIndexTokens: 5,
  }), /5-token limit/);
  await assert.rejects(searchCurrentMemories(data.ledger, { query: '㍍' }, {
    maxQueryCharacters: 1, maxQueryBytes: 3,
  }), /normalized query contains/);
  await assert.rejects(searchCurrentMemories(data.ledger, { query: '\ud800' }), /well-formed Unicode/);
  await assert.rejects(searchCurrentMemories(data.ledger, { query: new String('marker') }), /primitive text/);

  await data.archive.close();
  await assert.rejects(retrieveConversationEvidence(data.archive, {
    conversationId: 'benchmark-conversation', messageId: 'message-001',
    query: 'xxxxxx', retrievedAt: at,
  }, { maxQueryCharacters: 5 }), /6 characters; the limit is 5/);

  const expansionFile = path.join(data.directory, 'normalized-expansion.jsonl');
  const expansionLedger = await createMemoryLedger(expansionFile, {
    ledgerId: 'normalized-expansion-ledger', clock, sync: false,
  });
  await expansionLedger.record(authored('memory:normalized-expansion', '㍍'));
  await assert.rejects(searchCurrentMemories(expansionLedger, { query: '㍍' }, {
    maxIndexBytes: 3,
  }), /normalized index text exceeds the 3-byte limit/);
  await expansionLedger.close();
});

test('current retrieval joins the ledger queue behind an earlier mutation', async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'queued-memory.jsonl');
  const ledger = await createMemoryLedger(file, {
    ledgerId: 'queued-ledger', clock, sync: false,
  });
  const record = authored('memory:queued', 'Queued retrieval marker.');
  const pendingRecord = ledger.record(record);
  const pendingSearch = searchCurrentMemories(ledger, { query: 'queued marker' });
  const [view, search] = await Promise.all([pendingRecord, pendingSearch]);
  assert.equal(search.results[0].record.fingerprint, view.currentFingerprint);
  assert.equal(search.receipt.ledger.events, 2);
  assert.equal(search.results[0].lastSequence, 2);
  await ledger.close();
});

test('current-memory context rejects searches made stale by a queued ledger change', async t => {
  const data = await fixture(t);
  const search = await searchCurrentMemories(data.ledger, { query: 'cobalt gate' });
  const current = await data.ledger.get('observation:route');
  const pendingRetraction = data.ledger.retract({
    id: current.id,
    expectedFingerprint: current.currentFingerprint,
    expectedSequence: current.lastSequence,
    actor: operator,
    reason: 'Invalidate the cached current search.',
  });
  await assert.rejects(
    renderRetrievalContext({ memory: [search] }),
    /current-memory retrieval is stale/,
  );
  await pendingRetraction;
  assert.deepEqual((await searchCurrentMemories(data.ledger, { query: 'cobalt gate' })).results, []);
});

test('context validates every search before starting live freshness reads', async t => {
  const data = await fixture(t);
  const current = await searchCurrentMemories(data.ledger, { query: 'cobalt gate' });
  const history = await searchMemoryHistory(data.ledger, { query: 'amber gate' });
  await data.ledger.close();
  await assert.rejects(
    renderRetrievalContext({ memory: [current, history] }),
    /only current-memory retrievals/,
  );
});

test('retrieval context preserves four types and receipts whole-record budget omissions', async t => {
  const data = await fixture(t);
  const exact = await retrieveConversationEvidence(data.archive, {
    conversationId: 'benchmark-conversation', messageId: 'message-002',
    query: 'atlas route uses the cobalt gate', retrievedAt: at,
  });
  const typed = await searchCurrentMemories(data.ledger, { query: 'Typed marker', limit: 3 });
  const allTypes = await renderRetrievalContext({ conversation: [exact], memory: [typed] });
  assert.match(allTypes.text, /FIELDWORK_EVIDENCE/);
  assert.match(allTypes.text, /FIELDWORK_OBSERVATION/);
  assert.match(allTypes.text, /FIELDWORK_MEMORY/);
  assert.match(allTypes.text, /FIELDWORK_SUMMARY/);
  assert.equal(allTypes.receipt.retrieval.conversation[0].returned, 1);
  assert.equal(allTypes.receipt.retrieval.memory[0].returned, 3);
  assert.doesNotMatch(JSON.stringify(allTypes.receipt), /Typed marker|cobalt gate/);

  const budget = await searchCurrentMemories(data.ledger, {
    query: 'Budget marker zephyr', limit: 2,
  });
  assert.equal(budget.receipt.returned, 2);
  const roomy = await renderRetrievalContext({ memory: [budget] });
  const shortCharacters = roomy.receipt.context.included.find(row => row.id === 'memory:budget-short').characters;
  const sectionBound = await renderRetrievalContext({ memory: [budget] }, {
    memoryCharacters: shortCharacters,
  });
  assert.match(sectionBound.text, /Budget marker zephyr/);
  assert.doesNotMatch(sectionBound.text, /LONG_ONLY_START/);
  assert.doesNotMatch(sectionBound.text, /LONG_ONLY_END/);
  assert.deepEqual(
    sectionBound.receipt.context.skipped.map(row => [row.id, row.reason]),
    [['memory:budget-long', 'section-budget']],
  );
  assert.equal(sectionBound.receipt.retrieval.memory[0].returned, 2);
  assert.doesNotMatch(JSON.stringify(sectionBound.receipt), /Budget marker zephyr|LONG_ONLY_/);

  const deduplicated = await renderRetrievalContext({ memory: [budget, budget] });
  assert.deepEqual(deduplicated.receipt.selection.memory, {
    input: 4, unique: 2, deduplicated: 2,
  });
  assert.equal(deduplicated.receipt.selection.results, 4);

  const exactSourceBytes = deduplicated.receipt.selection.sourceBytes;
  const exactSourceBound = await renderRetrievalContext({
    memory: [budget, budget],
    limits: { maxSourceBytes: exactSourceBytes },
  });
  assert.equal(exactSourceBound.receipt.limits.maxSourceBytes, exactSourceBytes);
  assert.equal(exactSourceBound.receipt.selection.sourceBytes, exactSourceBytes);
  await assert.rejects(renderRetrievalContext({
    memory: [budget, budget],
    limits: { maxSourceBytes: exactSourceBytes - 1 },
  }), new RegExp(`source data exceeds ${exactSourceBytes - 1} bytes`));

  const shortOnly = await searchCurrentMemories(data.ledger, {
    query: 'Budget marker zephyr', limit: 1,
  });
  const one = await renderRetrievalContext({ memory: [shortOnly] });
  const totalBound = await renderRetrievalContext({ memory: [budget] }, {
    maxCharacters: one.receipt.context.characters,
    memoryCharacters: 1_000_000,
  });
  assert.deepEqual(
    totalBound.receipt.context.skipped.map(row => [row.id, row.reason]),
    [['memory:budget-long', 'total-budget']],
  );

  const history = await searchMemoryHistory(data.ledger, { query: 'amber gate' });
  await assert.rejects(renderRetrievalContext({ memory: [history] }), /only current-memory retrievals/);

  const marker = await searchCurrentMemories(data.ledger, { query: 'marker', limit: 5 });
  assert.equal(marker.results.length, 5);
  await assert.rejects(
    renderRetrievalContext({ memory: Array(52).fill(marker) }),
    /more than 256 results/,
  );
  await assert.rejects(renderRetrievalContext({
    conversation: [exact], memory: [marker], limits: { maxSearches: 1 },
  }), /more than 1 searches/);
});
