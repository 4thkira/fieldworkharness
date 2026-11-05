import { createHash } from 'node:crypto';
import { boundedJson, canonicalJson, deepFreeze, isPlainObject, parseJsonNoDuplicates } from './json-data.mjs';
import { projectMessageText } from './message-content.mjs';
import { assembleRootedMessages, ROOT_MARKER } from './root-context.mjs';
import { createMemoryEventLog, isEventLog } from './event-log.mjs';
import { isMemoryForeground, refreshMemoryForeground, withMemoryForeground } from './memory-foreground.mjs';
import { claimContextualToolSession, isContextualToolSession } from './contextual-tools.mjs';
import { isToolPermissionStore } from './tool-permissions.mjs';
import { isToolEffectStore } from './tool-effects.mjs';
import { createToolRegistry, executePreparedTool, isToolRegistry, prepareToolCall, TOOL_LIMITS } from './tools.mjs';

export const RUN_LIMITS = Object.freeze({
  steps: 32,
  transcriptBytes: 8 * 1024 * 1024,
  replyBytes: 1024 * 1024,
  toolResultBytes: 256 * 1024,
  callsPerStep: 8,
  callsInEnvelope: 32,
  trackedAttemptsPerInput: 2,
});

// Said to the agent, request-only, on the last step of a conversation run.
// A tool call there could never be observed, and a small local model that is
// not told so tends to reach for one more tool and end with no words at all.
export const FINAL_STEP_NOTE = '[Fieldwork room note: This is the last step of this reply, so tools cannot run now. Answer the person in words, using only what you have already found, and say plainly if anything is unfinished.]';

const encoder = new TextEncoder();
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function runError(message, cause) {
  return new Error(`Run: ${message}`, cause === undefined ? undefined : { cause });
}

function reasonOf(error) {
  try {
    let reason = String(error instanceof Error ? error.message || error.name : error);
    if (typeof reason.toWellFormed === 'function') reason = reason.toWellFormed();
    const characters = [...reason];
    if (characters.length <= 2000) return reason;
    const suffix = '…[truncated]';
    return `${characters.slice(0, 2000 - [...suffix].length).join('')}${suffix}`;
  }
  catch { return 'a thrown value that could not be rendered'; }
}

