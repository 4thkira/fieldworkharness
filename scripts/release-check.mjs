import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['--test', 'test/release-package.test.mjs'], {
  cwd: root,
  env: { ...process.env, FIELDWORK_RELEASE_INSTALL: '1' },
  stdio: 'inherit',
  windowsHide: true,
});

const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

if (result.signal) {
  console.error(`Release check stopped by ${result.signal}.`);
  process.exitCode = 1;
} else {
  process.exitCode = result.code ?? 1;
}
