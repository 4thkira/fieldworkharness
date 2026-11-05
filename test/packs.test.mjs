import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDWORK_CONFIG_FORMAT, normalizeFieldworkConfig } from '../src/config.mjs';
import { createHostServices, createPackRegistry, startPackHost } from '../src/packs.mjs';

const selected = packs => normalizeFieldworkConfig({ format: FIELDWORK_CONFIG_FORMAT, packs });
const pack = (name, extra = {}) => ({ apiVersion: 1, name, version: '0.1.0', ...extra });

test('an empty selection loads and starts absolutely nothing', async () => {
  let loaded = 0;
  const registry = createPackRegistry({ dormant: () => { loaded++; throw new Error('should remain asleep'); } });
  const host = await startPackHost({ config: selected([]), registry });
  assert.equal(loaded, 0);
  assert.deepEqual(host.receipt.packs, []);
  await host.close();
});

test('only selected loaders run, declaration order is preserved, and options stay namespaced', async () => {
  const events = [];
  const registry = createPackRegistry({
    unused: () => { throw new Error('unselected loader ran'); },
    second: () => pack('second', {
      configure: options => ({ label: String(options.label) }),
      setup: ({ config }) => { events.push(`setup:${config.label}`); },
    }),
    first: () => pack('first', {
      configure: options => ({ label: String(options.label) }),
      setup: ({ config }) => { events.push(`setup:${config.label}`); },
    }),
  });
  const host = await startPackHost({
    config: selected([
      { name: 'second', options: { label: 'two' } },
      { name: 'first', options: { label: 'one' } },
    ]),
    registry,
  });
  assert.deepEqual(events, ['setup:two', 'setup:one']);
  assert.deepEqual(host.receipt.packs.map(row => row.name), ['second', 'first']);
  await host.close();
});

test('unknown configured packs fail before any registry loader runs', async () => {
  let loads = 0;
  const registry = createPackRegistry({ known: () => { loads++; return pack('known'); } });
  await assert.rejects(startPackHost({
    config: selected([{ name: 'known' }, { name: 'missing' }]),
    registry,
  }), /missing is not in the injected registry/);
  assert.equal(loads, 0);
});

test('required services negotiate exact APIs before configuration or setup', async () => {
  let configured = 0, setups = 0;
  const registry = createPackRegistry({
    memory: () => pack('memory', {
      requiredServices: { storage: 2 },
      configure: () => { configured++; return {}; },
      setup: () => { setups++; },
    }),
  });
  await assert.rejects(startPackHost({ config: selected([{ name: 'memory' }]), registry }), /storage API 2.*unavailable/);
  await assert.rejects(startPackHost({
    config: selected([{ name: 'memory' }]), registry,
    services: createHostServices({ storage: { apiVersion: 1, value: {} } }),
  }), /requires host service storage API 2.*provides API 1/);
  assert.equal(configured, 0);
  assert.equal(setups, 0);
});

test('a pack receives only declared compatible services and optional misses stay visible in the receipt', async () => {
  const storage = { put() {} }, logger = { write() {} }, secret = { token: 'not granted' };
  let seen;
  const registry = createPackRegistry({
    memory: () => pack('memory', {
      requiredServices: { storage: 1 },
      optionalServices: { logger: 2, clock: 1 },
      setup: input => { seen = input; },
    }),
  });
  const host = await startPackHost({
    config: selected([{ name: 'memory' }]),
    registry,
    services: createHostServices({
      storage: { apiVersion: 1, value: storage },
      logger: { apiVersion: 1, value: logger },
      secret: { apiVersion: 1, value: secret },
    }),
  });
  assert.deepEqual(Object.keys(seen.services), ['storage']);
  assert.equal(seen.services.storage, storage);
  assert.equal(seen.services.logger, undefined);
  assert.equal(seen.services.secret, undefined);
  assert.deepEqual(host.receipt.packs[0].services.optional, [
    { name: 'clock', apiVersion: 1, status: 'unavailable' },
    { name: 'logger', apiVersion: 2, status: 'version-mismatch', hostApiVersion: 1 },
  ]);
  await host.close();
});

