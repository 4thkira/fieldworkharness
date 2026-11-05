import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createContextualToolSession,
  LOAD_TOOL_GROUP,
  UNLOAD_TOOL_GROUP,
} from '../src/contextual-tools.mjs';
import { createToolGroupSettings } from '../src/tool-groups.mjs';
import {
  createToolRegistry,
  executePreparedTool,
  permissionOfTool,
  prepareToolCall,
} from '../src/tools.mjs';

test('contextual controllers are internal and normalized run-only permissions survive every step', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-contextual-tools-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = await createToolGroupSettings({ file: path.join(directory, 'tool-groups.json') });
  await settings.set('web', 'on-demand');
  const base = createToolRegistry([{
    name: 'what_time_is_it',
    description: 'Return one synthetic resident clock value.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ now: 'synthetic' }),
  }, {
    name: 'read_web_page',
    description: 'Read one synthetic on-demand web page.',
    permission: 'internal',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ text: 'synthetic page' }),
  }]);

  let propertyReads = 0;
  const runOnlyTarget = {
    name: 'run_only_probe',
    description: 'Return one immutable run-only synthetic probe.',
    permission: 'internal',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: () => ({ ok: true }),
  };
  const runOnlyProxy = new Proxy(runOnlyTarget, {
    get(target, key, receiver) {
      propertyReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const session = createContextualToolSession({ tools: base, settings, extraResident: [runOnlyProxy] });
  assert.equal(propertyReads, 0, 'reconstruction uses the normalized registry rather than rereading definitions');
  runOnlyTarget.permission = 'configurable';

  const first = session.stepRegistry();
  assert.equal(permissionOfTool(first, 'what_time_is_it'), 'configurable');
  assert.equal(permissionOfTool(first, 'run_only_probe'), 'internal');
  assert.equal(permissionOfTool(first, LOAD_TOOL_GROUP), 'internal');
  const load = prepareToolCall(first, LOAD_TOOL_GROUP, { group: 'web' }, { step: 2 });
  assert.equal(load.permission, 'internal');
  assert.equal(prepareToolCall(first, 'run_only_probe', {}).permission, 'internal');
  assert.deepEqual(await executePreparedTool(load), {
    accepted: true,
    action: 'load',
    group: 'web',
    effectiveStep: 3,
    tools: ['read_web_page'],
    loadedGroups: ['web'],
  });

  const second = session.stepRegistry();
  assert.equal(permissionOfTool(second, 'read_web_page'), 'internal');
  assert.equal(permissionOfTool(second, 'run_only_probe'), 'internal');
  assert.equal(permissionOfTool(second, UNLOAD_TOOL_GROUP), 'internal');
  const unload = prepareToolCall(second, UNLOAD_TOOL_GROUP, { group: 'web' }, { step: 3 });
  assert.equal(unload.permission, 'internal');
  await executePreparedTool(unload);

  const third = session.stepRegistry();
  assert.equal(third.names.includes('read_web_page'), false);
  assert.equal(permissionOfTool(third, LOAD_TOOL_GROUP), 'internal');
  assert.equal(permissionOfTool(third, 'run_only_probe'), 'internal');
  assert.equal(propertyReads, 0);
});
