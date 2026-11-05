import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadManagedSettings } from '../src/agent-management.mjs';
import { bridgeSecretsFileFor, loadBridgeSecrets } from '../src/bridge-management.mjs';
import { loadFieldworkSecrets, secretsFileFor } from '../src/model-connection.mjs';
import { readRoomSecret } from '../src/room-secret.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

const RELEASE_EXPERT_TEMPLATE_FILES = Object.freeze([
  'templates/fieldwork-expert/fieldwork.json',
  'templates/fieldwork-expert/profile.json',
  'templates/fieldwork-expert/roots/identity.md',
  'templates/fieldwork-expert/roots/relationships.md',
  'templates/fieldwork-expert/roots/voice.md',
  'templates/fieldwork-expert/state/look.json',
  'templates/fieldwork-expert/state/tool-groups.json',
]);

const RELEASE_FONT_FILES = Object.freeze([
  'browser/fonts/AtkinsonHyperlegibleMono-Italic-Variable.woff2',
  'browser/fonts/AtkinsonHyperlegibleMono-Variable.woff2',
  'browser/fonts/AtkinsonHyperlegibleNext-Italic-Variable.woff2',
  'browser/fonts/AtkinsonHyperlegibleNext-Variable.woff2',
  'browser/fonts/ComicNeue-Bold.woff2',
  'browser/fonts/ComicNeue-BoldItalic.woff2',
  'browser/fonts/ComicNeue-Italic.woff2',
  'browser/fonts/ComicNeue-Regular.woff2',
  'browser/fonts/CozetteVector.woff2',
  'browser/fonts/CozetteVectorBold.woff2',
  'browser/fonts/Lexend-Bold.woff2',
  'browser/fonts/Lexend-Regular.woff2',
  'browser/fonts/Shantell_Sans-Normal-Bold.woff2',
  'browser/fonts/Shantell_Sans-Normal-Bold_Italic.woff2',
  'browser/fonts/Shantell_Sans-Normal-Regular.woff2',
  'browser/fonts/Shantell_Sans-Normal-Regular_Italic.woff2',
]);

const RELEASE_LICENSE_FILES = Object.freeze([
  'docs/licenses/MPL-2.0.txt',
  'docs/licenses/atkinson-hyperlegible-mono-OFL.txt',
  'docs/licenses/atkinson-hyperlegible-next-OFL.txt',
  'docs/licenses/comic-neue-OFL.txt',
  'docs/licenses/cozette-MIT.txt',
  'docs/licenses/eglantine-marginalia-LICENSE.txt',
  'docs/licenses/eglantine-marginalia-florilegium-LICENSE.txt',
  'docs/licenses/lexend-OFL.txt',
  'docs/licenses/shantell-sans-OFL.txt',
]);

const RELEASE_EGLANTINE_FILES = Object.freeze([
  'vendor/eglantine-marginalia/LICENSE',
  'vendor/eglantine-marginalia/README.md',
  'vendor/eglantine-marginalia/calendar/figures.js',
  'vendor/eglantine-marginalia/calendar/index.js',
  'vendor/eglantine-marginalia/calendar/names.js',
  'vendor/eglantine-marginalia/calendar/plants.js',
  'vendor/eglantine-marginalia/calendar/republican.js',
  'vendor/eglantine-marginalia/field.js',
  'vendor/eglantine-marginalia/florilegium-LICENSE.txt',
  'vendor/eglantine-marginalia/form.js',
  'vendor/eglantine-marginalia/forms/arbre-fruitier.form.js',
  'vendor/eglantine-marginalia/forms/capitule.form.js',
  'vendor/eglantine-marginalia/forms/conifere.form.js',
  'vendor/eglantine-marginalia/forms/cryptogame.form.js',
  'vendor/eglantine-marginalia/forms/epi-aromatique.form.js',
  'vendor/eglantine-marginalia/forms/epi-graminee.form.js',
  'vendor/eglantine-marginalia/forms/feuillage.form.js',
  'vendor/eglantine-marginalia/forms/grimpante.form.js',
  'vendor/eglantine-marginalia/forms/hiver.form.js',
  'vendor/eglantine-marginalia/forms/lis-bulbe.form.js',
  'vendor/eglantine-marginalia/forms/ombelle-corymbe.form.js',
  'vendor/eglantine-marginalia/forms/racine-tubercule.form.js',
  'vendor/eglantine-marginalia/forms/rosacee-coupe.form.js',
  'vendor/eglantine-marginalia/geometry.js',
  'vendor/eglantine-marginalia/grow.js',
  'vendor/eglantine-marginalia/index.js',
  'vendor/eglantine-marginalia/inks.js',
  'vendor/eglantine-marginalia/kit.js',
  'vendor/eglantine-marginalia/paint.js',
  'vendor/eglantine-marginalia/palettes.js',
  'vendor/eglantine-marginalia/random.js',
  'vendor/eglantine-marginalia/registry.js',
  'vendor/eglantine-marginalia/render.js',
  'vendor/eglantine-marginalia/shapes.js',
  'vendor/eglantine-marginalia/toolkit.js',
]);

