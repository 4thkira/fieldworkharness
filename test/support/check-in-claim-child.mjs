import { createCheckInStore } from '../../src/check-ins.mjs';

function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('check-in claim child requires an IPC channel'));
    process.send(message, error => error ? reject(error) : resolve());
  });
}

function waitForStart() {
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
    const store = await createCheckInStore({ file, clock: () => new Date(at) });
    const started = waitForStart();
    await send({ type: 'ready' });
    await started;
    const result = await store.claimDue({ timeZone: 'UTC' });
    await send({ type: 'result', result });
  } catch (error) {
    try { await send({ type: 'error', message: error?.message, stack: error?.stack }); }
    catch { /* The parent may already have closed IPC. */ }
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}
