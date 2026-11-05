import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MINIMUM_NODE_MAJOR } from '../scripts/prepare-dependencies.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runSetup(settingsFile, agentHome, tools = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, 'scripts', 'start.mjs'), '--setup', '--no-start'], {
      cwd: repo,
      env: { ...process.env, FIELDWORK_SETTINGS: settingsFile, FIELDWORK_NO_BROWSER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
    child.stdin.end(`${agentHome}\n\n\n${tools}\n\n`);
  });
}

test('first-run setup leaves outbound web reading off by default', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-setup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settingsFile = path.join(directory, 'custom-settings.json');
  const agentHome = path.join(directory, 'agent');
  const result = await runSetup(settingsFile, agentHome);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Web reading starts off/);
  const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(settings.tools, 'memory,notebook,clock');
  assert.doesNotMatch(settings.tools, /web/);
});

test('first-run web opt-in keeps the suggested local tools when entered as instructed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-setup-web-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settingsFile = path.join(directory, 'custom-settings.json');
  const agentHome = path.join(directory, 'agent');
  const result = await runSetup(settingsFile, agentHome, 'memory,notebook,clock,web');
  assert.equal(result.code, 0, result.output);
  const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(settings.tools, 'memory,notebook,clock,web');
});

test('browser room help names the local meaning kit alongside every tool option', async () => {
  const child = spawn(process.execPath, [path.join(repo, 'scripts', 'browser-chat.mjs'), '--help'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /--tools memory,notebook,clock,web,meaning/);
  assert.match(output, /meaning\s+add one automatic-memory seat chosen by meaning/);
});

test('startup refuses an oversized settings file before parsing or echoing it', { timeout: 20_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-oversized-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settingsFile = path.join(directory, 'fieldwork.local.json');
  const sentinel = 'DO_NOT_ECHO_OVERSIZED_SETTINGS_123456789';
  await fs.writeFile(settingsFile, JSON.stringify({ padding: sentinel.repeat(2000) }));
  const child = spawn(process.execPath, [path.join(repo, 'scripts', 'start.mjs'), '--setup', '--no-start'], {
    cwd: repo,
    env: { ...process.env, FIELDWORK_SETTINGS: settingsFile, FIELDWORK_NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 1, output);
  assert.match(output, /65536-byte settings limit/);
  assert.doesNotMatch(output, /DO_NOT_ECHO/);
});

test('custom launcher bearer files are ignored by basename', async t => {
  let ignore;
  try { ignore = await fs.readFile(path.join(repo, '.gitignore'), 'utf8'); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    t.skip('source-control metadata is intentionally absent from the release archive');
    return;
  }
  assert.match(ignore, /^\*\.room-secret$/m);
});

test('Windows launchers share the verified bootstrap and Node floor', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
  const shrinkwrap = JSON.parse(await fs.readFile(path.join(repo, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(packageJson.engines.node, `>=${MINIMUM_NODE_MAJOR}`);
  assert.equal(shrinkwrap.packages[''].engines.node, packageJson.engines.node);
  for (const file of ['Start Fieldwork.cmd', 'Fieldwork Settings.cmd']) {
    const text = await fs.readFile(path.join(repo, file), 'utf8');
    assert.match(text, new RegExp(`process\\.versions\\.node[\\s\\S]*>= ${MINIMUM_NODE_MAJOR}`), file);
    assert.match(text, new RegExp(`needs Node\\.js ${MINIMUM_NODE_MAJOR} or newer`), file);
    assert.match(text, /set "ERRORLEVEL="/i, file);
    assert.match(text, /node scripts\\prepare-dependencies-cli\.mjs/, file);
    assert.match(text, /:failed[\s\S]*set "FIELDWORK_EXIT=%errorlevel%"[\s\S]*exit \/b %FIELDWORK_EXIT%/, file);
    assert.doesNotMatch(text, /npm (?:ci|install)/, file);
  }
});

function runBatch(file, environment) {
  return new Promise((resolve, reject) => {
    // An explicit .\ keeps this working where NoDefaultCurrentDirectoryInExePath
    // stops cmd.exe from finding a bare script name in the current folder.
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `call .\\${path.basename(file)}`], {
      cwd: path.dirname(file),
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
    child.stdin.end();
  });
}

test('Windows launcher adapters preserve failures and forward only the settings flag', {
  skip: process.platform === 'win32' ? false : 'Windows batch behavior',
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork cmd & ()-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logFile = path.join(directory, 'node-calls.log');
  const preloadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-cmd-preload-'));
  t.after(() => fs.rm(preloadDirectory, { recursive: true, force: true }));
  const preloadFile = path.join(preloadDirectory, 'stub-node.cjs');
  await fs.writeFile(preloadFile, [
    "const fs = require('node:fs');",
    "const target = String(process.argv[1] || '').replaceAll('\\\\', '/');",
    "const log = kind => fs.appendFileSync(process.env.FIELDWORK_STUB_LOG, `${kind}|${process.argv.slice(1).join(' ')}\\n`);",
    "if (target.endsWith('scripts/prepare-dependencies-cli.mjs')) {",
    "  log('prepare');",
    "  process.exit(Number(process.env.FIELDWORK_STUB_PREPARE_CODE));",
    "}",
    "if (target.endsWith('scripts/start.mjs')) {",
    "  log('start');",
    '  process.exit(0);',
    '}',
    '',
  ].join('\n'));
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'errorlevel') delete environment[key];
  }
  Object.assign(environment, {
    ERRORLEVEL: 'shadowed',
    FIELDWORK_STUB_LOG: logFile,
    FIELDWORK_STUB_PREPARE_CODE: '0',
    NODE_OPTIONS: `--require=${preloadFile}`,
  });

  const startLauncher = path.join(directory, 'start-launcher.cmd');
  const settingsLauncher = path.join(directory, 'settings-launcher.cmd');
  await fs.copyFile(path.join(repo, 'Start Fieldwork.cmd'), startLauncher);
  await fs.copyFile(path.join(repo, 'Fieldwork Settings.cmd'), settingsLauncher);
  const started = await runBatch(startLauncher, environment);
  assert.equal(started.code, 0, started.output);
  const settings = await runBatch(settingsLauncher, environment);
  assert.equal(settings.code, 0, settings.output);
  const calls = await fs.readFile(logFile, 'utf8');
  assert.match(calls, /start\|[^\r\n]*\\scripts\\start\.mjs\r?\n/);
  assert.match(calls, /start\|[^\r\n]*\\scripts\\start\.mjs --setup\r?\n/);

  await fs.writeFile(logFile, '');
  const failed = await runBatch(startLauncher, {
    ...environment,
    FIELDWORK_STUB_PREPARE_CODE: '7',
  });
  assert.equal(failed.code, 7, failed.output);
  assert.doesNotMatch(await fs.readFile(logFile, 'utf8'), /^start\|/m);
});
