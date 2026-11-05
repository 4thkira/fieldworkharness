import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  finalizePortableAgentImport,
  PORTABLE_AGENT_FORMAT,
  PORTABLE_AGENT_INCOMPLETE_MARKER,
  PORTABLE_AGENT_LIMITS,
  exportPortableAgent,
  importPortableAgent,
  inspectPortableAgent,
} from '../src/agent-portability.mjs';
import { canonicalJson } from '../src/json-data.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(repo, 'templates', 'agent-home');
const fixedClock = () => new Date('2036-05-06T07:08:09.000Z');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-portability-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'source-agent');
  await fs.cp(template, home, { recursive: true });
  return {
    directory,
    home,
    bundle: path.join(directory, 'sample-agent.fieldwork-agent'),
    imported: path.join(directory, 'imported-agent'),
  };
}

async function missing(file) {
  await assert.rejects(fs.lstat(file), error => error?.code === 'ENOENT');
}

async function assertNoStage(directory, fragment) {
  const names = await fs.readdir(directory);
  assert.equal(names.some(name => name.includes(fragment)), false, `left staging content in ${directory}`);
}

async function ordinaryAgent(t) {
  const data = await fixture(t);
  await fs.mkdir(path.join(data.home, 'workspace', 'empty'), { recursive: true });
  await fs.writeFile(path.join(data.home, 'workspace', 'note.txt'), 'portable notebook text\n');
  await fs.mkdir(path.join(data.home, 'state'), { recursive: true });
  await fs.writeFile(path.join(data.home, 'state', 'conversation.jsonl'), '{"saved":"turn"}\n');
  await fs.mkdir(path.join(data.home, 'workspace', 'a', 'z'), { recursive: true });
  await fs.mkdir(path.join(data.home, 'workspace', 'a-z'), { recursive: true });
  return data;
}

test('a portable bundle round-trips agent bytes while omitting local authority and recovery state', async t => {
  const data = await ordinaryAgent(t);
  await fs.writeFile(path.join(data.home, 'state', 'room-secret'), 'room-bearer-that-must-not-travel');
  await fs.writeFile(path.join(data.home, 'state', 'bridges.json'), '{"format":"fieldwork-bridges/v1"}\n');
  await fs.mkdir(path.join(data.home, 'backups', 'state-old'), { recursive: true });
  await fs.writeFile(path.join(data.home, 'backups', 'state-old', 'conversation.jsonl'), 'old local recovery');

  const exported = await exportPortableAgent({
    home: data.home,
    agentName: '  Sample Agent  ',
    destination: data.bundle,
    knownSecrets: ['synthetic-supervisor-secret'],
    clock: fixedClock,
  });
  assert.deepEqual({
    format: exported.format,
    destination: exported.destination,
    name: exported.name,
    omitted: exported.omitted,
  }, {
    format: PORTABLE_AGENT_FORMAT,
    destination: await fs.realpath(data.bundle),
    name: 'Sample Agent',
    omitted: { recoveryCopies: 1, roomCredentials: 1, bridgeBindings: 1 },
  });

  const manifestText = await fs.readFile(path.join(data.bundle, 'manifest.json'), 'utf8');
  assert.equal(manifestText.includes(data.home), false, 'manifest disclosed the absolute source path');
  assert.equal(manifestText.includes(data.home.replaceAll('\\', '\\\\')), false, 'manifest disclosed a JSON-escaped source path');
  const inspected = await inspectPortableAgent(data.bundle);
  assert.equal(inspected.exportedAt, '2036-05-06T07:08:09.000Z');
  assert.equal(inspected.agent.name, 'Sample Agent');
  assert.equal(exported.files, inspected.payload.files.length);
  assert.equal(exported.bytes, inspected.payload.bytes);
  assert.deepEqual(inspected.omitted, { recoveryCopies: 1, roomCredentials: 1, bridgeBindings: 1 });

  const imported = await importPortableAgent({
    source: data.bundle,
    destination: data.imported,
    knownSecrets: ['synthetic-supervisor-secret'],
  });
  assert.equal(imported.destination, await fs.realpath(data.imported));
  assert.equal(imported.name, 'Sample Agent');
  assert.equal(await fs.readFile(path.join(data.imported, 'workspace', 'note.txt'), 'utf8'), 'portable notebook text\n');
  assert.equal(await fs.readFile(path.join(data.imported, 'state', 'conversation.jsonl'), 'utf8'), '{"saved":"turn"}\n');
  assert.equal((await fs.lstat(path.join(data.imported, 'workspace', 'empty'))).isDirectory(), true);
  await missing(path.join(data.imported, 'state', 'room-secret'));
  await missing(path.join(data.imported, 'state', 'bridges.json'));
  await missing(path.join(data.imported, 'backups'));
});