async function runNpm(arguments_, options = {}) {
  const npmCli = process.env.npm_execpath
    ?? (process.platform === 'win32'
      ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : null);
  const command = npmCli ? process.execPath : 'npm';
  const args = npmCli ? [npmCli, ...arguments_] : arguments_;
  return run(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    timeout: 180_000,
    killSignal: 'SIGKILL',
    ...options,
  });
}

async function npmPack(directory) {
  const { stdout } = await runNpm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', directory,
  ]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.length, 1, 'the release check expects one package manifest');
  assert.equal(typeof parsed[0].filename, 'string');
  return { manifest: parsed[0], archive: path.join(directory, parsed[0].filename) };
}

function runSetup(packageRoot, settingsFile, agentHome) {
  return new Promise((resolve, reject) => {
    const environment = {
      ...process.env,
      FIELDWORK_SETTINGS: settingsFile,
      FIELDWORK_NO_BROWSER: '1',
    };
    delete environment.FIELDWORK_API_KEY;
    delete environment.FIELDWORK_TELEGRAM_TOKEN;
    delete environment.FIELDWORK_DISCORD_TOKEN;
    const child = spawn(process.execPath, [
      path.join(packageRoot, 'scripts', 'start.mjs'), '--setup', '--no-start',
    ], {
      cwd: packageRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    let timedOut = false;
    const finish = work => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 30_000);
    timer.unref();
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
    child.once('error', error => finish(() => reject(error)));
    child.once('close', code => finish(() => {
      if (timedOut) reject(new Error('packaged first setup exceeded 30 seconds'));
      else resolve({ code, output });
    }));
    child.stdin.end(`${agentHome}\n\n\n\n\n`);
  });
}

function assertArchiveBoundary(manifest) {
  const entries = manifest.files.map(item => [item.path.replaceAll('\\', '/'), item]);
  const included = new Map(entries);
  const files = [...included.keys()];
  assert.equal(included.size, entries.length, 'release archive contains duplicate normalized paths');

  const requireNonEmpty = required => {
    const item = included.get(required);
    assert.ok(item, `release archive is missing ${required}`);
    assert.ok(
      Number.isSafeInteger(item.size) && item.size > 0,
      `release archive contains an empty or invalid ${required}`,
    );
  };

  for (const required of [
    'CHANGELOG.md',
    'CODE_OF_CONDUCT.md',
    'CONTRIBUTING.md',
    'RELEASING.md',
    'SECURITY.md',
    'npm-shrinkwrap.json',
    'package.json',
    'README.md',
    'LICENSE',
    'Start Fieldwork.cmd',
    'Fieldwork Settings.cmd',
    'Set Fieldwork API Key.cmd',
    'browser/index.html',
    'docs/releases/0.1.0-alpha.1.md',
    'scripts/start.mjs',
    'scripts/build-release.mjs',
    'scripts/prepare-public-repo.mjs',
    'scripts/prepare-dependencies.mjs',
    'scripts/prepare-dependencies-cli.mjs',
    'scripts/release-check.mjs',
    'src/agent-portability.mjs',
    'src/browser-view.mjs',
    'src/fieldwork-help.mjs',
    'templates/agent-home/profile.json',
    ...RELEASE_EXPERT_TEMPLATE_FILES,
    'docs/third-party.md',
    'browser/madoromi-palettes.css',
    ...RELEASE_EGLANTINE_FILES,
    ...RELEASE_LICENSE_FILES,
    ...RELEASE_FONT_FILES,
  ]) requireNonEmpty(required);

  assert.deepEqual(
    files.filter(file => file.startsWith('docs/licenses/')).sort(),
    [...RELEASE_LICENSE_FILES].sort(),
    'release archive license inventory must be reviewed exactly',
  );
  assert.deepEqual(
    files.filter(file => file.startsWith('browser/fonts/')).sort(),
    [...RELEASE_FONT_FILES].sort(),
    'release archive font inventory must be reviewed exactly',
  );
  assert.deepEqual(
    files.filter(file => file.startsWith('vendor/eglantine-marginalia/')).sort(),
    [...RELEASE_EGLANTINE_FILES].sort(),
    'release archive Églantine inventory must be reviewed exactly',
  );
  for (const file of RELEASE_EGLANTINE_FILES.filter(file => file.endsWith('.js'))) {
    assert.ok(included.get(file).size > 0, `release archive contains an empty ${file}`);
  }

  const forbidden = files.filter(file => {
    const lower = file.toLowerCase();
    const parts = lower.split('/');
    const basename = parts.at(-1);
    return file.startsWith('/')
      || parts.includes('..')
      || parts.some(part => part === '.git'
        || part === 'workspace'
        || (part === 'state' && !RELEASE_EXPERT_TEMPLATE_FILES.includes(file)))
      || basename === 'package-lock.json'
      || basename === 'agents.md'
      || basename === '.env'
      || basename.startsWith('.env.')
      || basename.startsWith('fieldwork.local')
      || lower.endsWith('.secrets.json')
      || lower.endsWith('.room-secret');
  });
  assert.deepEqual(forbidden, [], `release archive contains forbidden paths: ${forbidden.join(', ')}`);
}

function escapedAt(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) slashes++;
  return slashes % 2 === 1;
}

