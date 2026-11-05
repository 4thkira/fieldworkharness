import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectStateLocks } from '../src/stale-state-locks.mjs';

// The demo removes its own temporary folder when stopped with Ctrl+C, but a
// hard stop (closing its window, Task Manager, a tool ending the process)
// skips that cleanup and leaves the folder behind. Each new demo therefore
// removes earlier demo folders, but only when every lock inside names a
// process that is no longer running. A folder that is live, lockless,
// unreadable, or holds anything other than plain files is left alone.

const DEMO_FOLDER = /^fieldwork-browser-demo-[A-Za-z0-9]{6}$/u;

export async function removeAbandonedDemoFolders({ tmpdir = os.tmpdir(), keep = null, processStatus } = {}) {
  const removed = [];
  const kept = [];
  let names;
  try { names = await fs.readdir(tmpdir); }
  catch { return { removed, kept }; }
  for (const name of names.sort()) {
    if (!DEMO_FOLDER.test(name)) continue;
    const folder = path.join(tmpdir, name);
    if (keep && path.resolve(folder) === path.resolve(keep)) continue;
    try {
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory()) { kept.push(folder); continue; }
      const entries = await fs.readdir(folder, { withFileTypes: true });
      if (entries.some(entry => !entry.isFile())) { kept.push(folder); continue; }
      const locks = await inspectStateLocks(folder, processStatus ? { processStatus } : undefined);
      const abandoned = locks.length > 0
        && locks.every(row => row.status === 'valid' && row.owner === 'dead' && !row.guardPresent);
      if (!abandoned) { kept.push(folder); continue; }
      await fs.rm(folder, { recursive: true, force: true });
      removed.push(folder);
    } catch {
      kept.push(folder);
    }
  }
  return { removed, kept };
}
