import { createTaskHeartbeatStore } from '../../src/task-heartbeats.mjs';

function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('task heartbeat claim child requires an IPC channel'));
    process.send(message, error => error ? reject(error) : resolve());
  });
}

function waitForClaimBarrier() {
  return new Promise((resolve, reject) => {
    process.once('message', message => {
      if (message?.type === 'claim') resolve();
      else reject(new Error(`expected claim barrier, received ${JSON.stringify(message)}`));
    });
    process.once('disconnect', () => reject(new Error('IPC disconnected before the claim barrier')));
  });
}

if (process.send) {
  try {
    const [file, at] = process.argv.slice(2);
    if (!file || !at || Number.isNaN(Date.parse(at))) throw new Error('expected a state file and ISO timestamp');
    const store = await createTaskHeartbeatStore({ file, clock: () => new Date(at) });
    const barrier = waitForClaimBarrier();
    await send({ type: 'ready' });
    await barrier;
    const result = await store.claimDue();
    await send({ type: 'result', result });
  } catch (error) {
    try { await send({ type: 'error', message: error?.message, stack: error?.stack }); }
    catch { /* The parent may already have closed IPC. */ }
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}
