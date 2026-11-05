export const REPLY_INPUT_RECEIPT_FORMAT = 'fieldwork-reply-input-receipt/v1';
export const OFFERED_MEMORY_BATCH_LIMIT = 16;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const recordRows = value => Array.isArray(value) && value.every(record);
const stringRows = value => Array.isArray(value) && value.every(row => typeof row === 'string');
const sourceKinds = new Set(['conversation', 'run-event', 'document', 'memory']);
const sourceFingerprint = /^[0-9a-f]{64}$/;
const exactInstant = value => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const sourceRow = value => record(value)
  && sourceKinds.has(value.kind)
  && typeof value.fingerprint === 'string'
  && sourceFingerprint.test(value.fingerprint)
  && (value.observedThrough === null || exactInstant(value.observedThrough));
const rootRow = value => record(value)
  && (!Object.hasOwn(value, 'observedThrough') || value.observedThrough === null || exactInstant(value.observedThrough));
const indexRow = value => record(value)
  && value.kind === 'memory-ledger'
  && typeof value.ledgerId === 'string'
  && value.ledgerId.length > 0
  && Number.isSafeInteger(value.events)
  && value.events >= 1
  && typeof value.head === 'string'
  && sourceFingerprint.test(value.head);
const legacyLedgerRow = value => record(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && Number.isSafeInteger(value.events)
  && value.events >= 1
  && typeof value.head === 'string'
  && sourceFingerprint.test(value.head);

const trailStep = row => record(row) && (
  (row.kind === 'note' && typeof row.text === 'string')
  || (row.kind === 'tool' && typeof row.tool === 'string')
);

export const offeredMemoryKey = ({ id, fingerprint }) => JSON.stringify([id, fingerprint]);

// A memory may be revised between model steps. Preserve each exact offered
// version, while folding repeats of that same version into one visible row.
export function offeredMemoryVersions(memory) {
  const rows = new Map();
  const includedIds = new Set();
  const omittedIds = new Set();
  const steps = Array.isArray(memory?.steps) ? memory.steps : [];
  steps.forEach((step, index) => {
    const stepNumber = Number.isSafeInteger(step?.step) ? step.step : index + 1;
    const included = new Set((Array.isArray(step?.context?.included) ? step.context.included : [])
      .map(row => row?.id).filter(id => typeof id === 'string' && id));
    for (const row of Array.isArray(step?.selected) ? step.selected : []) {
      if (typeof row?.id !== 'string' || !row.id) continue;
      if (!included.has(row.id)) {
        omittedIds.add(row.id);
        continue;
      }
      includedIds.add(row.id);
      const candidate = {
        id: row.id,
        fingerprint: typeof row.fingerprint === 'string' ? row.fingerprint : '',
      };
      const key = offeredMemoryKey(candidate);
      const existing = rows.get(key);
      if (existing) {
        if (!existing.steps.includes(stepNumber)) existing.steps.push(stepNumber);
      } else {
        rows.set(key, {
          ...candidate,
          matchedBy: row.matchedBy,
          matchedTerms: row.matchedTerms,
          timeMatch: row.timeMatch === true,
          steps: [stepNumber],
        });
      }
    }
  });
  for (const id of includedIds) omittedIds.delete(id);
  const versionsById = new Map();
  for (const row of rows.values()) versionsById.set(row.id, (versionsById.get(row.id) || 0) + 1);
  return {
    rows: [...rows.values()].map(row => ({ ...row, versioned: versionsById.get(row.id) > 1 })),
    omittedIds: [...omittedIds],
  };
}

export function offeredMemoryBatches(rows, limit = OFFERED_MEMORY_BATCH_LIMIT) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(limit) || limit < 1) return [];
  const batches = [];
  for (let index = 0; index < rows.length; index += limit) batches.push(rows.slice(index, index + limit));
  return batches;
}

function validReceipt(value) {
  if (!record(value) || value.format !== REPLY_INPUT_RECEIPT_FORMAT) return false;
  if (!record(value.currentMessage) || typeof value.currentMessage.included !== 'boolean') return false;
  if (!record(value.profile) || !recordRows(value.profile.roots) || !value.profile.roots.every(rootRow)) return false;
  if (!Array.isArray(value.room) || !value.room.every(record)) return false;
  if (!record(value.conversation)) return false;
  if (value.conversation.compaction != null && !record(value.conversation.compaction)) return false;
  const recovery = value.conversation.recovery;
  if (recovery != null && (!record(recovery) || !recordRows(recovery.selected || []))) return false;
  if (!record(value.memory) || typeof value.memory.enabled !== 'boolean' || !recordRows(value.memory.steps)) return false;
  for (const step of value.memory.steps) {
    if (Object.hasOwn(step, 'index') && !indexRow(step.index)) return false;
    if (Object.hasOwn(step, 'ledger') && !legacyLedgerRow(step.ledger)) return false;
    if (!recordRows(step.selected || []) || !record(step.context)) return false;
    if (!step.selected.every(row => {
      const sources = Object.hasOwn(row, 'sources') ? row.sources : [];
      return recordRows(sources) && sources.every(sourceRow);
    })) return false;
    if (!recordRows(step.context.included || []) || !recordRows(step.context.skipped || [])) return false;
  }
  if (!record(value.tools) || !stringRows(value.tools.available) || !recordRows(value.tools.steps)) return false;
  if (!value.tools.steps.every(step => stringRows(step.available || []))) return false;
  return typeof value.note === 'string';
}

export function replyContinuityModel(rawTrail, rawReceipt) {
  const trailKnown = rawTrail == null || (Array.isArray(rawTrail) && rawTrail.every(trailStep));
  const trail = trailKnown && Array.isArray(rawTrail) ? rawTrail : [];
  const receipt = validReceipt(rawReceipt) ? rawReceipt : null;
  if (!trail.length && !receipt) return null;

  const cues = [];
  if (receipt?.currentMessage?.included === true) cues.push('conversation');

  const roots = Array.isArray(receipt?.profile?.roots) ? receipt.profile.roots.length : 0;
  if (roots) cues.push(`${roots} root${roots === 1 ? '' : 's'}`);

  const memories = new Set();
  const memorySteps = Array.isArray(receipt?.memory?.steps) ? receipt.memory.steps : [];
  for (const step of memorySteps) {
    const included = Array.isArray(step?.context?.included) ? step.context.included : [];
    for (const row of included) {
      if (typeof row?.id !== 'string' || !row.id) continue;
      memories.add(`${typeof row.type === 'string' ? row.type : ''}:${row.id}`);
    }
  }
  if (memories.size) cues.push(`${memories.size} memor${memories.size === 1 ? 'y' : 'ies'} offered`);
  else if (receipt) cues.push(receipt.memory?.enabled === false ? 'memory off' : 'no memory offered');

  const tools = trail.filter(step => step.kind === 'tool').length;
  if (tools) cues.push(`${tools} tool call${tools === 1 ? '' : 's'}`);
  else if (receipt && trailKnown) cues.push('no tool calls');

  return { trail, receipt, cues };
}
