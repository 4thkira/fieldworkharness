import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { browserLaunchCommand, openBrowser } from '../src/browser-launch.mjs';

test('browser launch commands stay platform-specific', () => {
  assert.deepEqual(browserLaunchCommand('http://local.test/', { platform: 'win32' }), [
    'rundll32', ['url.dll,FileProtocolHandler', 'http://local.test/'],
  ]);
  assert.deepEqual(browserLaunchCommand('http://local.test/', { platform: 'darwin' }), [
    'open', ['http://local.test/'],
  ]);
  assert.deepEqual(browserLaunchCommand('http://local.test/', { platform: 'linux' }), [
    'xdg-open', ['http://local.test/'],
  ]);
});

test('browser launch can be disabled without starting a child', () => {
  let called = false;
  const result = openBrowser('http://local.test/', {
    environment: { FIELDWORK_NO_BROWSER: '1' },
    spawnProcess: () => { called = true; },
  });
  assert.equal(called, false);
  assert.deepEqual(result, { requested: false, reason: 'disabled' });
});

test('an asynchronous launcher error prints the usable URL instead of crashing', () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const messages = [];
  const result = openBrowser('http://local.test/#token=synthetic', {
    environment: {},
    platform: 'linux',
    spawnProcess: () => child,
    log: message => messages.push(message),
  });
  child.emit('error', new Error('xdg-open is unavailable'));
  assert.deepEqual(result, { requested: true, command: 'xdg-open' });
  assert.deepEqual(messages, ['Open this in your browser: http://local.test/#token=synthetic']);
});

test('a nonzero launcher exit prints the usable URL', () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const messages = [];
  openBrowser('http://local.test/', {
    environment: {},
    platform: 'linux',
    spawnProcess: () => child,
    log: message => messages.push(message),
  });
  child.emit('exit', 127);
  assert.deepEqual(messages, ['Open this in your browser: http://local.test/']);
});

test('a successful launcher exit stays quiet', () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const messages = [];
  openBrowser('http://local.test/', {
    environment: {},
    platform: 'linux',
    spawnProcess: () => child,
    log: message => messages.push(message),
  });
  child.emit('exit', 0);
  assert.deepEqual(messages, []);
});

test('a synchronous launcher failure prints the usable URL', () => {
  const messages = [];
  const result = openBrowser('http://local.test/', {
    environment: {},
    spawnProcess: () => { throw new Error('cannot spawn'); },
    log: message => messages.push(message),
  });
  assert.deepEqual(result, { requested: false, reason: 'launch-failed' });
  assert.deepEqual(messages, ['Open this in your browser: http://local.test/']);
});