test('every configure result is checked before the first setup begins', async () => {
  let setups = 0;
  const registry = createPackRegistry({
    good: () => pack('good', { configure: () => ({}), setup: () => { setups++; } }),
    broken: () => pack('broken', { configure: () => ['not an object'], setup: () => { setups++; } }),
  });
  await assert.rejects(startPackHost({
    config: selected([{ name: 'good' }, { name: 'broken' }]), registry,
  }), /configure\(\) result must be a JSON object/);
  assert.equal(setups, 0);
});

test('startup is transactional and cleans the failed pack plus earlier packs in reverse order', async () => {
  const order = [];
  const registry = createPackRegistry({
    first: () => pack('first', { setup: ({ defer }) => {
      defer(() => order.push('first:defer'));
      return { stop: () => order.push('first:stop') };
    } }),
    second: () => pack('second', { setup: ({ defer }) => {
      defer(() => order.push('second:defer'));
      throw new Error('split open');
    } }),
  });
  await assert.rejects(startPackHost({
    config: selected([{ name: 'first' }, { name: 'second' }]), registry,
  }), /second setup\(\) failed: split open/);
  assert.deepEqual(order, ['second:defer', 'first:stop', 'first:defer']);
});

test('a setup timeout or external abort rolls back resources instead of stranding earlier packs', async () => {
  const order = [];
  const registry = createPackRegistry({
    first: () => pack('first', { setup: ({ defer }) => {
      defer(() => order.push('first:defer'));
      return { stop: () => order.push('first:stop') };
    } }),
    hangs: () => pack('hangs', { setup: ({ defer, signal }) => {
      defer(() => order.push(`hangs:defer:${signal.aborted}`));
      return new Promise(() => {});
    } }),
  });
  await assert.rejects(startPackHost({
    config: selected([{ name: 'first' }, { name: 'hangs' }]), registry,
    setupTimeoutMs: 10, cleanupTimeoutMs: 20,
  }), /hangs setup\(\) failed: .*timed out/);
  assert.deepEqual(order, ['hangs:defer:true', 'first:stop', 'first:defer']);

  const controller = new AbortController();
  const abortRegistry = createPackRegistry({ hangs: () => pack('hangs', { setup: ({ defer }) => {
    defer(() => order.push('aborted:defer'));
    queueMicrotask(() => controller.abort(new Error('operator cancelled start')));
    return new Promise(() => {});
  } }) });
  await assert.rejects(startPackHost({
    config: selected([{ name: 'hangs' }]), registry: abortRegistry, signal: controller.signal,
    setupTimeoutMs: 100,
  }), /operator cancelled start/);
  assert.equal(order.at(-1), 'aborted:defer');
});

test('a hanging loader is bounded and observes startup cancellation', async () => {
  const hangs = () => new Promise(() => {});
  await assert.rejects(startPackHost({
    config: selected([{ name: 'hangs' }]), registry: createPackRegistry({ hangs }), loadTimeoutMs: 10,
  }), /loader timed out/);

  const controller = new AbortController();
  const pending = startPackHost({
    config: selected([{ name: 'hangs' }]), registry: createPackRegistry({ hangs }),
    signal: controller.signal, loadTimeoutMs: 100,
  });
  queueMicrotask(() => controller.abort(new Error('cancelled during load')));
  await assert.rejects(pending, /cancelled during load/);
});