function matchingBracket(source, opening) {
  let depth = 1;
  for (let index = opening + 1; index < source.length; index++) {
    if (escapedAt(source, index)) continue;
    if (source[index] === '[') depth++;
    else if (source[index] === ']' && --depth === 0) return index;
  }
  return -1;
}

function quotedMarkdownTitle(source, start, quote) {
  const closing = quote === '(' ? ')' : quote;
  for (let index = start + 1; index < source.length; index++) {
    if (escapedAt(source, index)) continue;
    if (source[index] === '\r' || source[index] === '\n') return -1;
    if (source[index] === closing) return index + 1;
  }
  return -1;
}

function couldStartReferenceDefinition(source, opening) {
  const carriage = source.lastIndexOf('\r', opening - 1);
  const newline = source.lastIndexOf('\n', opening - 1);
  const prefix = source.slice(Math.max(carriage, newline) + 1, opening);
  // Definitions may be nested in quote/list containers, but cannot interrupt
  // ordinary paragraph text. This broad container alphabet stays fail-closed
  // without mistaking inline code such as PowerShell's [Environment]:: for one.
  return /^[\t >+*().0-9-]*$/u.test(prefix);
}

function inlineMarkdownDestination(source, opening, document) {
  let index = opening + 1;
  while (source[index] === ' ' || source[index] === '\t') index++;
  let target = '';
  if (source[index] === '<') {
    const start = ++index;
    while (index < source.length && source[index] !== '>' && source[index] !== '\r' && source[index] !== '\n') index++;
    assert.equal(source[index], '>', `packaged Markdown link has an unterminated angle destination in ${document}`);
    target = source.slice(start, index);
    index++;
  } else {
    const start = index;
    let depth = 0;
    for (; index < source.length; index++) {
      if (escapedAt(source, index)) continue;
      const character = source[index];
      if (character === '\r' || character === '\n') break;
      if ((character === ' ' || character === '\t') && depth === 0) break;
      if (character === '(') depth++;
      else if (character === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    assert.equal(depth, 0, `packaged Markdown link has an unbalanced destination in ${document}`);
    target = source.slice(start, index);
  }
  assert.ok(target, `packaged Markdown link has an empty destination in ${document}`);

  while (source[index] === ' ' || source[index] === '\t') index++;
  assert.ok(index < source.length && source[index] !== '\r' && source[index] !== '\n',
    `packaged Markdown link is missing its closing parenthesis in ${document}: ${target}`);
  if (source[index] !== ')') {
    assert.match(source[index] ?? '', /["'(]/u, `packaged Markdown link has an invalid title in ${document}: ${target}`);
    const afterTitle = quotedMarkdownTitle(source, index, source[index]);
    assert.notEqual(afterTitle, -1, `packaged Markdown link has an unterminated title in ${document}: ${target}`);
    index = afterTitle;
    while (source[index] === ' ' || source[index] === '\t') index++;
  }
  assert.equal(source[index], ')', `packaged Markdown link is missing its closing parenthesis in ${document}: ${target}`);
  return { target, end: index + 1 };
}

function collectInlineMarkdownLinks(prose, document, start = 0, end = prose.length) {
  const links = [];
  for (let index = start; index < end; index++) {
    if (prose[index] !== '[' || escapedAt(prose, index)) continue;
    const closing = matchingBracket(prose, index);
    if (closing === -1 || closing >= end) continue;
    if (prose[closing + 1] === ':' && couldStartReferenceDefinition(prose, index)) {
      assert.fail(`packaged Markdown reference definitions are unsupported in ${document}; use inline links`);
    }
    if (prose[closing + 1] === '[') {
      assert.fail(`packaged Markdown reference links are unsupported in ${document}; use inline links`);
    }
    if (prose[closing + 1] !== '(') continue;
    const parsed = inlineMarkdownDestination(prose, closing + 1, document);
    assert.ok(parsed.end <= end, `packaged Markdown link crosses a containing label in ${document}`);
    links.push(...collectInlineMarkdownLinks(prose, document, index + 1, closing));
    links.push(parsed.target);
    index = parsed.end - 1;
  }
  return links;
}

function inlineMarkdownLinks(source, document) {
  // Deliberately inspect link-shaped text inside code and raw HTML too. A
  // small release gate cannot safely reproduce all CommonMark block/inline
  // precedence, and treating examples conservatively cannot hide a live link.
  return collectInlineMarkdownLinks(source, document);
}

async function assertPackagedMarkdownLinks(packageRoot, manifest) {
  const files = manifest.files.map(item => item.path.replaceAll('\\', '/'));
  const included = new Set(files);
  const documents = files.filter(file => file.toLowerCase().endsWith('.md'));
  const realRoot = await fs.realpath(packageRoot);
  const rootPrefix = `${realRoot}${path.sep}`;

  for (const document of documents) {
    const documentPath = path.join(packageRoot, ...document.split('/'));
    const realDocument = await fs.realpath(documentPath);
    assert.ok(realDocument === realRoot || realDocument.startsWith(rootPrefix),
      `packaged Markdown document resolves outside the package: ${document}`);
    const source = await fs.readFile(realDocument, 'utf8');
    for (const target of inlineMarkdownLinks(source, document)) {
      assert.doesNotMatch(target, /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/u,
        `packaged Markdown link character references are unsupported in ${document}: ${target}`);
      if (target.startsWith('#') || /^(?:https?|mailto):/iu.test(target)) continue;
      assert.doesNotMatch(target, /^[A-Za-z][A-Za-z0-9+.-]*:/u,
        `packaged Markdown link uses an unsupported scheme in ${document}: ${target}`);
      assert.doesNotMatch(target, /[\\?\s]/u,
        `packaged Markdown link must be a plain relative path in ${document}: ${target}`);
      let decoded;
      const fragment = target.indexOf('#');
      const rawPath = fragment === -1 ? target : target.slice(0, fragment);
      try { decoded = decodeURIComponent(rawPath); }
      catch { assert.fail(`packaged Markdown link has invalid escaping in ${document}: ${target}`); }
      if (!decoded) continue;
      assert.doesNotMatch(decoded, /^[A-Za-z][A-Za-z0-9+.-]*:/u,
        `packaged Markdown link decodes to an unsupported scheme in ${document}: ${target}`);
      assert.doesNotMatch(decoded, /[\\?\s\0]/u,
        `packaged Markdown link must decode to a plain relative path in ${document}: ${target}`);
      assert.equal(decoded.startsWith('/'), false,
        `packaged Markdown link is absolute in ${document}: ${target}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(document), decoded));
      assert.equal(resolved === '..' || resolved.startsWith('../'), false,
        `packaged Markdown link leaves the archive in ${document}: ${target}`);
      const present = included.has(resolved) || files.some(file => file.startsWith(`${resolved.replace(/\/$/u, '')}/`));
      assert.ok(present, `packaged Markdown link is missing from the archive in ${document}: ${target}`);
      const diskTarget = path.resolve(packageRoot, ...resolved.split('/'));
      let realTarget;
      try { realTarget = await fs.realpath(diskTarget); }
      catch (error) {
        if (error?.code === 'ENOENT') assert.fail(`packaged Markdown link is missing on disk in ${document}: ${target}`);
        throw error;
      }
      assert.ok(realTarget === realRoot || realTarget.startsWith(rootPrefix),
        `packaged Markdown link resolves outside the package in ${document}: ${target}`);
    }
  }
}

async function fileExists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function privateRoomBearer(file) {
  try { return await readRoomSecret(file, { label: 'release check' }); }
  catch (error) {
    if (/not valid UTF-8/.test(error?.message ?? '')) {
      throw new Error('a local room bearer is not valid UTF-8; fix it before release checking');
    }
    if (/invalid shape/.test(error?.message ?? '')) {
      throw new Error('a local room bearer has an invalid shape; replace it before release checking');
    }
    throw new Error('a local room bearer could not be read safely; fix it before release checking');
  }
}

async function localSecretValues({
  settingsFiles: suppliedSettingsFiles = null,
  environment = process.env,
} = {}) {
  const settingsFiles = suppliedSettingsFiles
    ? new Set(suppliedSettingsFiles)
    : new Set([path.join(root, 'fieldwork.local.json')]);
  if (!suppliedSettingsFiles && environment.FIELDWORK_SETTINGS) {
    settingsFiles.add(path.resolve(environment.FIELDWORK_SETTINGS));
  }
  const values = [
    environment.FIELDWORK_API_KEY,
    environment.FIELDWORK_TELEGRAM_TOKEN,
    environment.FIELDWORK_DISCORD_TOKEN,
  ];
  const roomSecretFiles = new Set();
  for (const settingsFile of settingsFiles) {
    roomSecretFiles.add(`${settingsFile}.room-secret`);
    let modelSecrets;
    try { modelSecrets = await loadFieldworkSecrets(secretsFileFor(settingsFile)); }
    catch { throw new Error('the local model secret store is invalid; fix it before release checking'); }
    values.push(modelSecrets.apiKey);
    let bridgeSecrets;
    try { bridgeSecrets = await loadBridgeSecrets(bridgeSecretsFileFor(settingsFile)); }
    catch { throw new Error('the local bridge secret store is invalid; fix it before release checking'); }
    values.push(bridgeSecrets.telegramToken, bridgeSecrets.discordToken);
    if (await fileExists(settingsFile)) {
      let settings;
      try { settings = await loadManagedSettings(settingsFile); }
      catch { throw new Error('the local settings file is invalid; fix it before release checking'); }
      const homes = [settings.agentHome, ...(Array.isArray(settings.agents) ? settings.agents.map(row => row?.home) : [])];
      for (const home of homes) {
        if (typeof home === 'string' && path.isAbsolute(home)) roomSecretFiles.add(path.join(home, 'state', 'room-secret'));
      }
    }
  }
  for (const file of roomSecretFiles) values.push(await privateRoomBearer(file));
  const present = values.filter(value => typeof value === 'string' && value.length > 0);
  if (present.some(value => Buffer.byteLength(value, 'utf8') < 8)) {
    throw new Error('a configured local credential is shorter than 8 UTF-8 bytes; replace it before release checking');
  }
  return [...new Set(present)];
}

async function filesContainingValues(packageRoot, manifest, values) {
  if (!values.length) return [];
  const realRoot = await fs.realpath(packageRoot);
  const prefix = `${realRoot}${path.sep}`;
  const needles = values.map(value => Buffer.from(value, 'utf8'));
  const found = [];
  for (const item of manifest.files) {
    const file = path.resolve(packageRoot, item.path);
    const realFile = await fs.realpath(file);
    assert.ok(realFile.startsWith(prefix), `release archive path leaves the repository: ${item.path}`);
    const bytes = await fs.readFile(realFile);
    if (needles.some(needle => bytes.indexOf(needle) !== -1)) found.push(item.path.replaceAll('\\', '/'));
  }
  return found;
}

async function trackedSourceManifest() {
  const { stdout } = await run('git', ['ls-files', '-z', '--cached'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const files = stdout.split('\0').filter(Boolean).map(file => ({ path: file }));
  assert.ok(files.length > 0, 'release source scan requires a tracked tree');
  return { files };
}

test('release archive manifest and documentation links are complete and exclude local state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-release-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.private, true, 'registry publication must remain disabled');
  assert.equal(packageJson.version, '0.1.0-alpha.1', 'the first GitHub prerelease version must stay explicit');
  assert.equal(packageJson.author?.name, '4thkira', 'the public maintainer must stay explicit');
  assert.equal(
    packageJson.repository?.url,
    'git+https://github.com/4thkira/fieldworkharness.git',
    'the package must name the canonical public repository',
  );
  assert.equal(packageJson.homepage, 'https://github.com/4thkira/fieldworkharness#readme');
  assert.equal(packageJson.bugs?.url, 'https://github.com/4thkira/fieldworkharness/issues');
  assert.equal(packageJson.scripts?.['release:prepare-public'], 'node scripts/prepare-public-repo.mjs');
  assert.equal(packageJson.scripts?.['release:build'], 'node scripts/build-release.mjs');
  const shrinkwrap = JSON.parse(await fs.readFile(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(shrinkwrap.version, packageJson.version, 'the shrinkwrap version must match the package');
  assert.equal(shrinkwrap.packages?.['']?.version, packageJson.version, 'the shrinkwrap root must match the package');

  const { manifest } = await npmPack(directory);
  assertArchiveBoundary(manifest);
  await assertPackagedMarkdownLinks(root, manifest);
  const secrets = await localSecretValues();
  const sourceLeaks = await filesContainingValues(root, await trackedSourceManifest(), secrets);
  assert.deepEqual(sourceLeaks, [], `tracked source contains a local credential value in: ${sourceLeaks.join(', ')}`);
  const leaks = await filesContainingValues(root, manifest, secrets);
  assert.deepEqual(leaks, [], `release archive contains a local credential value in: ${leaks.join(', ')}`);
});

test('packaged Markdown links use the documented restricted inline form', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-release-markdown-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'docs'));
  await fs.writeFile(path.join(directory, 'docs', 'guide(one).md'), '# Guide\n');
  const manifest = { files: [{ path: 'README.md' }, { path: 'docs/guide(one).md' }] };
  const accepted = [
    '[nested [label]](docs/guide(one).md)',
    '[plain wrapper [inner](docs/guide(one).md)]',
    '[escaped \\] label](<docs/guide(one).md> "title")',
    '[directory](docs/)',
    '[local](#fragment)',
    '[web](https://example.test/a_(b)?q=1#x)',
    '[mail](mailto:reader@example.test)',
    'PowerShell keeps `[Environment]::SetEnvironmentVariable("KEY", $null, "User")` literal.',
  ].join('\n');
  await fs.writeFile(path.join(directory, 'README.md'), `${accepted}\n`);
  await assertPackagedMarkdownLinks(directory, manifest);

  const rejected = [
    ['[escape](../outside.md)', /leaves the archive/],
    ['[encoded escape](%2e%2e/outside.md)', /leaves the archive/],
    ['[encoded fragment is a filename](README.md%23missing)', /missing from the archive/],
    ['[query](README.md?raw=1)', /plain relative path/],
    ['[encoded query](README.md%3Fraw=1)', /decode to a plain relative path/],
    ['[backslash](docs\\guide.md)', /plain relative path/],
    ['[unsupported](file:README.md)', /unsupported scheme/],
    ['[encoded unsupported](file%3AREADME.md)', /decodes to an unsupported scheme/],
    ['[absolute](/README.md)', /absolute/],
    ['[malformed escape](README.md%E0%A4%A)', /invalid escaping/],
    ['[reference][guide]', /reference links are unsupported/],
    ['[guide]: docs/guide(one).md', /reference definitions are unsupported/],
    ['> [guide]: docs/guide(one).md', /reference definitions are unsupported/],
    ['[multi\nline]: docs/guide(one).md', /reference definitions are unsupported/],
    ['[wrapper [escape](../outside.md)]', /leaves the archive/],
    ['[![bad](../outside.png)](https://example.test/)', /leaves the archive/],
    ['\\` [not code](../outside.md) \\`', /leaves the archive/],
    ['`[checked conservatively](../outside.md)`', /leaves the archive/],
    ['```md\n[checked conservatively](../outside.md)\n```', /leaves the archive/],
    ['paragraph\n    [not hidden](../outside.md)', /leaves the archive/],
    ['# `\n[not hidden](../outside.md)\n`', /leaves the archive/],
    ['text <!-- ` --> [not hidden](../outside.md) `', /leaves the archive/],
    ['<!--\n```\n-->\n[not hidden](../outside.md)', /leaves the archive/],
    ['    ```md\n[not hidden](../outside.md)\n    ```', /leaves the archive/],
    ['```bad`info\n[not hidden](../outside.md)\n```', /leaves the archive/],
    ['[safe prefix](README.md`/../../outside.md#`)', /leaves the archive/],
    ['[unbalanced](docs/guide(one.md)', /closing parenthesis/],
  ];
  for (const [source, expected] of rejected) {
    await fs.writeFile(path.join(directory, 'README.md'), `${source}\n`);
    await assert.rejects(assertPackagedMarkdownLinks(directory, manifest), expected, source);
  }

  await fs.mkdir(path.join(directory, '&period;&period;'));
  await fs.writeFile(path.join(directory, '&period;&period;', 'outside.md'), '# Decoy path\n');
  await fs.writeFile(path.join(directory, 'javascript&colon;alert(1)'), 'decoy\n');
  const entityManifest = {
    files: [
      ...manifest.files,
      { path: '&period;&period;/outside.md' },
      { path: 'javascript&colon;alert(1)' },
    ],
  };
  for (const source of [
    '[entity escape](&period;&period;/outside.md)',
    '[entity scheme](javascript&colon;alert(1))',
  ]) {
    await fs.writeFile(path.join(directory, 'README.md'), `${source}\n`);
    await assert.rejects(
      assertPackagedMarkdownLinks(directory, entityManifest),
      /character references are unsupported/,
      source,
    );
  }

  await fs.writeFile(path.join(directory, 'README.md'), '[not packaged](docs/unlisted.md)\n');
  await fs.writeFile(path.join(directory, 'docs', 'unlisted.md'), '# Present only on disk\n');
  await assert.rejects(assertPackagedMarkdownLinks(directory, manifest), /missing from the archive/);

  const missingManifest = { files: [...manifest.files, { path: 'docs/missing.md' }] };
  await fs.writeFile(path.join(directory, 'README.md'), '[not extracted](docs/missing.md)\n');
  await assert.rejects(assertPackagedMarkdownLinks(directory, missingManifest), /missing on disk/);
});

test('release credential scan reports only selected paths', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-release-scan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'safe.txt'), 'ordinary public text\n');
  await fs.writeFile(path.join(directory, 'leak.txt'), 'prefix synthetic-private-token-123 suffix\n');
  const found = await filesContainingValues(directory, {
    files: [{ path: 'safe.txt' }, { path: 'leak.txt' }],
  }, ['synthetic-private-token-123']);
  assert.deepEqual(found, ['leak.txt']);
});

test('release credential discovery rejects damaged stores without echoing their bytes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-release-private-json-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settingsFile = path.join(directory, 'fieldwork.local.json');
  const specimens = [
    ['malformed JSON', Buffer.from('{"apiKey":synthetic-malformed-secret-that-must-not-echo}\n')],
    ['array', Buffer.from('["synthetic-array-secret-that-must-not-echo"]\n')],
    ['wrong format', Buffer.from('{"format":"synthetic-wrong-format-that-must-not-echo","baseURL":null,"apiKey":null}\n')],
    ['unknown field', Buffer.from('{"format":"fieldwork-supervisor-secrets/v1","baseURL":null,"apiKey":null,"extra":"synthetic-unknown-secret-that-must-not-echo"}\n')],
    ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])],
  ];
  for (const [name, bytes] of specimens) {
    await t.test(name, async () => {
      await fs.writeFile(secretsFileFor(settingsFile), bytes);
      let failure;
      try { await localSecretValues({ settingsFiles: [settingsFile], environment: {} }); }
      catch (error) { failure = error; }
      assert.ok(failure instanceof Error);
      assert.equal(failure.message, 'the local model secret store is invalid; fix it before release checking');
      assert.doesNotMatch(String(failure), /synthetic-[a-z-]+-that-must-not-echo/);
      assert.equal(failure.cause, undefined);
    });
  }
});