function exactFields(value, allowed, where) {
  if (!isPlainObject(value)) throw runError(`${where} must be an object`);
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw runError(`${where} has unknown field ${JSON.stringify(String(key))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw runError(`${where}.${key} must be an enumerable data property`);
    fields[key] = descriptor.value;
  }
  return fields;
}

function boundedWhole(value, fallback, maximum, name) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw runError(`${name} must be a whole number from 1 to ${maximum}`);
  return number;
}

function checkContent(content, where, { nullable = false } = {}) {
  try { projectMessageText(content, { where, nullable }); }
  catch (error) { throw runError(error.message, error); }
}

function checkHistoricalCall(call, where) {
  const fields = exactFields(call, ['id', 'type', 'function'], where);
  if (typeof fields.id !== 'string' || !fields.id || fields.id.length > 128) throw runError(`${where}.id must be 1-128 characters`);
  if (fields.type !== 'function') throw runError(`${where}.type must be function`);
  const fn = exactFields(fields.function, ['name', 'arguments'], `${where}.function`);
  if (typeof fn.name !== 'string' || !fn.name) throw runError(`${where}.function.name must be text`);
  if (typeof fn.arguments !== 'string') throw runError(`${where}.function.arguments must be JSON text`);
}

function cloneTranscript(messages, maxBytes) {
  let cloned;
  try { cloned = boundedJson(messages, { where: 'messages', maxBytes, maxDepth: 48, maxNodes: 100_000 }).value; }
  catch (error) { throw runError(error.message, error); }
  if (!Array.isArray(cloned) || !cloned.length) throw runError('messages must be a nonempty array');
  const transcript = structuredClone(cloned);
  for (let index = 0; index < transcript.length; index++) {
    const message = transcript[index];
    const where = `messages[${index}]`;
    if (!isPlainObject(message)) throw runError(`${where} must be an object with a role`);
    const roleField = Object.getOwnPropertyDescriptor(message, 'role');
    const role = roleField?.enumerable && Object.hasOwn(roleField, 'value') ? roleField.value : undefined;
    if (typeof role !== 'string') throw runError(`${where} must have an own data role`);
    if (['system', 'developer', 'user'].includes(role)) {
      const fields = exactFields(message, ['role', 'content'], where);
      checkContent(fields.content, `${where}.content`);
    } else if (role === 'assistant') {
      const fields = exactFields(message, ['role', 'content', 'tool_calls'], where);
      const content = fields.content === undefined ? null : fields.content;
      checkContent(content, `${where}.content`, { nullable: true });
      if (fields.tool_calls !== undefined) {
        if (!Array.isArray(fields.tool_calls)) throw runError(`${where}.tool_calls must be an array`);
        fields.tool_calls.forEach((call, callIndex) => checkHistoricalCall(call, `${where}.tool_calls[${callIndex}]`));
      }
      if (content === null) message.content = '';
    } else if (role === 'tool') {
      const fields = exactFields(message, ['role', 'content', 'tool_call_id'], where);
      if (typeof fields.content !== 'string') throw runError(`${where}.content must be text`);
      if (typeof fields.tool_call_id !== 'string' || !fields.tool_call_id) throw runError(`${where}.tool_call_id must be text`);
    } else {
      throw runError(`${where}.role ${JSON.stringify(role)} is not supported`);
    }
  }
  return transcript;
}

function ensureTranscriptBound(transcript, maximum) {
  const bytes = encoder.encode(canonicalJson(transcript)).length;
  if (bytes > maximum) throw runError(`transcript is ${bytes} JSON bytes; the limit is ${maximum}`);
  return bytes;
}

function normalizeCalls(raw, step) {
  if (raw === undefined) return { calls: [], repairs: [], problems: new Map() };
  if (!Array.isArray(raw)) throw runError('provider reply tool_calls must be an array');
  if (raw.length > RUN_LIMITS.callsInEnvelope) throw runError(`provider reply contains ${raw.length} tool calls; the envelope limit is ${RUN_LIMITS.callsInEnvelope}`);
  const seen = new Set(), repairs = [], problems = new Map(), calls = [];
  for (let index = 0; index < raw.length; index++) {
    const original = isPlainObject(raw[index]) ? raw[index] : {};
    const functionValue = Object.hasOwn(original, 'function') ? original.function : undefined;
    const fn = isPlainObject(functionValue) ? functionValue : {};
    const originalId = Object.hasOwn(original, 'id') ? original.id : undefined;
    let id = typeof originalId === 'string' ? originalId.trim() : '';
    if (!id || id.length > 128 || seen.has(id)) {
      const old = id;
      id = `call-${step}-${index + 1}`;
      while (seen.has(id)) id += '-again';
      repairs.push(old ? `call ${index + 1} had an unusable or duplicate id` : `call ${index + 1} had no id`);
    }
    seen.add(id);
    const functionName = Object.hasOwn(fn, 'name') ? fn.name : undefined;
    let name = typeof functionName === 'string' ? functionName.trim() : '';
    if (!name) {
      name = 'invalid_tool_call';
      problems.set(id, 'The provider call named no tool, so nothing ran.');
      repairs.push(`call ${index + 1} named no tool`);
    }
    let argumentText = Object.hasOwn(fn, 'arguments') ? fn.arguments : undefined;
    if (typeof argumentText !== 'string') {
      try {
        argumentText = boundedJson(argumentText ?? {}, { where: `call ${index + 1} arguments`, maxBytes: TOOL_LIMITS.argumentBytes }).canonical;
        repairs.push(`call ${index + 1} sent arguments as JSON data rather than JSON text`);
      } catch {
        argumentText = '{}';
        problems.set(id, `${name} arguments were not JSON text or representable JSON data.`);
      }
    }
    const argumentBytes = encoder.encode(argumentText).length;
    if (argumentBytes > TOOL_LIMITS.argumentBytes) problems.set(id, `${name} arguments are ${argumentBytes} bytes; the limit is ${TOOL_LIMITS.argumentBytes}.`);
    const originalType = Object.hasOwn(original, 'type') ? original.type : undefined;
    if (originalType !== undefined && originalType !== 'function') repairs.push(`call ${index + 1} had non-function type ${JSON.stringify(originalType)}`);
    calls.push(deepFreeze({ id, type: 'function', function: { name, arguments: argumentText } }));
  }
  return { calls, repairs, problems };
}

function visibleText(content) {
  if (typeof content === 'string') return content.trim() ? content : '';
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string' && part.text.trim()).map(part => part.text).join('\n');
}

function hasVisibleContent(content) {
  if (visibleText(content)) return true;
  return Array.isArray(content) && content.some(part => part?.type !== 'text');
}

function normalizeProviderReply(reply, step, maxBytes) {
  let value;
  try { value = boundedJson(reply, { where: 'provider reply', object: true, maxBytes, maxDepth: 48, maxNodes: 100_000 }).value; }
  catch (error) { throw runError(error.message, error); }
  const fields = exactFields(value, ['role', 'content', 'tool_calls'], 'provider reply');
  if (fields.role !== 'assistant') throw runError('provider reply role must be assistant');
  let content = fields.content === undefined ? null : fields.content;
  checkContent(content, 'provider reply content', { nullable: true });
  const normalized = normalizeCalls(fields.tool_calls, step);
  if (content === null && normalized.calls.length) content = '';
  if (!normalized.calls.length && !hasVisibleContent(content)) throw runError('provider reply contained neither visible content nor a tool call');
  const message = { role: 'assistant', content };
  if (normalized.calls.length) message.tool_calls = normalized.calls;
  return { message: deepFreeze(message), ...normalized };
}

function parseArguments(call) {
  try {
    const value = parseJsonNoDuplicates(call.function.arguments, { where: `${call.function.name} arguments` });
    if (!isPlainObject(value)) throw new Error('the decoded value was not an object');
    return value;
  } catch (error) {
    throw runError(`${call.function.name} arguments were not one JSON object: ${error.message}`, error);
  }
}

function normalizeToolValue(name, value, maximum) {
  try { return boundedJson(value, { where: `${name} result`, maxBytes: maximum, maxDepth: 48, maxNodes: 100_000 }).value; }
  catch (error) { throw runError(error.message, error); }
}

function providerContract(provider) {
  if (!isPlainObject(provider)) throw runError('provider must be an object with complete(request)');
  const id = Object.getOwnPropertyDescriptor(provider, 'id');
  const complete = Object.getOwnPropertyDescriptor(provider, 'complete');
  if (!complete?.enumerable || !Object.hasOwn(complete, 'value') || typeof complete.value !== 'function') throw runError('provider.complete must be an enumerable data function');
  if (!id?.enumerable || !Object.hasOwn(id, 'value') || typeof id.value !== 'string' || !providerIdPattern.test(id.value)) {
    throw runError('provider.id must be an enumerable 1-200 character portable identifier');
  }
  return Object.freeze({
    id: id.value,
    complete: request => complete.value.call(provider, request),
  });
}

function checkSignal(signal) {
  if (signal !== undefined && (typeof signal !== 'object' || typeof signal.throwIfAborted !== 'function')) throw runError('signal must be an AbortSignal when present');
}

function toolPermissionContext(value) {
  const raw = exactFields(value, ['origin', 'interactive'], 'toolPermissionContext');
  if (typeof raw.origin !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(raw.origin)) {
    throw runError('toolPermissionContext.origin must be 1-64 lowercase letters, digits, or hyphens, beginning with a letter');
  }
  if (typeof raw.interactive !== 'boolean') throw runError('toolPermissionContext.interactive must be a boolean');
  return Object.freeze({ origin: raw.origin, interactive: raw.interactive });
}

function permissionRefusal(name, authorization) {
  if (authorization.reason === 'policy-never') return `Tool ${JSON.stringify(name)} is set to Never, so it did not run.`;
  if (authorization.reason === 'approval-required') {
    return `Tool ${JSON.stringify(name)} is set to Ask. The person must choose Allow next exact retry once, Always, or Never; this call did not run and a later turn must retry it after approval.`;
  }
  if (authorization.reason === 'approval-unavailable') {
    return `Tool ${JSON.stringify(name)} is set to Ask, but this noninteractive run cannot open an approval request, so it did not run.`;
  }
  if (authorization.reason === 'request-capacity') return `Tool ${JSON.stringify(name)} needs approval, but the pending-request limit is full, so it did not run.`;
  return `Tool ${JSON.stringify(name)} was not permitted to run.`;
}

async function appendFailure(log, type, error, step) {
  try { await log.append(type, { step, reason: reasonOf(error) }); }
  catch (traceError) {
    if (error instanceof Error && !Object.hasOwn(error, 'traceError')) {
      Object.defineProperty(error, 'traceError', { value: traceError, enumerable: true });
    }
  }
}

async function run(input = {}, { isolated = false } = {}) {
  const raw = exactFields(input, isolated ? [
    'provider', 'messages', 'tools', 'eventLog', 'maxSteps',
    'maxTranscriptBytes', 'maxReplyBytes', 'maxToolResultBytes', 'signal', 'onProgress',
    'toolPermissions', 'toolPermissionContext', 'toolEffects', 'toolEffectRun',
  ] : [
    'profile', 'provider', 'messages', 'tools', 'eventLog', 'memoryForeground', 'maxSteps',
    'maxTranscriptBytes', 'maxReplyBytes', 'maxToolResultBytes', 'signal', 'onProgress',
    'toolPermissions', 'toolPermissionContext', 'toolEffects', 'toolEffectRun',
  ], 'input');
  const profile = raw.profile;
  const provider = providerContract(raw.provider);
  const messages = raw.messages;
  const suppliedTools = raw.tools === undefined ? createToolRegistry() : raw.tools;
  const toolSession = isContextualToolSession(suppliedTools) ? suppliedTools : null;
  const initialTools = toolSession ? toolSession.stepRegistry() : suppliedTools;
  const eventLog = raw.eventLog === undefined ? createMemoryEventLog() : raw.eventLog;
  const memoryForeground = raw.memoryForeground ?? null;
  const toolPermissions = raw.toolPermissions ?? null;
  const permissionContext = raw.toolPermissionContext === undefined ? null : toolPermissionContext(raw.toolPermissionContext);
  const toolEffects = raw.toolEffects ?? null;
  const toolEffectRun = raw.toolEffectRun ?? null;
  let maxSteps = raw.maxSteps === undefined ? 8 : raw.maxSteps;
  let maxTranscriptBytes = raw.maxTranscriptBytes === undefined ? RUN_LIMITS.transcriptBytes : raw.maxTranscriptBytes;
  let maxReplyBytes = raw.maxReplyBytes === undefined ? RUN_LIMITS.replyBytes : raw.maxReplyBytes;
  let maxToolResultBytes = raw.maxToolResultBytes === undefined ? RUN_LIMITS.toolResultBytes : raw.maxToolResultBytes;
  const signal = raw.signal;
  if (raw.onProgress !== undefined && typeof raw.onProgress !== 'function') throw runError('onProgress must be a function when present');
  // Live progress for a watching page: text as it is written, tools as they
  // start. Display only: a failing listener never changes the run.
  const progress = event => { try { raw.onProgress?.(Object.freeze(event)); } catch { /* ignored */ } };
  const providerId = provider.id;
  if (!isToolRegistry(initialTools)) throw runError('tools must be a Fieldwork tool registry or contextual tool session');
  if (!isEventLog(eventLog)) throw runError('eventLog must be created by Fieldwork');
  if (memoryForeground !== null && !isMemoryForeground(memoryForeground)) {
    throw runError('memoryForeground must be returned by buildMemoryForeground()');
  }
  if (toolPermissions !== null && !isToolPermissionStore(toolPermissions)) {
    throw runError('toolPermissions must be returned by createToolPermissionStore()');
  }
  if (toolPermissions && !permissionContext) throw runError('toolPermissions needs toolPermissionContext');
  if (!toolPermissions && permissionContext) throw runError('toolPermissionContext needs toolPermissions');
  if (toolEffects !== null && !isToolEffectStore(toolEffects)) {
    throw runError('toolEffects must be returned by createToolEffectStore()');
  }
  if ((toolEffects === null) !== (toolEffectRun === null)) {
    throw runError('toolEffects and toolEffectRun must be supplied together');
  }
  checkSignal(signal);
  maxSteps = boundedWhole(maxSteps, 8, RUN_LIMITS.steps, 'maxSteps');
  maxTranscriptBytes = boundedWhole(maxTranscriptBytes, RUN_LIMITS.transcriptBytes, 32 * 1024 * 1024, 'maxTranscriptBytes');
  maxReplyBytes = boundedWhole(maxReplyBytes, RUN_LIMITS.replyBytes, 8 * 1024 * 1024, 'maxReplyBytes');
  maxToolResultBytes = boundedWhole(maxToolResultBytes, RUN_LIMITS.toolResultBytes, 4 * 1024 * 1024, 'maxToolResultBytes');
  const transcript = cloneTranscript(messages, maxTranscriptBytes);
  let activeMemoryForeground = memoryForeground;
  const requestTranscript = () => activeMemoryForeground ? withMemoryForeground(transcript, activeMemoryForeground) : transcript;
  const assemble = value => isolated
    ? { messages: deepFreeze(structuredClone(value)), receipt: null }
    : assembleRootedMessages(value, profile);
  assemble(requestTranscript()); // Validate the context seam before writing a run receipt.
  const before = await eventLog.receipt();
  if (before.events !== 0) throw runError('eventLog already contains events; each run needs a fresh log');
  if (toolEffects) {
    let effectContext;
    try { effectContext = await toolEffects.runContext(toolEffectRun); }
    catch (error) { throw runError('toolEffectRun must be an active run capability from toolEffects', error); }
    if (effectContext.runId !== before.runId) throw runError('toolEffectRun belongs to a different event-log run');
    if (permissionContext && effectContext.origin !== permissionContext.origin) {
      throw runError('toolEffectRun origin must match toolPermissionContext.origin');
    }
  }
  if (toolSession) claimContextualToolSession(toolSession);

  let started = false, step = 0;
  const spoken = [];
  const trackedEffectAttempts = new Map();
  try {
    await eventLog.append('run_started', {
      provider: providerId,
      ...(isolated ? { context: 'isolated' } : { profile: profile.receipt.fingerprint }),
      messages: transcript.length,
      tools: initialTools.names,
      maxSteps,
      trackedAttemptsPerInput: RUN_LIMITS.trackedAttemptsPerInput,
      ...(memoryForeground ? { memoryForeground: memoryForeground.receipt } : {}),
    });
    started = true;
    for (step = 1; step <= maxSteps; step++) {
      signal?.throwIfAborted();
      const stepTools = toolSession ? toolSession.stepRegistry() : initialTools;
      if (activeMemoryForeground) activeMemoryForeground = await refreshMemoryForeground(activeMemoryForeground);
      signal?.throwIfAborted();
      const transcriptBytes = ensureTranscriptBound(transcript, maxTranscriptBytes);
      // Tools stay declared on the last step: some services refuse tool history
      // without them, and small local models answered worse (often with nothing)
      // when they vanished. Assemble the request-only note with the roots so
      // the user-tail voice remains the final request context. Isolated
      // instruments keep exactly the messages their caller supplied.
      const lastStepNote = !isolated && step === maxSteps && stepTools.names.length > 0;
      const requestContext = lastStepNote
        ? [...requestTranscript(), { role: 'user', content: FINAL_STEP_NOTE }]
        : requestTranscript();
      const rooted = assemble(requestContext);
      const requestMessages = rooted.messages;
      await eventLog.append('provider_request', {
        step,
        provider: providerId,
        transcriptMessages: transcript.length,
        transcriptBytes,
        requestMessages: requestMessages.length,
        ...(isolated ? { context: 'isolated' } : { roots: rooted.receipt }),
        ...(activeMemoryForeground ? { memoryForeground: activeMemoryForeground.receipt } : {}),
        ...(lastStepNote ? { finalStepNote: FINAL_STEP_NOTE } : {}),
        tools: stepTools.names,
      });

      let rawReply;
      try {
        progress({ type: 'step', step });
        rawReply = await provider.complete(Object.freeze({
          messages: requestMessages,
          tools: stepTools.providerTools,
          signal,
          step,
          ...(raw.onProgress ? { onText: delta => { if (typeof delta === 'string' && delta) progress({ type: 'text', step, delta }); } } : {}),
        }));
      } catch (error) {
        await appendFailure(eventLog, 'provider_failed', error, step);
        throw error;
      }
      signal?.throwIfAborted();
      const normalized = normalizeProviderReply(rawReply, step, maxReplyBytes);
      transcript.push(normalized.message);
      const words = visibleText(normalized.message.content);
      if (words) spoken.push(words);
      await eventLog.append('provider_response', {
        step,
        message: normalized.message,
        repairs: normalized.repairs,
        problems: [...normalized.problems].map(([callId, reason]) => ({ callId, reason })),
      });
      ensureTranscriptBound(transcript, maxTranscriptBytes);
      if (normalized.message.tool_calls?.length) {
        progress({ type: 'tools', step, names: normalized.message.tool_calls.map(call => call.function?.name).filter(Boolean) });
      }

      if (!normalized.calls.length) {
        await eventLog.append('run_completed', { status: 'completed', steps: step, messages: transcript.length, spoken: spoken.length });
        return deepFreeze({
          status: 'completed',
          answer: spoken.join('\n\n'),
          spoken: [...spoken],
          message: normalized.message,
          messages: transcript,
          receipt: await eventLog.receipt(),
        });
      }

      const finalStep = step === maxSteps;
      for (let index = 0; index < normalized.calls.length; index++) {
        signal?.throwIfAborted();
        const call = normalized.calls[index];
        let result;
        const refusal = normalized.problems.get(call.id)
          || (index >= RUN_LIMITS.callsPerStep ? `Only ${RUN_LIMITS.callsPerStep} tool calls may run in one step; this call was number ${index + 1}.` : '')
          || (finalStep ? 'The run reached its final provider step, so this call did not start where its result could never be observed.' : '')
          || (!stepTools.names.includes(call.function.name) ? `Tool ${JSON.stringify(call.function.name)} was not offered in this provider step and did not run.` : '');
        let event;
        if (refusal) {
          result = { ok: false, error: refusal, effectMayHaveOccurred: false };
          event = await eventLog.append('tool_refused', { step, callId: call.id, name: call.function.name, result });
        } else {
          let args;
          let prepared;
          let effectAttemptKey = null;
          let priorEffectAttempts = 0;
          try { args = parseArguments(call); }
          catch (error) {
            result = { ok: false, error: reasonOf(error), effectMayHaveOccurred: false };
            event = await eventLog.append('tool_refused', { step, callId: call.id, name: call.function.name, result });
          }
          if (!event) {
            try {
              prepared = prepareToolCall(stepTools, call.function.name, args, { signal, callId: call.id, step });
            } catch (error) {
              if (signal?.aborted) throw signal.reason ?? error;
              result = { ok: false, error: reasonOf(error), effectMayHaveOccurred: false };
              event = await eventLog.append('tool_refused', { step, callId: call.id, name: call.function.name, result });
            }
          }
          if (!event && toolEffects && prepared.effect === 'tracked') {
            const fenced = await toolEffects.fence({
              tool: prepared.name,
              argumentsSha256: prepared.argumentsSha256,
            });
            if (fenced) {
              const failure = runError(`tool ${JSON.stringify(prepared.name)} has an unresolved effect that needs recovery review before it can run again`);
              try {
                await eventLog.append('tool_recovery_required', {
                  step,
                  callId: call.id,
                  name: prepared.name,
                  effectId: fenced.actionId,
                });
              } catch (traceError) {
                Object.defineProperty(failure, 'traceError', { value: traceError, enumerable: true });
              }
              throw failure;
            }
          }
          if (!event && prepared.effect === 'tracked') {
            effectAttemptKey = `${prepared.name}:${prepared.argumentsSha256}`;
            priorEffectAttempts = trackedEffectAttempts.get(effectAttemptKey) ?? 0;
            if (priorEffectAttempts >= RUN_LIMITS.trackedAttemptsPerInput) {
              result = {
                ok: false,
                error: `Tool ${JSON.stringify(prepared.name)} already entered its executor ${priorEffectAttempts} times with this exact input in this run; the per-run limit is ${RUN_LIMITS.trackedAttemptsPerInput}, so this call did not run.`,
                effectMayHaveOccurred: false,
              };
              event = await eventLog.append('tool_refused', {
                step,
                callId: call.id,
                name: prepared.name,
                result,
                budget: {
                  kind: 'tracked-attempts-per-input',
                  limit: RUN_LIMITS.trackedAttemptsPerInput,
                  attempted: priorEffectAttempts,
                  argumentsSha256: prepared.argumentsSha256,
                },
              });
            }
          }
          let authorization = null;
          if (!event && toolPermissions && prepared.permission === 'configurable') {
            try {
              authorization = await toolPermissions.authorize({
                tool: prepared.name,
                argumentsSha256: prepared.argumentsSha256,
                summary: prepared.permissionSummary,
                origin: permissionContext.origin,
                interactive: permissionContext.interactive,
                callId: call.id,
                step,
                runId: before.runId,
              });
              if (!authorization.allowed) {
                result = {
                  ok: false,
                  error: permissionRefusal(call.function.name, authorization),
                  effectMayHaveOccurred: false,
                  permission: {
                    mode: authorization.mode,
                    reason: authorization.reason,
                    ...(authorization.requestId ? { requestId: authorization.requestId } : {}),
                  },
                };
                event = await eventLog.append('tool_refused', { step, callId: call.id, name: call.function.name, result });
              }
            } catch (error) {
              result = {
                ok: false,
                error: `Tool ${JSON.stringify(call.function.name)} permission could not be checked, so it did not run.`,
                effectMayHaveOccurred: false,
                permission: { mode: 'unavailable', reason: 'check-failed' },
              };
              event = await eventLog.append('tool_refused', {
                step, callId: call.id, name: call.function.name, result,
                permissionFailure: reasonOf(error),
              });
            }
          }
          if (!event) {
            const permission = prepared.permission === 'internal'
              ? { mode: 'internal', reason: 'internal' }
              : authorization
                ? {
                    mode: authorization.mode,
                    reason: authorization.reason,
                    ...(authorization.requestId ? { requestId: authorization.requestId } : {}),
                  }
                : { mode: 'not-configured', reason: 'no-store' };
            if (toolEffects && prepared.effect === 'tracked') {
              signal?.throwIfAborted();
              const effect = await toolEffects.prepare({
                run: toolEffectRun,
                tool: prepared.name,
                argumentsSha256: prepared.argumentsSha256,
                summary: prepared.permissionSummary,
                permission,
                callIdHash: createHash('sha256').update(call.id, 'utf8').digest('hex'),
              });
              signal?.throwIfAborted();
              const attempt = await toolEffects.beginAttempt({
                run: toolEffectRun,
                actionId: effect.actionId,
                expectedRevision: effect.revision,
              });

              // The executor begins immediately after its durable attempt
              // edge. Trace writes are secondary and never stand between the
              // authority boundary and executor entry.
              trackedEffectAttempts.set(effectAttemptKey, priorEffectAttempts + 1);
              const execution = executePreparedTool(prepared).then(
                value => ({ kind: 'returned', value }),
                error => ({ kind: 'threw', error }),
              );
              const startedTrace = eventLog.append('tool_started', {
                step,
                callId: call.id,
                name: call.function.name,
                permission,
                effectId: effect.actionId,
              }).then(
                value => ({ ok: true, value }),
                error => ({ ok: false, error }),
              );
              const observed = await execution;
              const outcome = observed.kind === 'returned'
                ? 'executor-returned'
                : signal?.aborted ? 'interrupted' : 'executor-error';
              try {
                await toolEffects.reportOutcome({ capability: attempt.capability, outcome });
              } catch (reportError) {
                const trace = await startedTrace;
                const primary = signal?.aborted
                  ? signal.reason ?? observed.error ?? reportError
                  : observed.kind === 'threw'
                    ? new AggregateError([observed.error, reportError], 'Tool execution and durable outcome report both failed')
                    : reportError;
                if (!trace.ok && primary instanceof Error && !Object.hasOwn(primary, 'traceError')) {
                  Object.defineProperty(primary, 'traceError', { value: trace.error, enumerable: true });
                }
                if (signal?.aborted && primary instanceof Error && !Object.hasOwn(primary, 'toolEffectError')) {
                  Object.defineProperty(primary, 'toolEffectError', { value: reportError, enumerable: true });
                }
                throw primary;
              }
              const trace = await startedTrace;
              if (observed.kind === 'threw') {
                const failure = signal?.aborted ? signal.reason ?? observed.error : observed.error;
                let interruptionTraceError = null;
                if (trace.ok) {
                  try {
                    await eventLog.append('tool_interrupted', {
                      step,
                      callId: call.id,
                      name: call.function.name,
                      effectId: effect.actionId,
                      outcome,
                    });
                  } catch (error) {
                    interruptionTraceError = error;
                  }
                }
                if (!trace.ok && failure instanceof Error && !Object.hasOwn(failure, 'traceError')) {
                  Object.defineProperty(failure, 'traceError', { value: trace.error, enumerable: true });
                } else if (interruptionTraceError && failure instanceof Error && !Object.hasOwn(failure, 'traceError')) {
                  Object.defineProperty(failure, 'traceError', { value: interruptionTraceError, enumerable: true });
                }
                throw failure;
              }
              if (!trace.ok) throw trace.error;
              signal?.throwIfAborted();
              result = { ok: true, value: normalizeToolValue(call.function.name, observed.value, maxToolResultBytes) };
              event = await eventLog.append('tool_finished', {
                step,
                callId: call.id,
                name: call.function.name,
                result,
                effectId: effect.actionId,
              });
            } else {
              await eventLog.append('tool_started', {
                step, callId: call.id, name: call.function.name, permission,
              });
              try {
                if (prepared.effect === 'tracked') {
                  trackedEffectAttempts.set(effectAttemptKey, priorEffectAttempts + 1);
                }
                const value = await executePreparedTool(prepared);
                result = { ok: true, value: normalizeToolValue(call.function.name, value, maxToolResultBytes) };
              } catch (error) {
                if (signal?.aborted) {
                  await appendFailure(eventLog, 'tool_interrupted', error, step);
                  throw signal.reason ?? error;
                }
                result = { ok: false, error: reasonOf(error), effectMayHaveOccurred: prepared.effect !== 'read-only' };
              }
              event = await eventLog.append('tool_finished', { step, callId: call.id, name: call.function.name, result });
            }
          }
        }
        const receipt = { runId: event.runId, sequence: event.sequence, hash: event.hash };
        transcript.push(deepFreeze({
          role: 'tool',
          tool_call_id: call.id,
          content: canonicalJson({ ...result, receipt }),
        }));
        ensureTranscriptBound(transcript, maxTranscriptBytes);
      }
      if (finalStep) {
        await eventLog.append('run_completed', { status: 'exhausted', steps: step, messages: transcript.length, spoken: spoken.length });
        return deepFreeze({
          status: 'exhausted',
          answer: spoken.join('\n\n'),
          spoken: [...spoken],
          message: normalized.message,
          messages: transcript,
          receipt: await eventLog.receipt(),
        });
      }
    }
    throw runError('step loop ended unexpectedly');
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (started) await appendFailure(eventLog, signal?.aborted ? 'run_stopped' : 'run_failed', failure, step);
    throw failure;
  }
}

export function runConversation(input = {}) {
  return run(input, { isolated: false });
}

// A deliberately rootless run for instruments that must not inherit the
// author's identity, current conversation, or automatic memory. Callers still
// provide the complete bounded message set and exact tool registry.
export function runIsolatedConversation(input = {}) {
  return run(input, { isolated: true });
}

export function transcriptContainsInjectedRoots(messages) {
  return canonicalJson(messages).includes(ROOT_MARKER);
}