test('a configured Fieldwork secret crossing a read boundary aborts export without echo or residue', async t => {
  const data = await ordinaryAgent(t);
  const secret = 'configured-fieldwork-secret-value';
  await fs.writeFile(path.join(data.home, 'workspace', 'leak.bin'), Buffer.concat([
    Buffer.alloc((64 * 1024) - 7, 0x61),
    Buffer.from(secret),
    Buffer.alloc(64 * 1024, 0x62),
    Buffer.from('after'),
  ]));

  let failure = null;
  try {
    await exportPortableAgent({
      home: data.home,
      agentName: 'Sample Agent',
      destination: data.bundle,
      knownSecrets: [secret],
      clock: fixedClock,
    });
  } catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /workspace\/leak\.bin contains a configured Fieldwork credential/);
  assert.equal(`${failure.message}\n${failure.stack ?? ''}`.includes(secret), false, 'credential was echoed in the failure');
  await missing(data.bundle);
  await assertNoStage(data.directory, '.fieldwork-export-');
});

test('known credentials are refused in names, paths, and manifest metadata without being echoed', async t => {
  const secret = 'configured-fieldwork-secret-value';
  await t.test('agent name', async t => {
    const data = await ordinaryAgent(t);
    let failure = null;
    try {
      await exportPortableAgent({ home: data.home, agentName: secret, destination: data.bundle, knownSecrets: [secret], clock: fixedClock });
    } catch (error) { failure = error; }
    assert.match(failure?.message ?? '', /agent name contains a configured Fieldwork credential/);
    assert.equal(`${failure?.message}\n${failure?.stack}`.includes(secret), false);
    await missing(data.bundle);
  });

  await t.test('file path', async t => {
    const data = await ordinaryAgent(t);
    await fs.writeFile(path.join(data.home, 'workspace', `${secret}.txt`), 'ordinary bytes');
    let failure = null;
    try {
      await exportPortableAgent({ home: data.home, agentName: 'Sample Agent', destination: data.bundle, knownSecrets: [secret], clock: fixedClock });
    } catch (error) { failure = error; }
    assert.match(failure?.message ?? '', /agent path contains a configured Fieldwork credential/);
    assert.equal(`${failure?.message}\n${failure?.stack}`.includes(secret), false);
    await missing(data.bundle);
  });

  await t.test('import manifest', async t => {
    const data = await exportedFixture(t);
    const manifestFile = path.join(data.bundle, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.agent.name = secret;
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    let failure = null;
    try { await importPortableAgent({ source: data.bundle, destination: data.imported, knownSecrets: [secret] }); }
    catch (error) { failure = error; }
    assert.match(failure?.message ?? '', /manifest contains a configured Fieldwork credential/);
    assert.equal(`${failure?.message}\n${failure?.stack}`.includes(secret), false);
    await missing(data.imported);
  });
});

test('resolved source and destination paths cannot hide a configured credential behind a link', async t => {
  const data = await ordinaryAgent(t);
  const secret = 'configured-path-secret-value';
  const realParent = path.join(data.directory, secret);
  const alias = path.join(data.directory, 'portable-alias');
  await fs.mkdir(path.join(realParent, 'child'), { recursive: true });
  try { await fs.symlink(realParent, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`directory links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  let failure = null;
  try {
    await exportPortableAgent({
      home: data.home,
      agentName: 'Sample Agent',
      destination: path.join(alias, 'child', 'bundle'),
      knownSecrets: [secret],
      clock: fixedClock,
    });
  } catch (error) { failure = error; }
  assert.match(failure?.message ?? '', /resolved export destination contains a configured Fieldwork credential/);
  assert.equal(`${failure?.message}\n${failure?.stack}`.includes(secret), false);
  await missing(path.join(realParent, 'child', 'bundle'));
});

test('credential-like filenames, including hidden secret stores, refuse export', async t => {
  for (const filename of ['fieldwork.local.secrets.json', '.secrets.json']) {
    await t.test(filename, async t => {
      const data = await ordinaryAgent(t);
      await fs.writeFile(path.join(data.home, 'workspace', filename), '{"apiKey":"unknown"}\n');
      await assert.rejects(
        exportPortableAgent({ home: data.home, agentName: 'Sample Agent', destination: data.bundle, clock: fixedClock }),
        error => /credential-like file/.test(error?.message ?? '')
          && (error?.message ?? '').includes(`workspace/${filename}`),
      );
      await missing(data.bundle);
    });
  }
});

async function exportedFixture(t) {
  const data = await ordinaryAgent(t);
  await exportPortableAgent({ home: data.home, agentName: 'Sample Agent', destination: data.bundle, clock: fixedClock });
  return data;
}

async function refusedImport(data, pattern) {
  await assert.rejects(
    importPortableAgent({ source: data.bundle, destination: data.imported }),
    pattern,
  );
  await missing(data.imported);
  await assertNoStage(data.directory, '.fieldwork-import-');
}

function refreshPayloadDigest(manifest) {
  manifest.payload.bytes = manifest.payload.files.reduce((sum, file) => sum + file.bytes, 0);
  manifest.payload.sha256 = createHash('sha256').update(canonicalJson({
    directories: manifest.payload.directories,
    files: manifest.payload.files,
    bytes: manifest.payload.bytes,
  }), 'utf8').digest('hex');
}

test('import rejects extra, missing, and content-tampered payloads without leaving a home', async t => {
  await t.test('extra file', async t => {
    const data = await exportedFixture(t);
    await fs.writeFile(path.join(data.bundle, 'agent', 'extra.txt'), 'not declared');
    await refusedImport(data, /payload does not match its manifest/);
  });

  await t.test('missing file', async t => {
    const data = await exportedFixture(t);
    await fs.rm(path.join(data.bundle, 'agent', 'workspace', 'note.txt'));
    await refusedImport(data, /payload does not match its manifest/);
  });

  await t.test('changed bytes', async t => {
    const data = await exportedFixture(t);
    await fs.writeFile(path.join(data.bundle, 'agent', 'workspace', 'note.txt'), 'tampered notebook text\n');
    await refusedImport(data, /payload does not match its manifest/);
  });
});

test('import strictly rejects traversal, duplicate-key, and invalid-UTF-8 manifests', async t => {
  await t.test('traversal path', async t => {
    const data = await exportedFixture(t);
    const manifestFile = path.join(data.bundle, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.payload.files[0].path = '../escape';
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    await refusedImport(data, /not a portable relative path/);
  });

  await t.test('duplicate key', async t => {
    const data = await exportedFixture(t);
    const manifestFile = path.join(data.bundle, 'manifest.json');
    const source = await fs.readFile(manifestFile, 'utf8');
    await fs.writeFile(manifestFile, source.replace('{\n', `{\n  "format": "${PORTABLE_AGENT_FORMAT}",\n`));
    await refusedImport(data, /repeat.*object key.*format/i);
  });

  await t.test('invalid UTF-8', async t => {
    const data = await exportedFixture(t);
    await fs.writeFile(path.join(data.bundle, 'manifest.json'), Buffer.from([0xff, 0xfe, 0xfd]));
    await refusedImport(data, /must be valid UTF-8/);
  });

  await t.test('Windows reserved path', async t => {
    const data = await exportedFixture(t);
    const manifestFile = path.join(data.bundle, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.payload.files[0].path = 'CON';
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    await refusedImport(data, /nonportable path segment/);
  });

  await t.test('case-insensitive collision', async t => {
    const data = await exportedFixture(t);
    const manifestFile = path.join(data.bundle, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.payload.files[0].path = manifest.payload.files[1].path.toUpperCase();
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    await refusedImport(data, /manifest paths collide/);
  });

  await t.test('non-NFC path', async t => {
    const data = await exportedFixture(t);
    const manifestFile = path.join(data.bundle, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.payload.files[0].path = 'workspace/e\u0301.txt';
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    await refusedImport(data, /must be nonempty NFC text/);
  });

  await t.test('declared file over the bound', async t => {
    const data = await exportedFixture(t);
    const manifestFile = path.join(data.bundle, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.payload.files[0].bytes = PORTABLE_AGENT_LIMITS.fileBytes + 1;
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    await refusedImport(data, /payload\.files\[0\]\.bytes is outside its supported bound/);
  });
});

test('import rejects a byte-valid payload whose copied profile is invalid', async t => {
  const data = await exportedFixture(t);
  const profileFile = path.join(data.bundle, 'agent', 'profile.json');
  const replacement = Buffer.from('{}\n');
  await fs.writeFile(profileFile, replacement);
  const manifestFile = path.join(data.bundle, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const row = manifest.payload.files.find(file => file.path === 'profile.json');
  row.bytes = replacement.length;
  row.sha256 = createHash('sha256').update(replacement).digest('hex');
  refreshPayloadDigest(manifest);
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
  await refusedImport(data, /portable agent has an invalid profile/);
});

test('import also refuses a currently known credential hidden in ordinary payload bytes', async t => {
  const data = await ordinaryAgent(t);
  const secret = 'known-on-the-receiving-installation';
  await fs.writeFile(path.join(data.home, 'workspace', 'ordinary-note.txt'), `copied elsewhere: ${secret}\n`);
  await exportPortableAgent({ home: data.home, agentName: 'Sample Agent', destination: data.bundle, clock: fixedClock });
  let failure = null;
  try { await importPortableAgent({ source: data.bundle, destination: data.imported, knownSecrets: [secret] }); }
  catch (error) { failure = error; }
  assert.match(failure?.message ?? '', /ordinary-note\.txt contains a configured Fieldwork credential/);
  assert.equal(`${failure?.message}\n${failure?.stack}`.includes(secret), false);
  await missing(data.imported);
});

test('a deferred import keeps its incomplete marker until explicit finalization', async t => {
  const data = await exportedFixture(t);
  const imported = await importPortableAgent({
    source: data.bundle,
    destination: data.imported,
    deferPublication: true,
  });
  const marker = path.join(await fs.realpath(data.imported), PORTABLE_AGENT_INCOMPLETE_MARKER);
  assert.equal(imported.incompleteMarker, marker);
  assert.equal(await fs.readFile(marker, 'utf8'), `${PORTABLE_AGENT_FORMAT}\n`);
  assert.equal(await fs.readFile(path.join(data.imported, 'workspace', 'note.txt'), 'utf8'), 'portable notebook text\n');

  await finalizePortableAgentImport(data.imported);
  await missing(marker);
  assert.equal(await fs.readFile(path.join(data.imported, 'workspace', 'note.txt'), 'utf8'), 'portable notebook text\n');
});

test('existing export and import destinations are never replaced', async t => {
  const data = await ordinaryAgent(t);
  await fs.mkdir(data.bundle);
  await fs.writeFile(path.join(data.bundle, 'keep.txt'), 'keep export destination');
  await assert.rejects(
    exportPortableAgent({ home: data.home, agentName: 'Sample Agent', destination: data.bundle, clock: fixedClock }),
    /export destination already exists/,
  );
  assert.equal(await fs.readFile(path.join(data.bundle, 'keep.txt'), 'utf8'), 'keep export destination');

  await fs.rm(data.bundle, { recursive: true });
  await exportPortableAgent({ home: data.home, agentName: 'Sample Agent', destination: data.bundle, clock: fixedClock });
  await fs.mkdir(data.imported);
  await fs.writeFile(path.join(data.imported, 'keep.txt'), 'keep import destination');
  await assert.rejects(
    importPortableAgent({ source: data.bundle, destination: data.imported }),
    /import destination already exists/,
  );
  assert.equal(await fs.readFile(path.join(data.imported, 'keep.txt'), 'utf8'), 'keep import destination');
});

test('export refuses a symbolic link instead of following content outside the agent home', async t => {
  const data = await ordinaryAgent(t);
  const outside = path.join(data.directory, 'outside.txt');
  await fs.writeFile(outside, 'must remain outside');
  try {
    await fs.symlink(outside, path.join(data.home, 'workspace', 'outside-link'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    exportPortableAgent({ home: data.home, agentName: 'Sample Agent', destination: data.bundle, clock: fixedClock }),
    /unsupported symbolic link workspace\/outside-link/,
  );
  await missing(data.bundle);
  assert.equal(await fs.readFile(outside, 'utf8'), 'must remain outside');
  await assertNoStage(data.directory, '.fieldwork-export-');
});

test('import refuses a symbolic link inserted into a bundle payload', async t => {
  const data = await exportedFixture(t);
  const outside = path.join(data.directory, 'outside.txt');
  const payload = path.join(data.bundle, 'agent', 'workspace', 'note.txt');
  await fs.writeFile(outside, 'must remain outside');
  await fs.rm(payload);
  try {
    await fs.symlink(outside, payload);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await refusedImport(data, /unsupported symbolic link workspace\/note\.txt/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'must remain outside');
});

test('manifest executable metadata survives a transport that drops the bundle file mode', async t => {
  if (process.platform === 'win32') { t.skip('Windows does not expose portable executable mode bits'); return; }
  const data = await ordinaryAgent(t);
  const script = path.join(data.home, 'workspace', 'run.sh');
  await fs.writeFile(script, '#!/bin/sh\nexit 0\n');
  await fs.chmod(script, 0o700);
  await exportPortableAgent({ home: data.home, agentName: 'Sample Agent', destination: data.bundle, clock: fixedClock });
  await fs.chmod(path.join(data.bundle, 'agent', 'workspace', 'run.sh'), 0o600);
  await importPortableAgent({ source: data.bundle, destination: data.imported });
  const mode = (await fs.stat(path.join(data.imported, 'workspace', 'run.sh'))).mode;
  assert.notEqual(mode & 0o100, 0, 'manifest executable intent was not restored');
});