test('release credential discovery validates the complete room bearer', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-release-room-secret-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settingsFile = path.join(directory, 'fieldwork.local.json');
  const sentinel = 'synthetic-room-secret-that-must-not-echo';
  await fs.writeFile(`${settingsFile}.room-secret`, sentinel);
  let failure;
  try { await localSecretValues({ settingsFiles: [settingsFile], environment: {} }); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, 'a local room bearer has an invalid shape; replace it before release checking');
  assert.doesNotMatch(String(failure), new RegExp(sentinel));
  assert.equal(failure.cause, undefined);
});

test('release credential discovery refuses secrets too short to scan safely', async () => {
  await assert.rejects(
    localSecretValues({ settingsFiles: [], environment: { FIELDWORK_API_KEY: 'short' } }),
    /credential is shorter than 8 UTF-8 bytes/,
  );
});

test('release archive installs and runs its private first setup', {
  timeout: 360_000,
  skip: process.env.FIELDWORK_RELEASE_INSTALL === '1'
    ? false
    : 'the network-capable smoke runs through npm run release:check',
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-release-install-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const { manifest, archive } = await npmPack(directory);
  assertArchiveBoundary(manifest);

  const installRoot = path.join(directory, 'install');
  await fs.mkdir(installRoot);
  await runNpm([
    'install', '--prefer-offline', '--ignore-scripts', '--no-fund', '--no-audit',
    '--package-lock=false', '--prefix', installRoot, archive,
  ], { cwd: installRoot });
  const packageRoot = path.join(installRoot, 'node_modules', packageJson.name);
  await assertPackagedMarkdownLinks(packageRoot, manifest);
  const installedLeaks = await filesContainingValues(packageRoot, manifest, await localSecretValues());
  assert.deepEqual(installedLeaks, [], `installed archive contains a local credential value in: ${installedLeaks.join(', ')}`);
  const bootstrapFile = path.join(packageRoot, 'scripts', 'prepare-dependencies-cli.mjs');
  await run(process.execPath, [bootstrapFile], {
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    timeout: 180_000,
    killSignal: 'SIGKILL',
  });
  const bootstrapStampFile = path.join(packageRoot, 'node_modules', '.fieldwork-dependencies.json');
  const firstBootstrapStamp = await fs.readFile(bootstrapStampFile, 'utf8');
  const secondBootstrap = await run(process.execPath, [bootstrapFile], {
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    timeout: 180_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(secondBootstrap.stdout, '', 'an unchanged packaged launch must not reinstall dependencies');
  assert.equal(await fs.readFile(bootstrapStampFile, 'utf8'), firstBootstrapStamp,
    'an unchanged packaged launch must retain its verified dependency receipt');
  const installedClient = JSON.parse(await fs.readFile(
    path.join(packageRoot, 'node_modules', '@opencode', 'client', 'package.json'), 'utf8',
  ));
  assert.equal(installedClient.version, packageJson.dependencies['@opencode/client'],
    'the packaged install must honor the pinned model-client dependency');

  const settingsDirectory = path.join(directory, 'isolated-settings');
  await fs.mkdir(settingsDirectory);
  const settingsFile = path.join(settingsDirectory, 'fieldwork.local.json');
  const agentHome = path.join(directory, 'agent-home');
  const setup = await runSetup(packageRoot, settingsFile, agentHome);
  assert.equal(setup.code, 0, setup.output);
  assert.match(setup.output, /First start: a few questions/);
  const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(settings.agentHome, agentHome);
  assert.equal(settings.tools, 'memory,notebook,clock');
  assert.doesNotMatch(settings.tools, /web/, 'the packaged first run must retain the private default');
});