test('shutdown is once-only, reverse-order, aborts signals, and preserves every cleanup failure', async () => {
  const order = [], signals = [];
  const registry = createPackRegistry({
    first: () => pack('first', { setup: ({ signal, defer }) => {
      signals.push(signal);
      defer(() => { order.push('first:defer'); throw new Error('first cracked'); });
      return { stop: () => order.push('first:stop') };
    } }),
    second: () => pack('second', { setup: ({ signal, defer }) => {
      signals.push(signal);
      defer(() => order.push('second:defer'));
      return { stop: () => { order.push('second:stop'); throw new Error('second cracked'); } };
    } }),
  });
  const host = await startPackHost({ config: selected([{ name: 'first' }, { name: 'second' }]), registry });
  const one = host.close(), two = host.close();
  assert.equal(one, two);
  await assert.rejects(one, error => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual(error.errors.map(item => item.message), ['second cracked', 'first cracked']);
    return true;
  });
  assert.deepEqual(order, ['second:stop', 'second:defer', 'first:stop', 'first:defer']);
  assert.ok(signals.every(signal => signal.aborted));
});

test('cleanup timeouts and hostile thrown values do not prevent later cleanup', async () => {
  const order = [];
  const hostile = { [Symbol.toPrimitive]() { throw new Error('conversion exploded'); } };
  const registry = createPackRegistry({
    first: () => pack('first', { setup: ({ defer }) => {
      defer(() => order.push('first:last'));
      defer(() => { order.push('first:hostile'); throw hostile; });
    } }),
    second: () => pack('second', { setup: ({ defer }) => {
      defer(() => order.push('second:after-hang'));
      return { stop: () => { order.push('second:hang'); return new Promise(() => {}); } };
    } }),
  });
  const host = await startPackHost({
    config: selected([{ name: 'first' }, { name: 'second' }]), registry, cleanupTimeoutMs: 10,
  });
  await assert.rejects(host.close(), error => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(error.errors[0].message, /cleanup timed out/);
    assert.match(error.errors[1].message, /could not be rendered/);
    return true;
  });
  assert.deepEqual(order, ['second:hang', 'second:after-hang', 'first:hostile', 'first:last']);
});

test('a returned stop method keeps its receiver', async () => {
  let live, receiverWasKept = false;
  const registry = createPackRegistry({ bound: () => pack('bound', { setup: () => {
    live = { stop() { receiverWasKept = this === live; } };
    return live;
  } }) });
  const host = await startPackHost({ config: selected([{ name: 'bound' }]), registry });
  await host.close();
  assert.equal(receiverWasKept, true);
});

test('the startup abort signal is detached after the host starts', async () => {
  const controller = new AbortController();
  let packSignal, cleanups = 0;
  const registry = createPackRegistry({ probe: () => pack('probe', { setup: ({ signal, defer }) => {
    packSignal = signal;
    defer(() => { cleanups++; });
  } }) });
  const host = await startPackHost({ config: selected([{ name: 'probe' }]), registry, signal: controller.signal });
  controller.abort(new Error('too late'));
  assert.equal(packSignal.aborted, false);
  assert.equal(cleanups, 0);
  await host.close();
  assert.equal(packSignal.aborted, true);
  assert.equal(cleanups, 1);
});

test('pack definitions, registries, service catalogs, and setup results are strict', async () => {
  assert.throws(() => createPackRegistry({ '../bad': () => ({}) }), /invalid registry pack name/);
  assert.throws(() => createPackRegistry({ good: {} }), /loader function/);
  assert.throws(() => createHostServices({ storage: { apiVersion: 1, value: {}, extra: true } }), /unknown field "extra"/);
  assert.throws(() => createHostServices({ storage: { apiVersion: 0, value: {} } }), /positive whole number/);

  const cases = [
    [() => ({ ...pack('wrong'), name: 'other' }), /declare that same name/],
    [() => ({ ...pack('wrong'), apiVersion: 2 }), /apiVersion must be 1/],
    [() => ({ ...pack('wrong'), surprise: true }), /unknown field "surprise"/],
    [() => pack('wrong', { requiredServices: { storage: 1 }, optionalServices: { storage: 1 } }), /both required and optional/],
    [() => pack('wrong', { setup: () => ({ extra: true }) }), /setup\(\) result has unknown field/],
  ];
  for (const [loader, pattern] of cases) {
    const registry = createPackRegistry({ wrong: loader });
    await assert.rejects(startPackHost({ config: selected([{ name: 'wrong' }]), registry }), pattern);
  }
});

