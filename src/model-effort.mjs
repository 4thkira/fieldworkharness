// Reasoning effort is a request-level model control, not a prompt instruction.
// Public OpenAI Chat Completions documents the first seven values. The Codex
// subscription catalogue may additionally advertise `ultra`; Fieldwork offers
// that value only when the catalogue names it for the selected model.

export const OPENAI_CHAT_REASONING_EFFORTS = Object.freeze([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

export const CHATGPT_SUBSCRIPTION_REASONING_EFFORTS = Object.freeze([
  ...OPENAI_CHAT_REASONING_EFFORTS,
  'ultra',
]);

export const MODEL_REASONING_EFFORTS = CHATGPT_SUBSCRIPTION_REASONING_EFFORTS;

export const isReasoningEffort = (value, allowed = MODEL_REASONING_EFFORTS) => (
  typeof value === 'string' && allowed.includes(value)
);

export const OPENAI_CHAT_REASONING_EFFORT_OPTIONS = Object.freeze([
  Object.freeze({ id: 'none', description: 'No deliberate reasoning when the model supports it.' }),
  Object.freeze({ id: 'minimal', description: 'The lightest supported reasoning.' }),
  Object.freeze({ id: 'low', description: 'Faster responses with lighter reasoning.' }),
  Object.freeze({ id: 'medium', description: 'A balance of speed and reasoning depth.' }),
  Object.freeze({ id: 'high', description: 'More reasoning for complex work.' }),
  Object.freeze({ id: 'xhigh', description: 'Extra-high reasoning for difficult work.' }),
  Object.freeze({ id: 'max', description: 'The model\'s maximum public reasoning effort.' }),
]);
