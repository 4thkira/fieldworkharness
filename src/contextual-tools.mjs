import { deepFreeze } from './json-data.mjs';
import { isToolGroupSettings, TOOL_GROUPS, toolGroupOf } from './tool-groups.mjs';
import { createToolRegistry, isToolRegistry, onlyTools, withTools } from './tools.mjs';

// A contextual session is deliberately per run. Persistent settings decide
// which groups are resident, loadable on demand, or unavailable; the loaded
// set itself disappears when the run ends. Each provider step receives one
// frozen registry snapshot, so a controller call can only affect the next
// step—not sibling calls in the same response envelope.

export const LOAD_TOOL_GROUP = 'load_tool_group';
export const UNLOAD_TOOL_GROUP = 'unload_tool_group';

const sessions = new WeakMap();

function contextualError(message) {
  return new Error(`Contextual tools: ${message}`);
}

const groupLine = (group, mode, names) => `${group.label} (${group.id}) — ${mode}: ${names.join(', ')}`;

export function createContextualToolSession({ tools, settings, extraResident = [] } = {}) {
  if (!isToolRegistry(tools)) throw contextualError('tools must be a Fieldwork tool registry');
  if (!isToolGroupSettings(settings)) throw contextualError('settings must be Fieldwork tool-group settings');
  if (!Array.isArray(extraResident)) throw contextualError('extraResident must be an array of tool definitions');
  const extraRegistry = createToolRegistry(extraResident);
  if (tools.names.includes(LOAD_TOOL_GROUP) || tools.names.includes(UNLOAD_TOOL_GROUP)) {
    throw contextualError('the base registry uses a reserved contextual controller name');
  }
  if (extraRegistry.names.includes(LOAD_TOOL_GROUP) || extraRegistry.names.includes(UNLOAD_TOOL_GROUP)) {
    throw contextualError('a run-only tool uses a reserved contextual controller name');
  }
  // Validate collisions at the session boundary instead of discovering one
  // only after a model has already asked to load a group.
  withTools(tools, extraRegistry);

  const modes = settings.modes();
  const namesByGroup = new Map(TOOL_GROUPS.map(group => [group.id, []]));
  for (const name of tools.names) namesByGroup.get(toolGroupOf(name)).push(name);
  const presentGroups = TOOL_GROUPS.filter(group => namesByGroup.get(group.id).length);
  const loaded = new Set();
  let cache = null;

  const controller = (name, groups, action) => Object.freeze({
    name,
    description: `${action === 'load' ? 'Load' : 'Unload'} one on-demand tool group for this run. The change applies on the next model step, never to sibling calls in this response.`,
    permission: 'internal',
    effect: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          enum: groups,
          description: `Exact on-demand group id to ${action}.`,
        },
      },
      required: ['group'],
      additionalProperties: false,
    },
    async execute({ group }, context) {
      const names = namesByGroup.get(group) ?? [];
      if (modes[group] !== 'on-demand' || !names.length) {
        return { accepted: false, group, reason: 'This group is not loadable in this run.' };
      }
      if (action === 'load') {
        if (loaded.has(group)) return { accepted: false, group, reason: 'This group is already loaded.' };
        loaded.add(group);
      } else {
        if (!loaded.has(group)) return { accepted: false, group, reason: 'This group is not loaded.' };
        loaded.delete(group);
      }
      cache = null;
      return {
        accepted: true,
        action,
        group,
        effectiveStep: context.step + 1,
        tools: [...names],
        loadedGroups: [...loaded].sort(),
      };
    },
  });

  const stepRegistry = () => {
    const key = [...loaded].sort().join(',');
    if (cache?.key === key) return cache.registry;
    const selected = onlyTools(tools, name => {
      const group = toolGroupOf(name);
      return modes[group] === 'resident' || (modes[group] === 'on-demand' && loaded.has(group));
    });
    const notLoaded = presentGroups.filter(group => modes[group.id] === 'on-demand' && !loaded.has(group.id)).map(group => group.id);
    const nowLoaded = presentGroups.filter(group => loaded.has(group.id)).map(group => group.id);
    const controls = [];
    if (notLoaded.length) controls.push(controller(LOAD_TOOL_GROUP, notLoaded, 'load'));
    if (nowLoaded.length) controls.push(controller(UNLOAD_TOOL_GROUP, nowLoaded, 'unload'));
    const registry = withTools(withTools(selected, extraRegistry), controls);
    cache = { key, registry };
    return registry;
  };

  const catalogueText = () => {
    const lines = [
      'Tool catalogue for this run. Resident groups are declared now. On-demand groups are not declared until you call load_tool_group; load and unload changes take effect on the next model step and reset after this run. Off groups cannot be loaded.',
    ];
    for (const group of presentGroups) lines.push(groupLine(group, modes[group.id], namesByGroup.get(group.id)));
    if (extraRegistry.names.length) lines.push(`Run-only resident tools: ${extraRegistry.names.join(', ')}`);
    return lines.join('\n');
  };

  const session = Object.freeze({
    stepRegistry,
    catalogueText,
    permittedNames: deepFreeze(tools.names.filter(name => modes[toolGroupOf(name)] !== 'off')),
    modes,
    view: () => deepFreeze({
      loaded: [...loaded].sort(),
      resident: presentGroups.filter(group => modes[group.id] === 'resident').map(group => group.id),
      onDemand: presentGroups.filter(group => modes[group.id] === 'on-demand').map(group => group.id),
      off: presentGroups.filter(group => modes[group.id] === 'off').map(group => group.id),
    }),
  });
  sessions.set(session, { claimed: false });
  return session;
}

export function isContextualToolSession(value) {
  return Boolean(value) && sessions.has(value);
}

// A contextual session carries transient loaded state, so it belongs to one
// run. Claiming is synchronous: sequential and concurrent reuse both fail
// before another provider request can inherit the previous run's loads.
export function claimContextualToolSession(value) {
  const state = sessions.get(value);
  if (!state) throw contextualError('session was not created by Fieldwork');
  if (state.claimed) throw contextualError('session has already been used; create a fresh session for each run');
  state.claimed = true;
}