test('SemVer validation accepts build metadata and rejects malformed prereleases', async () => {
  const starts = async version => startPackHost({
    config: selected([{ name: 'versioned' }]),
    registry: createPackRegistry({ versioned: () => ({ ...pack('versioned'), version }) }),
  });
  const valid = await starts('1.2.3-rc.1+build.7');
  await valid.close();
  await assert.rejects(starts('1.0.0-a..b'), /must be SemVer/);
  await assert.rejects(starts('1.0.0-01'), /must be SemVer/);
  await assert.rejects(starts(`1.0.0+${'x'.repeat(300)}`), /must be SemVer/);
});

test('a transient loader failure may be retried, while accessor-backed callbacks are never invoked', async () => {
  let loads = 0;
  const registry = createPackRegistry({ retry: () => {
    loads++;
    if (loads === 1) throw new Error('temporary loader failure');
    return pack('retry');
  } });
  await assert.rejects(startPackHost({ config: selected([{ name: 'retry' }]), registry }), /temporary loader failure/);
  const host = await startPackHost({ config: selected([{ name: 'retry' }]), registry });
  assert.equal(loads, 2);
  await host.close();

  let definitionReads = 0;
  const definition = pack('accessor');
  Object.defineProperty(definition, 'setup', { enumerable: true, get() { definitionReads++; return () => {}; } });
  await assert.rejects(startPackHost({
    config: selected([{ name: 'accessor' }]), registry: createPackRegistry({ accessor: () => definition }),
  }), /setup must be an enumerable data property/);
  assert.equal(definitionReads, 0);

  let stopReads = 0;
  await assert.rejects(startPackHost({
    config: selected([{ name: 'result' }]),
    registry: createPackRegistry({ result: () => pack('result', { setup: () => {
      const live = {};
      Object.defineProperty(live, 'stop', { enumerable: true, get() { stopReads++; return () => {}; } });
      return live;
    } }) }),
  }), /stop must be an enumerable data property/);
  assert.equal(stopReads, 0);
});

test('prototype pollution and configure then accessors cannot supply or execute pack fields', async () => {
  Object.prototype.apiVersion = 1;
  Object.prototype.name = 'polluted';
  Object.prototype.version = '1.0.0';
  try {
    await assert.rejects(startPackHost({
      config: selected([{ name: 'polluted' }]), registry: createPackRegistry({ polluted: () => ({}) }),
    }), /apiVersion must be 1/);
  } finally {
    delete Object.prototype.apiVersion;
    delete Object.prototype.name;
    delete Object.prototype.version;
  }

  let reads = 0;
  const answer = {};
  Object.defineProperty(answer, 'then', { enumerable: true, get() { reads++; return () => {}; } });
  await assert.rejects(startPackHost({
    config: selected([{ name: 'probe' }]),
    registry: createPackRegistry({ probe: () => pack('probe', { configure: () => answer }) }),
  }), /then must be an enumerable data property/);
  assert.equal(reads, 0);
});

test('options cannot be silently ignored and configure must remain synchronous JSON', async () => {
  await assert.rejects(startPackHost({
    config: selected([{ name: 'plain', options: { typo: true } }]),
    registry: createPackRegistry({ plain: () => pack('plain') }),
  }), /has options but does not declare configure/);
  await assert.rejects(startPackHost({
    config: selected([{ name: 'async' }]),
    registry: createPackRegistry({ async: () => pack('async', { configure: async () => ({}) }) }),
  }), /configure\(\) must be synchronous/);
});
