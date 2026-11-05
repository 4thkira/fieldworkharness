import {
  offeredMemoryBatches,
  offeredMemoryKey,
  offeredMemoryVersions,
  replyContinuityModel,
} from './reply-continuity.js';

const byId = id => document.getElementById(id);

const elements = {
  workspace: document.querySelector('.workspace'),
  sidebar: document.querySelector('.sidebar'),
  inspectorPanel: document.querySelector('.inspector'),
  conversationList: byId('conversation-list'),
  archivedConversations: byId('archived-conversations'),
  archivedConversationCount: byId('archived-conversation-count'),
  archivedConversationList: byId('archived-conversation-list'),
  fieldworkList: byId('fieldwork-list'),
  modeSwitch: byId('mode-switch'),
  modeTalk: byId('mode-talk'),
  modeFieldwork: byId('mode-fieldwork'),
  conversationPanel: document.querySelector('.conversation-panel'),
  fieldworkPanel: byId('fieldwork-panel'),
  fieldworkForm: byId('fieldwork-form'),
  fieldworkPrompt: byId('fieldwork-prompt'),
  fieldworkSteps: byId('fieldwork-steps'),
  fieldworkError: byId('fieldwork-error'),
  fieldworkDetail: byId('fieldwork-detail'),
  fieldworkTitle: byId('fieldwork-title'),
  fieldworkChip: byId('fieldwork-chip'),
  conversationSearch: byId('conversation-search'),
  newConversation: byId('new-conversation'),
  conversationTitleRow: document.querySelector('.conversation-title-row'),
  conversationTitleHeading: byId('conversation-title'),
  conversationTitle: byId('conversation-title-text'),
  conversationTitleEdit: byId('conversation-title-edit'),
  conversationTitleForm: byId('conversation-title-form'),
  conversationTitleInput: byId('conversation-title-input'),
  conversationTitleCancel: byId('conversation-title-cancel'),
  conversationTitleStatus: byId('conversation-title-status'),
  conversationActions: byId('conversation-actions'),
  conversationProactiveAction: byId('conversation-proactive-action'),
  conversationArchiveAction: byId('conversation-archive-action'),
  conversationAnnouncement: byId('conversation-announcement'),
  modelChip: byId('model-chip'),
  modelSection: byId('model-section'),
  modelCurrent: byId('model-current'),
  modelBrowse: byId('model-browse'),
  modelDialog: byId('model-dialog'),
  modelSearch: byId('model-search'),
  modelList: byId('model-list'),
  modelCount: byId('model-count'),
  modelDialogStatus: byId('model-dialog-status'),
  modelStatus: byId('model-status'),
  modelEffortForm: byId('model-effort-form'),
  modelEffort: byId('model-effort'),
  modelEffortNote: byId('model-effort-note'),
  modelEffortStatus: byId('model-effort-status'),
  modelEffortApply: byId('model-effort-apply'),
  providerService: byId('provider-service'),
  providerAccess: byId('provider-access'),
  providerHelp: byId('provider-help'),
  connectionForm: byId('connection-form'),
  connectionService: byId('connection-service'),
  connectionEndpointRow: byId('connection-endpoint-row'),
  connectionEndpoint: byId('connection-endpoint'),
  connectionModel: byId('connection-model'),
  connectionKeyRow: byId('connection-key-row'),
  connectionApiKey: byId('connection-api-key'),
  connectionKeyNote: byId('connection-key-note'),
  connectionStatus: byId('connection-status'),
  connectionSave: byId('connection-save'),
  connectionSecretActions: byId('connection-secret-actions'),
  connectionForgetKey: byId('connection-forget-key'),
  connectionManageNote: byId('connection-manage-note'),
  telegramBridgeForm: byId('telegram-bridge-form'),
  telegramBridgeScope: byId('telegram-bridge-scope'),
  telegramBridgeChatId: byId('telegram-bridge-chat-id'),
  telegramBridgeUserId: byId('telegram-bridge-user-id'),
  telegramBridgeToken: byId('telegram-bridge-token'),
  telegramBridgeGroupRow: byId('telegram-bridge-group-row'),
  telegramBridgeGroupConfirmation: byId('telegram-bridge-group-confirmation'),
  telegramBridgeStatus: byId('telegram-bridge-status'),
  telegramBridgeRefresh: byId('telegram-bridge-refresh'),
  telegramBridgeDisconnect: byId('telegram-bridge-disconnect'),
  telegramBridgeForgetToken: byId('telegram-bridge-forget-token'),
  telegramBridgeDetail: byId('telegram-bridge-detail'),
  discordBridgeForm: byId('discord-bridge-form'),
  discordBridgeScope: byId('discord-bridge-scope'),
  discordBridgeChannelId: byId('discord-bridge-channel-id'),
  discordBridgeGuildRow: byId('discord-bridge-guild-row'),
  discordBridgeGuildId: byId('discord-bridge-guild-id'),
  discordBridgeUserId: byId('discord-bridge-user-id'),
  discordBridgeToken: byId('discord-bridge-token'),
  discordBridgeGroupRow: byId('discord-bridge-group-row'),
  discordBridgeGroupConfirmation: byId('discord-bridge-group-confirmation'),
  discordBridgeStatus: byId('discord-bridge-status'),
  discordBridgeRefresh: byId('discord-bridge-refresh'),
  discordBridgeDisconnect: byId('discord-bridge-disconnect'),
  discordBridgeForgetToken: byId('discord-bridge-forget-token'),
  discordBridgeDetail: byId('discord-bridge-detail'),
  deliveryRecovery: byId('delivery-recovery'),
  deliveryRecoverySummary: byId('delivery-recovery-summary'),
  deliveryRecoveryRange: byId('delivery-recovery-range'),
  deliveryRecoveryList: byId('delivery-recovery-list'),
  deliveryRecoveryStatus: byId('delivery-recovery-status'),
  guideForm: byId('guide-rewrite-form'),
  guideList: byId('guide-list'),
  guideStatus: byId('guide-status'),
  guideRewrite: byId('guide-rewrite'),
  settingsSearch: byId('settings-search'),
  settingsSearchStatus: byId('settings-search-status'),
  statusDot: byId('status-dot'),
  statusLabel: byId('status-label'),
  restart: byId('restart-button'),
  settingsButton: byId('settings-button'),
  settingsDialog: byId('settings-dialog'),
  runChip: byId('run-chip'),
  notice: byId('conversation-notice'),
  messages: byId('messages'),
  empty: byId('conversation-empty'),
  composer: byId('composer'),
  input: byId('message-input'),
  send: byId('send-button'),
  metrics: byId('profile-metrics'),
  rootCount: byId('root-count'),
  roots: byId('root-list'),
  rootsNotice: byId('roots-notice'),
  emptyRootsNotice: byId('empty-roots-notice'),
  provider: byId('provider-label'),
  toolLabel: byId('tool-label'),
  packLabel: byId('pack-label'),
  archive: byId('archive-label'),
  toolCount: byId('tool-count'),
  tools: byId('tool-list'),
  packCount: byId('pack-count'),
  packs: byId('pack-list'),
  memoryForm: byId('memory-search-form'),
  memoryQuery: byId('memory-query'),
  memorySummary: byId('memory-summary'),
  memoryResults: byId('memory-results'),
  receipts: byId('receipt-list'),
  appearanceForm: byId('appearance-form'),
  typefacePreview: byId('typeface-preview'),
  interfaceTypefacePreview: byId('interface-typeface-preview'),
  technicalTypefacePreview: byId('technical-typeface-preview'),
  appearanceReset: byId('appearance-reset'),
  appearanceRevision: byId('appearance-revision'),
  appearanceStatus: byId('appearance-status'),
  appearanceDecorationStatus: byId('appearance-decoration-status'),
  agentList: byId('agent-list'),
  agentCreateForm: byId('agent-create-form'),
  agentCreateName: byId('agent-create-name'),
  agentCreateExpert: byId('agent-create-expert'),
  agentRenameForm: byId('agent-rename-form'),
  agentRenameName: byId('agent-rename-name'),
  agentMoveForm: byId('agent-move-form'),
  agentMoveDestination: byId('agent-move-destination'),
  agentExportForm: byId('agent-export-form'),
  agentExportDestination: byId('agent-export-destination'),
  agentImportForm: byId('agent-import-form'),
  agentImportSource: byId('agent-import-source'),
  agentStatus: byId('agent-status'),
  clearStateConfirmation: byId('clear-state-confirmation'),
  clearStateButton: byId('clear-state-button'),
  resetAgentConfirmation: byId('reset-agent-confirmation'),
  resetAgentButton: byId('reset-agent-button'),
  recoveryList: byId('recovery-list'),
  restorePreview: byId('restore-preview'),
  restorePreviewTitle: byId('restore-preview-title'),
  restorePreviewDescription: byId('restore-preview-description'),
  restorePreviewLocation: byId('restore-preview-location'),
  restoreConfirmationPhrase: byId('restore-confirmation-phrase'),
  restoreConfirmation: byId('restore-confirmation'),
  restoreButton: byId('restore-button'),
  resetStatus: byId('reset-status'),
};

// The authored markup keeps Settings beside the inspector it controls, but the
// live dialog must not inherit inspector hiding or move when panels are
// reordered. Put it at the document boundary before rendering appearance.
document.body.append(elements.settingsDialog);

const templates = {
  message: byId('message-template'),
  instrument: byId('instrument-template'),
  memory: byId('memory-template'),
  receipt: byId('receipt-template'),
};

const launchTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const STORED_TOKEN = 'fieldwork-room-token-v1';
const STALE_TOKEN = 'request token is missing or invalid';

// localStorage is scoped to this exact origin (host and port), so the plain
// room address works again in this browser after the first launch link.
function storedToken() {
  try { return window.localStorage.getItem(STORED_TOKEN); } catch { return null; }
}

function storeToken(token) {
  try {
    if (token) window.localStorage.setItem(STORED_TOKEN, token);
    else window.localStorage.removeItem(STORED_TOKEN);
  } catch { /* Storage may be unavailable; the launch link still works. */ }
}

function launchToken() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fromFragment = fragment.getAll('token');
  const stateToken = window.history.state && typeof window.history.state === 'object'
    ? window.history.state.fieldworkToken
    : null;
  const token = fromFragment.length === 1 ? fromFragment[0] : (stateToken ?? storedToken());
  if (typeof token !== 'string' || !launchTokenPattern.test(token)) return null;
  if (fromFragment.length === 1) {
    window.history.replaceState({ fieldworkToken: token }, '', `${window.location.pathname}${window.location.search}`);
    storeToken(token);
  }
  return token;
}

// Opening a new launch link in a tab already on this address changes only the
// fragment, which does not reload the page. Adopt the new token and start fresh.
window.addEventListener('hashchange', () => {
  const fromFragment = new URLSearchParams(window.location.hash.slice(1)).getAll('token');
  if (fromFragment.length !== 1 || !launchTokenPattern.test(fromFragment[0])) return;
  launchToken();
  window.location.reload();
});

const state = {
  token: launchToken(),
  origin: window.location.origin,
  busy: false,
  appearanceBusy: false,
  agentBusy: false,
  connectionBusy: false,
  bridgeBusy: false,
  deliveryRecoveryBusy: false,
  deliveryRecovery: null,
  deliveryRecoveryNotice: false,
  toolRecoveryBusy: false,
  toolRecovery: null,
  guideBusy: false,
  guides: null,
  recoveryBackups: [],
  selectedBackupId: null,
  bootstrap: null,
  conversationId: null,
  conversations: [],
  conversationTitleEditingId: null,
  conversationTitleEditorGeneration: 0,
  conversationTitleBusy: false,
  conversationLifecycleBusy: false,
  conversationSelectionGeneration: 0,
  mode: 'talk',
  fieldworks: [],
  fieldworkId: null,
  fieldworkCurrent: null,
  fieldworkTimer: null,
  pendingAttachments: [],
};

const fallbackAgentGrammar = Object.freeze({
  subject: 'the agent',
  object: 'the agent',
  possessiveDeterminer: "the agent's",
  possessivePronoun: "the agent's",
  reflexive: 'the agent',
  agreement: 'singular',
  configured: false,
});

function agentGrammar() {
  const forms = state.look?.agent?.pronounForms;
  const keys = ['subject', 'object', 'possessiveDeterminer', 'possessivePronoun', 'reflexive'];
  if (!forms || !keys.every(key => typeof forms[key] === 'string' && forms[key]) || !['singular', 'plural'].includes(forms.agreement)) {
    return fallbackAgentGrammar;
  }
  return { ...forms, configured: true };
}

const agentVerb = (grammar, singular, plural) => grammar.agreement === 'plural' ? plural : singular;

const typefaceOptions = Object.freeze([
  'serif', 'sans', 'mono', 'system-sans', 'system-mono',
  'cozette', 'comic-neue', 'lexend', 'shantell',
]);
const appearanceOptions = Object.freeze({
  palette: Object.freeze([
    'fieldwork', 'amber', 'cyanotype', 'monochrome',
    'madoromi-haru-yoru', 'madoromi-natsu-yoru', 'madoromi-aki-yoru', 'madoromi-fuyu-yoru',
  ]),
  density: Object.freeze(['dense', 'relaxed']),
  textSize: Object.freeze(['extra-small', 'small', 'standard', 'large', 'extra-large']),
  typeface: typefaceOptions,
  interfaceTypeface: typefaceOptions,
  technicalTypeface: typefaceOptions,
  lineSpacing: Object.freeze(['tight', 'standard', 'airy']),
  readingWidth: Object.freeze(['narrow', 'standard', 'wide', 'full']),
  messageLayout: Object.freeze(['alternating', 'stacked']),
  avatars: Object.freeze(['shown', 'hidden']),
  sidebarWidth: Object.freeze(['narrow', 'standard', 'wide']),
  inspector: Object.freeze(['narrow', 'standard', 'wide']),
  panelOrder: Object.freeze([
    'navigator-conversation-inspector', 'navigator-inspector-conversation',
    'conversation-navigator-inspector', 'conversation-inspector-navigator',
    'inspector-navigator-conversation', 'inspector-conversation-navigator',
  ]),
  sidebarVisibility: Object.freeze(['shown', 'hidden']),
  inspectorVisibility: Object.freeze(['shown', 'hidden']),
  texture: Object.freeze(['grid', 'dither', 'plain']),
  motion: Object.freeze(['system', 'reduced']),
  side: Object.freeze(['right', 'left']),
});

function setText(node, value, fallback = '—') {
  node.textContent = value === undefined || value === null || value === '' ? fallback : String(value);
}

function shortHash(value) {
  return typeof value === 'string' && value.length > 16 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers['x-fieldwork-token'] = state.token;
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let value;
  try { value = await response.json(); }
  catch { value = { error: `Fieldwork returned ${response.status} without a JSON body.` }; }
  if (response.status === 403 && value.error === STALE_TOKEN) {
    storeToken(null);
    throw new Error(state.token
      ? 'This room has a new password, probably because it restarted. Open the link printed in its terminal.'
      : 'This room needs its password. Open the link printed in its terminal once; this browser will remember it.');
  }
  if (!response.ok) throw new Error(value.error || `Fieldwork returned ${response.status}.`);
  return value;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function appendMetric(term, value) {
  const wrap = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.textContent = value ?? '—';
  dd.title = value ?? '';
  wrap.append(dt, dd);
  elements.metrics.append(wrap);
}

function appendInstrument(list, { name, detail, active = true }) {
  const fragment = templates.instrument.content.cloneNode(true);
  const item = fragment.querySelector('li');
  const marker = fragment.querySelector('.instrument-state');
  marker.classList.toggle('active', active);
  fragment.querySelector('strong').textContent = name;
  fragment.querySelector('small').textContent = detail || 'declared';
  list.append(item);
}

// Tools grouped by what they are for, so a long list stays easy to scan.
const TOOL_GROUPS = [
  ['Memory', /remember|recall|memory|forget/],
  ['Notebook', /file/],
  ['Shelf', /shelf/],
  ['Web', /web|page|search/],
  ['Clock', /time|clock|date/],
  ['Moods & expression', /mood|thinking|emoji/],
  ['Self & room', /portrait|pronoun|guide|review_changes/],
  ['Fieldworks & check-ins', /fieldwork|check/],
];
const ROOM_GROUP_LABELS = { memory: 'Memory', notebook: 'Notebook', collections: 'Collections', shelf: 'Shelf', web: 'Web', clock: 'Clock', expression: 'Moods & expression', self: 'Self & room', other: 'Other' };
const toolGroupFor = tool => ROOM_GROUP_LABELS[tool.group] ?? TOOL_GROUPS.find(([, pattern]) => pattern.test(tool.name))?.[0] ?? 'Other';
const toolGroup = name => TOOL_GROUPS.find(([, pattern]) => pattern.test(name))?.[0] ?? 'Other';

function renderToolList() {
  const tools = Array.isArray(state.tools) ? state.tools : [];
  const query = byId('tool-search').value.trim().toLowerCase();
  const shown = query ? tools.filter(tool => `${tool.name} ${tool.description || ''} ${toolGroupFor(tool)}`.toLowerCase().includes(query)) : tools;
  clear(elements.tools);
  const groups = new Map();
  for (const tool of shown) {
    const group = toolGroupFor(tool);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(tool);
  }
  const order = [...new Set([...Object.values(ROOM_GROUP_LABELS), ...TOOL_GROUPS.map(([name]) => name), 'Other'])];
  for (const group of order) {
    const rows = groups.get(group);
    if (!rows) continue;
    const heading = document.createElement('li');
    heading.className = 'tool-group';
    heading.textContent = `${group} · ${rows.length}`;
    elements.tools.append(heading);
    for (const tool of rows) {
      const detail = tool.mode === 'off'
        ? `off in Settings → Tools · ${tool.description || ''}`
        : tool.mode === 'on-demand'
          ? `on demand; the agent can load it for one run · ${tool.description || ''}`
          : tool.description || 'resident tool';
      appendInstrument(elements.tools, { name: tool.name, detail, active: tool.mode !== 'off' });
      const item = elements.tools.lastElementChild;
      if (tool.mode === 'off') item.classList.add('switched-off');
      if (tool.mode === 'on-demand') item.classList.add('on-demand');
      item.tabIndex = 0;
      item.title = 'Show the whole description';
      const toggle = () => item.classList.toggle('expanded');
      item.addEventListener('click', toggle);
      item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    }
  }
  if (query && !shown.length) {
    const none = document.createElement('li');
    none.className = 'tool-group none';
    none.textContent = 'No tool matches.';
    elements.tools.append(none);
  }
}

function renderToolStatus(tools) {
  setText(elements.toolCount, tools.length, '0');
  const residentTools = tools.filter(tool => tool.mode === 'resident').length;
  const onDemandTools = tools.filter(tool => tool.mode === 'on-demand').length;
  setText(elements.toolLabel, `${residentTools} resident${onDemandTools ? ` · ${onDemandTools} on demand` : ''}`);
}

// Roots that still hold only the template's bracketed instruction are sent to
// the model exactly as they are, so a newcomer is told before the first hello.
function renderUnwrittenRoots(ids, total, editable) {
  const listed = ids.length < 3 ? ids.join(' and ') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`;
  const example = 'For an example, open docs/writing-roots.md in your Fieldwork folder.';
  const one = ids.length === 1;
  const how = editable
    ? `Choose Edit beside ${one ? 'it' : 'each one'} below to write it.`
    : `Write ${one ? 'it' : 'them'} in the roots folder of the agent home, then restart Fieldwork.`;
  elements.rootsNotice.hidden = !ids.length;
  elements.emptyRootsNotice.hidden = !ids.length;
  if (!ids.length) return;
  elements.rootsNotice.textContent = ids.length === total
    ? `Your agent is still blank: ${listed} still ${one ? 'holds' : 'hold'} the template's instructions, and the model reads ${one ? 'it' : 'them'} exactly as written. ${how} ${example}`
    : `Not written yet: ${listed}. The model reads ${ids.length === 1 ? 'it' : 'them'} exactly as written. ${how} ${example}`;
  elements.emptyRootsNotice.textContent = ids.length === total
    ? `Your agent is still blank. Open Health → Roots and write who your agent is first. ${example}`
    : `Not written yet: ${listed}. Open Health → Roots to write ${ids.length === 1 ? 'it' : 'them'}.`;
}

function rootVerificationDetails(root) {
  const details = document.createElement('details');
  details.className = 'root-verification';
  const summary = document.createElement('summary');
  summary.textContent = 'Verify';
  const values = document.createElement('dl');
  const versionTerm = document.createElement('dt');
  versionTerm.textContent = 'Version';
  const versionValue = document.createElement('dd');
  const version = document.createElement('code');
  version.textContent = exactVersionLabel(root.sha256);
  version.tabIndex = 0;
  version.setAttribute('aria-label', `Exact version for ${root.id}`);
  versionValue.append(version);
  const edgeTerm = document.createElement('dt');
  edgeTerm.textContent = 'Read edge';
  const edgeValue = document.createElement('dd');
  edgeValue.textContent = rootEdgeLabel(root);
  values.append(versionTerm, versionValue, edgeTerm, edgeValue);
  details.append(summary, values);
  return details;
}

function renderHealth(bootstrap) {
  const health = bootstrap.health || {};
  const profile = health.profile || {};
  const roots = Array.isArray(profile.roots) ? profile.roots : [];
  const tools = Array.isArray(health.tools) ? health.tools : [];
  const packs = Array.isArray(health.packs) ? health.packs : [];

  clear(elements.metrics);
  appendMetric('Status', health.status || 'unknown');
  appendMetric('Agent files', `${roots.length} loaded`);
  appendMetric('Profile version', versionLabel(profile.fingerprint));
  appendMetric('Size', `${profile.bytes ?? 0} bytes`);

  clear(elements.roots);
  const unwrittenIds = new Set(Array.isArray(profile.unwrittenRoots) ? profile.unwrittenRoots : []);
  roots.forEach(root => {
    const when = plainTime(root.observedThrough);
    appendInstrument(elements.roots, {
      name: root.id,
      detail: [
        unwrittenIds.has(root.id) ? 'not written yet' : '',
        root.placement === 'system' ? 'read first' : root.placement === 'user-tail' ? 'read last' : root.placement,
        `${root.bytes} bytes`,
        when ? `as of ${when}` : '',
      ].filter(Boolean).join(' · '),
    });
    const item = elements.roots.lastElementChild;
    item.querySelector('div').append(rootVerificationDetails(root));
    if (bootstrap.capabilities?.editRoots) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'root-edit-button';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit ${root.id}`);
      edit.addEventListener('click', () => { void openRootEditor(root.id); });
      item.append(edit);
    }
  });
  renderUnwrittenRoots(roots.filter(root => unwrittenIds.has(root.id)).map(root => root.id), roots.length, Boolean(bootstrap.capabilities?.editRoots));
  setText(elements.rootCount, roots.length, '0');

  state.tools = tools;
  renderToolList();
  renderToolStatus(tools);

  clear(elements.packs);
  packs.forEach(pack => appendInstrument(elements.packs, {
    name: pack.name,
    detail: pack.status || 'selected',
    active: pack.status === 'ready' || pack.status === 'selected',
  }));
  setText(elements.packCount, packs.length, '0');

  setText(elements.provider, health.provider?.id, 'Not connected');
  setText(elements.packLabel, `${packs.length} selected`);
  setText(elements.archive, health.archive?.status, 'Not connected');

  const healthy = health.status === 'ready';
  elements.statusDot.className = `status-dot ${healthy ? 'healthy' : 'failed'}`;
  const degradedLabel = health.externalDeliveries?.status === 'unavailable'
    ? 'Delivery receipts unavailable'
    : health.status;
  setText(elements.statusLabel, healthy ? 'Local and ready' : degradedLabel, 'Unavailable');
  elements.send.disabled = !bootstrap.capabilities?.chat || state.busy;
  elements.input.disabled = !bootstrap.capabilities?.chat || state.busy;
  elements.memoryQuery.disabled = !bootstrap.capabilities?.memory;
  for (const control of elements.appearanceForm.elements) {
    control.disabled = !bootstrap.capabilities?.appearance || state.appearanceBusy;
  }
}

function displayContent(message) {
  if (typeof message.display === 'string') return message.display;
  if (typeof message.content === 'string') return message.content;
  return '[Structured message content]';
}

const agentPathLabel = () => `How ${agentGrammar().subject} got there`;

function trailSection(trail) {
  const section = document.createElement('section');
  const heading = document.createElement('h4');
  heading.textContent = 'Visible steps';
  const list = document.createElement('ol');
  list.className = 'continuity-steps';
  for (const step of trail) {
    const item = document.createElement('li');
    if (step.kind === 'note') { item.className = 'note'; item.textContent = step.text; }
    else {
      if (step.ok === false) item.className = 'failed';
      const outcome = step.ok === false ? ' — failed' : step.ok === null ? ' — outcome unknown' : '';
      item.textContent = `${step.tool}${step.detail ? ` (${step.detail})` : ''}${outcome}`;
    }
    list.append(item);
  }
  section.append(heading, list);
  return section;
}

const versionLabel = value => (typeof value === 'string' && value.length >= 8 ? value.slice(0, 8) : 'unknown');
const exactVersionLabel = value => (typeof value === 'string' && value ? value : 'unknown');
const rootEdgeLabel = root => (root?.observedThrough ? `loaded through ${root.observedThrough}` : 'loaded edge not recorded');
const memoryIndexLabel = (receipt, { exact = false } = {}) => {
  const edge = receipt?.index ?? receipt?.ledger ?? null;
  if (!edge || !Number.isSafeInteger(edge.events) || typeof edge.head !== 'string') return 'memory index edge not recorded';
  return `memory index · ${edge.events} event${edge.events === 1 ? '' : 's'} · through ${(exact ? exactVersionLabel : versionLabel)(edge.head)}`;
};
const sourceEdgeLabel = (source, { exact = false } = {}) => `${source?.kind || 'source'}:${(exact ? exactVersionLabel : versionLabel)(source?.fingerprint)} · ${source?.observedThrough ? `observed through ${source.observedThrough}` : 'edge not recorded'}`;
const sourceEdgeSummary = sources => {
  const edged = sources.filter(source => source?.observedThrough).length;
  if (sources.length === 1) return edged ? '1 source · edge recorded' : '1 source · edge not recorded';
  return `${sources.length} sources · ${edged} edged${edged === sources.length ? '' : ` · ${sources.length - edged} unknown`}`;
};

function sourceEdgeDetails(sources, summaryText = sourceEdgeSummary(sources), { exact = false } = {}) {
  const details = document.createElement('details');
  details.className = 'source-edges';
  const summary = document.createElement('summary');
  summary.textContent = summaryText;
  const list = document.createElement('ul');
  for (const source of sources) {
    const item = document.createElement('li');
    item.textContent = sourceEdgeLabel(source, { exact });
    list.append(item);
  }
  details.append(summary, list);
  return details;
}

function inputList(title, rows) {
  const section = document.createElement('section');
  const heading = document.createElement('h4');
  heading.textContent = title;
  const list = document.createElement('ul');
  for (const row of rows) {
    const item = document.createElement('li');
    if (typeof row === 'string') item.textContent = row;
    else item.append(row);
    list.append(item);
  }
  section.append(heading, list);
  return section;
}


// A short local time for a recorded instant: "12:28 AM" today, "Nov 4, 12:28 AM" otherwise.
function plainTime(iso) {
  const date = new Date(iso);
  if (typeof iso !== 'string' || !Number.isFinite(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const ROOM_NOTE_LABELS = Object.freeze({
  'room-look': 'Names, icons and pronouns',
  'agent-guides': 'House guides',
  'tool-catalogue': 'The list of tools it could load',
  expression: 'Moods and thinking lines',
  'model-history': 'Which model is thinking now',
});

const ROOT_PLACEMENT_LABELS = Object.freeze({
  system: 'read first',
  'user-tail': 'read last, just before the reply',
});

function plainRoomNote(entry) {
  const details = document.createElement('details');
  details.className = 'input-text';
  const summary = document.createElement('summary');
  summary.textContent = ROOM_NOTE_LABELS[entry.id] ?? entry.id;
  const text = document.createElement('pre');
  text.textContent = entry.text;
  text.tabIndex = 0;
  text.setAttribute('aria-label', `Room note ${entry.id}`);
  details.append(summary, text);
  return details;
}

// What a person can recognize: the conversation, the agent's files, the notes
// the room added, the memories offered and the tools on hand.
function plainContinuitySections(receipt) {
  const sections = [];
  const conversation = receipt.conversation || {};
  const attachments = receipt.currentMessage?.attachments || 0;
  const conversationRows = [receipt.currentMessage?.included === true
    ? `The newest message${attachments ? ` and ${plural(attachments, 'attachment')}` : ''}`
    : 'The newest message was not recorded as included.'];
  const compacted = conversation.compaction;
  if (compacted) {
    if (conversation.recentVerbatimMessages) conversationRows.push(`${plural(conversation.recentVerbatimMessages, 'recent message')}, word for word`);
    conversationRows.push(`${plural(compacted.coveredMessages, 'older message')} as a summary written in the agent's own words`);
  } else {
    conversationRows.push(conversation.historyMessages
      ? `${plural(conversation.historyMessages, 'earlier message')}, word for word`
      : 'No earlier messages');
  }
  const recovered = conversation.recovery || {};
  for (const row of recovered.selected || []) {
    conversationRows.push(`Messages ${row.startMessage + 1}–${row.endMessage} again, word for word, because they matched this message`);
  }
  if (recovered.omittedForBudget) conversationRows.push(`${plural(recovered.omittedForBudget, 'more matching older message')} left out to save space`);
  sections.push(inputList('The conversation', conversationRows));

  const roots = receipt.profile?.roots || [];
  if (roots.length) sections.push(inputList('Agent files', roots.map(root => {
    const placement = ROOT_PLACEMENT_LABELS[root.placement];
    const when = plainTime(root.observedThrough);
    return `${root.id}${placement ? `, ${placement}` : ''}${when ? ` · as of ${when}` : ''}`;
  })));

  const room = receipt.room || [];
  if (room.length) sections.push(inputList('Notes from the room', room.map(plainRoomNote)));

  const stepNotes = (Array.isArray(receipt.stepNotes) ? receipt.stepNotes : [])
    .filter(note => Number.isSafeInteger(note?.step) && typeof note.text === 'string');
  if (stepNotes.length) sections.push(inputList('Last-step note', stepNotes.map(note => (
    `Step ${note.step} was the last one, so Fieldwork added: ${note.text}`
  ))));

  const memory = receipt.memory || {};
  const memoryRows = [];
  const offered = [];
  const versions = offeredMemoryVersions(memory);
  const omittedIds = new Set(versions.omittedIds);
  for (const row of versions.rows) {
    const words = row.matchedBy === 'meaning'
      ? 'close in meaning to the message'
      : `${plural(row.matchedTerms || 0, 'word')} in common with the message${row.timeMatch ? ', and the date' : ''}`;
    const step = row.versioned
      ? `${row.steps.length === 1 ? 'step' : 'steps'} ${row.steps.join(', ')}`
      : '';
    const suffix = [step, words].filter(Boolean).join(' · ');
    // Receipts hold ids, not memory text; the words load when the fold opens.
    const item = document.createElement('span');
    item.textContent = `A saved memory · ${suffix}`;
    memoryRows.push(item);
    if (/^[0-9a-f]{64}$/.test(row.fingerprint)) {
      offered.push({ id: row.id, fingerprint: row.fingerprint, suffix, item });
    }
  }
  if (!memory.enabled) memoryRows.push('Automatic memory was off.');
  else if (!memoryRows.length) memoryRows.push(omittedIds.size ? 'Some memories matched, but none fit in the space for them.' : 'No saved memory matched this message.');
  else if (omittedIds.size) memoryRows.push(`${plural(omittedIds.size, 'more matching memory', 'more matching memories')} left out to save space`);
  sections.push(inputList('Memories offered', memoryRows));

  const tools = receipt.tools?.available || [];
  if (tools.length) {
    const toolDetails = document.createElement('details');
    toolDetails.className = 'input-tools';
    const toolSummary = document.createElement('summary');
    toolSummary.textContent = `${plural(tools.length, 'tool')} it could use`;
    const toolText = document.createElement('p');
    toolText.textContent = tools.join(', ');
    toolDetails.append(toolSummary, toolText);
    let previous = tools;
    for (const step of receipt.tools?.steps || []) {
      const available = step.available || [];
      if (JSON.stringify(available) === JSON.stringify(previous)) continue;
      const added = available.filter(name => !previous.includes(name));
      const removed = previous.filter(name => !available.includes(name));
      const row = document.createElement('p');
      row.textContent = [
        added.length ? `From step ${step.step} it could also use ${added.join(', ')}.` : '',
        removed.length ? `From step ${step.step} it put away ${removed.join(', ')}.` : '',
      ].filter(Boolean).join(' ');
      if (row.textContent) toolDetails.append(row);
      previous = available;
    }
    sections.push(toolDetails);
  } else sections.push(inputList('Tools', ['No tools were offered.']));
  return { sections, offered };
}

const OFFERED_MEMORY_STATES = Object.freeze({
  unchanged: '',
  revised: ' (revised since)',
  withdrawn: ' (withdrawn since)',
});

// Fill in the words of each offered memory, as the exact version that was offered.
async function showOfferedMemories(offered) {
  for (const batch of offeredMemoryBatches(offered)) {
    try {
      const response = await request('/api/memory/offered', {
        method: 'POST',
        body: { memories: batch.map(({ id, fingerprint }) => ({ id, fingerprint })) },
      });
      const byKey = new Map((response.memories || []).map(row => [offeredMemoryKey(row), row]));
      for (const memory of batch) {
        const row = byKey.get(offeredMemoryKey(memory));
        if (row && typeof row.text === 'string') {
          const flat = [...row.text.replace(/\s+/g, ' ').trim()];
          const short = flat.length > 220 ? `${flat.slice(0, 219).join('').trimEnd()}…` : flat.join('');
          memory.item.textContent = `“${short}”${OFFERED_MEMORY_STATES[row.state] ?? ''} · ${memory.suffix}`;
        } else {
          memory.item.textContent = `A memory that is no longer available (${memory.id}) · ${memory.suffix}`;
        }
      }
    } catch {
      for (const memory of batch) memory.item.textContent = `A saved memory (${memory.id}) · ${memory.suffix}`;
    }
  }
}

// The exact record behind the plain view: versions, hashes, exact instants,
// memory index edges and source edges, for anyone checking the receipt itself.
function exactContinuitySections(validReceipt) {
  const sections = [];
  const recordNote = document.createElement('p');
  recordNote.className = 'reply-continuity-note';
  recordNote.textContent = validReceipt.note;
  sections.push(recordNote);

  const conversation = validReceipt.conversation || {};
  const conversationRows = [];
  const attachments = validReceipt.currentMessage?.attachments || 0;
  conversationRows.push(validReceipt.currentMessage?.included === true
    ? `Current message${attachments ? ` and ${attachments} attachment${attachments === 1 ? '' : 's'}` : ''} — included`
    : 'Current message — not recorded as included');
  const compacted = conversation.compaction;
  if (compacted) {
    conversationRows.push(`${conversation.recentVerbatimMessages || 0} recent archived message${conversation.recentVerbatimMessages === 1 ? '' : 's'} — exact text`);
    conversationRows.push(`${compacted.coveredMessages} earlier message${compacted.coveredMessages === 1 ? '' : 's'} — first-person carried memory, generation ${compacted.generation}, version ${exactVersionLabel(compacted.fingerprint)}`);
  } else {
    conversationRows.push(`${conversation.historyMessages || 0} earlier message${conversation.historyMessages === 1 ? '' : 's'} — exact text`);
  }
  const recovered = conversation.recovery || {};
  for (const row of recovered.selected || []) {
    conversationRows.push(`Messages ${row.startMessage + 1}–${row.endMessage} recovered exactly for this question · version ${exactVersionLabel(row.fingerprint)}`);
  }
  if (recovered.omittedForBudget) conversationRows.push(`${recovered.omittedForBudget} matching earlier turn${recovered.omittedForBudget === 1 ? '' : 's'} omitted for space`);
  sections.push(inputList('Conversation', conversationRows));

  const roots = validReceipt.profile?.roots || [];
  if (roots.length) sections.push(inputList('Agent files', roots.map(root => (
    `${root.id} · ${root.placement} · ${root.characters} characters · version ${exactVersionLabel(root.sha256)} · ${rootEdgeLabel(root)}`
  ))));

  const room = validReceipt.room || [];
  if (room.length) sections.push(inputList('Room notes', room.map(entry => (
    `${entry.id} · ${entry.characters} characters · version ${exactVersionLabel(entry.sha256)}`
  ))));

  const memory = validReceipt.memory || {};
  const memoryRows = [];
  if (!memory.enabled) memoryRows.push('Automatic memory was off.');
  const memorySteps = memory.steps || [];
  if (memory.enabled && !memorySteps.length) memoryRows.push('No automatic memory was offered.');
  for (const step of memorySteps) {
    memoryRows.push(`Model step ${step.step}: ${step.status} (${step.reason}) · ${memoryIndexLabel(step, { exact: true })}`);
    const seat = step.meaning;
    if (seat) {
      const ratio = ppm => (ppm / 1_000_000).toFixed(2);
      memoryRows.push(`Meaning seat: ${seat.model} · floor ${ratio(seat.floorPpm)} · ${seat.picked} picked${Number.isSafeInteger(seat.bestPpm) ? ` · best ${ratio(seat.bestPpm)}` : ''} · ${seat.embedded} newly embedded${seat.waiting ? ` · ${seat.waiting} waiting` : ''} · ${seat.ms} ms${seat.error ? ` · ${seat.error}` : ''}`);
    }
    const included = new Set((step.context?.included || []).map(row => row.id));
    const skipped = new Map((step.context?.skipped || []).map(row => [row.id, row.reason]));
    for (const row of step.selected || []) {
      const why = row.matchedBy === 'meaning'
        ? `found by meaning, similarity ${((row.meaningPpm || 0) / 1_000_000).toFixed(2)}`
        : `${row.matchedTerms} matched term${row.matchedTerms === 1 ? '' : 's'}${row.timeMatch ? ', date matched' : ''}`;
      const outcome = included.has(row.id) ? 'offered' : skipped.has(row.id) ? `omitted: ${skipped.get(row.id)}` : 'selected';
      const base = `${row.id} · ${why} · ${outcome} · version ${exactVersionLabel(row.fingerprint)}`;
      const sources = Array.isArray(row.sources) ? row.sources : [];
      memoryRows.push(sources.length
        ? sourceEdgeDetails(sources, `${base} · ${sourceEdgeSummary(sources)}`, { exact: true })
        : base);
    }
    if (!(step.selected || []).length) memoryRows.push(`No memory was offered on step ${step.step}.`);
  }
  if (memoryRows.length) sections.push(inputList('Automatic memory', memoryRows));

  const tools = validReceipt.tools?.available || [];
  if (tools.length) {
    const rows = [`${tools.length} tool schema${tools.length === 1 ? '' : 's'} offered initially`];
    let previous = tools;
    for (const step of validReceipt.tools?.steps || []) {
      const available = step.available || [];
      if (JSON.stringify(available) === JSON.stringify(previous)) continue;
      rows.push(`Step ${step.step} changed: ${available.join(', ') || 'no tools'}`);
      previous = available;
    }
    sections.push(inputList('Tool schemas', rows));
  } else sections.push(inputList('Tool schemas', ['No tool schemas were offered.']));
  return sections;
}

// One compact map of the visible steps and inputs for a reply. It does not
// claim to expose hidden reasoning or prove which input caused a sentence.
function replyContinuityDetails(rawTrail, receipt) {
  const model = replyContinuityModel(rawTrail, receipt);
  if (!model) return null;
  const { trail, receipt: validReceipt, cues } = model;
  const details = document.createElement('details');
  details.className = 'reply-continuity';
  const summary = document.createElement('summary');
  summary.textContent = [agentPathLabel(), ...cues].join(' · ');
  const body = document.createElement('div');
  body.className = 'reply-continuity-body';

  const note = document.createElement('p');
  note.className = 'reply-continuity-note';
  note.textContent = validReceipt
    ? 'What the model was given for this reply. It shows what was offered, not which parts the reply used, and never hidden reasoning.'
    : 'No saved input receipt is available for this reply.';
  body.append(note);
  if (trail.length) body.append(trailSection(trail));
  if (!validReceipt) {
    details.append(summary, body);
    return details;
  }

  const plain = plainContinuitySections(validReceipt);
  body.append(...plain.sections);
  if (plain.offered.length) {
    let loaded = false;
    details.addEventListener('toggle', () => {
      if (!details.open || loaded) return;
      loaded = true;
      void showOfferedMemories(plain.offered);
    });
  }
  const technical = document.createElement('details');
  technical.className = 'continuity-technical';
  const technicalSummary = document.createElement('summary');
  technicalSummary.textContent = 'Technical details: full versions, hashes and exact times';
  technical.append(technicalSummary, ...exactContinuitySections(validReceipt));
  body.append(technical);

  details.append(summary, body);
  return details;
}

function deliveryStatus(receipt) {
  if (receipt.outcome === 'platform-accepted') return 'Platform accepted';
  if (receipt.outcome === 'partially-accepted') return 'Some parts accepted';
  if (receipt.outcome === 'not-sent' || receipt.outcome === 'platform-rejected') return 'Not sent';
  if (receipt.outcome === 'not-attempted') return 'Not attempted';
  if (receipt.outcome === 'may-have-been-sent') return 'May have been sent';
  return 'Send status unknown';
}

function deliveryDetails(receipt) {
  if (!receipt || receipt.format !== 'fieldwork-external-delivery-action/v1') return null;
  const details = document.createElement('details');
  details.className = `message-delivery ${receipt.outcome || 'unknown'}`;
  const summary = document.createElement('summary');
  const status = deliveryStatus(receipt);
  const platform = receipt.platform === 'telegram' ? 'Telegram' : 'Discord';
  const checks = Array.isArray(receipt.checks) ? receipt.checks : [];
  const failed = checks.filter(check => check.status === 'failed').length;
  summary.textContent = failed
    ? `${status} · ${failed} failed check${failed === 1 ? '' : 's'}`
    : `${status} · ${platform}`;

  const list = document.createElement('dl');
  const rows = [
    ['Status', status],
    ['Platform', platform],
    ['Destination', receipt.destinationId],
    ['Source message', receipt.sourceMessageId],
    ['Action', receipt.id],
    ['Prepared', formatTime(receipt.at)],
    ['Content', `${receipt.content?.characters ?? 'unknown'} characters · ${receipt.content?.bytes ?? 'unknown'} bytes`],
    ['Content hash', receipt.content?.sha256 ?? 'unavailable'],
    ['Parts', String(receipt.content?.chunks?.length ?? 0)],
    ['Action receipt', receipt.actionFingerprint ?? 'unavailable'],
  ];
  if (receipt.attemptedAt) rows.push(['Attempted', formatTime(receipt.attemptedAt)]);
  if (receipt.attemptFingerprint) rows.push(['Attempt receipt', receipt.attemptFingerprint]);
  if (receipt.settledAt) rows.push(['Settled', formatTime(receipt.settledAt)]);
  if (Number.isSafeInteger(receipt.acceptedChunks) && Number.isSafeInteger(receipt.totalChunks)) {
    rows.push(['Accepted parts', `${receipt.acceptedChunks} of ${receipt.totalChunks}`]);
  }
  if (receipt.failureKind) rows.push(['Failure kind', receipt.failureKind]);
  if (receipt.settlementFingerprint) rows.push(['Settlement receipt', receipt.settlementFingerprint]);
  if (Array.isArray(receipt.acknowledgements) && receipt.acknowledgements.length) {
    rows.push(['Destination-bound messages', receipt.acknowledgements
      .map(row => `${Number(row.index) + 1}: ${row.platformMessageId}`)
      .join(', ')]);
  } else if (Array.isArray(receipt.platformMessageIds) && receipt.platformMessageIds.length) {
    rows.push(['Platform messages', receipt.platformMessageIds.join(', ')]);
  }
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    list.append(term, description);
  }
  const checkList = document.createElement('ul');
  checkList.className = 'delivery-checks';
  for (const check of checks) {
    const item = document.createElement('li');
    item.className = check.status;
    item.textContent = `${check.id}: ${check.status}${check.reason ? ` (${check.reason})` : ''}`;
    checkList.append(item);
  }
  details.append(summary, list, checkList);
  return details;
}

function renderMessages(messages, omittedMessages = 0) {
  clear(elements.messages);
  if (Number.isSafeInteger(omittedMessages) && omittedMessages > 0) {
    const note = document.createElement('p');
    note.className = 'history-window-note';
    note.textContent = `${omittedMessages} earlier message${omittedMessages === 1 ? '' : 's'} remain saved. Fieldwork can recover their exact text when it is relevant.`;
    elements.messages.append(note);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    elements.messages.append(elements.empty);
    return;
  }
  for (const message of messages) {
    if (message.role === 'tool') continue;
    elements.messages.append(buildMessageItem(message));
  }
  scrollToEnd();
}

function buildMessageItem(message) {
  if (message.kind === 'check-in' || message.kind === 'postcard' || message.kind === 'free-time') {
    const divider = document.createElement('li');
    divider.className = 'checkin-divider';
    const agentName = state.look?.agent?.name || 'Your agent';
    divider.textContent = message.kind === 'postcard'
      ? `📮 A postcard from ${agentName}`
      : message.kind === 'free-time' ? `🕰 Free time with ${agentName}` : `📬 ${agentName} checked in`;
    const time = document.createElement('time');
    time.textContent = formatTime(message.at);
    divider.append(time);
    return divider;
  }
  const roleLabels = { user: 'You', assistant: 'Agent', system: 'System', developer: 'Host' };
  const fragment = templates.message.content.cloneNode(true);
  const item = fragment.querySelector('.message');
  const role = message.role || 'unknown';
  item.dataset.role = role;
  const who = role === 'user' ? state.look?.person : role === 'assistant' ? state.look?.agent : null;
  const bridgeLabel = message.kind === 'bridge' && message.route?.platform
    ? ` · via ${message.route.platform === 'telegram' ? 'Telegram' : 'Discord'}`
    : '';
  const pronounLabel = who?.pronouns ? ` · ${who.pronouns}` : '';
  fragment.querySelector('.message-role').textContent = `${who?.name ?? roleLabels[role] ?? role}${pronounLabel}${bridgeLabel}`;
  fillAvatar(fragment.querySelector('.avatar'), who?.icon ?? null);
  fragment.querySelector('time').textContent = formatTime(message.at);
  renderRichText(fragment.querySelector('.message-content'), displayContent(message));
  if (Array.isArray(message.attachments) && message.attachments.length) item.append(messageAttachments(message.attachments));
  const continuity = replyContinuityDetails(message.trail, message.inputs);
  if (continuity) item.append(continuity);
  const delivery = deliveryDetails(message.delivery);
  if (delivery) item.append(delivery);
  if (message.kind === 'bridge' && message.route) {
    const details = document.createElement('details');
    details.className = 'message-route';
    const summary = document.createElement('summary');
    summary.textContent = 'How this got here';
    const list = document.createElement('dl');
    for (const [label, value] of [
      ['Bridge', message.route.platform],
      ['Destination', message.route.destinationId],
      ['Source user', message.route.sourceUserId],
      ['Source message', message.route.sourceMessageId],
    ]) {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      list.append(term, description);
    }
    details.append(summary, list);
    item.append(details);
  }
  return item;
}

function renderReceipts(receipts) {
  clear(elements.receipts);
  if (!Array.isArray(receipts)) return;
  for (const receipt of receipts) {
    const fragment = templates.receipt.content.cloneNode(true);
    const detail = fragment.querySelector('details');
    fragment.querySelector('summary span').textContent = receipt.label || receipt.format || 'Receipt';
    fragment.querySelector('time').textContent = formatTime(receipt.at);
    fragment.querySelector('pre').textContent = JSON.stringify(receipt.value ?? receipt, null, 2);
    elements.receipts.append(detail);
  }
}

// Églantine margin garden (src/marginalia.mjs). The room draws it from the
// saved choice and its own clock; the page only shows the picture it gets
// back, refreshes it every five minutes, and never inserts SVG markup.
const garden = {
  aside: byId('room-marginalia'), image: byId('room-marginalia-image'), panel: document.querySelector('.conversation-panel'),
  enabled: byId('marginalia-enabled'), controls: byId('marginalia-controls'), mode: byId('marginalia-mode'),
  formRow: byId('marginalia-form-row'), form: byId('marginalia-form'), seed: byId('marginalia-seed'),
  manner: byId('marginalia-manner'), palette: byId('marginalia-palette'), reading: byId('marginalia-reading'),
  source: byId('marginalia-fullness-source'), fullnessRow: byId('marginalia-fullness-row'), fullness: byId('marginalia-fullness'),
  output: byId('marginalia-fullness-output'), calendarNote: byId('marginalia-calendar-note'),
  timer: null, request: 0, filled: false, failed: false, error: null,
};
const GARDEN_REFRESH_MS = 5 * 60 * 1000;
const gardenNarrow = window.matchMedia('(max-width: 900px)');

// The backdrop (src/backdrops.mjs) works the same way as the garden: the room
// draws it, the page shows the picture and asks again every five minutes.
const backdrop = {
  aside: byId('room-backdrop'), image: byId('room-backdrop-image'),
  enabled: byId('backdrop-enabled'), controls: byId('backdrop-controls'),
  scene: byId('backdrop-scene'), seed: byId('backdrop-seed'), strength: byId('backdrop-strength'),
  timer: null, request: 0, filled: false, failed: false, error: null,
};

function renderDecorationStatus() {
  const messages = [backdrop.error, garden.error].filter(Boolean);
  elements.appearanceDecorationStatus.textContent = messages.join(' ');
  elements.appearanceDecorationStatus.hidden = messages.length === 0;
}

function clearDecorationFailure(item) {
  const changed = item.failed || item.error;
  item.failed = false;
  item.error = null;
  if (changed) renderDecorationStatus();
}

function failDecoration(item, message) {
  item.failed = true;
  item.error = message;
  renderDecorationStatus();
}

function fillBackdropOptions(options) {
  if (backdrop.filled || !options) return;
  for (const [select, list] of [[backdrop.scene, options.scenes], [backdrop.strength, options.strengths]]) {
    for (const item of list || []) {
      const choice = document.createElement('option');
      choice.value = item.id;
      choice.textContent = item.label;
      select.append(choice);
    }
  }
  backdrop.filled = true;
}

function showBackdropChoice(selection, unchosen) {
  const shown = selection || unchosen;
  backdrop.enabled.checked = Boolean(selection);
  if (shown) {
    backdrop.scene.value = shown.scene;
    backdrop.seed.value = String(shown.seed);
    backdrop.strength.value = shown.strength;
  }
  backdrop.controls.hidden = !backdrop.enabled.checked;
}

function backdropFromForm() {
  if (!backdrop.enabled.checked) return null;
  return { scene: backdrop.scene.value, seed: Number(backdrop.seed.value), strength: backdrop.strength.value };
}

// The bubbles turn see-through when either decoration is showing.
function markDecorated() {
  garden.panel?.classList.toggle('decorated', !garden.aside.hidden || !backdrop.aside.hidden);
}

function hideBackdrop() {
  backdrop.aside.hidden = true;
  backdrop.image.removeAttribute('src');
  markDecorated();
}

function stopBackdrop() {
  backdrop.request += 1;
  if (backdrop.timer !== null) clearTimeout(backdrop.timer);
  backdrop.timer = null;
  hideBackdrop();
  clearDecorationFailure(backdrop);
}

async function refreshBackdrop() {
  if (backdrop.timer !== null) clearTimeout(backdrop.timer);
  backdrop.timer = null;
  const chosen = state.bootstrap?.appearance?.settings?.backdrop;
  if (!chosen) { stopBackdrop(); return; }
  const mine = ++backdrop.request;
  try {
    const response = await request('/api/backdrop/render', { method: 'POST', body: {} });
    if (mine !== backdrop.request) return;
    const renderError = response?.backdrop?.meta?.error;
    if (typeof renderError === 'string' && renderError) {
      hideBackdrop();
      failDecoration(backdrop, `${renderError} Apply the setting again or reload to retry.`);
      return;
    }
    const image = response?.backdrop?.image;
    if (typeof image === 'string' && image.startsWith('data:image/svg+xml;base64,')) {
      backdrop.image.src = image;
      backdrop.aside.dataset.strength = chosen.strength;
      backdrop.aside.hidden = false;
      markDecorated();
      clearDecorationFailure(backdrop);
    } else {
      hideBackdrop();
      failDecoration(backdrop, 'The chosen backdrop could not be drawn. Apply the setting again or reload to retry.');
      return;
    }
  } catch (error) {
    if (mine !== backdrop.request) return;
    hideBackdrop();
    failDecoration(backdrop, 'The chosen backdrop could not be drawn. Apply the setting again or reload to retry.');
    console.warn('The backdrop could not be drawn', error);
    return;
  }
  if (mine === backdrop.request && !backdrop.failed && state.bootstrap?.appearance?.settings?.backdrop) {
    backdrop.timer = setTimeout(() => { void refreshBackdrop(); }, GARDEN_REFRESH_MS);
  }
}

function fillGardenOptions(options) {
  if (garden.filled || !options) return;
  const lists = [[garden.mode, options.modes], [garden.form, options.forms], [garden.manner, options.manners],
    [garden.palette, options.palettes], [garden.reading, options.readings], [garden.source, options.fullnessSources]];
  for (const [select, list] of lists) {
    for (const item of list || []) {
      const choice = document.createElement('option');
      choice.value = item.id;
      choice.textContent = item.label;
      select.append(choice);
    }
  }
  garden.filled = true;
}

function updateGardenControls() {
  const on = garden.enabled.checked;
  const calendar = garden.mode.value === 'calendar';
  const manual = garden.source.value === 'manual';
  garden.controls.hidden = !on;
  garden.formRow.hidden = calendar;
  garden.calendarNote.hidden = !on || !calendar;
  garden.fullnessRow.hidden = !manual;
  garden.output.value = Number(garden.fullness.value).toFixed(2);
}

// A saved choice is shown exactly; with none saved, the controls hold the
// room's suggestion, which is only saved if the person ticks the box and applies.
function showGardenChoice(selection, unchosen) {
  const shown = selection || unchosen;
  garden.enabled.checked = Boolean(selection);
  if (shown) {
    garden.mode.value = shown.mode;
    garden.form.value = shown.form;
    garden.seed.value = String(shown.seed);
    garden.manner.value = shown.manner;
    garden.palette.value = shown.palette;
    garden.reading.value = shown.reading;
    garden.source.value = shown.fullness.source;
    garden.fullness.value = String(shown.fullness.value);
  }
  updateGardenControls();
}

function gardenFromForm() {
  if (!garden.enabled.checked) return null;
  const manual = garden.source.value === 'manual';
  return {
    mode: garden.mode.value,
    seed: Number(garden.seed.value),
    form: garden.form.value,
    manner: garden.manner.value,
    palette: garden.palette.value,
    reading: garden.reading.value,
    fullness: { source: garden.source.value, value: manual ? Number(garden.fullness.value) : 0 },
  };
}

function hideGarden() {
  garden.aside.hidden = true;
  garden.image.removeAttribute('src');
  garden.panel?.classList.remove('marginalia-active');
  markDecorated();
}

function suspendGarden() {
  garden.request += 1;
  if (garden.timer !== null) clearTimeout(garden.timer);
  garden.timer = null;
  hideGarden();
}

// Bumping the request number makes any drawing still on its way arrive stale,
// so switching the garden off mid-draw cannot bring it back.
function stopGarden() {
  suspendGarden();
  clearDecorationFailure(garden);
}

async function refreshGarden() {
  if (garden.timer !== null) clearTimeout(garden.timer);
  garden.timer = null;
  if (!state.bootstrap?.appearance?.settings?.marginalia) { stopGarden(); return; }
  if (gardenNarrow.matches) { suspendGarden(); return; }
  const mine = ++garden.request;
  try {
    const response = await request('/api/marginalia/render', { method: 'POST', body: {} });
    if (mine !== garden.request) return;
    const renderError = response?.marginalia?.meta?.error;
    if (typeof renderError === 'string' && renderError) {
      hideGarden();
      failDecoration(garden, `${renderError} Apply the setting again or reload to retry.`);
      return;
    }
    const image = response?.marginalia?.image;
    if (typeof image === 'string' && image.startsWith('data:image/svg+xml;base64,')) {
      garden.image.src = image;
      garden.aside.hidden = false;
      garden.panel?.classList.add('marginalia-active');
      markDecorated();
      clearDecorationFailure(garden);
    } else {
      // Complementary calendar days deliberately have no plant or image.
      hideGarden();
      clearDecorationFailure(garden);
    }
  } catch (error) {
    if (mine !== garden.request) return;
    hideGarden();
    failDecoration(garden, 'The chosen margin garden could not be drawn. Apply the setting again or reload to retry.');
    console.warn('The margin garden could not be drawn', error);
    return;
  }
  if (mine === garden.request && !garden.failed && !gardenNarrow.matches && state.bootstrap?.appearance?.settings?.marginalia) {
    garden.timer = setTimeout(() => { void refreshGarden(); }, GARDEN_REFRESH_MS);
  }
}

function renderPanelOrder(value) {
  if (!appearanceOptions.panelOrder.includes(value)) return;
  const panels = {
    navigator: [elements.sidebar],
    conversation: [elements.fieldworkPanel, elements.conversationPanel],
    inspector: [elements.inspectorPanel],
  };
  for (const slot of value.split('-')) elements.workspace.append(...panels[slot]);
}

function renderTypefacePreview(key, value) {
  if (!appearanceOptions[key]?.includes(value)) return;
  const preview = elements[`${key}Preview`];
  if (preview) preview.dataset.typeface = value;
}

function renderAppearance(value) {
  const settings = value?.settings || {};
  for (const [key, options] of Object.entries(appearanceOptions)) {
    const selected = settings[key];
    if (!options.includes(selected)) continue;
    document.documentElement.dataset[key] = selected;
    const control = elements.appearanceForm.elements.namedItem(key);
    if (control instanceof HTMLSelectElement) control.value = selected;
  }
  renderPanelOrder(settings.panelOrder);
  for (const key of ['typeface', 'interfaceTypeface', 'technicalTypeface']) {
    renderTypefacePreview(key, settings[key]);
  }
  const revision = Number.isSafeInteger(value?.revision) ? value.revision : 0;
  elements.appearanceRevision.textContent = `Revision ${revision}`;
  fillGardenOptions(state.bootstrap?.marginalia?.options);
  showGardenChoice(settings.marginalia || null, state.bootstrap?.marginalia?.unchosen);
  if (settings.marginalia) {
    clearDecorationFailure(garden);
    if (gardenNarrow.matches) suspendGarden();
    else void refreshGarden();
  }
  else stopGarden();
  fillBackdropOptions(state.bootstrap?.backdrop?.options);
  showBackdropChoice(settings.backdrop || null, state.bootstrap?.backdrop?.unchosen);
  if (settings.backdrop) { clearDecorationFailure(backdrop); void refreshBackdrop(); }
  else stopBackdrop();
}

function setAppearanceBusy(busy) {
  state.appearanceBusy = busy;
  for (const control of elements.appearanceForm.elements) control.disabled = busy;
  elements.appearanceReset.disabled = busy;
  if (!busy) updateGardenControls();
}

async function updateAppearance(settings, message) {
  if (state.appearanceBusy || !state.bootstrap?.capabilities?.appearance) return;
  setAppearanceBusy(true);
  try {
    const response = await request('/api/appearance', {
      method: 'POST',
      body: {
        expectedRevision: state.bootstrap.appearance.revision,
        changes: settings,
      },
    });
    state.bootstrap.appearance = response.appearance;
    renderAppearance(response.appearance);
    if (response.receipt) appendReceipt('Appearance update', response.receipt);
    elements.appearanceStatus.textContent = message;
  } catch (error) {
    elements.appearanceStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setAppearanceBusy(false);
  }
}

function addMeta(list, term, value) {
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.textContent = value ?? '—';
  dd.title = value ?? '';
  list.append(dt, dd);
}

function addMetaNode(list, term, node) {
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.append(node);
  list.append(dt, dd);
}

function renderMemory(response) {
  const results = Array.isArray(response.results) ? response.results : [];
  clear(elements.memoryResults);
  const summary = response.recent
    ? (results.length ? `${results.length} most recent · ${response.mode || 'current'}` : 'No memories yet.')
    : `${results.length} result${results.length === 1 ? '' : 's'} · ${response.mode || 'current'}`;
  const indexReceipt = response.recent ? response.receipt : response.receipt?.search;
  setText(elements.memorySummary, `${summary} · ${memoryIndexLabel(indexReceipt)}`);
  for (const result of results) {
    const fragment = templates.memory.content.cloneNode(true);
    const item = fragment.querySelector('.memory-card');
    const lifecycle = result.lifecycle || { type: 'fact' };
    const lifecycleStatus = result.lifecycleStatus || { phase: 'active', due: false };
    fragment.querySelector('.type-badge').textContent = lifecycle.type || result.kind || 'evidence';
    fragment.querySelector('.state-badge').textContent = lifecycleStatus.due ? 'due' : (lifecycleStatus.phase || result.state || response.mode || 'current');
    fragment.querySelector('.memory-id').textContent = result.id || result.logicalId || 'unnamed';
    fragment.querySelector('.memory-text').textContent = result.text || result.excerpt || '';
    const meta = fragment.querySelector('.memory-meta');
    addMeta(meta, 'Fingerprint', shortHash(result.fingerprint));
    addMeta(meta, 'Basis', result.basis || '—');
    addMeta(meta, 'Confidence', result.confidence || '—');
    addMeta(meta, 'Record kind', result.kind || '—');
    addMeta(meta, 'Status', `${lifecycleStatus.phase || 'active'}${lifecycleStatus.due ? ` · ${lifecycleStatus.attention?.join(', ') || 'due'}` : ''}`);
    if (lifecycle.notBefore) addMeta(meta, 'Not before', lifecycle.notBefore);
    if (lifecycle.reviewAt) addMeta(meta, 'Review at', lifecycle.reviewAt);
    if (lifecycle.expiresAt) addMeta(meta, 'Expires at', lifecycle.expiresAt);
    if (lifecycle.evidence) addMeta(meta, 'Verdict evidence', lifecycle.evidence);
    if (lifecycle.changeCriteria) addMeta(meta, 'Could change if', lifecycle.changeCriteria);
    if (lifecycle.reviewPrompt) addMeta(meta, 'Review question', lifecycle.reviewPrompt);
    const sources = Array.isArray(result.sources) ? result.sources : [];
    if (sources.length) addMetaNode(meta, 'Sources', sourceEdgeDetails(sources));
    else addMeta(meta, 'Sources', String(result.sourceCount ?? 0));
    addMeta(meta, 'Evidence', Array.isArray(result.evidenceFingerprints) ? result.evidenceFingerprints.length : 0);
    elements.memoryResults.append(item);
  }
  if (response.receipt && !response.recent) appendReceipt('Memory search', response.receipt);
}

// With the search box empty, the Memory tab shows the newest matching records.
async function showRecentMemories() {
  if (!state.bootstrap?.capabilities?.memory) return;
  const data = new FormData(elements.memoryForm);
  if (String(data.get('query') || '').trim()) return;
  try {
    renderMemory(await request('/api/memory/search', { method: 'POST', body: { query: '', mode: data.get('mode') || 'current' } }));
  } catch (error) {
    elements.memorySummary.textContent = error instanceof Error ? error.message : String(error);
  }
}

function appendReceipt(label, value) {
  const current = state.bootstrap?.receipts || [];
  const next = [{ label, at: new Date().toISOString(), value }, ...current].slice(0, 32);
  if (state.bootstrap) state.bootstrap.receipts = next;
  renderReceipts(next);
}

function setBusy(busy) {
  state.busy = busy;
  elements.runChip.textContent = busy ? 'Running' : 'Idle';
  elements.runChip.classList.toggle('running', busy);
  const archived = state.conversations.find(row => row.id === state.conversationId)?.archived === true;
  elements.send.disabled = busy || state.conversationLifecycleBusy || archived || !state.bootstrap?.capabilities?.chat;
  elements.input.disabled = busy || state.conversationLifecycleBusy || archived || !state.bootstrap?.capabilities?.chat;
  elements.newConversation.disabled = busy || state.conversationLifecycleBusy;
  elements.conversationArchiveAction.disabled = busy || state.conversationLifecycleBusy;
  elements.conversationProactiveAction.disabled = busy || state.conversationLifecycleBusy;
  for (const control of elements.conversationList.querySelectorAll('button')) control.disabled = busy || state.conversationLifecycleBusy;
  for (const control of elements.archivedConversationList.querySelectorAll('button')) control.disabled = busy || state.conversationLifecycleBusy;
  elements.guideRewrite.disabled = busy || state.guideBusy || !state.bootstrap?.capabilities?.chat || !state.guides;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  elements.notice.textContent = message;
  elements.notice.classList.add('error');
  elements.notice.hidden = false;
  elements.conversationAnnouncement.textContent = message;
  elements.statusDot.className = 'status-dot failed';
}

// ---- conversation sidebar ---------------------------------------------------

const dayKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

function conversationGroup(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return 'Today';
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
  return 'Earlier';
}

function conversationLabel(row) {
  if (row.title) return row.title;
  if (!row.messageCount) return 'New conversation';
  const when = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(row.createdAt));
  return `Conversation · ${when}`;
}

function conversationTime(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return conversationGroup(iso) === 'Today'
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function mergeConversationRows(incoming) {
  if (!Array.isArray(incoming)) return;
  const currentById = new Map(state.conversations.map(row => [row.id, row]));
  const merged = incoming.map(row => {
    const current = currentById.get(row.id);
    currentById.delete(row.id);
    if (!current) return row;
    const next = { ...row };
    const incomingTitleRevision = Number.isSafeInteger(row.titleRevision) ? row.titleRevision : 0;
    const currentTitleRevision = Number.isSafeInteger(current.titleRevision) ? current.titleRevision : 0;
    if (incomingTitleRevision < currentTitleRevision) {
      for (const key of ['title', 'customTitle', 'titleRevision', 'titleBy']) next[key] = current[key];
    }
    const incomingLifecycleRevision = Number.isSafeInteger(row.lifecycleRevision) ? row.lifecycleRevision : 0;
    const currentLifecycleRevision = Number.isSafeInteger(current.lifecycleRevision) ? current.lifecycleRevision : 0;
    if (incomingLifecycleRevision < currentLifecycleRevision) {
      for (const key of ['archived', 'lifecycleRevision', 'lifecycleBy', 'statusChangedAt', 'archivedAt']) next[key] = current[key];
    }
    const incomingProactiveRevision = Number.isSafeInteger(row.proactiveRevision) ? row.proactiveRevision : 0;
    const currentProactiveRevision = Number.isSafeInteger(current.proactiveRevision) ? current.proactiveRevision : 0;
    if (incomingProactiveRevision < currentProactiveRevision) {
      for (const key of ['proactiveMode', 'proactiveRevision', 'proactiveBy', 'proactiveChangedAt']) next[key] = current[key];
    }
    return next;
  });
  merged.push(...currentById.values());
  merged.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));
  state.conversations = merged;
  renderConversationPolicyNotice();
}

function renderConversationHeading() {
  const active = state.conversations.find(row => row.id === state.conversationId);
  elements.conversationTitle.textContent = active ? conversationLabel(active) : 'A clean local room';
  elements.conversationTitleEdit.disabled = !active;
  elements.conversationTitleEdit.title = active ? `Rename “${conversationLabel(active)}”` : 'Rename conversation';
  elements.conversationActions.hidden = !active;
  elements.conversationProactiveAction.hidden = !active || active.archived === true;
  elements.conversationProactiveAction.textContent = active?.proactiveMode === 'suppress'
    ? 'Allow automatic check-ins here'
    : 'Stop automatic check-ins here';
  const proactiveActionLabel = active
    ? `${active.proactiveMode === 'suppress' ? 'Allow' : 'Stop'} automatic check-ins for “${conversationLabel(active)}”`
    : 'Change automatic check-ins for this conversation';
  elements.conversationProactiveAction.setAttribute('aria-label', proactiveActionLabel);
  elements.conversationProactiveAction.title = proactiveActionLabel;
  elements.conversationProactiveAction.disabled = !active || active.archived === true || state.busy || state.conversationLifecycleBusy;
  elements.conversationArchiveAction.textContent = active?.archived ? 'Restore' : 'Archive';
  elements.conversationArchiveAction.disabled = !active || state.busy || state.conversationLifecycleBusy;
  elements.conversationArchiveAction.title = active?.archived
    ? `Restore “${conversationLabel(active)}”`
    : active ? `Archive “${conversationLabel(active)}”` : '';
  elements.conversationArchiveAction.setAttribute('aria-label', active?.archived
    ? `Restore “${conversationLabel(active)}”`
    : active ? `Archive “${conversationLabel(active)}”` : 'Archive conversation');
  const chatUnavailable = !state.bootstrap?.capabilities?.chat || active?.archived === true;
  elements.send.disabled = state.busy || state.conversationLifecycleBusy || chatUnavailable;
  elements.input.disabled = state.busy || state.conversationLifecycleBusy || chatUnavailable;
}

function mergeConversationTitle(response, id) {
  const incoming = Array.isArray(response?.conversations)
    ? response.conversations.find(row => row.id === id)
    : null;
  const index = state.conversations.findIndex(row => row.id === id);
  if (!incoming || index < 0 || !Number.isSafeInteger(incoming.titleRevision)) return false;
  const current = state.conversations[index];
  const currentRevision = Number.isSafeInteger(current.titleRevision) ? current.titleRevision : 0;
  if (incoming.titleRevision <= currentRevision) return false;
  state.conversations = state.conversations.map((row, rowIndex) => (rowIndex === index ? {
    ...row,
    title: incoming.title,
    customTitle: incoming.customTitle,
    titleRevision: incoming.titleRevision,
    titleBy: incoming.titleBy,
  } : row));
  renderConversationHeading();
  renderConversations();
  return true;
}

function setConversationTitleBusy(busy) {
  state.conversationTitleBusy = busy;
  for (const control of elements.conversationTitleForm.elements) control.disabled = busy;
}

function closeConversationTitleEditor({ focus = false } = {}) {
  state.conversationTitleEditingId = null;
  setConversationTitleBusy(false);
  elements.conversationTitleForm.hidden = true;
  elements.conversationTitleRow.hidden = false;
  elements.conversationTitleStatus.textContent = '';
  elements.conversationTitleStatus.hidden = true;
  if (focus) elements.conversationTitleEdit.focus();
}

function openConversationTitleEditor() {
  const active = state.conversations.find(row => row.id === state.conversationId);
  if (!active || state.conversationTitleBusy) return;
  state.conversationTitleEditingId = active.id;
  state.conversationTitleEditorGeneration += 1;
  elements.conversationTitleInput.value = conversationLabel(active);
  elements.conversationTitleStatus.textContent = '';
  elements.conversationTitleStatus.hidden = true;
  elements.conversationTitleRow.hidden = true;
  elements.conversationTitleForm.hidden = false;
  elements.conversationTitleInput.focus();
  elements.conversationTitleInput.select();
}

function renderConversations() {
  const rows = Array.isArray(state.conversations) ? state.conversations : [];
  const query = elements.conversationSearch.value.trim().toLowerCase();
  const activeRows = rows.filter(row => !row.archived);
  const archivedRows = rows.filter(row => row.archived);
  const shown = query ? activeRows.filter(row => conversationLabel(row).toLowerCase().includes(query)) : activeRows;
  clear(elements.conversationList);
  if (!shown.length) {
    const none = document.createElement('p');
    none.className = 'conversation-none';
    none.textContent = query ? 'No active conversation title matches.' : 'No active conversations yet.';
    elements.conversationList.append(none);
  }
  let group = '';
  for (const row of shown) {
    const next = conversationGroup(row.updatedAt);
    if (next !== group) {
      group = next;
      const heading = document.createElement('p');
      heading.className = 'conversation-group';
      heading.textContent = group;
      elements.conversationList.append(heading);
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'conversation-item';
    item.dataset.id = row.id;
    item.disabled = state.busy || state.conversationLifecycleBusy;
    if (row.id === state.conversationId) item.setAttribute('aria-current', 'true');
    if (checkIns.unread.has(row.id)) item.classList.add('unread');
    const title = document.createElement('strong');
    title.textContent = conversationLabel(row);
    title.title = conversationLabel(row);
    const time = document.createElement('time');
    time.dateTime = row.updatedAt;
    time.textContent = conversationTime(row.updatedAt);
    const count = document.createElement('span');
    count.textContent = `${row.messageCount} message${row.messageCount === 1 ? '' : 's'}${row.proactiveMode === 'suppress' ? ' · auto check-ins off' : ''}`;
    item.append(title, time, count);
    item.addEventListener('click', () => { void openConversation(row.id); });
    elements.conversationList.append(item);
  }

  elements.archivedConversationCount.textContent = String(archivedRows.length);
  elements.archivedConversations.hidden = state.mode === 'fieldwork' || archivedRows.length === 0;
  if (!archivedRows.length) elements.archivedConversations.open = false;
  clear(elements.archivedConversationList);
  const shownArchived = query
    ? archivedRows.filter(row => conversationLabel(row).toLowerCase().includes(query))
    : archivedRows;
  if (archivedRows.length && !shownArchived.length) {
    const none = document.createElement('p');
    none.className = 'conversation-none';
    none.textContent = 'No archived conversation title matches.';
    elements.archivedConversationList.append(none);
  }
  for (const row of shownArchived) {
    const item = document.createElement('div');
    item.className = 'archived-conversation-item';
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = conversationLabel(row);
    title.title = conversationLabel(row);
    const meta = document.createElement('span');
    meta.textContent = `${conversationTime(row.updatedAt)} · ${row.messageCount} message${row.messageCount === 1 ? '' : 's'}`;
    copy.append(title, meta);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = 'Restore';
    restore.setAttribute('aria-label', `Restore “${conversationLabel(row)}”`);
    restore.disabled = state.busy || state.conversationLifecycleBusy;
    restore.addEventListener('click', () => { void setConversationArchived(row.id, false); });
    item.append(copy, restore);
    elements.archivedConversationList.append(item);
  }
}

function applyConversation(response) {
  if (typeof response.conversationId === 'string' && response.conversationId !== state.conversationId) {
    elements.conversationActions.open = false;
  }
  if (state.conversationTitleEditingId && response.conversationId !== state.conversationTitleEditingId) {
    closeConversationTitleEditor();
  }
  mergeConversationRows(response.conversations);
  if (typeof response.conversationId === 'string') state.conversationId = response.conversationId;
  if (state.bootstrap) state.bootstrap.conversation = response.conversation;
  renderMessages(response.conversation?.messages || [], response.conversation?.omittedMessages || 0);
  renderConversationHeading();
  renderConversations();
}

async function openConversation(id) {
  if (state.conversationLifecycleBusy) return;
  checkIns.unread.delete(id);
  updateUnreadTitle();
  if (id === state.conversationId) return;
  const selectionGeneration = ++state.conversationSelectionGeneration;
  try {
    const response = await request('/api/conversations/open', { method: 'POST', body: { id } });
    if (selectionGeneration !== state.conversationSelectionGeneration) {
      mergeConversationRows(response.conversations);
      renderConversations();
      return;
    }
    applyConversation(response);
    elements.input.focus();
  } catch (error) {
    showError(error);
  }
}

async function setConversationArchived(id, archived) {
  if (state.conversationLifecycleBusy || state.busy) return;
  const row = state.conversations.find(conversation => conversation.id === id);
  if (!row || row.archived === archived) return;
  const selectionGeneration = ++state.conversationSelectionGeneration;
  let focusAfter = null;
  state.conversationLifecycleBusy = true;
  elements.conversationActions.open = false;
  renderConversationHeading();
  renderConversations();
  try {
    const response = await request('/api/conversations/archive', {
      method: 'POST',
      body: { id, archived, expectedRevision: row.lifecycleRevision ?? 0 },
    });
    if (selectionGeneration !== state.conversationSelectionGeneration) {
      mergeConversationRows(response.conversations);
      renderConversationHeading();
      renderConversations();
      return;
    }
    applyConversation(response);
    focusAfter = archived ? elements.conversationTitle : elements.input;
  } catch (error) {
    showError(error);
    try {
      const response = await request('/api/bootstrap');
      mergeConversationRows(response.conversations);
    } catch { /* Keep the lifecycle diagnostic. */ }
  } finally {
    state.conversationLifecycleBusy = false;
    renderConversationHeading();
    renderConversations();
    if (focusAfter) setTimeout(() => focusAfter.focus(), 0);
  }
}

async function setConversationProactive(id, mode) {
  if (state.conversationLifecycleBusy || state.busy) return;
  const row = state.conversations.find(conversation => conversation.id === id);
  if (!row || row.archived || row.proactiveMode === mode) return;
  state.conversationLifecycleBusy = true;
  const summary = elements.conversationActions.querySelector('summary');
  elements.conversationActions.open = false;
  summary?.focus();
  renderConversationHeading();
  renderConversations();
  try {
    const response = await request('/api/conversations/proactive', {
      method: 'POST',
      body: { id, mode, expectedRevision: row.proactiveRevision ?? 0 },
    });
    mergeConversationRows(response.conversations);
    renderConversationHeading();
    renderConversations();
    renderCheckIns();
    const changed = state.conversations.find(conversation => conversation.id === id) || row;
    const announcement = mode === 'suppress'
      ? `Automatic check-ins stopped for “${conversationLabel(changed)}”.`
      : `Automatic check-ins allowed for “${conversationLabel(changed)}”.`;
    elements.notice.textContent = announcement;
    elements.notice.classList.remove('error');
    elements.notice.hidden = false;
    elements.conversationAnnouncement.textContent = announcement;
  } catch (error) {
    showError(error);
    try {
      const response = await request('/api/bootstrap');
      mergeConversationRows(response.conversations);
    } catch { /* Keep the policy diagnostic. */ }
  } finally {
    state.conversationLifecycleBusy = false;
    renderConversationHeading();
    renderConversations();
  }
}

elements.conversationSearch.addEventListener('input', () => (state.mode === 'fieldwork' ? renderFieldworkList() : renderConversations()));
elements.newConversation.addEventListener('click', async () => {
  if (state.mode === 'fieldwork') { showFieldworkForm(); return; }
  if (state.conversationLifecycleBusy) return;
  const selectionGeneration = ++state.conversationSelectionGeneration;
  try {
    const response = await request('/api/conversations/new', { method: 'POST', body: {} });
    if (selectionGeneration !== state.conversationSelectionGeneration) {
      mergeConversationRows(response.conversations);
      renderConversations();
      return;
    }
    applyConversation(response);
    elements.input.focus();
  } catch (error) {
    showError(error);
  }
});

elements.conversationTitleEdit.addEventListener('click', openConversationTitleEditor);
elements.conversationArchiveAction.addEventListener('click', () => {
  const active = state.conversations.find(row => row.id === state.conversationId);
  if (active) void setConversationArchived(active.id, !active.archived);
});
elements.conversationProactiveAction.addEventListener('click', () => {
  const active = state.conversations.find(row => row.id === state.conversationId);
  if (active && !active.archived) void setConversationProactive(active.id, active.proactiveMode === 'suppress' ? 'allow' : 'suppress');
});
elements.conversationTitleCancel.addEventListener('click', () => closeConversationTitleEditor({ focus: true }));
elements.conversationTitleInput.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || state.conversationTitleBusy) return;
  event.preventDefault();
  closeConversationTitleEditor({ focus: true });
});
elements.conversationTitleForm.addEventListener('submit', async event => {
  event.preventDefault();
  const id = state.conversationTitleEditingId;
  if (!id || state.conversationTitleBusy) return;
  const active = state.conversations.find(row => row.id === id);
  if (!active) return;
  const editorGeneration = state.conversationTitleEditorGeneration;
  const title = elements.conversationTitleInput.value;
  setConversationTitleBusy(true);
  elements.conversationTitleStatus.textContent = '';
  elements.conversationTitleStatus.hidden = true;
  try {
    const response = await request('/api/conversations/rename', {
      method: 'POST', body: { id, title, expectedRevision: active.titleRevision ?? 0 },
    });
    if (state.conversationTitleEditingId !== id || state.conversationTitleEditorGeneration !== editorGeneration) {
      mergeConversationTitle(response, id);
      return;
    }
    mergeConversationTitle(response, id);
    closeConversationTitleEditor({ focus: true });
  } catch (error) {
    try {
      mergeConversationTitle(await request('/api/bootstrap'), id);
    } catch { /* Keep the original rename diagnostic. */ }
    if (state.conversationTitleEditingId !== id || state.conversationTitleEditorGeneration !== editorGeneration) {
      showError(error);
      return;
    }
    elements.conversationTitleStatus.textContent = error instanceof Error ? error.message : String(error);
    elements.conversationTitleStatus.hidden = false;
    elements.conversationTitleInput.focus();
  } finally {
    if (state.conversationTitleEditingId === id && state.conversationTitleEditorGeneration === editorGeneration) {
      setConversationTitleBusy(false);
    }
  }
});

async function refresh() {
  const bootstrap = await request('/api/bootstrap');
  state.bootstrap = bootstrap;
  renderHealth(bootstrap);
  applyConversation(bootstrap);
  renderModel(bootstrap.model);
  renderConnection(bootstrap.connection, Boolean(bootstrap.capabilities?.manageConnection));
  renderBridges(bootstrap.bridges, Boolean(bootstrap.capabilities?.manageBridges));
  renderDeliveryRecovery(bootstrap.deliveryRecovery);
  renderToolRecovery(bootstrap.toolRecovery);
  renderAgents(bootstrap.agents, Boolean(bootstrap.capabilities?.manageAgents));
  renderBackups(bootstrap.agentBackups, Boolean(bootstrap.capabilities?.manageAgents));
  setSettingsCategoryAvailable('connection', Boolean(bootstrap.model || bootstrap.connection));
  setSettingsCategoryAvailable('identity', Boolean(bootstrap.capabilities?.editLook));
  setSettingsCategoryAvailable('guides', Boolean(bootstrap.guides && bootstrap.capabilities?.guides));
  setSettingsCategoryAvailable('expression', Boolean(bootstrap.capabilities?.expression));
  setSettingsCategoryAvailable('checkins', Boolean(bootstrap.capabilities?.checkIns));
  setSettingsCategoryAvailable('heartbeats', Boolean(bootstrap.capabilities?.heartbeats));
  setSettingsCategoryAvailable('goals', Boolean(bootstrap.capabilities?.goals));
  setSettingsCategoryAvailable('outside-reader', Boolean(bootstrap.capabilities?.outsideReaders));
  setSettingsCategoryAvailable('changes', Boolean(bootstrap.capabilities?.changes));
  setSettingsCategoryAvailable('tools', Boolean(bootstrap.capabilities?.toolGroups || bootstrap.capabilities?.toolPermissions || bootstrap.capabilities?.toolRecovery));
  setSettingsCategoryAvailable('notes', Boolean(bootstrap.capabilities?.builderNotes));
  showNotesDot(bootstrap.builderNotesUnread || 0);
  byId('tab-shelf').hidden = !bootstrap.capabilities?.shelf;
  byId('memory-switch').hidden = !bootstrap.capabilities?.collections;
  byId('changes-open-collections').hidden = !bootstrap.capabilities?.collections;
  if (!bootstrap.capabilities?.collections) memoryView = 'memories';
  if (bootstrap.checkIns) { checkIns.view = bootstrap.checkIns; checkIns.seen = bootstrap.checkIns.latest?.at ?? null; renderCheckIns(); }
  startCheckInWatch(Boolean(bootstrap.capabilities?.checkIns));
  goals.view = bootstrap.goals || null;
  heartbeats.view = bootstrap.heartbeats || null;
  heartbeats.tools = (bootstrap.health?.tools || []).filter(tool => tool.available !== false && tool.name !== 'report_task_heartbeat');
  renderHeartbeatBinding(heartbeatBindingSelection());
  renderHeartbeatTools();
  renderHeartbeats();
  startHeartbeatWatch(Boolean(bootstrap.capabilities?.heartbeats));
  renderGoals();
  startGoalWatch(Boolean(bootstrap.capabilities?.goals));
  outsideReaders.view = bootstrap.outsideReaders || null;
  outsideReaders.fingerprint = JSON.stringify(outsideReaders.view);
  renderOutsideReaderChoices();
  renderOutsideReaders();
  startOutsideReaderWatch(Boolean(bootstrap.capabilities?.outsideReaders));
  state.look = bootstrap.look;
  state.guides = bootstrap.guides;
  state.expression = bootstrap.expression;
  renderGuides(bootstrap.guides, Boolean(bootstrap.capabilities?.guides));
  renderExpression();
  renderCheckIns();
  renderLook(bootstrap.capabilities?.editLook);
  renderMessages(state.bootstrap.conversation?.messages || [], state.bootstrap.conversation?.omittedMessages || 0);
  elements.modeSwitch.hidden = !bootstrap.capabilities?.fieldwork;
  byId('attach-button').hidden = !bootstrap.capabilities?.attachments;
  byId('stop-button').hidden = !bootstrap.capabilities?.shutdown;
  elements.restart.hidden = !bootstrap.capabilities?.restart;
  renderReceipts(bootstrap.receipts || []);
  renderAppearance(bootstrap.appearance);
  // The notice bar only speaks up when something needs attention. A supervised
  // agent action crosses a process restart, so its result arrives with the new
  // room instead of disappearing into the launcher's terminal.
  const lifecycleNotice = bootstrap.startupNotice;
  const connectionNotice = bootstrap.capabilities?.chat ? '' : (bootstrap.notice || 'No model is connected, so chat is off.');
  elements.notice.textContent = [lifecycleNotice?.message, connectionNotice].filter(Boolean).join(' ');
  elements.notice.classList.toggle('error', lifecycleNotice?.kind === 'error');
  elements.notice.hidden = !lifecycleNotice && !connectionNotice;
  if (!elements.notice.hidden) elements.conversationAnnouncement.textContent = elements.notice.textContent;
}

elements.composer.addEventListener('submit', async event => {
  event.preventDefault();
  const text = elements.input.value;
  const attached = state.pendingAttachments;
  if ((!text.trim() && !attached.length) || state.busy || state.conversationLifecycleBusy) return;
  setBusy(true);
  const startedIn = state.conversationId;
  elements.input.value = '';
  state.pendingAttachments = [];
  renderAttachmentTray();
  if (elements.empty.parentNode === elements.messages) elements.empty.remove();
  const sent = buildMessageItem({
    role: 'user',
    display: text,
    at: new Date().toISOString(),
    attachments: attached.map(item => (item.image ? { kind: 'image', src: item.dataUrl } : { kind: 'file', name: item.name, text: dataUrlText(item.dataUrl) })),
  });
  sent.classList.add('pending');
  const live = startLiveReply();
  elements.messages.append(sent, live.item);
  scrollToEnd();
  try {
    const body = { text, conversationId: startedIn };
    if (attached.length) body.attachments = attached.map(item => ({ name: item.name, dataUrl: item.dataUrl }));
    const response = await streamChat(body, live);
    live.stop();
    if (!byId('panel-shelf').hidden) void loadShelf();
    if (response.look) {
      const before = state.look?.agent?.icon ?? null;
      state.look = response.look;
      renderLook(Boolean(state.bootstrap?.capabilities?.editLook));
      if (!sameIcon(before, state.look.agent.icon) && state.look.agent.iconBy === 'agent') showPortraitChange(before, state.look.agent.icon);
    }
    if (response.guides) renderGuides(response.guides, Boolean(state.bootstrap?.capabilities?.guides));
    if (typeof response.builderNotesUnread === 'number') showNotesDot(response.builderNotesUnread);
    if (response.expression) { state.expression = response.expression; renderExpression(); }
    if (response.conversationId === state.conversationId) applyConversation(response);
    else { mergeConversationRows(response.conversations); renderConversations(); }
    if (response.receipt) appendReceipt('Conversation run', response.receipt);
    if (response.receipt?.status === 'exhausted' && response.saved !== false) {
      // The agent reached for another tool on its very last step, so that call could not run.
      elements.notice.textContent = 'Your agent ran out of steps before it finished: it tried to use another tool on its last step. Send another message to let it carry on.';
      elements.notice.classList.remove('error');
      elements.notice.hidden = false;
      elements.conversationAnnouncement.textContent = elements.notice.textContent;
    }
    if (response.saved === false) showError(new Error('The reply arrived but could not be saved to the archive. It may be missing after a restart; see Receipts.'));
  } catch (error) {
    // Nothing was kept: take the bubbles back and give the words back.
    live.stop();
    sent.remove();
    live.item.remove();
    if (!elements.input.value) elements.input.value = text;
    if (!state.pendingAttachments.length && attached.length) { state.pendingAttachments = attached; renderAttachmentTray(); }
    showError(error);
  } finally {
    live.stop();
    setBusy(false);
    elements.input.focus();
  }
});

elements.input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.memoryForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(elements.memoryForm);
  try {
    const response = await request('/api/memory/search', {
      method: 'POST',
      body: { query: data.get('query'), mode: data.get('mode') },
    });
    renderMemory(response);
  } catch (error) {
    elements.memorySummary.textContent = error instanceof Error ? error.message : String(error);
  }
});

elements.appearanceForm.addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(elements.appearanceForm);
  const settings = Object.fromEntries(Object.keys(appearanceOptions)
    .filter(key => data.has(key))
    .map(key => [key, data.get(key)]));
  settings.marginalia = gardenFromForm();
  settings.backdrop = backdropFromForm();
  void updateAppearance(settings, 'Appearance saved for this agent.');
});

for (const key of ['typeface', 'interfaceTypeface', 'technicalTypeface']) {
  elements.appearanceForm.elements.namedItem(key).addEventListener('change', event => {
    renderTypefacePreview(key, event.currentTarget.value);
  });
}

backdrop.enabled.addEventListener('change', () => { backdrop.controls.hidden = !backdrop.enabled.checked; });
for (const control of [garden.enabled, garden.mode, garden.source, garden.fullness]) {
  control.addEventListener(control === garden.fullness ? 'input' : 'change', updateGardenControls);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !garden.failed && !gardenNarrow.matches && state.bootstrap?.appearance?.settings?.marginalia) void refreshGarden();
  if (document.visibilityState === 'visible' && !backdrop.failed && state.bootstrap?.appearance?.settings?.backdrop) void refreshBackdrop();
});
gardenNarrow.addEventListener('change', event => {
  if (event.matches) suspendGarden();
  else if (!garden.failed && state.bootstrap?.appearance?.settings?.marginalia) void refreshGarden();
});

elements.appearanceReset.addEventListener('click', () => {
  const defaults = state.bootstrap?.appearance?.defaults;
  if (!defaults) return;
  void updateAppearance(defaults, 'Appearance reset to the host defaults.');
});

// Only the inspector's tabs: the Talk | Fieldwork switch is a tablist of its own.
const tabs = [...document.querySelectorAll('.inspector-tabs [role="tab"]')];
function selectTab(tab, focus = false) {
  beginCollectionViewerRequest();
  collectionState.generation += 1;
  if (tab?.id === 'tab-memory') void showMemoryView();
  if (tab?.id === 'tab-shelf') void loadShelf();
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    byId(candidate.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) tab.focus();
}

// ---- settings and agent homes ------------------------------------------------------

const settingsCategoryButtons = [...document.querySelectorAll('[data-settings-page]')];
const settingsPages = [...document.querySelectorAll('[data-settings-page-panel]')];
const settingsAvailability = new Map(settingsCategoryButtons.map(button => [button.dataset.settingsPage, !button.hidden]));

function settingsSearchText(button) {
  const page = settingsPages.find(candidate => candidate.dataset.settingsPagePanel === button.dataset.settingsPage);
  return `${button.textContent} ${button.dataset.settingsKeywords || ''} ${page?.textContent || ''}`.toLocaleLowerCase();
}

function applySettingsSearch() {
  const query = elements.settingsSearch.value.trim().toLocaleLowerCase();
  const shown = [];
  for (const button of settingsCategoryButtons) {
    const available = settingsAvailability.get(button.dataset.settingsPage) !== false;
    const matches = !query || settingsSearchText(button).includes(query);
    button.hidden = !available || !matches;
    if (!button.hidden) shown.push(button);
  }
  const selected = settingsCategoryButtons.find(button => button.getAttribute('aria-selected') === 'true');
  const selectedPanel = selected ? byId(selected.getAttribute('aria-controls')) : null;
  if (!selected || selected.hidden) {
    if (shown[0]) selectSettingsPage(shown[0].dataset.settingsPage);
    else for (const page of settingsPages) page.hidden = true;
  } else if (selectedPanel?.hidden) {
    // A no-results search hides every panel. Restore the still-selected panel
    // when the query is cleared instead of leaving the settings body blank.
    selectSettingsPage(selected.dataset.settingsPage);
  }
  elements.settingsSearchStatus.textContent = query
    ? shown.length ? `${shown.length} matching ${shown.length === 1 ? 'category' : 'categories'}` : 'No settings match'
    : '';
}

function clearSettingsSearch() {
  if (!elements.settingsSearch.value) return;
  elements.settingsSearch.value = '';
  applySettingsSearch();
}

function setSettingsCategoryAvailable(name, available) {
  settingsAvailability.set(name, Boolean(available));
  applySettingsSearch();
}

function selectSettingsPage(name, focus = false) {
  if (name === 'changes') void loadChanges();
  if (name === 'tools') {
    void loadToolGroups();
    void loadToolRecovery();
  }
  if (name === 'notes') void loadBuilderNotes();
  if (name === 'outside-reader') {
    void refreshOutsideReaderView().catch(error => {
      byId('outside-reader-status').textContent = error instanceof Error ? error.message : String(error);
    });
  }
  let selectedButton = null;
  for (const button of settingsCategoryButtons) {
    const selected = button.dataset.settingsPage === name;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected) selectedButton = button;
  }
  for (const page of settingsPages) page.hidden = page.dataset.settingsPagePanel !== name;
  if (focus) selectedButton?.focus();
}

function activeAgent() {
  return state.bootstrap?.agents?.agents?.find(agent => agent.active) || null;
}

function syncConnectionFields() {
  const subscription = elements.connectionService.value === 'chatgpt-subscription';
  elements.connectionEndpointRow.hidden = subscription;
  elements.connectionKeyRow.hidden = subscription;
  elements.connectionKeyNote.hidden = subscription;
  elements.connectionEndpoint.required = !subscription;
}

function setConnectionBusy(busy) {
  state.connectionBusy = busy;
  for (const control of elements.connectionForm.elements) control.disabled = busy;
  elements.connectionForgetKey.disabled = busy;
}

function renderConnection(connection, available) {
  elements.connectionForm.hidden = !available || !connection;
  elements.connectionSecretActions.hidden = !available || !connection?.access?.canForget;
  if (!connection) {
    elements.connectionManageNote.textContent = 'Run Fieldwork under its launcher to change the model service from this room.';
    return;
  }
  elements.connectionService.value = connection.service;
  elements.connectionEndpoint.value = connection.baseURL || '';
  elements.connectionModel.value = connection.model;
  elements.connectionApiKey.value = '';
  syncConnectionFields();
  const source = connection.access?.source;
  elements.connectionStatus.textContent = source === 'saved'
    ? 'Supervisor-saved key available'
    : source === 'environment'
      ? 'Environment key available'
      : source === 'codex'
        ? 'Uses Codex sign-in'
        : connection.access?.canForget
          ? 'Saved key belongs to another service URL'
          : connection.access?.status === 'not-needed'
            ? 'No key needed'
            : 'No key available';
  elements.connectionManageNote.textContent = available
    ? 'Service and saved API key are shared by the launcher. Each agent still keeps its own selected model for a service.'
    : 'Use “Fieldwork Settings” to change the service. This room was started without a supervisor.';
  setConnectionBusy(false);
}

async function performConnectionAction(body, title) {
  if (state.connectionBusy || !state.bootstrap?.capabilities?.manageConnection) return;
  setConnectionBusy(true);
  elements.connectionStatus.textContent = `${title}…`;
  try {
    await request('/api/connection', { method: 'POST', body });
  } catch (error) {
    elements.connectionStatus.textContent = error instanceof Error ? error.message : String(error);
    setConnectionBusy(false);
    return;
  }
  elements.settingsDialog.close();
  const screen = lifecycleScreen(title, 'Fieldwork is closing the current room cleanly, applying the connection, and coming back…');
  try {
    await waitForRestart();
    window.location.reload();
  } catch (error) {
    screen.text.textContent = error instanceof Error ? error.message : String(error);
  }
}

function syncTelegramBridgeFields() {
  const grouped = elements.telegramBridgeScope.value === 'group';
  elements.telegramBridgeGroupRow.hidden = !grouped;
  elements.telegramBridgeGroupConfirmation.required = grouped;
  if (!grouped) elements.telegramBridgeGroupConfirmation.value = '';
}

function syncDiscordBridgeFields() {
  const grouped = elements.discordBridgeScope.value === 'guild';
  elements.discordBridgeGuildRow.hidden = !grouped;
  elements.discordBridgeGuildId.required = grouped;
  elements.discordBridgeGroupRow.hidden = !grouped;
  elements.discordBridgeGroupConfirmation.required = grouped;
  if (!grouped) {
    elements.discordBridgeGuildId.value = '';
    elements.discordBridgeGroupConfirmation.value = '';
  }
}

function setBridgeBusy(busy) {
  state.bridgeBusy = busy;
  for (const control of elements.telegramBridgeForm.elements) control.disabled = busy;
  for (const control of elements.discordBridgeForm.elements) control.disabled = busy;
  for (const control of [
    elements.telegramBridgeDisconnect, elements.telegramBridgeForgetToken, elements.telegramBridgeRefresh,
    elements.discordBridgeDisconnect, elements.discordBridgeForgetToken, elements.discordBridgeRefresh,
  ]) control.disabled = busy;
}

function renderBridges(bridges, available) {
  const telegram = bridges?.telegram;
  elements.telegramBridgeForm.hidden = !available || !telegram;
  elements.telegramBridgeToken.value = '';
  const route = telegram?.route;
  elements.telegramBridgeScope.value = route?.scope || 'direct';
  elements.telegramBridgeChatId.value = route?.chatId || '';
  elements.telegramBridgeUserId.value = route?.allowedUserId || '';
  elements.telegramBridgeGroupConfirmation.value = '';
  syncTelegramBridgeFields();
  const states = {
    'not-configured': 'Not configured',
    'missing-token': 'Route saved · bot token missing',
    saved: 'Saved · connecting after restart',
    connecting: 'Connecting to Telegram…',
    connected: 'Connected to Telegram',
    paused: 'Paused',
    failed: 'Connection failed · see the launcher terminal',
  };
  elements.telegramBridgeStatus.textContent = [states[telegram?.state] || 'Unavailable', telegram?.detail].filter(Boolean).join(' · ');
  elements.telegramBridgeDisconnect.hidden = !available || !telegram?.configured;
  elements.telegramBridgeForgetToken.hidden = !available || !telegram?.token?.canForget;
  const tokenText = telegram?.token?.source === 'saved'
    ? 'A supervisor-saved bot token is available. It is never returned to this page.'
    : telegram?.token?.source === 'environment'
      ? 'FIELDWORK_TELEGRAM_TOKEN is available to this process. It is not changed here.'
      : 'No bot token is available yet. Enter one above when you save the route.';
  const binding = route?.conversationId
    ? telegram?.binding === 'live-unsaved'
      ? ' This conversation is live, but its route binding is not saved. Do not restart; Refresh status or another message will retry.'
      : ' This route continues one saved Fieldwork conversation. Changing its chat, allowed person, or scope starts a new one.'
    : route
      ? ' Its first accepted message will start and bind a saved Fieldwork conversation.'
      : '';
  elements.telegramBridgeDetail.textContent = `${tokenText}${binding}`;

  const discord = bridges?.discord;
  elements.discordBridgeForm.hidden = !available || !discord;
  elements.discordBridgeToken.value = '';
  const discordRoute = discord?.route;
  elements.discordBridgeScope.value = discordRoute?.scope || 'direct';
  elements.discordBridgeChannelId.value = discordRoute?.channelId || '';
  elements.discordBridgeGuildId.value = discordRoute?.guildId || '';
  elements.discordBridgeUserId.value = discordRoute?.allowedUserId || '';
  elements.discordBridgeGroupConfirmation.value = '';
  syncDiscordBridgeFields();
  const discordStates = {
    'not-configured': 'Not configured',
    'missing-token': 'Route saved · bot token missing',
    saved: 'Saved · connecting after restart',
    connecting: 'Connecting to Discord…',
    connected: 'Connected to Discord',
    paused: 'Paused',
    failed: 'Connection failed · see the launcher terminal',
  };
  elements.discordBridgeStatus.textContent = [discordStates[discord?.state] || 'Unavailable', discord?.detail].filter(Boolean).join(' · ');
  elements.discordBridgeDisconnect.hidden = !available || !discord?.configured;
  elements.discordBridgeForgetToken.hidden = !available || !discord?.token?.canForget;
  const discordTokenText = discord?.token?.source === 'saved'
    ? 'A supervisor-saved bot token is available. It is never returned to this page.'
    : discord?.token?.source === 'environment'
      ? 'FIELDWORK_DISCORD_TOKEN is available to this process. It is not changed here.'
      : 'No bot token is available yet. Enter one above when you save the route.';
  const discordBinding = discordRoute?.conversationId
    ? discord?.binding === 'live-unsaved'
      ? ' This conversation is live, but its route binding is not saved. Do not restart; Refresh status or another message will retry.'
      : ' This route continues one saved Fieldwork conversation. Changing its channel, allowed person, server, or scope starts a new one.'
    : discordRoute
      ? ' Its first accepted message will start and bind a saved Fieldwork conversation.'
      : '';
  elements.discordBridgeDetail.textContent = `${discordTokenText}${discordBinding}`;
  setBridgeBusy(false);
}

function deliveryRecoveryKind(item) {
  if (item?.state === 'prepared-not-attempted') return 'prepared';
  if (item?.state === 'legacy-attempted-unsettled'
    || item?.attemptTracking === 'legacy-untracked'
    || item?.tracking === 'legacy-untracked') return 'legacy';
  return 'attempted';
}

function deliveryRecoveryPlatform(item) {
  const value = item?.route?.platform || item?.platform || 'bridge';
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function deliveryRecoveryActionId(item) {
  return item?.actionId || item?.id || '';
}

function deliveryRecoveryFingerprint(item) {
  return item?.fingerprint || item?.expectedFingerprint || '';
}

function deliveryRecoveryChunkCount(item) {
  if (Number.isSafeInteger(item?.chunkCount) && item.chunkCount >= 0) return item.chunkCount;
  if (Array.isArray(item?.content?.chunks)) return item.content.chunks.length;
  if (Array.isArray(item?.chunks)) return item.chunks.length;
  if (Number.isSafeInteger(item?.chunks) && item.chunks >= 0) return item.chunks;
  return 0;
}

function deliveryRecoveryContentHash(item) {
  return item?.content?.sha256 || item?.contentHash || item?.contentSha256 || '';
}

function deliveryRecoveryTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    dateTime: date.toISOString(),
    label: new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date),
  };
}

function appendDeliveryRecoveryFact(list, label, value, { code = false, dateTime = null } = {}) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  if (dateTime) {
    const time = document.createElement('time');
    time.dateTime = dateTime;
    time.textContent = value || '—';
    description.append(time);
  } else if (code) {
    const exact = document.createElement('code');
    exact.textContent = value || '—';
    description.append(exact);
  } else {
    description.textContent = value || '—';
  }
  row.append(term, description);
  list.append(row);
}

function setDeliveryRecoveryBusy(busy) {
  state.deliveryRecoveryBusy = busy;
  for (const checkbox of elements.deliveryRecoveryList.querySelectorAll('input[type="checkbox"]')) {
    checkbox.disabled = busy;
  }
  for (const button of elements.deliveryRecoveryList.querySelectorAll('button[data-delivery-recovery-action]')) {
    const confirmation = button.dataset.confirmationId
      ? document.getElementById(button.dataset.confirmationId)
      : null;
    button.disabled = busy || !button.dataset.expectedFingerprint || Boolean(confirmation && !confirmation.checked);
  }
}

function updateBridgesCategoryAvailability() {
  const managedBridges = Boolean(state.bootstrap?.bridges && state.bootstrap?.capabilities?.manageBridges);
  const recoveryNeedsAttention = Boolean(
    state.deliveryRecovery
    && (state.deliveryRecovery.available === false || state.deliveryRecovery.count > 0),
  );
  setSettingsCategoryAvailable('bridges', managedBridges || recoveryNeedsAttention || state.deliveryRecoveryNotice);
}

function renderDeliveryRecovery(view) {
  const items = Array.isArray(view?.items) ? view.items : [];
  const count = Number.isSafeInteger(view?.count) && view.count >= 0 ? view.count : items.length;
  const shown = Number.isSafeInteger(view?.shown) && view.shown >= 0 ? view.shown : items.length;
  const hasMore = view?.hasMore === true || count > shown;
  const available = view?.available !== false;
  state.deliveryRecovery = { available, count, shown, hasMore, items };
  if (state.bootstrap) state.bootstrap.deliveryRecovery = state.deliveryRecovery;
  updateBridgesCategoryAvailability();
  elements.deliveryRecoverySummary.textContent = `Delivery recovery · ${count}`;
  elements.deliveryRecoveryRange.hidden = !available || !hasMore;
  elements.deliveryRecoveryRange.textContent = hasMore ? `Showing the latest ${shown} of ${count} unresolved replies.` : '';
  elements.deliveryRecovery.hidden = !available || count === 0;
  elements.deliveryRecoveryStatus.textContent = available ? '' : 'Recovery status unavailable';
  clear(elements.deliveryRecoveryList);

  for (const [index, item] of items.entries()) {
    const kind = deliveryRecoveryKind(item);
    const platform = deliveryRecoveryPlatform(item);
    const actionId = deliveryRecoveryActionId(item);
    const fingerprint = deliveryRecoveryFingerprint(item);
    const route = item?.route || {};
    const titleId = `delivery-recovery-title-${index}`;

    const card = document.createElement('article');
    card.className = `delivery-recovery-card ${kind}`;
    card.setAttribute('aria-labelledby', titleId);

    const heading = document.createElement('div');
    heading.className = 'delivery-recovery-heading';
    const title = document.createElement('h3');
    title.id = titleId;
    title.textContent = platform;
    const stateLabel = document.createElement('span');
    stateLabel.textContent = kind === 'prepared'
      ? 'Prepared · not attempted'
      : kind === 'legacy'
        ? 'Legacy · outcome unknown'
        : 'Attempted · outcome unknown';
    heading.append(title, stateLabel);

    const facts = document.createElement('dl');
    facts.className = 'delivery-recovery-facts';
    appendDeliveryRecoveryFact(facts, 'Destination ID', route.destinationId || item?.destinationId);
    appendDeliveryRecoveryFact(facts, 'Source message ID', item?.sourceMessageId);
    if (route.sourceUserId || item?.sourceUserId) {
      appendDeliveryRecoveryFact(facts, 'Source user ID', route.sourceUserId || item.sourceUserId);
    }
    const prepared = deliveryRecoveryTime(item?.preparedAt || item?.createdAt);
    appendDeliveryRecoveryFact(facts, 'Prepared', prepared?.label, { dateTime: prepared?.dateTime });
    const attempted = deliveryRecoveryTime(item?.attemptedAt);
    if (attempted) appendDeliveryRecoveryFact(facts, 'Attempted', attempted.label, { dateTime: attempted.dateTime });
    else if (kind !== 'prepared') appendDeliveryRecoveryFact(facts, 'Attempted', kind === 'legacy' ? 'Not recorded (legacy)' : 'Not recorded');
    appendDeliveryRecoveryFact(facts, 'Chunks', String(deliveryRecoveryChunkCount(item)));
    appendDeliveryRecoveryFact(facts, 'Content hash', shortHash(deliveryRecoveryContentHash(item)), { code: true });

    const inspect = document.createElement('details');
    inspect.className = 'delivery-recovery-inspect';
    const inspectSummary = document.createElement('summary');
    inspectSummary.textContent = 'Inspect';
    inspectSummary.setAttribute('aria-label', `Inspect exact recovery identifiers for ${platform} source message ${item?.sourceMessageId || 'unknown'}`);
    const exact = document.createElement('dl');
    exact.className = 'delivery-recovery-exact';
    appendDeliveryRecoveryFact(exact, 'Action ID', actionId, { code: true });
    appendDeliveryRecoveryFact(exact, 'Recovery fingerprint', fingerprint, { code: true });
    if (item?.actionFingerprint && item.actionFingerprint !== fingerprint) {
      appendDeliveryRecoveryFact(exact, 'Action fingerprint', item.actionFingerprint, { code: true });
    }
    if (item?.attemptFingerprint) {
      appendDeliveryRecoveryFact(exact, 'Attempt fingerprint', item.attemptFingerprint, { code: true });
    }
    inspect.append(inspectSummary, exact);

    const actions = document.createElement('div');
    actions.className = 'delivery-recovery-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary-button';
    button.dataset.deliveryRecoveryAction = kind === 'prepared' ? 'abandon-unsent' : 'acknowledge-uncertain';
    button.dataset.expectedFingerprint = fingerprint;

    if (kind === 'prepared') {
      button.textContent = 'Abandon unsent';
      button.setAttribute('aria-label', `Abandon unsent ${platform} reply for source message ${item?.sourceMessageId || 'unknown'}`);
    } else {
      const confirmationId = `delivery-recovery-confirm-${index}`;
      const confirmation = document.createElement('label');
      confirmation.className = 'delivery-recovery-confirmation';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = confirmationId;
      const confirmationText = document.createElement('span');
      confirmationText.textContent = 'I understand this reply may already have been delivered.';
      confirmation.append(checkbox, confirmationText);
      actions.append(confirmation);
      button.textContent = 'Acknowledge uncertainty';
      button.dataset.confirmationId = confirmationId;
      button.setAttribute('aria-label', `Acknowledge uncertain ${platform} delivery for source message ${item?.sourceMessageId || 'unknown'}`);
      checkbox.addEventListener('change', () => { button.disabled = state.deliveryRecoveryBusy || !checkbox.checked || !fingerprint; });
    }

    button.addEventListener('click', () => {
      void performDeliveryRecoveryAction(item, button.dataset.deliveryRecoveryAction);
    });
    actions.append(button);
    card.append(heading, facts, inspect, actions);
    elements.deliveryRecoveryList.append(card);
  }

  setDeliveryRecoveryBusy(state.deliveryRecoveryBusy);
}

function deliveryRecoveryView(response) {
  if (response?.deliveryRecovery?.available === false || Array.isArray(response?.deliveryRecovery?.items)) return response.deliveryRecovery;
  if (response?.available === false || Array.isArray(response?.items)) return response;
  return null;
}

async function refreshDeliveryRecovery() {
  if (!state.bootstrap?.deliveryRecovery || state.deliveryRecoveryBusy) return;
  try {
    const response = await request('/api/deliveries/recovery', { method: 'POST', body: {} });
    const view = deliveryRecoveryView(response);
    if (view) renderDeliveryRecovery(view);
  } catch (error) {
    renderDeliveryRecovery({ available: false, count: 0, shown: 0, hasMore: false, items: [] });
    elements.deliveryRecoveryStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function performDeliveryRecoveryAction(item, action) {
  if (state.deliveryRecoveryBusy) return;
  const id = deliveryRecoveryActionId(item);
  const expectedFingerprint = deliveryRecoveryFingerprint(item);
  if (!id || !expectedFingerprint) {
    elements.deliveryRecoveryStatus.textContent = 'This recovery record is missing its exact action or fingerprint.';
    return;
  }
  setDeliveryRecoveryBusy(true);
  elements.deliveryRecoveryStatus.textContent = action === 'abandon-unsent'
    ? 'Abandoning the unsent reply…'
    : 'Recording the uncertain outcome…';
  try {
    let available = true;
    const response = await request('/api/deliveries/recovery/action', {
      method: 'POST',
      body: { id, expectedFingerprint, action },
    });
    const returnedView = deliveryRecoveryView(response);
    if (returnedView) {
      available = returnedView.available !== false;
      if (available && returnedView.count === 0) state.deliveryRecoveryNotice = true;
      renderDeliveryRecovery(returnedView);
    }
    else {
      const refreshed = await request('/api/deliveries/recovery', { method: 'POST', body: {} });
      const view = deliveryRecoveryView(refreshed);
      if (view) {
        available = view.available !== false;
        if (available && view.count === 0) state.deliveryRecoveryNotice = true;
        renderDeliveryRecovery(view);
      }
    }
    const success = action === 'abandon-unsent'
      ? 'Unsent reply abandoned.'
      : 'Uncertain delivery acknowledged.';
    elements.deliveryRecoveryStatus.textContent = available
      ? success
      : `${success} Recovery status unavailable.`;
  } catch (error) {
    elements.deliveryRecoveryStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setDeliveryRecoveryBusy(false);
  }
}

async function performBridgeAction(body, title) {
  if (state.bridgeBusy || !state.bootstrap?.capabilities?.manageBridges) return;
  setBridgeBusy(true);
  const status = body.platform === 'discord' ? elements.discordBridgeStatus : elements.telegramBridgeStatus;
  status.textContent = `${title}…`;
  try {
    await request('/api/bridges/action', { method: 'POST', body });
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    setBridgeBusy(false);
    return;
  }
  elements.settingsDialog.close();
  const screen = lifecycleScreen(title, 'Fieldwork is closing the current room cleanly, applying the bridge change, and coming back…');
  try {
    await waitForRestart();
    window.location.reload();
  } catch (error) {
    screen.text.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function refreshBridgeStatus() {
  if (!state.bootstrap?.capabilities?.manageBridges || state.bridgeBusy) return;
  elements.telegramBridgeStatus.textContent = 'Refreshing…';
  elements.discordBridgeStatus.textContent = 'Refreshing…';
  try {
    const response = await request('/api/bridges/view', { method: 'POST', body: {} });
    state.bootstrap.bridges = response.bridges;
    renderBridges(response.bridges, true);
    renderCheckInDestinationNote();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.telegramBridgeStatus.textContent = message;
    elements.discordBridgeStatus.textContent = message;
  }
}

function renderAgents(registry, available) {
  setSettingsCategoryAvailable('agents', available);
  setSettingsCategoryAvailable('reset', available);
  clear(elements.agentList);
  if (!available || !registry) return;
  for (const agent of registry.agents) {
    const card = document.createElement('article');
    card.className = `agent-card${agent.active ? ' active' : ''}`;
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = agent.name;
    const mark = document.createElement('span');
    mark.textContent = agent.active ? 'active' : agent.id;
    heading.append(title, mark);
    const home = document.createElement('code');
    home.textContent = agent.home;
    home.title = agent.home;
    card.append(heading, home);
    if (!agent.active) {
      const button = document.createElement('button');
      button.className = 'secondary-button';
      button.type = 'button';
      button.textContent = 'Switch';
      button.disabled = state.agentBusy;
      button.addEventListener('click', () => { void performAgentAction({ action: 'switch', id: agent.id }, `Switching to ${agent.name}`); });
      card.append(button);
    }
    elements.agentList.append(card);
  }
  const active = activeAgent();
  if (active) {
    elements.agentRenameName.value = active.name;
    elements.agentMoveDestination.value = '';
    elements.agentMoveDestination.placeholder = active.home;
  }
}

function selectedBackup() {
  return state.recoveryBackups.find(row => row.id === state.selectedBackupId) || null;
}

function restoreConfirmation(row) {
  return row?.kind === 'state' ? 'RESTORE STATE' : row?.kind === 'agent' ? 'RESTORE AGENT' : '';
}

function selectBackup(row) {
  state.selectedBackupId = row.id;
  for (const button of elements.recoveryList.querySelectorAll('.recovery-copy')) {
    button.setAttribute('aria-pressed', String(button.dataset.backupId === row.id));
  }
  const stateOnly = row.kind === 'state';
  elements.restorePreview.hidden = false;
  elements.restorePreviewTitle.textContent = stateOnly ? 'Restore this state copy' : 'Restore this whole-agent copy';
  elements.restorePreviewDescription.textContent = stateOnly
    ? 'Replaces conversations, memories, room preferences, and derived context. Roots and workspace files stay as they are now.'
    : 'Replaces the entire active agent home, including roots, workspace files, conversations, memories, appearance, and model preferences.';
  elements.restorePreviewLocation.textContent = row.location;
  elements.restorePreviewLocation.title = row.location;
  elements.restoreConfirmationPhrase.textContent = restoreConfirmation(row);
  elements.restoreConfirmation.value = '';
  setAgentBusy(state.agentBusy);
  elements.restoreConfirmation.focus();
}

function renderBackups(registry, available) {
  clear(elements.recoveryList);
  state.recoveryBackups = available && registry ? registry.backups : [];
  state.selectedBackupId = null;
  elements.restorePreview.hidden = true;
  elements.restoreConfirmation.value = '';
  if (registry?.warning) elements.resetStatus.textContent = registry.warning;
  if (!available || !registry) {
    const empty = document.createElement('p');
    empty.className = 'recovery-empty';
    empty.textContent = 'Recovery-copy listing is unavailable in this room.';
    elements.recoveryList.append(empty);
    return;
  }
  if (!registry.backups.length) {
    const empty = document.createElement('p');
    empty.className = 'recovery-empty';
    empty.textContent = 'No recovery copies have been made for this agent yet.';
    elements.recoveryList.append(empty);
    return;
  }
  for (const row of registry.backups) {
    const item = document.createElement('article');
    item.setAttribute('role', 'listitem');
    const button = document.createElement('button');
    button.className = 'recovery-copy';
    button.type = 'button';
    button.dataset.backupId = row.id;
    button.setAttribute('aria-pressed', 'false');
    const title = document.createElement('strong');
    title.textContent = row.kind === 'state' ? 'State only' : 'Whole agent';
    const time = document.createElement('time');
    time.dateTime = row.createdAt;
    const when = new Date(row.createdAt);
    time.textContent = Number.isFinite(when.getTime()) ? when.toLocaleString() : row.createdAt;
    const location = document.createElement('code');
    location.textContent = row.location;
    location.title = row.location;
    button.append(title, time, location);
    button.addEventListener('click', () => selectBackup(row));
    item.append(button);
    elements.recoveryList.append(item);
  }
}

function setAgentBusy(busy) {
  state.agentBusy = busy;
  for (const form of [
    elements.agentCreateForm, elements.agentRenameForm, elements.agentMoveForm,
    elements.agentExportForm, elements.agentImportForm,
  ]) {
    for (const control of form.elements) control.disabled = busy;
  }
  elements.clearStateConfirmation.disabled = busy;
  elements.agentCreateExpert.disabled = busy;
  elements.resetAgentConfirmation.disabled = busy;
  elements.restoreConfirmation.disabled = busy;
  for (const button of elements.recoveryList.querySelectorAll('.recovery-copy')) button.disabled = busy;
  elements.clearStateButton.disabled = busy || elements.clearStateConfirmation.value !== 'CLEAR STATE';
  elements.resetAgentButton.disabled = busy || elements.resetAgentConfirmation.value !== 'RESET AGENT';
  const selected = selectedBackup();
  elements.restoreButton.disabled = busy || !selected || elements.restoreConfirmation.value !== restoreConfirmation(selected);
}

async function performAgentAction(body, title) {
  if (state.agentBusy || !state.bootstrap?.capabilities?.manageAgents) return;
  setAgentBusy(true);
  elements.agentStatus.textContent = `${title}…`;
  elements.resetStatus.textContent = `${title}…`;
  try {
    await request('/api/agents/action', { method: 'POST', body });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.agentStatus.textContent = message;
    elements.resetStatus.textContent = message;
    setAgentBusy(false);
    return;
  }
  elements.settingsDialog.close();
  const portable = body.action === 'export-agent' || body.action === 'import-agent';
  const screen = lifecycleScreen(title, portable
    ? 'Fieldwork closed the room cleanly and is copying, checking, and reopening it. A large agent may take a while…'
    : 'Fieldwork is closing the current room cleanly, applying the change, and coming back…');
  try {
    await waitForRestart(portable ? {
      timeoutMs: 30 * 60_000,
      timeoutMessage: 'The portable copy is still unavailable after 30 minutes. Check the launcher terminal before starting Fieldwork again; the supervised copy may still be finishing.',
    } : undefined);
    window.location.reload();
  } catch (error) {
    screen.text.textContent = error instanceof Error ? error.message : String(error);
  }
}

settingsCategoryButtons.forEach(button => {
  button.addEventListener('click', () => selectSettingsPage(button.dataset.settingsPage));
  button.addEventListener('keydown', event => {
    const available = settingsCategoryButtons.filter(candidate => !candidate.hidden);
    const index = available.indexOf(button);
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % available.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + available.length) % available.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = available.length - 1;
    if (next === null || index < 0) return;
    event.preventDefault();
    selectSettingsPage(available[next].dataset.settingsPage, true);
  });
});
elements.settingsSearch.addEventListener('input', applySettingsSearch);
elements.settingsButton.addEventListener('click', () => {
  applySettingsSearch();
  const selected = settingsCategoryButtons.find(button => button.getAttribute('aria-selected') === 'true' && !button.hidden);
  const first = settingsCategoryButtons.find(button => !button.hidden);
  selectSettingsPage(selected?.dataset.settingsPage || first?.dataset.settingsPage || 'appearance');
  elements.settingsDialog.showModal();
  elements.settingsSearch.focus();
  if (state.modelEffortConfigurable && state.modelAvailable) void loadModelChoices().catch(() => {});
  void refreshBridgeStatus();
  void refreshDeliveryRecovery();
});
byId('settings-close').addEventListener('click', () => elements.settingsDialog.close());
elements.settingsDialog.addEventListener('click', event => { if (event.target === elements.settingsDialog) elements.settingsDialog.close(); });
elements.settingsDialog.addEventListener('close', () => {
  clearSettingsSearch();
  state.deliveryRecoveryNotice = false;
  updateBridgesCategoryAvailability();
});

elements.connectionService.addEventListener('change', syncConnectionFields);
elements.connectionForm.addEventListener('submit', event => {
  event.preventDefault();
  const service = elements.connectionService.value;
  const body = {
    action: 'configure',
    service,
    model: elements.connectionModel.value.trim(),
  };
  if (service === 'openai-compatible') {
    body.baseURL = elements.connectionEndpoint.value.trim();
    if (elements.connectionApiKey.value) body.apiKey = elements.connectionApiKey.value;
  }
  void performConnectionAction(body, 'Updating the model connection');
});
elements.connectionForgetKey.addEventListener('click', () => {
  const confirmation = window.prompt('Type FORGET API KEY to remove the key saved by this Fieldwork launcher.');
  if (confirmation !== 'FORGET API KEY') return;
  void performConnectionAction({ action: 'forget-api-key', confirmation }, 'Forgetting the saved API key');
});

elements.telegramBridgeScope.addEventListener('change', syncTelegramBridgeFields);
elements.telegramBridgeRefresh.addEventListener('click', () => { void refreshBridgeStatus(); });
elements.telegramBridgeForm.addEventListener('submit', event => {
  event.preventDefault();
  const grouped = elements.telegramBridgeScope.value === 'group';
  const body = {
    action: 'configure',
    platform: 'telegram',
    destinationId: elements.telegramBridgeChatId.value.trim(),
    allowedUserId: elements.telegramBridgeUserId.value.trim(),
    scope: elements.telegramBridgeScope.value,
  };
  if (elements.telegramBridgeToken.value) body.token = elements.telegramBridgeToken.value;
  if (grouped) body.groupConfirmation = elements.telegramBridgeGroupConfirmation.value;
  void performBridgeAction(body, 'Updating the Telegram bridge');
});
elements.telegramBridgeDisconnect.addEventListener('click', () => {
  const confirmation = window.prompt('Type DISCONNECT TELEGRAM to stop this agent from listening on the configured Telegram route. The saved bot token will remain.');
  if (confirmation !== 'DISCONNECT TELEGRAM') return;
  void performBridgeAction({ action: 'disconnect', platform: 'telegram', confirmation }, 'Disconnecting the Telegram bridge');
});
elements.telegramBridgeForgetToken.addEventListener('click', () => {
  const confirmation = window.prompt('Type FORGET TELEGRAM TOKEN to remove the token saved by this Fieldwork launcher. The route will remain configured.');
  if (confirmation !== 'FORGET TELEGRAM TOKEN') return;
  void performBridgeAction({ action: 'forget-token', platform: 'telegram', confirmation }, 'Forgetting the saved Telegram token');
});

elements.discordBridgeScope.addEventListener('change', syncDiscordBridgeFields);
elements.discordBridgeRefresh.addEventListener('click', () => { void refreshBridgeStatus(); });
elements.discordBridgeForm.addEventListener('submit', event => {
  event.preventDefault();
  const grouped = elements.discordBridgeScope.value === 'guild';
  const body = {
    action: 'configure',
    platform: 'discord',
    destinationId: elements.discordBridgeChannelId.value.trim(),
    allowedUserId: elements.discordBridgeUserId.value.trim(),
    scope: elements.discordBridgeScope.value,
  };
  if (grouped) {
    body.guildId = elements.discordBridgeGuildId.value.trim();
    body.groupConfirmation = elements.discordBridgeGroupConfirmation.value;
  }
  if (elements.discordBridgeToken.value) body.token = elements.discordBridgeToken.value;
  void performBridgeAction(body, 'Updating the Discord bridge');
});
elements.discordBridgeDisconnect.addEventListener('click', () => {
  const confirmation = window.prompt('Type DISCONNECT DISCORD to stop this agent from listening on the configured Discord route. The saved bot token will remain.');
  if (confirmation !== 'DISCONNECT DISCORD') return;
  void performBridgeAction({ action: 'disconnect', platform: 'discord', confirmation }, 'Disconnecting the Discord bridge');
});
elements.discordBridgeForgetToken.addEventListener('click', () => {
  const confirmation = window.prompt('Type FORGET DISCORD TOKEN to remove the token saved by this Fieldwork launcher. The route will remain configured.');
  if (confirmation !== 'FORGET DISCORD TOKEN') return;
  void performBridgeAction({ action: 'forget-token', platform: 'discord', confirmation }, 'Forgetting the saved Discord token');
});

elements.agentCreateForm.addEventListener('submit', event => {
  event.preventDefault();
  void performAgentAction({ action: 'create', name: elements.agentCreateName.value }, 'Creating the new agent');
});
elements.agentCreateExpert.addEventListener('click', () => {
  void performAgentAction({ action: 'create-expert' }, 'Opening the Fieldwork Expert');
});
elements.agentRenameForm.addEventListener('submit', event => {
  event.preventDefault();
  const active = activeAgent();
  if (active) void performAgentAction({ action: 'rename', id: active.id, name: elements.agentRenameName.value }, 'Renaming the agent');
});
elements.agentMoveForm.addEventListener('submit', event => {
  event.preventDefault();
  const active = activeAgent();
  if (active) void performAgentAction({ action: 'move', id: active.id, destination: elements.agentMoveDestination.value }, 'Moving the agent home');
});
elements.agentExportForm.addEventListener('submit', event => {
  event.preventDefault();
  const active = activeAgent();
  if (active) void performAgentAction({
    action: 'export-agent', id: active.id, destination: elements.agentExportDestination.value,
  }, 'Exporting the active agent');
});
elements.agentImportForm.addEventListener('submit', event => {
  event.preventDefault();
  void performAgentAction({ action: 'import-agent', source: elements.agentImportSource.value }, 'Importing the agent copy');
});
elements.clearStateConfirmation.addEventListener('input', () => setAgentBusy(state.agentBusy));
elements.resetAgentConfirmation.addEventListener('input', () => setAgentBusy(state.agentBusy));
elements.restoreConfirmation.addEventListener('input', () => setAgentBusy(state.agentBusy));
elements.clearStateButton.addEventListener('click', () => {
  const active = activeAgent();
  if (active) void performAgentAction({ action: 'clear-state', id: active.id, confirmation: elements.clearStateConfirmation.value }, 'Clearing the agent state');
});
elements.resetAgentButton.addEventListener('click', () => {
  const active = activeAgent();
  if (active) void performAgentAction({ action: 'reset-agent', id: active.id, confirmation: elements.resetAgentConfirmation.value }, 'Resetting the agent from its starting template');
});
elements.restoreButton.addEventListener('click', () => {
  const active = activeAgent();
  const backup = selectedBackup();
  if (!active || !backup) return;
  const action = backup.kind === 'state' ? 'restore-state' : 'restore-agent';
  void performAgentAction({
    action,
    id: active.id,
    backupId: backup.id,
    confirmation: elements.restoreConfirmation.value,
  }, backup.kind === 'state' ? 'Restoring the agent state' : 'Restoring the whole agent');
});

// ---- agent files ------------------------------------------------------------------

const rootDialog = byId('root-dialog');
const rootState = { id: null, sha256: null, saved: '' };

async function openRootEditor(id) {
  byId('root-status').textContent = 'Opening…';
  try {
    const { root } = await request('/api/roots/get', { method: 'POST', body: { id } });
    rootState.id = root.id;
    rootState.sha256 = root.sha256;
    rootState.saved = root.text;
    byId('root-dialog-title').textContent = root.id;
    byId('root-dialog-path').textContent = `Agent file · ${root.path}`;
    byId('root-text').value = root.text;
    byId('root-status').textContent = 'Changes apply from the next message.';
    byId('root-history').open = false;
    if (!rootDialog.open) rootDialog.showModal();
    byId('root-text').focus();
    await loadRootHistory();
  } catch (error) {
    byId('root-status').textContent = error instanceof Error ? error.message : String(error);
    if (!rootDialog.open) showError(error);
  }
}

async function loadRootHistory() {
  const list = byId('root-history-list');
  clear(list);
  try {
    const { versions } = await request('/api/roots/history', { method: 'POST', body: { id: rootState.id } });
    if (!versions.length) {
      const none = document.createElement('li');
      none.textContent = 'No earlier versions yet. Each save keeps the version before it.';
      list.append(none);
    }
    for (const version of versions) {
      const item = document.createElement('li');
      const when = new Date(version.version.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z'));
      item.textContent = `${Number.isFinite(when.getTime()) ? when.toLocaleString() : version.version} · ${version.characters} characters: ${version.preview}`;
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = 'Restore';
      restore.addEventListener('click', async () => {
        try {
          const response = await request('/api/roots/restore', { method: 'POST', body: { id: rootState.id, version: version.version } });
          renderHealth({ ...state.bootstrap, health: response.health });
          await openRootEditor(rootState.id);
          byId('root-status').textContent = 'Restored. The version you replaced is in the history too.';
        } catch (error) {
          byId('root-status').textContent = error instanceof Error ? error.message : String(error);
        }
      });
      item.append(restore);
      list.append(item);
    }
  } catch { /* History is optional; the editor still works. */ }
}

byId('root-save').addEventListener('click', async () => {
  const text = byId('root-text').value;
  if (text === rootState.saved) { byId('root-status').textContent = 'Nothing changed.'; return; }
  byId('root-status').textContent = 'Saving…';
  try {
    const response = await request('/api/roots/save', { method: 'POST', body: { id: rootState.id, text, expectedSha256: rootState.sha256 } });
    rootState.sha256 = response.root.sha256;
    rootState.saved = response.root.text;
    renderHealth({ ...state.bootstrap, health: response.health });
    byId('root-status').textContent = 'Saved. Your agent uses this from the next message.';
    await loadRootHistory();
  } catch (error) {
    byId('root-status').textContent = error instanceof Error ? error.message : String(error);
  }
});
const closeRootEditor = () => {
  if (byId('root-text').value !== rootState.saved && !window.confirm('Close without saving your changes?')) return;
  rootDialog.close();
};
byId('root-cancel').addEventListener('click', closeRootEditor);
byId('root-dialog-close').addEventListener('click', closeRootEditor);
rootDialog.addEventListener('cancel', event => { event.preventDefault(); closeRootEditor(); });

// ---- names, icons and pronouns -----------------------------------------------------

function fillAvatar(node, icon) {
  clear(node);
  if (icon?.kind === 'emoji') node.textContent = icon.value;
  else if (icon?.kind === 'image' || icon?.kind === 'picture') {
    const image = document.createElement('img');
    image.alt = '';
    if (icon.kind === 'image') image.src = icon.dataUrl;
    else loadAttachmentImage(icon.ref).then(url => { image.src = url; }).catch(() => { image.replaceWith(document.createTextNode('?')); });
    node.append(image);
  }
}

const sameIcon = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

// When the agent changes its own portrait, say so plainly, with Undo.
function showPortraitChange(before, after) {
  const grammar = agentGrammar();
  const name = state.look?.agent?.name || 'Your agent';
  let toast = byId('portrait-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'portrait-toast';
    toast.className = 'portrait-toast';
    toast.setAttribute('role', 'status');
    elements.messages.parentNode.insertBefore(toast, elements.messages.nextSibling);
  }
  clear(toast);
  const was = document.createElement('span');
  was.className = 'avatar';
  fillAvatar(was, before);
  const arrow = document.createElement('span');
  arrow.textContent = '→';
  arrow.setAttribute('aria-hidden', 'true');
  const now = document.createElement('span');
  now.className = 'avatar';
  fillAvatar(now, after);
  const words = document.createElement('span');
  words.textContent = `${name} changed ${grammar.configured ? grammar.possessiveDeterminer : 'its'} portrait.`;
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = 'Undo';
  undo.addEventListener('click', async () => {
    try {
      const response = await request('/api/look/restore', { method: 'POST', body: { who: 'agent', index: 0 } });
      state.look = response.look;
      renderLook(Boolean(state.bootstrap?.capabilities?.editLook));
      renderMessages(state.bootstrap.conversation?.messages || [], state.bootstrap.conversation?.omittedMessages || 0);
      toast.remove();
    } catch (error) { showError(error); }
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Keep it';
  close.addEventListener('click', () => toast.remove());
  toast.append(was, arrow, now, words, undo, close);
}

function renderLook(editable) {
  renderAgentLanguage();
  byId('look-section').hidden = !editable;
  if (!editable) return;
  const grid = byId('look-grid');
  clear(grid);
  for (const [who, label] of [['agent', 'Your agent'], ['person', 'You']]) {
    const entry = state.look[who];
    const card = document.createElement('div');
    card.className = 'look-card';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    fillAvatar(avatar, entry.icon);
    const name = document.createElement('input');
    name.type = 'text';
    name.value = entry.name;
    name.maxLength = 40;
    name.setAttribute('aria-label', `${label}: name`);
    const pronouns = document.createElement('input');
    pronouns.type = 'text';
    pronouns.value = entry.pronouns || '';
    pronouns.maxLength = 80;
    pronouns.placeholder = who === 'agent' ? 'she/her or xe/xem/xyr/xyrs/xemself' : 'Pronouns (optional)';
    pronouns.setAttribute('aria-label', `${label}: pronouns`);
    const grammar = document.createElement('p');
    grammar.className = 'look-grammar';
    const syncGrammar = () => {
      const current = state.look[who];
      if (who === 'person') { grammar.textContent = 'Shown beside your messages.'; return; }
      const forms = current.pronounForms;
      grammar.textContent = forms
        ? `Room wording: ${forms.subject} · ${forms.object} · ${forms.possessiveDeterminer} · ${forms.possessivePronoun} · ${forms.reflexive} (${forms.agreement} verbs)`
        : current.pronouns
          ? 'Badge saved; room sentences use “the agent” until a familiar or five-part set is supplied.'
          : 'Add pronouns to use them in authored room sentences.';
    };
    const buttons = document.createElement('div');
    buttons.className = 'look-buttons';
    const emoji = document.createElement('button');
    emoji.type = 'button';
    emoji.textContent = 'Emoji';
    const upload = document.createElement('label');
    upload.textContent = 'Picture';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp,image/gif';
    upload.append(file);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'No icon';
    buttons.append(emoji, upload, remove);
    const status = document.createElement('p');
    status.className = 'look-status';
    const earlier = document.createElement('div');
    earlier.className = 'look-earlier';
    if (entry.iconHistory?.length) {
      const caption = document.createElement('small');
      caption.textContent = who === 'agent' && entry.iconBy === 'agent' ? 'Chosen by the agent. Earlier:' : 'Earlier:';
      earlier.append(caption);
      entry.iconHistory.forEach((row, index) => {
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'avatar';
        pick.title = `Bring this one back${row.by ? ` (set by ${row.by === 'agent' ? 'the agent' : 'you'})` : ''}`;
        fillAvatar(pick, row.icon);
        pick.addEventListener('click', async () => {
          status.textContent = 'Restoring…';
          try {
            const response = await request('/api/look/restore', { method: 'POST', body: { who, index } });
            state.look = response.look;
            renderLook(true);
            renderMessages(state.bootstrap.conversation?.messages || [], state.bootstrap.conversation?.omittedMessages || 0);
          } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
        });
        earlier.append(pick);
      });
    } else if (who === 'agent' && entry.iconBy === 'agent') {
      earlier.textContent = 'Chosen by the agent.';
    }
    card.append(avatar, name, pronouns, grammar, buttons, earlier, status);
    grid.append(card);
    syncGrammar();

    const save = async change => {
      status.textContent = 'Saving…';
      try {
        const response = await request('/api/look/update', { method: 'POST', body: { who, ...change } });
        state.look = response.look;
        fillAvatar(avatar, state.look[who].icon);
        name.value = state.look[who].name;
        pronouns.value = state.look[who].pronouns || '';
        syncGrammar();
        renderAgentLanguage();
        renderExpression(); // the mood chip says the agent's name
        status.textContent = state.look[who].pronounsBy === 'agent' ? 'Saved · pronouns chosen by the agent.' : 'Saved.';
        renderMessages(state.bootstrap.conversation?.messages || [], state.bootstrap.conversation?.omittedMessages || 0);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    name.addEventListener('change', () => { void save({ name: name.value }); });
    pronouns.addEventListener('change', () => { void save({ pronouns: pronouns.value }); });
    emoji.addEventListener('click', () => {
      const value = window.prompt(`An emoji for ${label.toLowerCase()}:`, entry.icon?.kind === 'emoji' ? entry.icon.value : '');
      if (value !== null && value.trim()) void save({ icon: { kind: 'emoji', value: value.trim() } });
    });
    remove.addEventListener('click', () => { void save({ icon: null }); });
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      if (chosen.size > 256 * 1024) { status.textContent = 'Pictures can be at most 256 KB.'; return; }
      const reader = new FileReader();
      reader.onload = () => { void save({ icon: { kind: 'image', dataUrl: String(reader.result) } }); };
      reader.readAsDataURL(chosen);
      file.value = '';
    });
    if (entry.pronounsBy === 'agent') status.textContent = 'Pronouns chosen by the agent.';
  }
}

// ---- agent-authored house guides -----------------------------------------------

function guideText(view, id) {
  const guide = view?.guides?.find(row => row.id === id);
  if (!guide) return '';
  if (guide.text) return guide.text;
  const grammar = agentGrammar();
  if (!grammar.configured) return guide.canonical;
  if (id === 'check-ins') {
    return `Check-ins let your agent write to you on ${grammar.possessiveDeterminer} own. During a check-in, ${grammar.subject} may also decide ${grammar.subject} ${agentVerb(grammar, 'has', 'have')} nothing to say, and then nothing is sent. “Free time now” gives ${grammar.object} an unstructured visit with no task or expected output; a quiet visit adds no conversation or check-in-history entry.`;
  }
  if (id === 'fieldworks') {
    return `Give your agent a question or task and a step budget. During a Fieldwork, ${grammar.subject} ${agentVerb(grammar, 'works', 'work')} without waiting for replies, ${agentVerb(grammar, 'leaves', 'leave')} a write-up and visible steps, and you can stop the run while ${grammar.subject} ${agentVerb(grammar, 'is', 'are')} working.`;
  }
  return guide.canonical;
}

function applyGuideSurfaces(view) {
  const surfaces = [
    ['telegram', 'telegram-bridge-intro'],
    ['discord', 'discord-bridge-intro'],
    ['check-ins', 'checkin-intro'],
    ['fieldworks', 'fieldwork-guide'],
  ];
  for (const [guideId, elementId] of surfaces) {
    const text = guideText(view, guideId);
    if (text) byId(elementId).textContent = text;
  }
}

function renderAgentLanguage() {
  const grammar = agentGrammar();
  byId('fieldwork-steps-copy').textContent = `Steps ${grammar.subject} may take`;
  byId('fieldwork-steps-box').querySelector('summary').textContent = agentPathLabel();
  byId('checkin-fieldwork-copy').textContent = grammar.configured
    ? `${grammar.subject} may start a Fieldwork of ${grammar.possessiveDeterminer} own while checking in`
    : 'the agent may start a Fieldwork independently while checking in';
  applyGuideSurfaces(state.guides);
  if (state.fieldworkCurrent) renderFieldwork(state.fieldworkCurrent);
}

async function changeGuide(path, body, status) {
  status.textContent = 'Updating…';
  try {
    const response = await request(path, { method: 'POST', body });
    renderGuides(response.guides, true);
    elements.guideStatus.textContent = 'Saved. The earlier wording remains in history.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderGuides(view, available) {
  state.guides = view;
  setSettingsCategoryAvailable('guides', Boolean(available && view));
  applyGuideSurfaces(view);
  clear(elements.guideList);
  elements.guideRewrite.disabled = !available || !view || !state.bootstrap?.capabilities?.chat || state.busy || state.guideBusy;
  if (!available || !view) return;
  for (const guide of view.guides) {
    const card = document.createElement('article');
    card.className = 'guide-card';
    const choice = document.createElement('label');
    choice.className = 'guide-choice';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = guide.id;
    checkbox.name = 'guide';
    const label = document.createElement('strong');
    label.textContent = guide.label;
    const summary = document.createElement('small');
    summary.textContent = guide.summary;
    choice.append(checkbox, label, summary);
    const copy = document.createElement('p');
    copy.className = 'guide-copy';
    copy.textContent = guideText(view, guide.id);
    const meta = document.createElement('div');
    meta.className = 'guide-meta';
    const source = document.createElement('span');
    source.textContent = guide.text
      ? `${guide.author?.kind === 'agent' ? 'Agent version' : 'Restored version'} · ${guide.updatedAt ? new Date(guide.updatedAt).toLocaleString() : 'saved'}`
      : 'Fieldwork wording';
    meta.append(source);
    if (guide.text) {
      const reset = document.createElement('button');
      reset.className = 'secondary-button';
      reset.type = 'button';
      reset.textContent = 'Use Fieldwork wording';
      reset.addEventListener('click', () => {
        void changeGuide('/api/guides/reset', { id: guide.id, expectedRevision: state.guides.revision }, source);
      });
      meta.append(reset);
    }
    card.append(choice, copy, meta);
    if (guide.history.length) {
      const history = document.createElement('details');
      history.className = 'guide-history';
      const heading = document.createElement('summary');
      heading.textContent = `Earlier wording (${guide.history.length})`;
      history.append(heading);
      for (const version of guide.history) {
        const row = document.createElement('div');
        row.className = 'guide-history-row';
        const preview = document.createElement('span');
        preview.textContent = version.preview;
        const restore = document.createElement('button');
        restore.className = 'secondary-button';
        restore.type = 'button';
        restore.textContent = 'Restore';
        restore.addEventListener('click', () => {
          void changeGuide('/api/guides/restore', {
            id: guide.id,
            version: version.version,
            expectedRevision: state.guides.revision,
          }, preview);
        });
        row.append(preview, restore);
        history.append(row);
      }
      card.append(history);
    }
    elements.guideList.append(card);
  }
}

elements.guideForm.addEventListener('submit', async event => {
  event.preventDefault();
  const selected = [...elements.guideList.querySelectorAll('input[name="guide"]:checked')].map(input => input.value);
  if (!selected.length) { elements.guideStatus.textContent = 'Choose at least one guide first.'; return; }
  if (state.busy || state.guideBusy) { elements.guideStatus.textContent = 'Wait for the current request to finish.'; return; }
  if (!state.bootstrap?.capabilities?.chat) { elements.guideStatus.textContent = 'Connect a model before asking the agent.'; return; }
  if (elements.input.value.trim() || state.pendingAttachments.length) {
    elements.guideStatus.textContent = 'Send or clear the current message draft before starting this request.';
    return;
  }
  state.guideBusy = true;
  elements.guideRewrite.disabled = true;
  elements.guideStatus.textContent = 'Opening a scoped rewrite request…';
  try {
    const response = await request('/api/guides/request', { method: 'POST', body: { guides: selected } });
    const labels = selected.map(id => state.guides.guides.find(guide => guide.id === id)?.label).filter(Boolean);
    elements.input.value = [
      `Please rewrite these Fieldwork house guides in your own voice: ${labels.join(', ')}.`,
      `This short-lived, single-use rewrite request is ${response.invitation.requestId}. It allows only these selected guide ids: ${response.invitation.guides.join(', ')}.`,
      'First call read_house_guides with that request_id. Then call rewrite_house_guides with the same request_id and the revision you read. Save complete, factually accurate versions. Preserve the real capability and permission boundaries; a guide rewrite changes prose only. If you do not want to rewrite one, leave it unchanged and tell me.',
    ].join('\n\n');
    elements.guideStatus.textContent = 'Invitation sent to the agent.';
    elements.settingsDialog.close();
    elements.composer.requestSubmit();
  } catch (error) {
    elements.guideStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    state.guideBusy = false;
    elements.guideRewrite.disabled = state.busy || !state.bootstrap?.capabilities?.chat || !state.guides;
  }
});

// ---- sending, thinking and live replies ---------------------------------------

// Used until the agent picks its own lines with set_thinking_lines.
const DEFAULT_THINKING = Object.freeze(['thinking', '(・・ ) ?', 'mulling it over', '( ˘ω˘ )']);

function scrollToEnd() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function thinkingElement() {
  const wrap = document.createElement('div');
  wrap.className = 'thinking';
  wrap.setAttribute('role', 'status');
  const dots = document.createElement('span');
  dots.className = 'thinking-dots';
  dots.setAttribute('aria-hidden', 'true');
  dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  const line = document.createElement('span');
  line.className = 'thinking-line';
  const tool = document.createElement('span');
  tool.className = 'thinking-tool';
  wrap.append(dots, line, tool);
  return { wrap, line, tool };
}

// The agent's bubble while it works: a thinking animation, then its words as
// they arrive. The finished reply replaces it.
function startLiveReply() {
  const item = buildMessageItem({ role: 'assistant', display: '', at: new Date().toISOString() });
  item.classList.add('live');
  const mood = state.expression?.current?.color;
  if (mood) item.dataset.moodColor = mood;
  const content = item.querySelector('.message-content');
  const thinking = thinkingElement();
  item.append(thinking.wrap);
  const lines = state.expression?.thinking?.length ? state.expression.thinking : DEFAULT_THINKING;
  const known = new Set((state.expression?.emoji || []).map(row => row.name));
  const showLine = text => { clear(thinking.line); appendEmojiText(thinking.line, text, known); };
  let turn = Math.floor(Math.random() * lines.length);
  showLine(lines[turn]);
  const timer = setInterval(() => {
    if (lines.length < 2) return;
    thinking.line.classList.add('fading');
    setTimeout(() => {
      turn = (turn + 1) % lines.length;
      showLine(lines[turn]);
      thinking.line.classList.remove('fading');
    }, 280);
  }, 2600);
  const steps = new Map();
  let frame = 0;
  const paint = () => {
    frame = 0;
    const nearBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 80;
    renderRichText(content, [...steps.values()].filter(Boolean).join('\n\n'));
    if (nearBottom) scrollToEnd();
  };
  return {
    item,
    step() { thinking.wrap.hidden = false; },
    text(step, delta) {
      steps.set(step, (steps.get(step) || '') + delta);
      thinking.wrap.hidden = true;
      if (!frame) frame = requestAnimationFrame(paint);
    },
    tools(names) {
      thinking.tool.textContent = names.length ? `using ${names.join(', ')}` : '';
      thinking.wrap.hidden = false;
    },
    stop() {
      clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
    },
  };
}

async function failedResponse(response) {
  let value;
  try { value = await response.json(); } catch { value = { error: `Fieldwork returned ${response.status} without a JSON body.` }; }
  if (response.status === 403 && value.error === STALE_TOKEN) {
    storeToken(null);
    return new Error(state.token
      ? 'This room has a new password, probably because it restarted. Open the link printed in its terminal.'
      : 'This room needs its password. Open the link printed in its terminal once; this browser will remember it.');
  }
  return new Error(value.error || `Fieldwork returned ${response.status}.`);
}

// Sends a chat and reads the reply as it is written: one JSON object per line.
async function streamChat(body, live) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { accept: 'application/x-ndjson', 'content-type': 'application/json', 'x-fieldwork-token': state.token || '' },
    body: JSON.stringify({ ...body, stream: true }),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw await failedResponse(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let reply = null;
  const handle = row => {
    if (!row.trim()) return;
    const event = JSON.parse(row);
    if (event.type === 'text') live.text(event.step, event.delta);
    else if (event.type === 'tools') live.tools(event.names || []);
    else if (event.type === 'step') live.step(event.step);
    else if (event.type === 'done') reply = event.reply;
    else if (event.type === 'error') throw new Error(event.error || 'The reply failed.');
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      handle(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
  }
  handle(buffered + decoder.decode());
  if (!reply) throw new Error('The reply stopped before it finished.');
  return reply;
}

// The tool drawer remembers whether it was open (this browser only).
{
  const drawer = byId('tool-drawer');
  try { drawer.open = localStorage.getItem('fieldwork-tool-drawer') === 'open'; } catch { /* storage unavailable */ }
  drawer.addEventListener('toggle', () => {
    try { localStorage.setItem('fieldwork-tool-drawer', drawer.open ? 'open' : 'closed'); } catch { /* storage unavailable */ }
    if (drawer.open) byId('tool-search').focus({ preventScroll: true });
  });
  byId('tool-search').addEventListener('input', renderToolList);
}

// ---- the Memory tab holds memories and, when there are any, collections -----------

let memoryView = 'memories';
try { if (localStorage.getItem('fieldwork-memory-view') === 'collections') memoryView = 'collections'; } catch { /* storage unavailable */ }

function showMemoryView() {
  const collectionsOn = !byId('memory-switch').hidden;
  if (!collectionsOn) memoryView = 'memories';
  byId('memory-view-memories').hidden = memoryView !== 'memories';
  byId('memory-view-collections').hidden = memoryView !== 'collections';
  for (const button of document.querySelectorAll('[data-memory-view]')) button.setAttribute('aria-pressed', String(button.dataset.memoryView === memoryView));
  return memoryView === 'collections' ? loadCollections() : showRecentMemories();
}

for (const button of document.querySelectorAll('[data-memory-view]')) {
  button.addEventListener('click', () => {
    beginCollectionViewerRequest();
    collectionState.generation += 1;
    memoryView = button.dataset.memoryView;
    try { localStorage.setItem('fieldwork-memory-view', memoryView); } catch { /* storage unavailable */ }
    void showMemoryView();
  });
}

// ---- collections: the agent's little databases ----------------------------------

const collectionState = {
  list: [], chosen: '', timer: null, mode: 'current', generation: 0,
  removed: [], removedNextCursor: null, removedTotal: 0, viewerGeneration: 0,
};
try { if (localStorage.getItem('fieldwork-collection-mode') === 'removed') collectionState.mode = 'removed'; } catch { /* storage unavailable */ }

function renderCollectionMode() {
  for (const button of document.querySelectorAll('[data-collection-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.collectionMode === collectionState.mode));
  }
  byId('collection-search').hidden = collectionState.mode !== 'current';
}

async function loadCollections() {
  try {
    collectionState.list = (await request('/api/collections/list', { method: 'POST', body: {} })).collections;
    if (collectionState.chosen && !collectionState.list.some(row => row.name === collectionState.chosen)) collectionState.chosen = '';
    renderCollectionMode();
    renderCollectionChips();
    if (collectionState.mode === 'removed') await loadRemovedCollections();
    else await searchCollections();
  } catch (error) {
    byId('collection-status').textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderCollectionChips() {
  const chips = byId('collection-chips');
  clear(chips);
  const agentName = state.look?.agent?.name || 'your agent';
  if (!collectionState.list.length) {
    byId('collection-status').textContent = `No collections yet. ${agentName} can make little databases here (plants, recipes, a dream log…) and search them later. They are plain markdown files in ${agentGrammar().configured ? agentGrammar().possessiveDeterminer : 'its'} notebook, under collections/.`;
    return;
  }
  byId('collection-status').textContent = '';
  const chip = (label, value, title) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (title) button.title = title;
    button.dataset.collectionValue = value;
    button.setAttribute('aria-pressed', String(collectionState.chosen === value));
    button.addEventListener('click', () => {
      beginCollectionViewerRequest();
      collectionState.generation += 1;
      collectionState.chosen = value;
      clear(byId('collection-results'));
      renderCollectionChips();
      const replacement = [...chips.querySelectorAll('button')]
        .find(candidate => candidate.dataset.collectionValue === value);
      if (document.activeElement === document.body) replacement?.focus();
      void searchCollections();
    });
    chips.append(button);
  };
  chip(collectionState.mode === 'current' ? `All · ${collectionState.list.reduce((sum, row) => sum + row.entries, 0)}` : 'All', '');
  for (const row of collectionState.list) chip(collectionState.mode === 'current' ? `${row.name} · ${row.entries}` : row.name, row.name, row.description || '');
}

async function searchCollections() {
  if (collectionState.mode === 'removed') return loadRemovedCollections();
  if (!collectionState.list.length) { clear(byId('collection-results')); return; }
  const query = byId('collection-search').value;
  const generation = ++collectionState.generation;
  try {
    const { results } = await request('/api/collections/search', { method: 'POST', body: { query, collection: collectionState.chosen || null } });
    if (generation !== collectionState.generation || collectionState.mode !== 'current') return;
    renderCollectionResults(results, query.trim());
  } catch (error) {
    if (generation !== collectionState.generation) return;
    byId('collection-status').textContent = error instanceof Error ? error.message : String(error);
  }
}

async function loadRemovedCollections({ append = false } = {}) {
  const cursor = append ? collectionState.removedNextCursor : 0;
  if (append && cursor === null) return;
  const generation = ++collectionState.generation;
  byId('collection-status').textContent = append ? 'Loading older removed entries…' : 'Loading removed entries…';
  try {
    const { removed } = await request('/api/collections/removed', {
      method: 'POST', body: { collection: collectionState.chosen || null, cursor, limit: 25 },
    });
    if (generation !== collectionState.generation || collectionState.mode !== 'removed') return;
    collectionState.removed = append ? [...collectionState.removed, ...removed.items] : removed.items;
    collectionState.removedNextCursor = removed.nextCursor;
    collectionState.removedTotal = removed.total;
    renderRemovedCollections();
  } catch (error) {
    if (generation !== collectionState.generation) return;
    byId('collection-status').textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderCollectionResults(results, query) {
  const box = byId('collection-results');
  const previouslyFocused = document.activeElement;
  clear(box);
  const note = document.createElement('p');
  note.className = 'settings-note';
  note.textContent = query ? `${results.length} match${results.length === 1 ? '' : 'es'}` : `${results.length} newest`;
  box.append(note);
  const when = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  for (const row of results) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'collection-card';
    card.setAttribute('aria-label', `Open ${row.title || row.entry} in ${row.collection}`);
    const top = document.createElement('div');
    top.className = 'collection-card-top';
    const title = document.createElement('strong');
    title.textContent = row.title || row.entry;
    const where = document.createElement('span');
    where.className = 'collection-badge';
    where.textContent = row.collection;
    top.append(title, where);
    card.append(top);
    const fields = Object.entries(row.fields || {});
    if (fields.length) {
      const list = document.createElement('div');
      list.className = 'collection-fields';
      for (const [key, value] of fields.slice(0, 6)) {
        const field = document.createElement('span');
        field.textContent = `${key}: ${value}`;
        list.append(field);
      }
      card.append(list);
    }
    if (row.snippet) {
      const snippet = document.createElement('small');
      snippet.textContent = row.snippet;
      card.append(snippet);
    }
    if (row.updated) {
      const meta = document.createElement('small');
      meta.className = 'collection-meta';
      meta.textContent = `updated ${when.format(new Date(row.updated))}`;
      card.append(meta);
    }
    card.addEventListener('click', event => { void openCollectionEntry(row.collection, row.entry, { trigger: event.currentTarget }); });
    box.append(card);
  }
  restoreCollectionListFocus(previouslyFocused);
}

function renderRemovedCollections() {
  const box = byId('collection-results');
  const previouslyFocused = document.activeElement;
  clear(box);
  const note = document.createElement('p');
  note.className = 'settings-note';
  note.textContent = collectionState.removedTotal
    ? `${collectionState.removed.length} of ${collectionState.removedTotal} removed`
    : 'No removed entries.';
  box.append(note);
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  for (const row of collectionState.removed) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'collection-card';
    card.setAttribute('aria-label', `Inspect removed ${row.title || row.entry} in ${row.collection}`);
    const top = document.createElement('div');
    top.className = 'collection-card-top';
    const title = document.createElement('strong');
    title.textContent = row.title || row.entry;
    const where = document.createElement('span');
    where.className = 'collection-badge';
    where.textContent = row.collection;
    top.append(title, where);
    const meta = document.createElement('small');
    meta.className = 'collection-meta';
    const retained = row.retainedAt ? when.format(new Date(row.retainedAt)) : 'unknown time';
    meta.textContent = `removed ${retained} · written by ${row.by || 'unknown'}`;
    card.append(top, meta);
    card.addEventListener('click', event => { void openCollectionVersion(row, { trigger: event.currentTarget }); });
    box.append(card);
  }
  if (collectionState.removedNextCursor !== null) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'secondary-button collection-load-more';
    more.textContent = 'Load older';
    more.addEventListener('click', () => {
      beginCollectionViewerRequest();
      void loadRemovedCollections({ append: true });
    });
    box.append(more);
  }
  byId('collection-status').textContent = '';
  restoreCollectionListFocus(previouslyFocused);
}

function beginCollectionViewerRequest() {
  collectionState.viewerGeneration += 1;
  return collectionState.viewerGeneration;
}

function collectionViewerRequestIsCurrent(viewerGeneration) {
  return viewerGeneration === collectionState.viewerGeneration;
}

function collectionFocusFallback() {
  const activeMode = [...document.querySelectorAll('[data-collection-mode]')]
    .find(button => button.getAttribute('aria-pressed') === 'true' && !button.closest('[hidden]'));
  return activeMode || byId('tab-memory');
}

function restoreCollectionListFocus(previouslyFocused) {
  if (previouslyFocused?.isConnected || document.activeElement !== document.body) return;
  if (previouslyFocused?.classList.contains('collection-load-more')) {
    (byId('collection-results').querySelector('.collection-load-more') || collectionFocusFallback())?.focus();
  } else if (previouslyFocused?.classList.contains('collection-card')) collectionFocusFallback()?.focus();
}

async function openCollectionEntry(collection, entry, { trigger = null, onError = showError } = {}) {
  const viewerGeneration = beginCollectionViewerRequest();
  try {
    const { history } = await request('/api/collections/history', { method: 'POST', body: { collection, entry } });
    if (!collectionViewerRequestIsCurrent(viewerGeneration)) return;
    const { version } = await request('/api/collections/version', {
      method: 'POST', body: { collection: history.collection, entry: history.entry, versionId: history.current.versionId },
    });
    if (!collectionViewerRequestIsCurrent(viewerGeneration)) return;
    renderCollectionViewer(version, { history, trigger, viewerGeneration });
  } catch (error) {
    if (collectionViewerRequestIsCurrent(viewerGeneration)) onError(error);
  }
}

async function openCollectionVersion(row, { history = null, trigger = null, onError = showError } = {}) {
  const viewerGeneration = beginCollectionViewerRequest();
  try {
    let resolvedHistory = history;
    if (!resolvedHistory && row.kind === 'removed') {
      ({ history: resolvedHistory } = await request('/api/collections/history', {
        method: 'POST', body: { collection: row.collection, entry: row.entry },
      }));
      if (!collectionViewerRequestIsCurrent(viewerGeneration)) return;
    }
    const { version } = await request('/api/collections/version', {
      method: 'POST', body: { collection: row.collection, entry: row.entry, versionId: row.versionId },
    });
    if (!collectionViewerRequestIsCurrent(viewerGeneration)) return;
    renderCollectionViewer(version, { history: resolvedHistory, trigger, viewerGeneration });
  } catch (error) {
    if (collectionViewerRequestIsCurrent(viewerGeneration)) onError(error);
  }
}

function collectionTime(value) {
  if (!value) return 'unknown time';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
    : 'unknown time';
}

function exportCollectionVersion(version) {
  const value = { format: 'fieldwork-collection-version-export/v1', exportedAt: new Date().toISOString(), version };
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `fieldwork-collection-${version.collection}-${version.entry}-${version.kind}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderCollectionViewer(version, { history = null, trigger = null, viewerGeneration = collectionState.viewerGeneration } = {}) {
  if (!collectionViewerRequestIsCurrent(viewerGeneration)) return;
  const viewer = attachmentViewer({ preserveCollectionRequest: true });
  const alreadyOpen = viewer.open;
  viewer.classList.add('text-view', 'collection-view');
  viewer.setAttribute('aria-labelledby', 'collection-view-title');
  const head = document.createElement('div');
  head.className = 'text-view-head';
  const title = document.createElement('span');
  title.id = 'collection-view-title';
  title.textContent = `${version.title || version.entry} · ${version.collection}`;
  const headActions = document.createElement('div');
  headActions.className = 'collection-entry-actions';
  if (version.kind !== 'current' && history?.current) {
    const current = document.createElement('button');
    current.type = 'button';
    current.textContent = 'Current';
    current.setAttribute('aria-label', `Inspect current ${version.title || version.entry}`);
    current.addEventListener('click', () => { void openCollectionVersion(history.current, { history, trigger: current }); });
    headActions.append(current);
  }
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.textContent = 'Export';
  exportButton.setAttribute('aria-label', `Export exact ${version.kind} version of ${version.title || version.entry}`);
  exportButton.addEventListener('click', () => exportCollectionVersion(version));
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close collection entry');
  close.textContent = '✕';
  close.addEventListener('click', () => viewer.close());
  headActions.append(exportButton, close);
  head.append(title, headActions);

  const body = document.createElement('div');
  body.className = 'entry-view';
  const meta = document.createElement('p');
  meta.className = 'collection-entry-meta';
  const retained = version.kind === 'current' ? '' : ` · retained ${collectionTime(version.retainedAt)}`;
  const restored = version.value?.restoredFrom
    ? ` · restored from ${version.value.restoredFrom.kind} ${version.value.restoredFrom.fingerprint.slice(0, 8)}`
    : '';
  meta.textContent = `written by ${version.by || 'unknown'} · updated ${collectionTime(version.updated)}${retained}${restored}`;
  body.append(meta);
  const fields = Object.entries(version.value?.fields || {});
  if (fields.length) {
    const table = document.createElement('dl');
    table.className = 'entry-fields';
    for (const [key, value] of fields) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      table.append(dt, dd);
    }
    body.append(table);
  }
  const text = document.createElement('div');
  renderRichText(text, version.value?.text || '');
  body.append(text);

  const actions = document.createElement('div');
  actions.className = 'collection-entry-actions';
  const status = document.createElement('p');
  status.className = 'collection-entry-status';
  status.setAttribute('role', 'status');
  status.tabIndex = -1;
  const canRestore = version.kind === 'history' || (version.kind === 'removed' && !history?.current);
  if (canRestore) {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'secondary-button';
    restore.textContent = 'Restore';
    restore.setAttribute('aria-label', `Restore this ${version.kind} version of ${version.title || version.entry}`);
    restore.addEventListener('click', async () => {
      const restoreGeneration = beginCollectionViewerRequest();
      restore.disabled = true;
      status.textContent = 'Restoring…';
      status.focus({ preventScroll: true });
      try {
        await request('/api/collections/restore', {
          method: 'POST',
          body: {
            collection: version.collection,
            entry: version.entry,
            versionId: version.versionId,
            expectedCurrentFingerprint: version.kind === 'history' ? history?.current?.fingerprint ?? null : null,
          },
        });
        collectionState.mode = 'current';
        try { localStorage.setItem('fieldwork-collection-mode', 'current'); } catch { /* storage unavailable */ }
        await loadCollections();
        byId('collection-status').textContent = `Restored ${version.title || version.entry}.`;
        if (!collectionViewerRequestIsCurrent(restoreGeneration) || !viewer.open) return;
        const refreshed = await request('/api/collections/history', {
          method: 'POST', body: { collection: version.collection, entry: version.entry },
        });
        if (!collectionViewerRequestIsCurrent(restoreGeneration) || !viewer.open) return;
        const exact = await request('/api/collections/version', {
          method: 'POST', body: {
            collection: version.collection, entry: version.entry, versionId: refreshed.history.current.versionId,
          },
        });
        if (!collectionViewerRequestIsCurrent(restoreGeneration) || !viewer.open) return;
        renderCollectionViewer(exact.version, {
          history: refreshed.history, trigger, viewerGeneration: restoreGeneration,
        });
      } catch (error) {
        if (!collectionViewerRequestIsCurrent(restoreGeneration) || !viewer.open) return;
        status.textContent = error instanceof Error ? error.message : String(error);
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.className = 'secondary-button';
        reload.textContent = 'Reload';
        reload.setAttribute('aria-label', `Reload current ${version.title || version.entry}`);
        reload.addEventListener('click', () => {
          reload.disabled = true;
          status.textContent = 'Reloading…';
          status.focus({ preventScroll: true });
          void openCollectionEntry(version.collection, version.entry, {
            trigger,
            onError: reloadError => {
              status.textContent = reloadError instanceof Error ? reloadError.message : String(reloadError);
              reload.disabled = false;
              reload.focus({ preventScroll: true });
            },
          });
        });
        actions.replaceChildren(reload);
        reload.focus({ preventScroll: true });
      }
    });
    actions.append(restore);
  }
  body.append(actions, status);

  const exact = document.createElement('details');
  exact.className = 'collection-exact';
  const exactSummary = document.createElement('summary');
  exactSummary.textContent = 'Exact Markdown';
  const raw = document.createElement('pre');
  raw.tabIndex = 0;
  raw.setAttribute('role', 'region');
  raw.setAttribute('aria-label', `Exact Markdown for ${version.title || version.entry}`);
  raw.textContent = version.raw;
  exact.append(exactSummary, raw);
  body.append(exact);

  if (history?.versions?.length) {
    const versions = document.createElement('details');
    versions.className = 'collection-versions';
    const summary = document.createElement('summary');
    summary.textContent = `Previous versions · ${history.versions.length}/${history.retentionLimit}`;
    versions.append(summary);
    for (const [versionIndex, row] of history.versions.entries()) {
      const item = document.createElement('div');
      item.className = 'collection-version-row';
      const about = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = collectionTime(row.updated);
      const detail = document.createElement('small');
      detail.textContent = `written by ${row.by || 'unknown'} · ${row.bytes} bytes`;
      about.append(label, detail);
      const inspect = document.createElement('button');
      inspect.type = 'button';
      inspect.className = 'secondary-button';
      inspect.textContent = 'Inspect';
      inspect.setAttribute('aria-label', `Inspect version ${versionIndex + 1} from ${collectionTime(row.updated)} · ${row.fingerprint.slice(0, 8)}`);
      inspect.addEventListener('click', () => { void openCollectionVersion(row, { history, trigger: inspect }); });
      item.append(about, inspect);
      versions.append(item);
    }
    body.append(versions);
  }

  viewer.append(head, body);
  if (alreadyOpen) {
    close.focus({ preventScroll: true });
  } else {
    viewer.collectionReturnFocus = trigger;
    viewer.addEventListener('close', () => {
      const returnFocus = viewer.collectionReturnFocus;
      delete viewer.collectionReturnFocus;
      viewer.classList.remove('text-view', 'collection-view');
      viewer.removeAttribute('aria-labelledby');
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active?.isConnected && active !== document.body && !viewer.contains(active)) return;
        const target = returnFocus?.isConnected ? returnFocus : collectionFocusFallback();
        if (target?.isConnected) target.focus();
      });
    }, { once: true });
    viewer.showModal();
  }
}

byId('collection-search').addEventListener('input', () => {
  beginCollectionViewerRequest();
  clearTimeout(collectionState.timer);
  collectionState.timer = setTimeout(() => { void searchCollections(); }, 250);
});

for (const button of document.querySelectorAll('[data-collection-mode]')) {
  button.addEventListener('click', () => {
    beginCollectionViewerRequest();
    collectionState.mode = button.dataset.collectionMode;
    collectionState.removed = [];
    collectionState.removedNextCursor = null;
    collectionState.generation += 1;
    clear(byId('collection-results'));
    try { localStorage.setItem('fieldwork-collection-mode', collectionState.mode); } catch { /* storage unavailable */ }
    renderCollectionMode();
    renderCollectionChips();
    if (collectionState.mode === 'removed') void loadRemovedCollections();
    else void searchCollections();
  });
}

// ---- the shelf -------------------------------------------------------------------

const shelfState = { items: [] };

async function loadShelf() {
  try {
    shelfState.items = (await request('/api/shelf/view', { method: 'POST', body: {} })).shelf;
    renderShelf();
  } catch (error) {
    byId('shelf-status').textContent = error instanceof Error ? error.message : String(error);
  }
}

async function shelfAction(action, body, message) {
  const status = byId('shelf-status');
  try {
    shelfState.items = (await request(`/api/shelf/${action}`, { method: 'POST', body })).shelf;
    status.textContent = message;
    renderShelf();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderShelf() {
  const grid = byId('shelf-grid');
  clear(grid);
  const showDown = byId('shelf-show-down').checked;
  const shown = shelfState.items.filter(item => showDown || !item.takenDown);
  const agentName = state.look?.agent?.name || 'Your agent';
  if (!shown.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = shelfState.items.length ? 'Everything here was taken down. Tick "Show taken down" to see it.' : `Nothing on the shelf yet. ${agentName} can put pictures and files here to keep or show, and so can you.`;
    grid.append(none);
    return;
  }
  const when = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  for (const item of shown) {
    const card = document.createElement('figure');
    card.className = `shelf-card${item.takenDown ? ' down' : ''}`;
    const face = document.createElement('button');
    face.type = 'button';
    face.className = 'shelf-face';
    face.title = `Open "${item.title}"`;
    if (item.kind === 'picture') {
      const image = document.createElement('img');
      image.alt = item.title;
      loadAttachmentImage(item.ref).then(url => { image.src = url; face.addEventListener('click', () => viewAttachment(url)); })
        .catch(() => { image.replaceWith(Object.assign(document.createElement('span'), { textContent: 'Picture missing' })); });
      face.append(image);
    } else {
      face.textContent = '📄';
      face.addEventListener('click', async () => {
        try { viewText(item.name || item.title, (await request('/api/shelf/text', { method: 'POST', body: { id: item.id } })).text); }
        catch (error) { showError(error); }
      });
    }
    const caption = document.createElement('figcaption');
    const title = document.createElement('strong');
    title.textContent = item.title;
    caption.append(title);
    if (item.note) {
      const note = document.createElement('span');
      note.className = 'shelf-note';
      renderRichText(note, item.note);
      caption.append(note);
    }
    const meta = document.createElement('small');
    meta.textContent = `${item.by === 'agent' ? agentName : 'You'} · ${when.format(new Date(item.at))}${item.takenDown ? ' · taken down' : ''}`;
    caption.append(meta);
    const buttons = document.createElement('div');
    buttons.className = 'shelf-buttons';
    const button = (text, handler) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.addEventListener('click', handler); buttons.append(node); };
    button('Edit', () => {
      const nextTitle = window.prompt('Title:', item.title);
      if (nextTitle === null) return;
      const nextNote = window.prompt('Note (optional):', item.note || '');
      if (nextNote === null) return;
      void shelfAction('edit', { id: item.id, title: nextTitle, note: nextNote }, 'Saved.');
    });
    if (item.takenDown) {
      button('Put back', () => { void shelfAction('putback', { id: item.id }, 'Put back on the shelf.'); });
      button('Delete', () => {
        if (window.confirm(`Delete "${item.title}" for good? This cannot be undone.`)) void shelfAction('remove', { id: item.id }, 'Deleted.');
      });
    } else {
      button('Take down', () => { void shelfAction('takedown', { id: item.id }, 'Taken down. It is kept; tick "Show taken down" to put it back.'); });
    }
    caption.append(buttons);
    card.append(face, caption);
    grid.append(card);
  }
}

byId('shelf-show-down').addEventListener('change', renderShelf);
byId('shelf-file').addEventListener('change', () => {
  const chosen = byId('shelf-file').files?.[0];
  byId('shelf-file').value = '';
  if (!chosen) return;
  const title = window.prompt('A title for it:', chosen.name.replace(/\.[^.]+$/, ''));
  if (title === null || !title.trim()) return;
  const reader = new FileReader();
  reader.onload = () => { void shelfAction('add', { name: chosen.name, dataUrl: String(reader.result), title }, 'Added to the shelf.'); };
  reader.readAsDataURL(chosen);
});

// ---- notes from the agent about the room ------------------------------------------

function showNotesDot(unread) {
  const button = byId('settings-button');
  button.classList.toggle('has-notes', unread > 0);
  button.title = unread > 0 ? `Settings · ${unread} new note${unread === 1 ? '' : 's'} from your agent` : 'Settings';
  const tab = byId('settings-tab-notes');
  if (tab) tab.textContent = unread > 0 ? `From your agent · ${unread}` : 'From your agent';
}

async function loadBuilderNotes() {
  try { renderBuilderNotes(await request('/api/builder/view', { method: 'POST', body: {} })); }
  catch (error) { byId('notes-status').textContent = error instanceof Error ? error.message : String(error); }
}

function renderBuilderNotes(view) {
  const agentName = state.look?.agent?.name || 'Your agent';
  showNotesDot(view.unread);
  byId('notes-intro').textContent = view.notes.length
    ? `${agentName} sends these when something in the room is broken, confusing, or missing. Mark them seen or done, and reply if you like; ${agentName} can read your replies.`
    : `Nothing yet. If something in the room is broken, confusing, or missing, ${agentName} can leave you a note here.`;
  const list = byId('builder-note-list');
  clear(list);
  const labels = { broken: '🔧 Broken', confusing: '❓ Confusing', wish: '✨ Wish' };
  const when = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (const note of view.notes) {
    const card = document.createElement('div');
    card.className = `builder-note ${note.status}`;
    const head = document.createElement('div');
    head.className = 'builder-note-head';
    const kind = document.createElement('span');
    kind.className = 'builder-note-kind';
    kind.textContent = labels[note.kind] || note.kind;
    const time = document.createElement('time');
    time.textContent = when.format(new Date(note.updatedAt || note.at));
    const status = document.createElement('span');
    status.className = 'builder-note-status';
    status.textContent = note.status;
    head.append(kind, time, status);
    const what = document.createElement('strong');
    what.textContent = note.what;
    card.append(head, what);
    if (note.detail) {
      const detail = document.createElement('div');
      detail.className = 'builder-note-detail';
      renderRichText(detail, note.detail);
      card.append(detail);
    }
    const reply = document.createElement('textarea');
    reply.rows = 2;
    reply.maxLength = 500;
    reply.placeholder = `Reply to ${agentName} (optional)`;
    reply.value = note.reply || '';
    const actions = document.createElement('div');
    actions.className = 'builder-note-actions';
    const act = (label, status) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        byId('notes-status').textContent = 'Saving…';
        try {
          renderBuilderNotes(await request('/api/builder/answer', { method: 'POST', body: { id: note.id, ...(status ? { status } : {}), reply: reply.value } }));
          byId('notes-status').textContent = 'Saved.';
        } catch (error) { byId('notes-status').textContent = error instanceof Error ? error.message : String(error); }
      });
      actions.append(button);
    };
    if (note.status === 'new') act('Mark seen', 'seen');
    if (note.status !== 'done') act('Done', 'done');
    if (note.status === 'done') act('Reopen', 'seen');
    act('Save reply', null);
    card.append(reply, actions);
    list.append(card);
  }
}

// ---- tool availability and person-set execution permission ----------------------

const toolRecoveryStates = Object.freeze({
  'prepared-not-attempted': Object.freeze({ label: 'Not entered', resolution: 'abandon-not-attempted', action: 'Close as not run', confirmation: '' }),
  'attempted-unsettled': Object.freeze({ label: 'Outcome unknown', resolution: 'acknowledge-uncertain', action: 'Acknowledge uncertainty', confirmation: 'I understand this action may already have happened.' }),
  'executor-error-uncertain': Object.freeze({ label: 'Effect uncertain', resolution: 'acknowledge-uncertain', action: 'Acknowledge uncertainty', confirmation: 'I understand this action may already have happened.' }),
  'interrupted-uncertain': Object.freeze({ label: 'Interrupted; effect uncertain', resolution: 'acknowledge-uncertain', action: 'Acknowledge uncertainty', confirmation: 'I understand this action may already have happened.' }),
  'executor-returned-uncommitted': Object.freeze({ label: 'Returned; save not confirmed', resolution: 'acknowledge-completed', action: 'Acknowledge completion', confirmation: 'I confirm this completed even though its run was not saved.' }),
});

const toolRecoveryOutcomeLabels = Object.freeze({
  'abandon-not-attempted': 'Closed as not run',
  'acknowledge-uncertain': 'Uncertainty acknowledged',
  'acknowledge-completed': 'Completion acknowledged',
});

async function loadToolRecovery() {
  if (!state.bootstrap?.capabilities?.toolRecovery || state.toolRecoveryBusy) return;
  try {
    const response = await request('/api/tools/recovery', { method: 'POST', body: {} });
    renderToolRecovery(response.toolRecovery);
  } catch (error) {
    byId('tools-status').textContent = error instanceof Error ? error.message : String(error);
  }
}

function toolRecoveryTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

async function resolveToolEffect(item, spec, confirmed) {
  if (state.toolRecoveryBusy) return;
  state.toolRecoveryBusy = true;
  renderToolRecovery(state.toolRecovery);
  byId('tools-status').textContent = 'Saving review…';
  try {
    const response = await request('/api/tools/recovery/action', {
      method: 'POST',
      body: {
        id: item.id,
        expectedRevision: item.revision,
        resolution: spec.resolution,
        confirmed,
      },
    });
    state.toolRecoveryBusy = false;
    renderToolRecovery(response.toolRecovery);
    byId('tools-status').textContent = `${item.tool}: ${toolRecoveryOutcomeLabels[spec.resolution]}.`;
  } catch (error) {
    state.toolRecoveryBusy = false;
    renderToolRecovery(state.toolRecovery);
    byId('tools-status').textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderToolRecovery(view) {
  const panel = byId('tool-effect-recovery');
  if (!panel) return;
  const wasOpen = panel.open;
  const historyPanel = byId('tool-effect-recovery-history');
  const historyWasOpen = historyPanel.open;
  const items = Array.isArray(view?.items) ? view.items : [];
  const history = Array.isArray(view?.history) ? view.history : [];
  const count = Number.isSafeInteger(view?.count) ? view.count : items.length;
  const settling = Number.isSafeInteger(view?.settling) ? view.settling : 0;
  const available = view?.available === true;
  state.toolRecovery = view || null;
  panel.hidden = !available || (count === 0 && settling === 0 && history.length === 0);
  if (panel.hidden) return;
  panel.open = wasOpen || count > 0 || settling > 0;
  byId('tool-effect-recovery-summary').textContent = count || settling ? 'Needs review' : 'Resolved tool effects';
  byId('tool-effect-recovery-count').textContent = count ? `· ${count}` : settling ? `· ${settling} settling` : `· ${history.length}`;
  const settlingCopy = byId('tool-effect-recovery-settling');
  settlingCopy.hidden = settling === 0;
  settlingCopy.textContent = settling ? `${settling} action${settling === 1 ? ' is' : 's are'} still settling.` : '';

  const list = byId('tool-effect-recovery-list');
  clear(list);
  for (const [index, item] of items.entries()) {
    const spec = toolRecoveryStates[item.state];
    const card = document.createElement('article');
    card.className = 'tool-effect-recovery-card';
    const heading = document.createElement('div');
    heading.className = 'tool-effect-recovery-heading';
    const title = document.createElement('h3');
    title.id = `tool-effect-recovery-title-${index}`;
    title.textContent = item.tool;
    const stateLabel = document.createElement('span');
    stateLabel.textContent = spec?.label || 'Review required';
    heading.append(title, stateLabel);
    card.setAttribute('aria-labelledby', title.id);
    const summary = document.createElement('p');
    summary.textContent = item.summary;
    const meta = document.createElement('small');
    meta.textContent = [permissionOriginLabel(item.origin), item.permission?.mode, toolRecoveryTime(item.reportedAt || item.attemptedAt || item.preparedAt)]
      .filter(Boolean).join(' · ');
    const inspect = document.createElement('details');
    inspect.className = 'tool-effect-recovery-inspect';
    const inspectSummary = document.createElement('summary');
    inspectSummary.textContent = 'Inspect record';
    const exact = document.createElement('dl');
    for (const [label, value] of [['Record', item.id], ['Revision', item.revision]]) {
      const wrapper = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      const code = document.createElement('code');
      code.textContent = value;
      description.append(code);
      wrapper.append(term, description);
      exact.append(wrapper);
    }
    inspect.append(inspectSummary, exact);
    card.append(heading, summary, meta, inspect);
    if (spec) {
      const actions = document.createElement('div');
      actions.className = 'tool-effect-recovery-actions';
      let confirmation = null;
      if (spec.confirmation) {
        const label = document.createElement('label');
        label.className = 'tool-effect-recovery-confirmation';
        confirmation = document.createElement('input');
        confirmation.type = 'checkbox';
        const copy = document.createElement('span');
        copy.textContent = spec.confirmation;
        label.append(confirmation, copy);
        actions.append(label);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary-button';
      button.textContent = spec.action;
      button.disabled = state.toolRecoveryBusy || !item.recoverable || Boolean(confirmation);
      confirmation?.addEventListener('change', () => {
        button.disabled = state.toolRecoveryBusy || !item.recoverable || !confirmation.checked;
      });
      button.addEventListener('click', () => void resolveToolEffect(item, spec, confirmation?.checked === true));
      actions.append(button);
      card.append(actions);
    }
    list.append(card);
  }
  if (view?.hasMore) {
    const range = document.createElement('p');
    range.className = 'tool-effect-recovery-range';
    range.textContent = `Showing ${items.length} of ${count}.`;
    list.append(range);
  }

  const historyList = byId('tool-effect-recovery-history-list');
  clear(historyList);
  historyPanel.hidden = history.length === 0;
  historyPanel.open = !historyPanel.hidden && historyWasOpen;
  byId('tool-effect-recovery-history-summary').textContent = `Resolved · ${history.length}`;
  for (const row of history) {
    const entry = document.createElement('div');
    entry.className = 'tool-effect-recovery-history-row';
    const title = document.createElement('strong');
    title.textContent = row.tool;
    const outcome = document.createElement('span');
    outcome.textContent = toolRecoveryOutcomeLabels[row.outcome] || row.outcome;
    const copy = document.createElement('p');
    copy.textContent = row.summary;
    const when = document.createElement('time');
    when.dateTime = row.finishedAt;
    when.textContent = toolRecoveryTime(row.finishedAt);
    entry.append(title, outcome, copy, when);
    historyList.append(entry);
  }
}

async function loadToolGroups() {
  try { renderToolGroups(await request('/api/tools/view', { method: 'POST', body: {} })); }
  catch (error) { byId('tools-status').textContent = error instanceof Error ? error.message : String(error); }
}

function captureToolRenderState() {
  return {
    groups: new Set([...document.querySelectorAll('#tool-group-list .tool-group-tools[open]')]
      .map(details => details.dataset.groupId)
      .filter(Boolean)),
    historyOpen: Boolean(byId('tool-permission-history')?.open),
  };
}

function permissionOriginLabel(origin) {
  return ({
    'local-chat': 'Local chat',
    bridge: 'Bridge',
    'check-in': 'Check-in',
    fieldwork: 'Fieldwork',
    'task-heartbeat': 'Task heartbeat',
    'outside-reader': 'Outside reader',
  })[origin] || origin;
}

function toolPermissionResponse(currentView, response) {
  if (Array.isArray(response?.groups)) return response;
  return { ...currentView, permissions: response?.permissions ?? response };
}

function renderToolPermissionPanels(permissions, historyOpen, currentView) {
  const pendingSection = byId('tool-permission-pending');
  const pendingList = byId('tool-permission-pending-list');
  const pending = Array.isArray(permissions?.pending) ? permissions.pending : [];
  clear(pendingList);
  pendingSection.hidden = pending.length === 0;
  byId('tool-permission-pending-count').textContent = pending.length
    ? `${pending.length} request${pending.length === 1 ? '' : 's'}`
    : '';
  for (const row of pending) {
    const card = document.createElement('article');
    card.className = 'tool-permission-request';
    const title = document.createElement('strong');
    title.id = `tool-permission-request-${row.id}`;
    title.textContent = row.tool;
    card.setAttribute('aria-labelledby', title.id);
    const summary = document.createElement('p');
    summary.textContent = row.summary;
    const meta = document.createElement('small');
    const when = new Date(row.createdAt);
    meta.textContent = `${permissionOriginLabel(row.origin)} · ${Number.isFinite(when.getTime()) ? when.toLocaleString() : row.createdAt}`;
    const exact = document.createElement('details');
    const exactSummary = document.createElement('summary');
    exactSummary.textContent = 'Exact request';
    const exactValue = document.createElement('code');
    exactValue.textContent = `call ${row.argumentsFingerprint} · request ${row.fingerprint}`;
    exact.append(exactSummary, exactValue);
    const actions = document.createElement('div');
    actions.className = 'tool-permission-actions';
    for (const [decision, label] of [
      ['once', 'Allow next exact retry once'],
      ['always', 'Always'],
      ['never', 'Never'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        for (const sibling of actions.querySelectorAll('button')) sibling.disabled = true;
        byId('tools-status').textContent = 'Saving decision…';
        try {
          const response = await request('/api/tools/decision', {
            method: 'POST',
            body: { requestId: row.id, expectedFingerprint: row.fingerprint, decision },
          });
          renderToolGroups(toolPermissionResponse(currentView, response));
          byId('tools-status').textContent = decision === 'once'
            ? `${row.tool} may run on its next exact retry once. Nothing resumed automatically.`
            : `${row.tool} saved as ${decision === 'always' ? 'Always' : 'Never'}. Nothing resumed automatically.`;
        } catch (error) {
          for (const sibling of actions.querySelectorAll('button')) sibling.disabled = false;
          byId('tools-status').textContent = error instanceof Error ? error.message : String(error);
        }
      });
      actions.append(button);
    }
    card.append(title, summary, meta, exact, actions);
    pendingList.append(card);
  }

  const history = byId('tool-permission-history');
  const historyList = byId('tool-permission-history-list');
  const grantsList = byId('tool-permission-grants');
  clear(historyList);
  clear(grantsList);
  const grants = Array.isArray(permissions?.grants) ? permissions.grants : [];
  const rows = Array.isArray(permissions?.history) ? permissions.history : [];
  history.hidden = grants.length === 0 && rows.length === 0;
  history.open = !history.hidden && historyOpen;
  byId('tool-permission-history-summary').textContent = `Permission history (${rows.length})`;
  if (grants.length) {
    const heading = document.createElement('h4');
    heading.textContent = 'Approved once';
    grantsList.append(heading);
    for (const grant of grants) {
      const item = document.createElement('div');
      item.className = 'tool-permission-grant';
      const title = document.createElement('strong');
      title.textContent = grant.tool;
      const copy = document.createElement('span');
      const expires = new Date(grant.expiresAt);
      copy.textContent = `${grant.summary} · exact call ${grant.argumentsFingerprint} · expires ${Number.isFinite(expires.getTime()) ? expires.toLocaleString() : grant.expiresAt}`;
      item.append(title, copy);
      grantsList.append(item);
    }
  }
  const actionLabels = {
    'policy-set': 'Policy set',
    'policy-cleared': 'Policy reset to default',
    'policy-retired': 'Policy retired',
    'request-created': 'Asked',
    'request-decided': 'Decided',
    'request-cancelled': 'Request cancelled',
    'grant-cancelled': 'One-time approval cancelled',
    'grant-consumed': 'One-time approval used',
    'grant-expired': 'One-time approval expired',
  };
  const shown = rows.slice(-30).reverse();
  if (rows.length > shown.length) {
    const range = document.createElement('p');
    range.className = 'tool-permission-range';
    range.textContent = `Showing the latest ${shown.length} of ${rows.length}.`;
    historyList.append(range);
  }
  for (const row of shown) {
    const item = document.createElement('div');
    item.className = 'tool-permission-history-row';
    const what = document.createElement('span');
    what.textContent = `${row.tool} · ${actionLabels[row.action] || row.action}${row.value ? ` · ${row.value}` : ''}`;
    const when = document.createElement('time');
    const date = new Date(row.at);
    when.dateTime = row.at;
    when.textContent = Number.isFinite(date.getTime()) ? date.toLocaleString() : row.at;
    const source = document.createElement('small');
    source.textContent = [row.actor, row.origin ? permissionOriginLabel(row.origin) : '', row.requestId ? `request ${shortHash(row.requestId)}` : '']
      .filter(Boolean).join(' · ');
    item.append(what, when, source);
    historyList.append(item);
  }
}

function renderToolGroups(view) {
  const preserved = captureToolRenderState();
  const permissions = view.permissions || null;
  const policyByTool = new Map((permissions?.policies || []).map(policy => [policy.tool, policy]));
  byId('tools-summary').textContent = `${view.resident} resident tool${view.resident === 1 ? '' : 's'} · ${view.onDemand} group${view.onDemand === 1 ? '' : 's'} on demand · ${view.off} off · ~${view.tokens.toLocaleString()} initial schema tokens. Availability controls loading; permission controls execution.${view.initial > view.many ? ' The initial tool list is large.' : ''}`;
  byId('tools-summary').classList.toggle('warning', view.initial > view.many);
  renderToolPermissionPanels(permissions, preserved.historyOpen, view);
  const list = byId('tool-group-list');
  clear(list);
  const canSetAvailability = Boolean(state.bootstrap?.capabilities?.toolGroups);
  for (const group of view.groups) {
    const row = document.createElement('div');
    row.className = 'tool-group-row';
    row.dataset.mode = group.mode;
    const text = document.createElement('div');
    text.className = 'tool-group-copy';
    text.id = `tool-group-copy-${group.id}`;
    const title = document.createElement('strong');
    title.id = `tool-group-title-${group.id}`;
    title.textContent = group.label;
    const summary = document.createElement('small');
    summary.textContent = group.summary;
    text.append(title, summary);
    const modeLabel = document.createElement('label');
    modeLabel.className = 'tool-group-mode';
    const modeText = document.createElement('span');
    modeText.id = `tool-group-mode-label-${group.id}`;
    modeText.textContent = 'Availability';
    const select = document.createElement('select');
    select.id = `tool-group-mode-${group.id}`;
    select.setAttribute('aria-labelledby', `${title.id} ${modeText.id}`);
    select.setAttribute('aria-describedby', `tool-group-cost-${group.id}`);
    for (const [value, label] of [['resident', 'Resident'], ['on-demand', 'On demand'], ['off', 'Off']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = group.mode;
    select.disabled = !canSetAvailability;
    modeLabel.htmlFor = select.id;
    modeLabel.append(modeText, select);
    const names = document.createElement('details');
    names.className = 'tool-group-tools';
    names.dataset.groupId = group.id;
    names.open = preserved.groups.has(group.id);
    const namesSummary = document.createElement('summary');
    namesSummary.textContent = `${group.tools.length} tool${group.tools.length === 1 ? '' : 's'}`;
    names.setAttribute('aria-label', `${group.label}: ${namesSummary.textContent}`);
    const permissionList = document.createElement('div');
    permissionList.className = 'tool-permission-list';
    for (const name of group.tools) {
      const permissionRow = document.createElement('div');
      permissionRow.className = 'tool-permission-row';
      const nameLabel = document.createElement('code');
      nameLabel.id = `tool-permission-name-${name}`;
      nameLabel.textContent = name;
      permissionRow.append(nameLabel);
      const policy = policyByTool.get(name);
      if (policy) {
        const permissionLabel = document.createElement('label');
        permissionLabel.className = 'tool-permission-mode';
        const permissionText = document.createElement('span');
        permissionText.id = `tool-permission-label-${name}`;
        permissionText.textContent = 'Permission';
        const permissionSelect = document.createElement('select');
        permissionSelect.id = `tool-permission-${name}`;
        permissionSelect.setAttribute('aria-labelledby', `${nameLabel.id} ${permissionText.id}`);
        for (const [value, label] of [['always', 'Always'], ['ask', 'Ask'], ['never', 'Never']]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          permissionSelect.append(option);
        }
        permissionSelect.value = policy.mode;
        permissionLabel.htmlFor = permissionSelect.id;
        permissionLabel.append(permissionText, permissionSelect);
        permissionSelect.addEventListener('change', async () => {
          const before = policy.mode;
          const chosenMode = permissionSelect.value;
          const chosenLabel = permissionSelect.selectedOptions[0].textContent;
          permissionSelect.disabled = true;
          byId('tools-status').textContent = 'Saving permission…';
          try {
            const response = await request('/api/tools/permission', {
              method: 'POST',
              body: { tool: name, mode: chosenMode, expectedRevision: permissions.revision },
            });
            renderToolGroups(toolPermissionResponse(view, response));
            byId('tools-status').textContent = `${name} saved as ${chosenLabel}.`;
          } catch (error) {
            permissionSelect.value = before;
            permissionSelect.disabled = false;
            byId('tools-status').textContent = error instanceof Error ? error.message : String(error);
          }
        });
        permissionRow.append(permissionLabel);
      }
      permissionList.append(permissionRow);
    }
    names.append(namesSummary, permissionList);
    const cost = document.createElement('span');
    cost.className = 'tool-group-cost';
    cost.id = `tool-group-cost-${group.id}`;
    cost.textContent = group.mode === 'resident'
      ? `${group.tools.length} tool${group.tools.length === 1 ? '' : 's'} · ~${group.tokens.toLocaleString()} tokens/request`
      : group.mode === 'on-demand'
        ? `${group.tools.length} tool${group.tools.length === 1 ? '' : 's'} · ~${group.tokens.toLocaleString()} tokens while loaded`
        : `${group.tools.length} tool${group.tools.length === 1 ? '' : 's'} · unavailable`;
    row.append(text, modeLabel, names, cost);
    select.addEventListener('change', async () => {
      if (!canSetAvailability) return;
      const before = group.mode;
      const chosenMode = select.value;
      const chosenLabel = select.selectedOptions[0].textContent;
      select.disabled = true;
      byId('tools-status').textContent = 'Saving…';
      try {
        renderToolGroups(await request('/api/tools/set', { method: 'POST', body: { group: group.id, mode: chosenMode } }));
        byId('tools-status').textContent = `${group.label} saved as ${chosenLabel}.`;
        await refreshHealthTools();
      } catch (error) {
        select.value = before;
        select.disabled = false;
        byId('tools-status').textContent = error instanceof Error ? error.message : String(error);
      }
    });
    list.append(row);
  }
}

// Health's tool list follows the switches without a full reload.
async function refreshHealthTools() {
  try {
    const bootstrap = await request('/api/bootstrap');
    const tools = bootstrap.health?.tools || [];
    state.tools = tools;
    if (state.bootstrap?.health) state.bootstrap.health.tools = tools;
    heartbeats.tools = tools.filter(tool => tool.available !== false && tool.name !== 'report_task_heartbeat');
    renderToolList();
    renderToolStatus(tools);
    renderHeartbeatTools();
  } catch { /* the next reload catches up */ }
}

// ---- changes: who changed what, and undo ----------------------------------------

const changes = { view: null, by: '', detail: null, detailTrigger: null, query: '', area: '' };

const changeAreaLabels = {
  appearance: 'Appearance', checkins: 'Check-ins', emoji: 'Emoji', guides: 'Guides', look: 'Names, icons & pronouns',
  conversations: 'Conversations', model: 'Model', moods: 'Moods', rest: 'Agent rest', roots: 'Roots', shelf: 'Shelf', thinking: 'Thinking lines', tools: 'Tool availability',
  'tool-permissions': 'Tool permissions',
};
const changeAreaLabel = area => typeof area === 'string' && Object.hasOwn(changeAreaLabels, area) ? changeAreaLabels[area] : area;

function changeMatches(item) {
  if (changes.area && item.area !== changes.area) return false;
  const query = changes.query.trim().toLocaleLowerCase();
  if (!query) return true;
  return [item.key, item.area, item.label, item.text, item.beforeText, item.afterText, item.owner, item.by]
    .filter(value => value !== undefined && value !== null)
    .some(value => String(value).toLocaleLowerCase().includes(query));
}

function renderChangeAreas(view) {
  const select = byId('changes-area');
  const selected = changes.area;
  const areas = [...new Set([...view.now, ...view.entries].map(item => item.area))].sort((left, right) => (
    changeAreaLabel(left).localeCompare(changeAreaLabel(right))
  ));
  clear(select);
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All kinds';
  select.append(all);
  for (const area of areas) {
    const option = document.createElement('option');
    option.value = area;
    option.textContent = changeAreaLabel(area);
    select.append(option);
  }
  select.value = areas.includes(selected) ? selected : '';
  changes.area = select.value;
}

async function loadChanges() {
  try {
    changes.view = await request('/api/changes/view', { method: 'POST', body: {} });
    renderChanges();
  } catch (error) {
    byId('changes-status').textContent = error instanceof Error ? error.message : String(error);
  }
}

function whoLabel(by) {
  const agentName = state.look?.agent?.name || 'Your agent';
  return by === 'agent' ? agentName : by === 'person' ? 'You' : '';
}

function ownerLabel(owner) {
  if (owner === 'agent') return `${whoLabel(owner)}'s`;
  if (owner === 'person') return 'Yours';
  if (owner === 'host') return 'Host';
  if (owner === 'system') return 'System';
  return '';
}

function exactChangeText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, null, 2);
}

function changeTargetAvailable(opens) {
  return opens === 'roots'
    ? Boolean(state.bootstrap?.capabilities?.editRoots)
    : settingsAvailability.get(opens) === true;
}

function openChangeTarget(opens, key) {
  const status = byId('changes-status');
  if (!changeTargetAvailable(opens)) {
    status.textContent = 'That setting is not available in this room.';
    status.focus({ preventScroll: true });
    return;
  }
  if (opens === 'roots') {
    if (typeof key !== 'string' || !key.startsWith('root:') || !key.slice('root:'.length)) {
      status.textContent = 'That retained root does not name an editable file.';
      status.focus({ preventScroll: true });
      return;
    }
    elements.settingsDialog.close();
    void openRootEditor(key.slice('root:'.length));
    return;
  }
  if (elements.settingsSearch.value) {
    elements.settingsSearch.value = '';
    applySettingsSearch();
  }
  selectSettingsPage(opens, true);
}

function renderChangeDetail() {
  const detail = changes.detail;
  const panel = byId('changes-detail');
  const open = byId('changes-detail-open');
  panel.hidden = !detail;
  open.hidden = true;
  if (!detail) return;
  if (detail.opens && changeTargetAvailable(detail.opens)) {
    open.hidden = false;
    open.textContent = detail.opens === 'roots' ? 'Open root file' : 'Open setting';
    open.setAttribute('aria-label', detail.opens === 'roots' ? `Open root file for ${detail.label}` : `Open settings for ${detail.label}`);
  }
  byId('changes-detail-title').textContent = detail.label;
  const currentOwner = ownerLabel(detail.current?.owner) || 'no owner recorded';
  const retained = `${detail.historyCount} retained change${detail.historyCount === 1 ? '' : 's'}`;
  byId('changes-detail-meta').textContent = detail.current ? `${currentOwner} now · ${retained} · key: ${detail.key}` : `Currently removed · ${retained} · key: ${detail.key}`;
  byId('changes-detail-current').textContent = detail.current ? exactChangeText(detail.current.value) : 'removed';
  const history = byId('changes-detail-history');
  clear(history);
  if (!detail.history.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = 'No retained changes for this value yet.';
    history.append(none);
    return;
  }
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  for (const entry of detail.history) {
    const row = document.createElement('details');
    row.className = `changes-detail-entry ${entry.by}`;
    const summary = document.createElement('summary');
    summary.textContent = `${when.format(new Date(entry.at))} · ${whoLabel(entry.by)}${entry.undoOf ? ' · undo' : ''}: ${entry.beforeText} → ${entry.afterText}`;
    const values = document.createElement('div');
    values.className = 'changes-exact-pair';
    for (const [labelText, value] of [['Before', entry.before], ['After', entry.after]]) {
      const block = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = labelText;
      const exact = document.createElement('pre');
      exact.className = 'changes-exact';
      exact.tabIndex = 0;
      exact.setAttribute('role', 'region');
      exact.setAttribute('aria-label', `${labelText} exact value`);
      exact.textContent = exactChangeText(value);
      block.append(label, exact);
      values.append(block);
    }
    row.append(summary, values);
    history.append(row);
  }
  if (detail.nextCursor !== undefined) {
    const older = document.createElement('button');
    older.type = 'button';
    older.className = 'secondary-button changes-load-older';
    older.textContent = `Load older exact history (${detail.historyCount - detail.nextCursor} remaining)`;
    older.addEventListener('click', () => { void inspectChange(detail.key, detail.nextCursor); });
    history.append(older);
  }
}

async function inspectChange(key, cursor = 0, trigger = null) {
  const status = byId('changes-status');
  status.textContent = cursor ? 'Reading older exact history…' : 'Reading the exact value and its history…';
  try {
    const page = await request('/api/changes/detail', { method: 'POST', body: { key, cursor } });
    changes.detail = cursor && changes.detail?.key === key
      ? { ...page, history: [...changes.detail.history, ...page.history] }
      : page;
    if (!cursor) changes.detailTrigger = trigger;
    renderChangeDetail();
    status.textContent = cursor ? 'Older exact history loaded.' : 'Exact value loaded.';
    byId('changes-detail').scrollIntoView({ block: 'nearest' });
    if (!cursor) byId('changes-detail-close').focus({ preventScroll: true });
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderChanges() {
  const view = changes.view;
  if (!view) return;
  renderChangeAreas(view);
  const agentName = state.look?.agent?.name || 'Your agent';
  byId('changes-filter-agent').textContent = agentName;
  const now = byId('changes-now');
  clear(now);
  const current = view.now.filter(changeMatches);
  if (!current.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = view.now.length ? 'No current state matches those filters.' : 'No inspectable room state is connected.';
    now.append(none);
  }
  for (const item of current) {
    const row = document.createElement('div');
    row.className = 'changes-now-row';
    const label = document.createElement('span');
    label.textContent = item.label;
    const value = document.createElement('span');
    value.className = 'changes-value';
    value.textContent = item.text;
    const owner = document.createElement('span');
    owner.className = `changes-owner ${item.owner || 'none'}`;
    owner.textContent = ownerLabel(item.owner);
    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.className = 'changes-action changes-inspect';
    inspect.textContent = 'Inspect';
    inspect.setAttribute('aria-label', `Inspect ${item.label}`);
    inspect.addEventListener('click', () => { void inspectChange(item.key, 0, inspect); });
    row.append(label, value, owner, inspect);
    now.append(row);
  }
  const list = byId('changes-list');
  clear(list);
  const shown = view.entries.filter(entry => (!changes.by || entry.by === changes.by) && changeMatches(entry));
  if (!shown.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = view.entries.length ? 'No retained history matches those filters.' : 'Nothing has changed since the log began.';
    list.append(none);
  }
  const when = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (const entry of shown) {
    const row = document.createElement('div');
    row.className = `changes-row ${entry.by}`;
    const meta = document.createElement('div');
    meta.className = 'changes-meta';
    const time = document.createElement('time');
    time.textContent = when.format(new Date(entry.at));
    const who = document.createElement('strong');
    who.textContent = whoLabel(entry.by);
    const what = document.createElement('span');
    what.textContent = entry.undoOf ? `undid a change to ${entry.label}` : entry.label;
    meta.append(time, who, what);
    const diff = document.createElement('div');
    diff.className = 'changes-diff';
    const before = document.createElement('del');
    before.textContent = entry.beforeText;
    const arrow = document.createElement('span');
    arrow.textContent = '→';
    arrow.setAttribute('aria-hidden', 'true');
    const after = document.createElement('ins');
    after.textContent = entry.afterText;
    diff.append(before, arrow, after);
    const actions = document.createElement('div');
    actions.className = 'changes-row-actions';
    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.className = 'changes-action';
    inspect.textContent = 'Inspect';
    inspect.setAttribute('aria-label', `Inspect ${entry.label}`);
    inspect.addEventListener('click', () => { void inspectChange(entry.key, 0, inspect); });
    actions.append(inspect);
    if (entry.undoable || (entry.opens && changeTargetAvailable(entry.opens))) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'changes-action';
      if (entry.undoable) {
        action.textContent = 'Undo';
        action.setAttribute('aria-label', `Undo change to ${entry.label}`);
        action.addEventListener('click', () => { void undoChange(entry.id); });
      } else {
        action.textContent = 'Open';
        action.title = 'This has its own history page';
        action.setAttribute('aria-label', `Open ${entry.label} settings`);
        action.addEventListener('click', () => openChangeTarget(entry.opens, entry.key));
      }
      actions.append(action);
    }
    row.append(meta, diff, actions);
    list.append(row);
  }
}

async function undoChange(id) {
  const status = byId('changes-status');
  const retained = changes.view?.entries?.find(entry => entry.id === id);
  const lifecycleUndo = retained?.area === 'conversations' && retained.key.endsWith(':status');
  const proactiveUndo = retained?.area === 'conversations' && retained.key.endsWith(':proactive');
  const conversationUndo = lifecycleUndo || proactiveUndo;
  if (conversationUndo && state.conversationLifecycleBusy) return;
  const selectionGeneration = lifecycleUndo ? ++state.conversationSelectionGeneration : state.conversationSelectionGeneration;
  if (conversationUndo) {
    state.conversationLifecycleBusy = true;
    renderConversationHeading();
    renderConversations();
  }
  status.textContent = 'Putting it back…';
  try {
    const response = await request('/api/changes/undo', { method: 'POST', body: { id } });
    changes.view = response;
    if (response.model) applyModelResponse(response);
    if (response.look) { state.look = response.look; renderLook(Boolean(state.bootstrap?.capabilities?.editLook)); }
    if (response.expression) { state.expression = response.expression; renderExpression(); }
    if (response.checkIns) { checkIns.view = response.checkIns; renderCheckIns(); }
    if (response.conversationTitle) {
      mergeConversationTitle({ conversations: [response.conversationTitle] }, response.conversationTitle.id);
    }
    if (response.conversationStatus) {
      if (selectionGeneration === state.conversationSelectionGeneration) applyConversation(response);
      else {
        mergeConversationRows(response.conversations);
        renderConversationHeading();
        renderConversations();
      }
    }
    if (response.conversationProactive) {
      mergeConversationRows(response.conversations);
      renderConversationHeading();
      renderConversations();
      renderCheckIns();
    }
    if (response.shelf) { shelfState.items = response.shelf; renderShelf(); }
    if (response.appearance) {
      state.bootstrap.appearance = response.appearance;
      renderAppearance(response.appearance);
    }
    changes.detail = null;
    changes.detailTrigger = null;
    renderChangeDetail();
    renderMessages(state.bootstrap.conversation?.messages || [], state.bootstrap.conversation?.omittedMessages || 0);
    renderChanges();
    status.textContent = 'Put back.';
    status.focus({ preventScroll: true });
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (conversationUndo) {
      state.conversationLifecycleBusy = false;
      renderConversationHeading();
      renderConversations();
    }
  }
}

for (const button of document.querySelectorAll('[data-changes-by]')) {
  button.addEventListener('click', () => {
    changes.by = button.dataset.changesBy;
    for (const other of document.querySelectorAll('[data-changes-by]')) other.setAttribute('aria-pressed', String(other === button));
    renderChanges();
  });
}

byId('changes-query').addEventListener('input', event => {
  changes.query = event.currentTarget.value;
  renderChanges();
});

byId('changes-area').addEventListener('change', event => {
  changes.area = event.currentTarget.value;
  renderChanges();
});

byId('changes-open-memory').addEventListener('click', () => {
  elements.settingsDialog.close();
  memoryView = 'memories';
  const history = elements.memoryForm.querySelector('input[name="mode"][value="history"]');
  if (history) history.checked = true;
  selectTab(byId('tab-memory'), true);
});

byId('changes-open-collections').addEventListener('click', () => {
  elements.settingsDialog.close();
  memoryView = 'collections';
  collectionState.mode = 'current';
  try {
    localStorage.setItem('fieldwork-memory-view', 'collections');
    localStorage.setItem('fieldwork-collection-mode', 'current');
  } catch { /* storage unavailable */ }
  selectTab(byId('tab-memory'), true);
});

byId('changes-detail-close').addEventListener('click', () => {
  const trigger = changes.detailTrigger;
  changes.detail = null;
  changes.detailTrigger = null;
  renderChangeDetail();
  if (trigger?.isConnected) trigger.focus();
});

byId('changes-detail-open').addEventListener('click', () => {
  if (changes.detail?.opens) openChangeTarget(changes.detail.opens, changes.detail.key);
});

// Export: exact retained values, fetched only when the person asks for them.
byId('changes-export').addEventListener('click', async () => {
  const status = byId('changes-status');
  status.textContent = 'Preparing the exact change log…';
  try {
    const value = await request('/api/changes/export', { method: 'POST', body: {} });
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `fieldwork-state-history-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    status.textContent = 'Exact change log exported.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});

// ---- check-ins -----------------------------------------------------------------

const checkIns = { view: null, seen: null, unread: new Set(), timer: null, baseTitle: document.title };

function renderConversationPolicyNotice() {
  const policyLine = byId('checkin-conversation-policy');
  const enabled = checkIns.view?.settings?.enabled === true;
  const activeConversations = state.conversations.filter(row => !row.archived);
  const allSuppressed = activeConversations.length > 0
    && activeConversations.every(row => row.proactiveMode === 'suppress');
  policyLine.hidden = !enabled || !allSuppressed;
  policyLine.textContent = enabled && allSuppressed
    ? 'All active conversations have automatic check-ins off. Scheduled check-ins are waiting.'
    : '';
}

function updateUnreadTitle() {
  document.title = checkIns.unread.size ? `(${checkIns.unread.size}) ${checkIns.baseTitle}` : checkIns.baseTitle;
}

// The agent's own rest: shown, never managed from here.
function renderRest() {
  const view = checkIns.view;
  const chip = byId('rest-chip');
  const agentName = state.look?.agent?.name || 'Your agent';
  const resting = view?.resting;
  chip.hidden = !resting;
  if (resting) {
    const until = resting.until ? new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(resting.until)) : null;
    chip.textContent = until ? `🌙 resting until ${until}` : '🌙 resting';
    chip.title = `${agentName} chose this time to rest. The room won't wake ${agentGrammar().configured ? agentGrammar().object : 'it'} for check-ins or task heartbeats; you can still write.`;
  }
  const line = byId('checkin-own-rest');
  if (!line || !view) return;
  const own = view.own || {};
  const parts = [];
  if (own.quiet) parts.push(`quiet every day ${own.quiet.from}–${own.quiet.to}`);
  if (own.breakUntil) parts.push(`a break until ${new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(own.breakUntil))}`);
  line.hidden = !parts.length;
  line.textContent = parts.length ? `${agentName}'s own rest: ${parts.join(', ')}. ${agentName} set this; check-ins and task heartbeats wait for it, and nothing is recorded about that time.` : '';
}

function renderCheckInDestinationNote(destination = byId('checkin-destination').value) {
  const note = byId('checkin-destination-note');
  const bridge = destination === 'room' ? null : state.bootstrap?.bridges?.[destination];
  note.hidden = destination === 'room';
  note.textContent = destination === 'room'
    ? ''
    : bridge?.configured && bridge?.binding === 'saved' && bridge?.state === 'connected'
      ? `Uses this agent's saved ${destination === 'telegram' ? 'Telegram' : 'Discord'} conversation.`
      : `${destination === 'telegram' ? 'Telegram' : 'Discord'} needs a connected bridge with a saved conversation first.`;
}

function renderCheckIns() {
  const view = checkIns.view;
  renderRest();
  renderConversationPolicyNotice();
  if (!view) return;
  const claimLine = byId('checkin-claim');
  const claim = view.claim;
  claimLine.hidden = !claim;
  claimLine.textContent = claim
    ? `${claim.kind === 'postcard' ? 'Postcard' : 'Check-in'} claimed · ${claim.runKind} · ${new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(claim.claimedAt))}–${new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(claim.expiresAt))}`
    : '';
  const agentName = state.look?.agent?.name || 'your agent';
  const settings = view.settings;
  byId('checkin-enabled').checked = settings.enabled;
  byId('checkin-enabled-label').textContent = `Let ${agentName} check in`;
  byId('checkin-every').value = String(settings.everyHours);
  byId('checkin-destination').value = settings.destination || 'room';
  renderCheckInDestinationNote(settings.destination || 'room');
  byId('checkin-quiet').checked = settings.quiet.enabled;
  byId('checkin-quiet-from').value = settings.quiet.from;
  byId('checkin-quiet-to').value = settings.quiet.to;
  byId('checkin-postcard').checked = settings.postcard.enabled;
  byId('checkin-postcard-at').value = settings.postcard.at;
  byId('checkin-fieldworks').checked = settings.fieldworks;
  const list = byId('checkin-history');
  clear(list);
  if (!view.history.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = 'No check-ins yet.';
    list.append(none);
  }
  const outcomes = {
    sent: 'wrote to you',
    quiet: 'had nothing to say',
    failed: "couldn't finish",
    'claim-expired': 'expired; not retried',
  };
  for (const row of view.history.slice(0, 12)) {
    const item = document.createElement('div');
    item.className = `checkin-row ${row.outcome}`;
    const when = document.createElement('time');
    when.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(row.at));
    const what = document.createElement('span');
    const kind = row.kind === 'postcard' ? '📮 Postcard' : row.kind === 'free-time' ? '🕰 Free time' : '📬 Check-in';
    what.textContent = `${kind}: ${outcomes[row.outcome] ?? row.outcome}${row.note ? ` · ${row.note}` : ''}`;
    item.append(when, what);
    if (row.outcome === 'sent' && row.conversationId) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open';
      open.addEventListener('click', () => { byId('settings-dialog').close(); void openConversation(row.conversationId); });
      item.append(open);
    }
    list.append(item);
  }
}

// An open page looks every 45 seconds for a check-in that left a message.
function startCheckInWatch(on) {
  clearInterval(checkIns.timer);
  checkIns.timer = null;
  if (!on) return;
  checkIns.timer = setInterval(async () => {
    if (state.busy || state.conversationLifecycleBusy) return;
    try {
      const response = await request('/api/checkins/view', { method: 'POST', body: {} });
      checkIns.view = response.checkIns;
      renderConversationPolicyNotice();
      renderRest();
      const latest = response.checkIns.latest;
      if (latest?.at && latest.at !== checkIns.seen) {
        checkIns.seen = latest.at;
        await showCheckIn(latest.conversationId);
      }
    } catch { /* The next look tries again. */ }
  }, 45_000);
}

async function showCheckIn(conversationId) {
  if (conversationId === state.conversationId) {
    applyConversation(await request('/api/conversations/open', { method: 'POST', body: { id: conversationId } }));
    if (document.hidden) checkIns.unread.add(conversationId);
  } else {
    checkIns.unread.add(conversationId);
    const response = await request('/api/conversations/open', { method: 'POST', body: { id: state.conversationId } });
    mergeConversationRows(response.conversations);
    renderConversations();
  }
  updateUnreadTitle();
  renderCheckIns();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && checkIns.unread.has(state.conversationId)) { checkIns.unread.delete(state.conversationId); updateUnreadTitle(); renderConversations(); }
});

byId('checkin-destination').addEventListener('change', event => {
  renderCheckInDestinationNote(event.currentTarget.value);
});

byId('checkin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const status = byId('checkin-status');
  status.textContent = 'Saving…';
  try {
    const response = await request('/api/checkins/update', { method: 'POST', body: { settings: {
      enabled: byId('checkin-enabled').checked,
      everyHours: Number(byId('checkin-every').value),
      destination: byId('checkin-destination').value,
      quiet: { enabled: byId('checkin-quiet').checked, from: byId('checkin-quiet-from').value, to: byId('checkin-quiet-to').value },
      postcard: { enabled: byId('checkin-postcard').checked, at: byId('checkin-postcard-at').value },
      fieldworks: byId('checkin-fieldworks').checked,
    } } });
    checkIns.view = response.checkIns;
    renderCheckIns();
    status.textContent = response.checkIns.settings.enabled ? 'Saved. The first check-in comes after one full wait.' : 'Saved. Check-ins are off.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});

async function checkInNow(kind, anyway = false) {
  const status = byId('checkin-status');
  if (!anyway && checkIns.view?.resting) {
    const agentName = state.look?.agent?.name || 'Your agent';
    if (!window.confirm(`${agentName} is resting by ${agentGrammar().configured ? agentGrammar().possessiveDeterminer : 'its'} own choice. Knock anyway?`)) { status.textContent = 'Left to rest.'; return; }
    anyway = true;
  }
  status.textContent = kind === 'postcard' ? 'Writing a postcard…' : kind === 'free-time' ? 'Opening some free time…' : 'Checking in…';
  try {
    const response = await request('/api/checkins/now', { method: 'POST', body: { kind, ...(anyway ? { anyway: true } : {}) } });
    checkIns.view = response.checkIns;
    checkIns.seen = response.checkIns.latest?.at ?? checkIns.seen;
    if (response.conversation) applyConversation(response);
    renderCheckIns();
    const grammar = agentGrammar();
    status.textContent = response.outcome === 'sent'
      ? response.note || `Done: ${grammar.subject} left you a message.`
      : response.outcome === 'quiet'
        ? kind === 'free-time'
          ? 'Quiet free time added no conversation or check-in-history entry.'
          : `This check-in was quiet: ${grammar.subject} had nothing to say this time.`
        : response.note || `The check-in failed: ${grammar.subject} couldn't finish; see Receipts.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}
byId('checkin-now').addEventListener('click', () => { void checkInNow('check-in'); });
byId('checkin-free-time-now').addEventListener('click', () => { void checkInNow('free-time'); });
byId('checkin-postcard-now').addEventListener('click', () => { void checkInNow('postcard'); });

// ---- task heartbeats -----------------------------------------------------------

const heartbeats = {
  view: null,
  tools: [],
  editing: null,
  busy: false,
  timer: null,
  inspections: new Map(),
  goalFingerprint: null,
};

const HEARTBEAT_BOUND_GOAL_TOOLS = new Set(['read_goal_or_promise', 'record_goal_measure']);
const HEARTBEAT_GOAL_TOOLS = new Set([
  'list_goals_and_promises',
  'read_goal_or_promise',
  'choose_long_term_goal',
  'record_explicit_promise',
  'record_goal_measure',
  'change_goal_or_promise_status',
]);

function heartbeatDate(value, options = {}) {
  if (!value) return 'never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...options,
  }).format(date);
}

function heartbeatOutcomeCopy(outcome) {
  if (outcome === 'no-change') return 'No meaningful change. Receipt kept; no message.';
  if (outcome === 'claim-expired') return 'Claim expired; next run deferred.';
  return String(outcome || 'Unknown outcome');
}

function heartbeatRows() {
  return heartbeats.view?.heartbeats || [];
}

function heartbeatBindingSelection() {
  const recordId = byId('heartbeat-binding-record').value;
  if (!recordId) return null;
  return { type: 'goal-measure', recordId, measureKey: byId('heartbeat-binding-measure').value };
}

function renderHeartbeatBinding(binding = null) {
  const recordSelect = byId('heartbeat-binding-record');
  const measureSelect = byId('heartbeat-binding-measure');
  const measureRow = byId('heartbeat-binding-measure-row');
  const selectedId = binding?.recordId || '';
  const records = goalRows();
  clear(recordSelect);
  const standalone = document.createElement('option');
  standalone.value = '';
  standalone.textContent = 'Standalone task';
  recordSelect.append(standalone);
  for (const row of records.filter(row => ['active', 'paused'].includes(row.status) || row.id === selectedId)) {
    const option = document.createElement('option');
    option.value = row.id;
    option.textContent = `${row.kind === 'promise' ? 'Promise' : 'Goal'} · ${row.name} · ${row.status}`;
    recordSelect.append(option);
  }
  if (selectedId && !records.some(row => row.id === selectedId)) {
    const missing = document.createElement('option');
    missing.value = selectedId;
    missing.textContent = `Unavailable record · ${selectedId}`;
    recordSelect.append(missing);
  }
  recordSelect.value = selectedId;

  clear(measureSelect);
  const record = records.find(row => row.id === selectedId);
  const measures = record?.statistics || [];
  for (const measure of measures) {
    const option = document.createElement('option');
    option.value = measure.key;
    option.textContent = `${measure.label} · ${measure.unit} · ${measure.source}`;
    measureSelect.append(option);
  }
  if (binding?.measureKey && !measures.some(measure => measure.key === binding.measureKey)) {
    const missing = document.createElement('option');
    missing.value = binding.measureKey;
    missing.textContent = `Unavailable measure · ${binding.measureKey}`;
    measureSelect.append(missing);
  }
  if (binding?.measureKey) measureSelect.value = binding.measureKey;
  measureRow.hidden = !selectedId;
  measureSelect.required = Boolean(selectedId);
  measureSelect.disabled = !selectedId;
}

function heartbeatBindingCopy(row) {
  const record = goalRows().find(candidate => candidate.id === row.binding.recordId);
  const measure = record?.statistics?.find(candidate => candidate.key === row.binding.measureKey);
  return record && measure
    ? `${record.kind} · ${record.name} · ${measure.label} (${measure.unit}) · ${record.status}`
    : `${row.binding.recordId} · ${row.binding.measureKey} · unavailable`;
}

function refreshHeartbeatBindingLabels() {
  const rows = new Map(heartbeatRows().filter(row => row.binding).map(row => [row.id, row]));
  for (const node of document.querySelectorAll('[data-heartbeat-binding-label]')) {
    const row = rows.get(node.dataset.heartbeatBindingLabel);
    if (row) node.textContent = heartbeatBindingCopy(row);
  }
}

function syncHeartbeatGoalOptions() {
  const fingerprint = JSON.stringify(goalRows().map(row => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    measures: (row.statistics || []).map(measure => ({
      key: measure.key, label: measure.label, unit: measure.unit, source: measure.source,
    })),
  })));
  if (fingerprint === heartbeats.goalFingerprint) return;
  heartbeats.goalFingerprint = fingerprint;
  const draft = heartbeatBindingSelection();
  renderHeartbeatBinding(draft);
  renderHeartbeatTools();
  refreshHeartbeatBindingLabels();
}

function renderHeartbeatTools(selected = null) {
  const list = byId('heartbeat-tool-list');
  if (!list) return;
  const checked = selected === null
    ? new Set([...list.querySelectorAll('input:checked')].map(input => input.value))
    : new Set(selected);
  clear(list);
  if (!heartbeats.tools.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = 'No inspection tools are available. A heartbeat may still reason from its definition and prior receipts.';
    list.append(none);
    return;
  }
  for (const tool of heartbeats.tools) {
    const label = document.createElement('label');
    label.className = 'heartbeat-tool-choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = tool.name;
    input.checked = checked.has(tool.name);
    const bound = Boolean(byId('heartbeat-binding-record').value);
    if (bound && HEARTBEAT_GOAL_TOOLS.has(tool.name)) {
      input.checked = HEARTBEAT_BOUND_GOAL_TOOLS.has(tool.name);
      input.disabled = true;
    }
    const copy = document.createElement('span');
    copy.textContent = tool.name;
    if (tool.description) {
      const detail = document.createElement('small');
      detail.textContent = tool.description;
      copy.append(detail);
    }
    label.append(input, copy);
    list.append(label);
  }
}

function selectedHeartbeatTools() {
  return [...byId('heartbeat-tool-list').querySelectorAll('input:checked')].map(input => input.value);
}

function heartbeatDefinitionFromForm() {
  return {
    name: byId('heartbeat-name').value,
    task: byId('heartbeat-task').value,
    meaningfulChange: byId('heartbeat-change').value,
    completionRule: byId('heartbeat-completion').value,
    cadenceHours: Number(byId('heartbeat-cadence').value),
    toolNames: selectedHeartbeatTools(),
    binding: heartbeatBindingSelection(),
  };
}

function resetHeartbeatForm() {
  heartbeats.editing = null;
  byId('heartbeat-form').reset();
  byId('heartbeat-cadence').value = '4';
  renderHeartbeatBinding(null);
  renderHeartbeatTools([]);
  byId('heartbeat-form-mode').textContent = 'New heartbeat';
  byId('heartbeat-cancel').hidden = true;
  byId('heartbeat-save').querySelector('span').textContent = 'Create';
}

function editHeartbeat(row) {
  heartbeats.editing = { id: row.id, expectedRevision: row.revision };
  byId('heartbeat-name').value = row.name;
  byId('heartbeat-task').value = row.task;
  byId('heartbeat-change').value = row.meaningfulChange;
  byId('heartbeat-completion').value = row.completionRule;
  byId('heartbeat-cadence').value = String(row.cadenceHours);
  renderHeartbeatBinding(row.binding);
  renderHeartbeatTools(row.toolNames);
  byId('heartbeat-form-mode').textContent = `Editing revision ${row.revision}`;
  byId('heartbeat-cancel').hidden = false;
  byId('heartbeat-save').querySelector('span').textContent = 'Save edit';
  byId('heartbeat-name').focus();
}

function setHeartbeatBusy(value, message = '') {
  heartbeats.busy = value;
  byId('heartbeat-save').disabled = value;
  byId('heartbeat-export').disabled = value;
  if (message) byId('heartbeat-status').textContent = message;
  renderHeartbeats();
}

async function heartbeatControl(action, row, extra = {}) {
  setHeartbeatBusy(true, action === 'run' ? `Running “${row.name}”…` : `${action[0].toUpperCase()}${action.slice(1)}…`);
  try {
    let body = action === 'run'
      ? { id: row.id, ...extra }
      : { id: row.id, expectedRevision: row.revision };
    const response = await request(`/api/heartbeats/${action}`, { method: 'POST', body });
    heartbeats.view = response.heartbeats;
    heartbeats.inspections.delete(row.id);
    if (action === 'run' && response.result?.receipt) {
      appendReceipt(`Task heartbeat · ${row.name}`, response.result.receipt);
      const outcome = response.result.receipt.outcome;
      byId('heartbeat-status').textContent = outcome === 'no-change'
        ? `“${row.name}” found no meaningful change. Its receipt was kept; no message was invented.`
        : outcome === 'failed'
          ? `“${row.name}” could not finish. Its failure receipt was kept.`
          : response.result.receipt.note || `“${row.name}” reported ${outcome}.`;
    } else {
      byId('heartbeat-status').textContent = action === 'remove'
        ? `“${row.name}” was removed. Its definition and history are still recoverable.`
        : `“${row.name}” is now ${response.heartbeat?.status || action + 'd'}.`;
    }
    renderHeartbeats();
    return response;
  } catch (error) {
    byId('heartbeat-status').textContent = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    setHeartbeatBusy(false);
  }
}

async function runHeartbeat(row) {
  let anyway = false;
  if (checkIns.view?.resting) {
    const agentName = state.look?.agent?.name || 'Your agent';
    const grammar = agentGrammar();
    if (!window.confirm(`${agentName} is resting by ${grammar.configured ? grammar.possessiveDeterminer : 'its'} own choice. Run this heartbeat anyway?`)) {
      byId('heartbeat-status').textContent = 'Left to rest.';
      return;
    }
    anyway = true;
  }
  await heartbeatControl('run', row, anyway ? { anyway: true } : {});
}

async function restoreHeartbeatVersion(row, version) {
  setHeartbeatBusy(true, `Restoring the text from revision ${version.revision}…`);
  try {
    const { name, task, meaningfulChange, completionRule, cadenceHours, toolNames, binding } = version.value;
    const response = await request('/api/heartbeats/update', {
      method: 'POST',
      body: {
        id: row.id,
        expectedRevision: row.revision,
        changes: { name, task, meaningfulChange, completionRule, cadenceHours, toolNames, binding },
      },
    });
    heartbeats.view = response.heartbeats;
    heartbeats.inspections.delete(row.id);
    byId('heartbeat-status').textContent = `Restored “${row.name}” from revision ${version.revision}; the restoration is revision ${response.heartbeat.revision}.`;
    renderHeartbeats();
  } catch (error) {
    byId('heartbeat-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setHeartbeatBusy(false);
  }
}

function renderHeartbeatInspection(body, row, inspection) {
  clear(body);
  const exact = document.createElement('pre');
  exact.className = 'changes-exact';
  exact.textContent = JSON.stringify({
    name: row.name,
    task: row.task,
    meaningfulChange: row.meaningfulChange,
    completionRule: row.completionRule,
    cadenceHours: row.cadenceHours,
    toolNames: row.toolNames,
    binding: row.binding,
    status: row.status,
  }, null, 2);
  body.append(exact);

  for (const version of inspection.versions) {
    const item = document.createElement('div');
    item.className = 'heartbeat-history-row';
    const when = document.createElement('time');
    when.dateTime = version.at;
    when.textContent = `r${version.revision} · ${heartbeatDate(version.at)}`;
    const copy = document.createElement('code');
    copy.textContent = `${version.action} by ${version.by}\n${JSON.stringify(version.value, null, 2)}`;
    item.append(when, copy);
    if (version.revision !== row.revision && row.status !== 'removed' && !row.running) {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = 'Restore this text';
      restore.addEventListener('click', () => { void restoreHeartbeatVersion(row, version); });
      item.append(restore);
    }
    body.append(item);
  }
  if (inspection.receipts.length) {
    const heading = document.createElement('strong');
    heading.textContent = 'Run receipts';
    body.append(heading);
  }
  for (const receipt of inspection.receipts) {
    const item = document.createElement('p');
    item.className = `heartbeat-receipt ${receipt.outcome}`;
    item.textContent = `${heartbeatDate(receipt.at)} · ${receipt.runKind} · ${heartbeatOutcomeCopy(receipt.outcome)}${receipt.note ? `\n${receipt.note}` : ''}`;
    body.append(item);
  }
}

async function loadHeartbeatInspection(row, body) {
  body.textContent = 'Loading exact definition and retained history…';
  try {
    let inspection = heartbeats.inspections.get(row.id);
    if (!inspection) {
      const response = await request('/api/heartbeats/inspect', { method: 'POST', body: { id: row.id } });
      heartbeats.view = response.heartbeats;
      inspection = response.inspection;
      heartbeats.inspections.set(row.id, inspection);
    }
    renderHeartbeatInspection(body, row, inspection);
  } catch (error) {
    body.textContent = error instanceof Error ? error.message : String(error);
  }
}

function heartbeatButton(label, onClick, { danger = false, disabled = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.disabled = disabled;
  if (danger) button.className = 'danger';
  button.addEventListener('click', onClick);
  return button;
}

function renderHeartbeats() {
  const list = byId('heartbeat-list');
  if (!list) return;
  clear(list);
  const rows = heartbeatRows();
  if (!rows.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = 'No task heartbeats yet. Nothing will wake on a task schedule until you create one.';
    list.append(none);
    return;
  }
  for (const row of rows) {
    const card = document.createElement('article');
    card.className = `heartbeat-card ${row.status}${row.running ? ' running' : ''}`;
    const head = document.createElement('div');
    head.className = 'heartbeat-head';
    const title = document.createElement('strong');
    title.textContent = row.name;
    const stateLabel = document.createElement('span');
    stateLabel.className = 'heartbeat-state';
    stateLabel.textContent = row.running ? 'running' : row.status;
    const when = document.createElement('time');
    const next = row.nextRunAt ? `next ${heartbeatDate(row.nextRunAt)}` : row.lastRunAt ? `last ${heartbeatDate(row.lastRunAt)}` : 'not run yet';
    when.textContent = next;
    when.title = row.nextRunAt || row.lastRunAt || '';
    head.append(title, stateLabel, when);

    const task = document.createElement('p');
    task.className = 'heartbeat-copy';
    task.textContent = row.task;
    const changed = document.createElement('div');
    changed.className = 'heartbeat-rule';
    const changedLabel = document.createElement('b'); changedLabel.textContent = 'Meaningful change';
    const changedText = document.createElement('span'); changedText.textContent = row.meaningfulChange;
    changed.append(changedLabel, changedText);
    const completion = document.createElement('div');
    completion.className = 'heartbeat-rule';
    const completionLabel = document.createElement('b'); completionLabel.textContent = 'Finished when';
    const completionText = document.createElement('span'); completionText.textContent = row.completionRule;
    completion.append(completionLabel, completionText);
    const meta = document.createElement('div');
    meta.className = 'heartbeat-meta';
    meta.textContent = `revision ${row.revision} · every ${row.cadenceHours}h · tools: ${row.toolNames.length ? row.toolNames.join(', ') : 'none'} · created ${heartbeatDate(row.createdAt)}`;
    card.append(head, task, changed, completion, meta);

    if (row.binding) {
      const bound = document.createElement('div');
      bound.className = 'heartbeat-rule';
      const label = document.createElement('b');
      label.textContent = 'Bound source';
      const copy = document.createElement('span');
      copy.dataset.heartbeatBindingLabel = row.id;
      copy.textContent = heartbeatBindingCopy(row);
      bound.append(label, copy);
      card.append(bound);
    }

    if (row.lastReceipt) {
      const receipt = document.createElement('p');
      receipt.className = `heartbeat-receipt ${row.lastReceipt.outcome}`;
      receipt.textContent = `${heartbeatDate(row.lastReceipt.at)} · ${heartbeatOutcomeCopy(row.lastReceipt.outcome)}${row.lastReceipt.note ? `\n${row.lastReceipt.note}` : ''}`;
      card.append(receipt);
    }

    const actions = document.createElement('div');
    actions.className = 'heartbeat-actions';
    const disabled = heartbeats.busy || row.running;
    if (['active', 'paused'].includes(row.status)) actions.append(heartbeatButton('Run now', () => { void runHeartbeat(row); }, { disabled: disabled || !heartbeats.view?.runnable || state.busy }));
    if (row.status === 'active') actions.append(heartbeatButton('Pause', () => { void heartbeatControl('pause', row); }, { disabled }));
    if (row.status === 'paused') actions.append(heartbeatButton('Resume', () => { void heartbeatControl('resume', row); }, { disabled }));
    if (row.status !== 'removed') actions.append(heartbeatButton('Edit', () => editHeartbeat(row), { disabled }));
    if (row.status !== 'removed') actions.append(heartbeatButton('Remove (kept)', () => {
      if (window.confirm(`Remove “${row.name}”? Its definition and full history will be kept so you can restore it.`)) void heartbeatControl('remove', row);
    }, { danger: true, disabled }));
    if (row.status === 'removed') actions.append(heartbeatButton('Restore paused', () => { void heartbeatControl('restore', row); }, { disabled: heartbeats.busy }));
    card.append(actions);

    const details = document.createElement('details');
    details.className = 'heartbeat-history';
    const summary = document.createElement('summary');
    summary.textContent = 'Exact definition & retained history';
    const body = document.createElement('div');
    body.className = 'heartbeat-history-body';
    details.append(summary, body);
    let loaded = false;
    details.addEventListener('toggle', () => {
      if (!details.open || loaded) return;
      loaded = true;
      void loadHeartbeatInspection(row, body);
    });
    card.append(details);
    list.append(card);
  }
}

function startHeartbeatWatch(on) {
  clearInterval(heartbeats.timer);
  heartbeats.timer = null;
  if (!on) return;
  heartbeats.timer = setInterval(async () => {
    if (state.busy || heartbeats.busy) return;
    try {
      const response = await request('/api/heartbeats/view', { method: 'POST', body: {} });
      heartbeats.view = response.heartbeats;
      renderHeartbeats();
    } catch { /* The next look tries again. */ }
  }, 45_000);
}

byId('heartbeat-binding-record').addEventListener('change', () => {
  const recordId = byId('heartbeat-binding-record').value;
  const ordinary = selectedHeartbeatTools().filter(name => !HEARTBEAT_GOAL_TOOLS.has(name));
  renderHeartbeatBinding(recordId ? { type: 'goal-measure', recordId, measureKey: '' } : null);
  renderHeartbeatTools(recordId ? [...ordinary, ...HEARTBEAT_BOUND_GOAL_TOOLS] : ordinary);
});

byId('heartbeat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const definition = heartbeatDefinitionFromForm();
  const editing = heartbeats.editing;
  setHeartbeatBusy(true, editing ? 'Saving the edit…' : 'Creating the heartbeat…');
  try {
    const response = await request(editing ? '/api/heartbeats/update' : '/api/heartbeats/create', {
      method: 'POST',
      body: editing
        ? { id: editing.id, expectedRevision: editing.expectedRevision, changes: definition }
        : { definition },
    });
    heartbeats.view = response.heartbeats;
    heartbeats.inspections.delete(response.heartbeat.id);
    byId('heartbeat-status').textContent = editing
      ? `Saved “${response.heartbeat.name}” as revision ${response.heartbeat.revision}.`
      : `Created “${response.heartbeat.name}”. Its first run waits one full cadence.`;
    resetHeartbeatForm();
    renderHeartbeats();
  } catch (error) {
    byId('heartbeat-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setHeartbeatBusy(false);
  }
});

byId('heartbeat-cancel').addEventListener('click', resetHeartbeatForm);

byId('heartbeat-export').addEventListener('click', async () => {
  setHeartbeatBusy(true, 'Collecting exact heartbeat definitions and histories…');
  try {
    const inspections = [];
    for (const row of heartbeatRows()) {
      const response = await request('/api/heartbeats/inspect', { method: 'POST', body: { id: row.id } });
      inspections.push(response.inspection);
    }
    const value = {
      format: 'fieldwork-task-heartbeat-export/v2',
      exportedAt: new Date().toISOString(),
      store: heartbeats.view,
      inspections,
    };
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `fieldwork-task-heartbeats-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    byId('heartbeat-status').textContent = 'Exact heartbeat definitions and retained history exported.';
  } catch (error) {
    byId('heartbeat-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setHeartbeatBusy(false);
  }
});

// ---- goals and promises -------------------------------------------------------

const goals = {
  view: null,
  editing: null,
  busy: false,
  timer: null,
  inspections: new Map(),
};

function goalRows() {
  return goals.view?.records || [];
}

function goalLocalDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function goalExactDate(value, label) {
  if (!value) throw new Error(`${label} needs an exact date and time.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is not a valid date and time.`);
  return date.toISOString();
}

function goalKindFields() {
  const goal = byId('goal-kind').value === 'goal';
  byId('goal-goal-fields').hidden = !goal;
  byId('goal-promise-fields').hidden = goal;
  byId('goal-success-signals').required = goal;
  byId('goal-review-at').required = goal;
  byId('goal-beneficiary').required = !goal;
  byId('goal-return-from').required = !goal;
  byId('goal-return-by').required = !goal;
}

function goalMeasureField(labelText, input) {
  const label = document.createElement('label');
  const labelCopy = document.createElement('span');
  labelCopy.textContent = labelText;
  label.append(labelCopy, input);
  return label;
}

function addGoalMeasure(measure = {}) {
  const list = byId('goal-measure-list');
  if (list.children.length >= 8) {
    byId('goal-status').textContent = 'A record can declare at most 8 measures.';
    return;
  }
  const row = document.createElement('div');
  row.className = 'goal-measure-row';

  const key = document.createElement('input');
  key.className = 'goal-measure-key';
  key.maxLength = 32;
  key.pattern = '[a-z][a-z0-9_-]{0,31}';
  key.placeholder = 'posts_read';
  key.value = measure.key || '';
  key.required = true;
  const label = document.createElement('input');
  label.className = 'goal-measure-label';
  label.maxLength = 80;
  label.placeholder = 'Posts read';
  label.value = measure.label || '';
  label.required = true;
  const unit = document.createElement('input');
  unit.className = 'goal-measure-unit';
  unit.maxLength = 40;
  unit.placeholder = 'posts';
  unit.value = measure.unit || '';
  unit.required = true;
  const source = document.createElement('textarea');
  source.className = 'goal-measure-source';
  source.maxLength = 500;
  source.rows = 2;
  source.placeholder = 'Named archive, query, ledger, or other exact source';
  source.value = measure.source || '';
  source.required = true;
  const condition = document.createElement('select');
  condition.className = 'goal-measure-condition';
  for (const [value, text] of [['', 'No target'], ['at-least', 'At least'], ['at-most', 'At most'], ['exact', 'Exactly']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    condition.append(option);
  }
  condition.value = measure.targetCondition || '';
  const target = document.createElement('input');
  target.className = 'goal-measure-target';
  target.type = 'number';
  target.step = 'any';
  target.placeholder = 'Optional';
  target.value = measure.target === null || measure.target === undefined ? '' : String(measure.target);
  const remove = document.createElement('button');
  remove.className = 'goal-measure-remove';
  remove.type = 'button';
  remove.textContent = 'Remove measure';
  remove.addEventListener('click', () => row.remove());
  row.append(
    goalMeasureField('Key', key),
    goalMeasureField('Label', label),
    goalMeasureField('Unit', unit),
    goalMeasureField('Named source', source),
    goalMeasureField('Target rule', condition),
    goalMeasureField('Target', target),
    remove,
  );
  list.append(row);
}

function goalMeasuresFromForm() {
  return [...byId('goal-measure-list').querySelectorAll('.goal-measure-row')].map((row, index) => {
    const targetText = row.querySelector('.goal-measure-target').value.trim();
    const targetCondition = row.querySelector('.goal-measure-condition').value;
    if (Boolean(targetText) !== Boolean(targetCondition)) throw new Error(`Measure ${index + 1} needs both a target and a target rule, or neither.`);
    const measure = {
      key: row.querySelector('.goal-measure-key').value,
      label: row.querySelector('.goal-measure-label').value,
      unit: row.querySelector('.goal-measure-unit').value,
      source: row.querySelector('.goal-measure-source').value,
    };
    if (targetCondition) {
      const target = Number(targetText);
      if (!Number.isFinite(target)) throw new Error(`Measure ${index + 1} target must be a finite number.`);
      measure.target = target;
      measure.targetCondition = targetCondition;
    }
    return measure;
  });
}

function goalDefinitionFromForm() {
  const kind = byId('goal-kind').value;
  const common = {
    kind,
    name: byId('goal-name').value,
    statement: byId('goal-statement').value,
    chosenBy: byId('goal-chosen-by').value,
    source: byId('goal-source').value,
    measures: goalMeasuresFromForm(),
  };
  if (kind === 'goal') return {
    ...common,
    beneficiary: '',
    successSignals: byId('goal-success-signals').value,
    reviewAt: goalExactDate(byId('goal-review-at').value, 'Review at'),
    returnFrom: null,
    returnBy: null,
  };
  return {
    ...common,
    beneficiary: byId('goal-beneficiary').value,
    successSignals: '',
    reviewAt: null,
    returnFrom: goalExactDate(byId('goal-return-from').value, 'Return from'),
    returnBy: goalExactDate(byId('goal-return-by').value, 'Return by'),
  };
}

function resetGoalForm() {
  goals.editing = null;
  byId('goal-form').reset();
  byId('goal-kind').disabled = false;
  clear(byId('goal-measure-list'));
  goalKindFields();
  byId('goal-form-mode').textContent = 'New goal or promise';
  byId('goal-cancel').hidden = true;
  byId('goal-save').querySelector('span').textContent = 'Create';
}

function editGoal(row) {
  goals.editing = { id: row.id, expectedRevision: row.revision };
  byId('goal-kind').value = row.kind;
  byId('goal-kind').disabled = true;
  byId('goal-chosen-by').value = row.chosenBy;
  byId('goal-name').value = row.name;
  byId('goal-statement').value = row.statement;
  byId('goal-source').value = row.source;
  byId('goal-success-signals').value = row.successSignals;
  byId('goal-review-at').value = goalLocalDate(row.reviewAt);
  byId('goal-beneficiary').value = row.beneficiary;
  byId('goal-return-from').value = goalLocalDate(row.returnFrom);
  byId('goal-return-by').value = goalLocalDate(row.returnBy);
  clear(byId('goal-measure-list'));
  for (const measure of row.measures) addGoalMeasure(measure);
  goalKindFields();
  byId('goal-form-mode').textContent = `Editing ${row.kind} revision ${row.revision}`;
  byId('goal-cancel').hidden = false;
  byId('goal-save').querySelector('span').textContent = 'Save edit';
  byId('goal-name').focus();
}

function setGoalBusy(value, message = '') {
  goals.busy = value;
  byId('goal-save').disabled = value;
  byId('goal-add-measure').disabled = value;
  byId('goal-export').disabled = value;
  if (message) byId('goal-status').textContent = message;
  renderGoals();
}

function goalButton(label, onClick, { danger = false, disabled = false } = {}) {
  return heartbeatButton(label, onClick, { danger, disabled });
}

async function goalControl(action, row, reason = '') {
  setGoalBusy(true, `${action[0].toUpperCase()}${action.slice(1)}…`);
  try {
    const body = { id: row.id, expectedRevision: row.revision };
    if (['finish', 'retire'].includes(action)) body.reason = reason;
    const response = await request(`/api/goals/${action}`, { method: 'POST', body });
    goals.view = response.goals;
    goals.inspections.delete(row.id);
    const suffix = response.record?.statusNote ? ` — ${response.record.statusNote}` : '';
    byId('goal-status').textContent = action === 'remove'
      ? `“${row.name}” was removed. Its definition, evidence, and history are still recoverable.`
      : `“${row.name}” is now ${response.record?.status || action + 'd'}${suffix}.`;
    renderGoals();
  } catch (error) {
    byId('goal-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setGoalBusy(false);
  }
}

function askGoalReason(action, row) {
  const question = action === 'finish'
    ? `What exact evidence shows “${row.name}” is finished or the promise was kept?`
    : `Why is “${row.name}” being retired or abandoned? This is a legitimate outcome and the reason will be kept.`;
  const reason = window.prompt(question, '');
  if (reason === null) return;
  if (!reason.trim()) {
    byId('goal-status').textContent = `${action === 'finish' ? 'Finishing' : 'Retiring'} needs an honest reason.`;
    return;
  }
  void goalControl(action, row, reason);
}

function goalDefinitionFromVersion(value) {
  return {
    kind: value.kind,
    name: value.name,
    statement: value.statement,
    chosenBy: value.chosenBy,
    source: value.source,
    beneficiary: value.beneficiary,
    successSignals: value.successSignals,
    reviewAt: value.reviewAt,
    returnFrom: value.returnFrom,
    returnBy: value.returnBy,
    measures: value.measures,
  };
}

async function restoreGoalVersion(row, version) {
  setGoalBusy(true, `Restoring the definition from revision ${version.revision}…`);
  try {
    const response = await request('/api/goals/update', {
      method: 'POST',
      body: { id: row.id, expectedRevision: row.revision, changes: goalDefinitionFromVersion(version.value) },
    });
    goals.view = response.goals;
    goals.inspections.delete(row.id);
    byId('goal-status').textContent = `Restored “${row.name}” from revision ${version.revision}; the restoration is revision ${response.record.revision}.`;
    renderGoals();
  } catch (error) {
    byId('goal-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setGoalBusy(false);
  }
}

function renderGoalInspection(body, row, inspection) {
  clear(body);
  const exact = document.createElement('pre');
  exact.className = 'changes-exact';
  exact.textContent = JSON.stringify(inspection.record, null, 2);
  body.append(exact);

  const versionHeading = document.createElement('strong');
  versionHeading.textContent = 'Definition and status history';
  body.append(versionHeading);
  for (const version of inspection.versions) {
    const item = document.createElement('div');
    item.className = 'goal-history-row';
    const when = document.createElement('time');
    when.dateTime = version.at;
    when.textContent = `r${version.revision} · ${heartbeatDate(version.at)}`;
    const copy = document.createElement('code');
    copy.textContent = `${version.action} by ${version.by}\n${JSON.stringify(version.value, null, 2)}`;
    item.append(when, copy);
    if (version.revision !== row.revision && row.status !== 'removed') {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = 'Restore this definition';
      restore.addEventListener('click', () => { void restoreGoalVersion(row, version); });
      item.append(restore);
    }
    body.append(item);
  }

  const checkHeading = document.createElement('strong');
  checkHeading.textContent = 'Raw measure checks';
  body.append(checkHeading);
  if (!inspection.checks.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = 'No measure checks have been recorded.';
    body.append(none);
  }
  for (const check of inspection.checks) {
    const item = document.createElement('pre');
    item.className = `goal-check-evidence ${check.outcome}`;
    item.textContent = JSON.stringify(check, null, 2);
    body.append(item);
  }
}

async function loadGoalInspection(row, body) {
  body.textContent = 'Loading exact definition, source checks, and retained history…';
  try {
    let inspection = goals.inspections.get(row.id);
    if (!inspection) {
      const response = await request('/api/goals/inspect', { method: 'POST', body: { id: row.id } });
      goals.view = response.goals;
      inspection = response.inspection;
      goals.inspections.set(row.id, inspection);
    }
    renderGoalInspection(body, row, inspection);
  } catch (error) {
    body.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderGoalCheckFields(form) {
  const outcome = form.querySelector('.goal-check-outcome').value;
  const value = form.querySelector('.goal-check-value-row');
  const edge = form.querySelector('.goal-check-edge-row');
  const note = form.querySelector('.goal-check-note-row');
  value.hidden = outcome !== 'observed';
  edge.hidden = outcome === 'no-data';
  note.querySelector('textarea').required = outcome === 'no-data';
  note.querySelector('span').textContent = outcome === 'no-data' ? 'Why no data' : 'Note (optional)';
}

async function recordGoalCheck(row, statistic, form) {
  const outcome = form.querySelector('.goal-check-outcome').value;
  const body = { id: row.id, measureKey: statistic.key, outcome };
  try {
    if (outcome === 'observed') {
      const rawValue = form.querySelector('.goal-check-value').value.trim();
      if (!rawValue) throw new Error('An observed check needs a numeric value.');
      body.value = Number(rawValue);
      if (!Number.isFinite(body.value)) throw new Error('The observed value must be a finite number.');
    }
    if (outcome !== 'no-data') body.observedThrough = goalExactDate(form.querySelector('.goal-check-edge').value, 'Observed through');
    const note = form.querySelector('.goal-check-note').value.trim();
    if (note) body.note = note;
    if (outcome === 'no-data' && !note) throw new Error('No data needs an honest reason.');
    setGoalBusy(true, `Recording ${statistic.label}…`);
    const response = await request('/api/goals/record', { method: 'POST', body });
    goals.view = response.goals;
    goals.inspections.delete(row.id);
    byId('goal-status').textContent = response.again
      ? `That exact ${outcome} source edge was already recorded; no duplicate was added.`
      : `Recorded ${outcome} for “${statistic.label}” from ${statistic.source}.`;
    renderGoals();
  } catch (error) {
    byId('goal-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setGoalBusy(false);
  }
}

function goalCheckForm(row, statistic) {
  const form = document.createElement('form');
  form.className = 'goal-check-form';
  const outcome = document.createElement('select');
  outcome.className = 'goal-check-outcome';
  for (const [value, text] of [['observed', 'Observed value'], ['no-change', 'No change at new source edge'], ['no-data', 'No data available']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; outcome.append(option);
  }
  const value = document.createElement('input'); value.type = 'number'; value.step = 'any'; value.className = 'goal-check-value';
  const edge = document.createElement('input'); edge.type = 'datetime-local'; edge.className = 'goal-check-edge';
  const note = document.createElement('textarea'); note.rows = 2; note.maxLength = 1000; note.className = 'goal-check-note';
  const outcomeRow = goalMeasureField('Outcome', outcome);
  const valueRow = goalMeasureField(`Value (${statistic.unit})`, value); valueRow.className = 'goal-check-value-row';
  const edgeRow = goalMeasureField('Observed through', edge); edgeRow.className = 'goal-check-edge-row';
  const noteRow = goalMeasureField('Note (optional)', note); noteRow.className = 'goal-check-note-row';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'secondary-button'; save.textContent = 'Record check';
  form.append(outcomeRow, valueRow, edgeRow, noteRow, save);
  outcome.addEventListener('change', () => renderGoalCheckFields(form));
  form.addEventListener('submit', event => { event.preventDefault(); void recordGoalCheck(row, statistic, form); });
  renderGoalCheckFields(form);
  return form;
}

function formatGoalNumber(value) {
  return value === null || value === undefined ? 'none' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(value);
}

function goalMeasureCard(row, statistic) {
  const card = document.createElement('section');
  card.className = 'goal-measure-card';
  const heading = document.createElement('div');
  heading.className = 'goal-measure-heading';
  const title = document.createElement('strong'); title.textContent = `${statistic.label} (${statistic.unit})`;
  const key = document.createElement('code'); key.textContent = statistic.key;
  heading.append(title, key);
  const source = document.createElement('p'); source.className = 'goal-source'; source.textContent = `Source: ${statistic.source}`;
  const target = statistic.target === null ? 'no target' : `${statistic.targetCondition.replace('-', ' ')} ${formatGoalNumber(statistic.target)} ${statistic.unit}`;
  const edge = statistic.observedThrough || 'none';
  const summary = document.createElement('p');
  summary.className = 'goal-statistics';
  summary.textContent = `${statistic.samples} numeric sample${statistic.samples === 1 ? '' : 's'} · ${statistic.checks} total check${statistic.checks === 1 ? '' : 's'} · latest outcome ${statistic.latestOutcome || 'none'} · source observed through ${edge} · target ${target}`;
  const values = document.createElement('p');
  values.className = 'goal-statistics';
  values.textContent = `first ${formatGoalNumber(statistic.first?.value)} · latest ${formatGoalNumber(statistic.latest?.value)} · change ${formatGoalNumber(statistic.change)} · range ${formatGoalNumber(statistic.minimum)} to ${formatGoalNumber(statistic.maximum)}${statistic.targetReached === null ? '' : ` · target ${statistic.targetReached ? 'reached' : 'not reached'}`}`;
  card.append(heading, source, summary, values);
  if (['active', 'paused'].includes(row.status)) card.append(goalCheckForm(row, statistic));
  return card;
}

function renderGoals() {
  const list = byId('goal-list');
  if (!list) return;
  syncHeartbeatGoalOptions();
  clear(list);
  const rows = goalRows();
  if (!rows.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = 'No long-term goals or explicit promises yet. Nothing is inferred from ordinary reminders or conversation.';
    list.append(none);
    return;
  }
  for (const row of rows) {
    const card = document.createElement('article');
    card.className = `goal-card ${row.kind} ${row.status}${row.clock?.overdue ? ' overdue' : row.clock?.due ? ' due' : ''}`;
    const head = document.createElement('div');
    head.className = 'goal-head';
    const title = document.createElement('strong'); title.textContent = row.name;
    const kind = document.createElement('span'); kind.className = 'goal-kind'; kind.textContent = row.kind;
    const status = document.createElement('span'); status.className = 'goal-state'; status.textContent = row.status;
    head.append(title, kind, status);
    const statement = document.createElement('p'); statement.className = 'goal-copy'; statement.textContent = row.statement;
    const definition = document.createElement('div'); definition.className = 'goal-definition';
    if (row.kind === 'goal') {
      const signals = document.createElement('p'); signals.textContent = `Success signals: ${row.successSignals}`;
      const review = document.createElement('p'); review.textContent = `Review at: ${row.reviewAt}${row.clock?.due ? ' · DUE' : ''}`;
      definition.append(signals, review);
    } else {
      const beneficiary = document.createElement('p'); beneficiary.textContent = `Beneficiary: ${row.beneficiary}`;
      const window = document.createElement('p'); window.textContent = `Return window: ${row.returnFrom} → ${row.returnBy}${row.clock?.overdue ? ' · OVERDUE' : row.clock?.due ? ' · OPEN' : ''}`;
      definition.append(beneficiary, window);
    }
    const source = document.createElement('p'); source.className = 'goal-source'; source.textContent = `Exact source: ${row.source}`;
    const meta = document.createElement('p'); meta.className = 'goal-meta'; meta.textContent = `chosen by ${row.chosenBy} · revision ${row.revision} · created ${row.createdAt} · last checked ${row.lastCheckedAt || 'never'}`;
    card.append(head, statement, definition, source, meta);
    if (row.statusNote) {
      const note = document.createElement('p'); note.className = 'goal-status-note'; note.textContent = `${row.status}: ${row.statusNote}`; card.append(note);
    }
    for (const statistic of row.statistics) card.append(goalMeasureCard(row, statistic));

    const actions = document.createElement('div');
    actions.className = 'goal-actions';
    const disabled = goals.busy;
    if (row.status === 'active') actions.append(goalButton('Pause', () => { void goalControl('pause', row); }, { disabled }));
    if (row.status === 'paused') actions.append(goalButton('Resume', () => { void goalControl('resume', row); }, { disabled }));
    if (['active', 'paused'].includes(row.status)) {
      actions.append(goalButton(row.kind === 'promise' ? 'Mark kept' : 'Mark finished', () => askGoalReason('finish', row), { disabled }));
      actions.append(goalButton('Retire / abandon', () => askGoalReason('retire', row), { disabled }));
    }
    if (row.status !== 'removed') actions.append(goalButton('Edit definition', () => editGoal(row), { disabled }));
    if (row.status !== 'removed') actions.append(goalButton('Remove (kept)', () => {
      if (window.confirm(`Remove “${row.name}”? Its exact definition, evidence, and history will stay recoverable.`)) void goalControl('remove', row);
    }, { danger: true, disabled }));
    if (row.status === 'removed') actions.append(goalButton('Restore', () => { void goalControl('restore', row); }, { disabled }));
    card.append(actions);

    const details = document.createElement('details');
    details.className = 'goal-history';
    const summary = document.createElement('summary'); summary.textContent = 'Exact current value, raw checks & retained history';
    const body = document.createElement('div'); body.className = 'goal-history-body';
    details.append(summary, body);
    let loaded = false;
    details.addEventListener('toggle', () => {
      if (!details.open || loaded) return;
      loaded = true;
      void loadGoalInspection(row, body);
    });
    card.append(details);
    list.append(card);
  }
}

function startGoalWatch(on) {
  clearInterval(goals.timer);
  goals.timer = null;
  if (!on) return;
  goals.timer = setInterval(async () => {
    if (state.busy || goals.busy) return;
    try {
      const response = await request('/api/goals/view', { method: 'POST', body: {} });
      goals.view = response.goals;
      renderGoals();
    } catch { /* The next look tries again. */ }
  }, 45_000);
}

byId('goal-kind').addEventListener('change', goalKindFields);
byId('goal-add-measure').addEventListener('click', () => addGoalMeasure());
byId('goal-cancel').addEventListener('click', resetGoalForm);

byId('goal-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const definition = goalDefinitionFromForm();
    const editing = goals.editing;
    setGoalBusy(true, editing ? 'Saving the definition edit…' : 'Creating the register entry…');
    const response = await request(editing ? '/api/goals/update' : '/api/goals/create', {
      method: 'POST',
      body: editing
        ? { id: editing.id, expectedRevision: editing.expectedRevision, changes: definition }
        : { definition },
    });
    goals.view = response.goals;
    goals.inspections.delete(response.record.id);
    byId('goal-status').textContent = editing
      ? `Saved “${response.record.name}” as revision ${response.record.revision}.`
      : `Recorded ${response.record.kind} “${response.record.name}” with its exact source.`;
    resetGoalForm();
    renderGoals();
  } catch (error) {
    byId('goal-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setGoalBusy(false);
  }
});

byId('goal-export').addEventListener('click', async () => {
  setGoalBusy(true, 'Collecting the exact register, raw checks, and retained history…');
  try {
    const inspections = [];
    for (const row of goalRows()) {
      const response = await request('/api/goals/inspect', { method: 'POST', body: { id: row.id } });
      inspections.push(response.inspection);
    }
    const value = {
      format: 'fieldwork-goal-register-export/v1',
      exportedAt: new Date().toISOString(),
      store: goals.view,
      inspections,
    };
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `fieldwork-goals-and-promises-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    byId('goal-status').textContent = 'Exact goals, promises, raw checks, and retained history exported.';
  } catch (error) {
    byId('goal-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setGoalBusy(false);
  }
});

goalKindFields();

// ---- outside reader -----------------------------------------------------------

const outsideReaders = {
  view: null,
  fingerprint: '',
  editing: null,
  busy: false,
  timer: null,
  inspections: new Map(),
  inspectionRequests: new Map(),
  openDisclosures: new Map(),
  pendingFocus: null,
};

function outsideReaderChoicesFingerprint(view = outsideReaders.view) {
  return JSON.stringify(view?.choices || null);
}

function captureOutsideReaderRenderState() {
  const list = byId('outside-reader-list');
  const open = new Set();
  const disclosures = new Map();
  for (const card of list.querySelectorAll('[data-outside-reader-id]')) {
    const id = card.dataset.outsideReaderId;
    if (card.querySelector('details')?.open) open.add(id);
    const nestedDetails = [...card.querySelectorAll('details[data-outside-reader-disclosure]')];
    const nested = new Set(nestedDetails.filter(details => details.open)
      .map(details => details.dataset.outsideReaderDisclosure));
    if (nestedDetails.length) {
      if (nested.size) outsideReaders.openDisclosures.set(id, nested);
      else outsideReaders.openDisclosures.delete(id);
    }
    const remembered = outsideReaders.openDisclosures.get(id);
    if (remembered?.size) disclosures.set(id, new Set(remembered));
  }
  const active = document.activeElement;
  if (active && list.contains(active)) {
    const card = active.closest('[data-outside-reader-id]');
    if (card) {
      outsideReaders.pendingFocus = {
        id: card.dataset.outsideReaderId,
        action: active.dataset.outsideReaderAction || 'card',
      };
    }
  } else if (active && active !== document.body && active !== document.documentElement) {
    // Do not pull focus back after the person deliberately moved elsewhere
    // while a longer review request was still running.
    outsideReaders.pendingFocus = null;
  }
  return { open, disclosures, focus: outsideReaders.pendingFocus };
}

function outsideReaderCard(id) {
  return [...byId('outside-reader-list').querySelectorAll('[data-outside-reader-id]')]
    .find(card => card.dataset.outsideReaderId === id) || null;
}

function restoreOutsideReaderFocus(focus = outsideReaders.pendingFocus) {
  if (!focus) return;
  const card = outsideReaderCard(focus.id);
  if (!card) return;
  const target = focus.action === 'card'
    ? card
    : [...card.querySelectorAll('[data-outside-reader-action]')]
      .find(control => control.dataset.outsideReaderAction === focus.action);
  if (target && !target.disabled) {
    target.focus({ preventScroll: true });
    outsideReaders.pendingFocus = null;
    return;
  }
  if (target?.disabled || focus.action.startsWith('restore-version:') || focus.action.startsWith('disclosure:') || focus.action === 'retry-inspection') return;
  card.focus({ preventScroll: true });
  outsideReaders.pendingFocus = null;
}

function outsideReaderRows() {
  return outsideReaders.view?.readers || [];
}

function outsideReaderDate(value) {
  if (!value) return 'never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function outsideReaderCadence(hours) {
  return hours % 24 === 0
    ? `${hours / 24} day${hours === 24 ? '' : 's'}`
    : `${hours} hour${hours === 1 ? '' : 's'}`;
}

function outsideReaderSourceChoices() {
  return (outsideReaders.view?.choices?.sources || []).filter(source => source.status !== 'removed');
}

function outsideReaderSourceId(source) {
  return source?.id || source?.recordId || '';
}

function outsideReaderSourceLabel(source) {
  const id = outsideReaderSourceId(source);
  const kind = source?.kind ? `${source.kind} · ` : '';
  const status = source?.status ? ` · ${source.status}` : '';
  return `${kind}${source?.name || id}${status}`;
}

function selectedOutsideReaderSources() {
  return [...byId('outside-reader-source-list').querySelectorAll('input:checked')].map(input => input.value);
}

function renderOutsideReaderCadences(selected = null) {
  const select = byId('outside-reader-cadence');
  const current = selected ?? select.value;
  const retainUnavailable = selected !== null || Boolean(outsideReaders.editing);
  const choices = outsideReaders.view?.choices?.cadenceHours || [];
  clear(select);
  for (const hours of choices) {
    const option = document.createElement('option');
    option.value = String(hours);
    option.textContent = outsideReaderCadence(hours);
    select.append(option);
  }
  if (retainUnavailable && current && ![...select.options].some(option => option.value === String(current))) {
    const retained = document.createElement('option');
    retained.value = String(current);
    retained.textContent = `${current} hours (retained)`;
    select.append(retained);
  }
  if ([...select.options].some(option => option.value === String(current))) select.value = String(current);
  else if ([...select.options].some(option => option.value === '24')) select.value = '24';
  else if (select.options.length) select.selectedIndex = 0;
}

function renderOutsideReaderSources(selected = null) {
  const list = byId('outside-reader-source-list');
  const active = document.activeElement;
  const focusedId = active instanceof HTMLInputElement && list.contains(active) ? active.value : null;
  const checked = new Set(selected === null ? selectedOutsideReaderSources() : selected);
  const choices = outsideReaderSourceChoices();
  const known = new Set(choices.map(outsideReaderSourceId));
  clear(list);
  if (!choices.length && !checked.size) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = 'No goals or promises available. Create one first.';
    list.append(none);
    return;
  }
  const appendChoice = (id, labelText, unavailable = false) => {
    const label = document.createElement('label');
    label.className = `outside-reader-source${unavailable ? ' unavailable' : ''}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = id;
    input.checked = checked.has(id);
    const copy = document.createElement('span');
    copy.textContent = labelText;
    if (unavailable) {
      const stable = document.createElement('small');
      stable.textContent = `Unavailable · ${id}`;
      copy.append(stable);
    }
    label.append(input, copy);
    list.append(label);
  };
  for (const source of choices) {
    const id = outsideReaderSourceId(source);
    if (id) appendChoice(id, outsideReaderSourceLabel(source));
  }
  for (const id of checked) {
    if (!known.has(id)) appendChoice(id, id, true);
  }
  if (focusedId) {
    const replacement = [...list.querySelectorAll('input')].find(input => input.value === focusedId);
    replacement?.focus({ preventScroll: true });
  }
}

function renderOutsideReaderChoices(selected = null) {
  renderOutsideReaderCadences(selected?.cadenceHours ?? null);
  renderOutsideReaderSources(selected?.source?.recordIds ?? null);
}

function outsideReaderDefinitionFromForm() {
  const recordIds = selectedOutsideReaderSources();
  if (!recordIds.length || recordIds.length > 24) throw new Error('Choose from 1 to 24 exact goal or promise records.');
  return {
    name: byId('outside-reader-name').value,
    focus: byId('outside-reader-focus').value,
    cadenceHours: Number(byId('outside-reader-cadence').value),
    source: { type: 'goal-record-set', recordIds },
  };
}

function resetOutsideReaderForm() {
  outsideReaders.editing = null;
  byId('outside-reader-form').reset();
  renderOutsideReaderChoices({ cadenceHours: 24, source: { recordIds: [] } });
  byId('outside-reader-form-mode').textContent = 'New review schedule';
  byId('outside-reader-cancel').hidden = true;
  byId('outside-reader-save').querySelector('span').textContent = 'Create';
}

function editOutsideReader(row) {
  outsideReaders.editing = { id: row.id, expectedRevision: row.revision };
  byId('outside-reader-name').value = row.name;
  byId('outside-reader-focus').value = row.focus;
  renderOutsideReaderChoices(row);
  byId('outside-reader-form-mode').textContent = `Editing revision ${row.revision}`;
  byId('outside-reader-cancel').hidden = false;
  byId('outside-reader-save').querySelector('span').textContent = 'Save edit';
  byId('outside-reader-name').focus();
}

function setOutsideReaderBusy(value, message = '') {
  outsideReaders.busy = value;
  byId('outside-reader-save').disabled = value;
  byId('outside-reader-export').disabled = value;
  if (message) byId('outside-reader-status').textContent = message;
  renderOutsideReaders();
}

function outsideReaderOutcomeCopy(receipt) {
  if (!receipt) return '';
  if (receipt.outcome === 'source-unchanged') return 'Source unchanged.';
  if (receipt.outcome === 'no-findings') return 'No findings.';
  if (receipt.outcome === 'findings') {
    const count = receipt.findingCount ?? receipt.findingIds?.length ?? receipt.findings?.length;
    return count === undefined ? 'Review leads found.' : `${count} review lead${count === 1 ? '' : 's'}.`;
  }
  if (receipt.outcome === 'failed') return receipt.note ? `Failed: ${receipt.note}` : 'Failed.';
  if (receipt.outcome === 'claim-expired') return 'Claim expired; next run deferred.';
  return String(receipt.outcome || 'unknown outcome');
}

function outsideReaderOutcomeLabel(receipt) {
  if (!receipt) return '';
  if (receipt.outcome === 'source-unchanged') return 'Unchanged';
  if (receipt.outcome === 'no-findings') return 'No findings';
  if (receipt.outcome === 'findings') {
    const count = receipt.findings?.length;
    return Number.isSafeInteger(count) ? `${count} review lead${count === 1 ? '' : 's'}` : 'Review leads';
  }
  if (receipt.outcome === 'failed') return 'Failed';
  if (receipt.outcome === 'claim-expired') return 'Claim expired';
  return String(receipt.outcome || 'Unknown');
}

function applyOutsideReaderView(view, inspection = null) {
  const fingerprint = JSON.stringify(view);
  const changed = fingerprint !== outsideReaders.fingerprint;
  const choicesChanged = outsideReaderChoicesFingerprint(view) !== outsideReaderChoicesFingerprint();
  const revisionChanged = outsideReaders.view?.revision !== view?.revision;
  if (revisionChanged) outsideReaders.inspections.clear();
  if (inspection?.reader?.id) outsideReaders.inspections.set(inspection.reader.id, inspection);
  outsideReaders.view = view;
  outsideReaders.fingerprint = fingerprint;
  if (changed) {
    if (choicesChanged) renderOutsideReaderChoices();
    renderOutsideReaders();
  }
  return changed;
}

function requestOutsideReaderInspection(id) {
  let pending = outsideReaders.inspectionRequests.get(id);
  if (!pending) {
    pending = request('/api/outside-readers/inspect', { method: 'POST', body: { id } })
      .finally(() => outsideReaders.inspectionRequests.delete(id));
    outsideReaders.inspectionRequests.set(id, pending);
  }
  return pending;
}

async function outsideReaderControl(action, row) {
  setOutsideReaderBusy(true, action === 'run' ? `Reviewing “${row.name}”…` : `${action[0].toUpperCase()}${action.slice(1)}…`);
  try {
    const body = action === 'run'
      ? { id: row.id }
      : { id: row.id, expectedRevision: row.revision };
    const response = await request(`/api/outside-readers/${action}`, { method: 'POST', body });
    outsideReaders.view = response.outsideReaders;
    outsideReaders.fingerprint = JSON.stringify(outsideReaders.view);
    outsideReaders.inspections.delete(row.id);
    if (action === 'run' && response.result?.receipt) {
      appendReceipt(`Outside reader · ${row.name}`, response.result.receipt);
      byId('outside-reader-status').textContent = outsideReaderOutcomeCopy(response.result.receipt);
    } else {
      byId('outside-reader-status').textContent = action === 'remove'
        ? `Removed “${row.name}”. History kept.`
        : `“${row.name}” is now ${response.reader?.status || action + 'd'}.`;
    }
    renderOutsideReaderChoices();
    renderOutsideReaders();
    return response;
  } catch (error) {
    byId('outside-reader-status').textContent = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    setOutsideReaderBusy(false);
  }
}

async function restoreOutsideReaderVersion(row, version) {
  setOutsideReaderBusy(true, `Restoring the definition from revision ${version.revision}…`);
  try {
    const { name, focus, cadenceHours, source } = version.value;
    const response = await request('/api/outside-readers/update', {
      method: 'POST',
      body: {
        id: row.id,
        expectedRevision: row.revision,
        changes: { name, focus, cadenceHours, source },
      },
    });
    outsideReaders.view = response.outsideReaders;
    outsideReaders.fingerprint = JSON.stringify(outsideReaders.view);
    outsideReaders.inspections.delete(row.id);
    byId('outside-reader-status').textContent = `Restored “${row.name}” from revision ${version.revision}; the restoration is revision ${response.reader.revision}.`;
    renderOutsideReaderChoices();
    renderOutsideReaders();
  } catch (error) {
    byId('outside-reader-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setOutsideReaderBusy(false);
  }
}

function outsideReaderFindingCard(finding, receipt = null) {
  const card = document.createElement('article');
  card.className = 'outside-reader-finding';
  const head = document.createElement('div');
  head.className = 'outside-reader-finding-head';
  const title = document.createElement('strong');
  title.textContent = finding.title || finding.statement || finding.summary || 'Review lead';
  const kind = document.createElement('span');
  kind.textContent = finding.kind || 'possible issue';
  head.append(title, kind);
  card.append(head);
  if (receipt) {
    const run = document.createElement('small');
    run.textContent = `Run ${outsideReaderDate(receipt.at)} · receipt ${receipt.id}`;
    card.append(run);
  }
  const statement = finding.statement || finding.summary;
  if (statement && statement !== title.textContent) {
    const copy = document.createElement('p');
    copy.textContent = statement;
    card.append(copy);
  }
  const whyText = finding.why || finding.reason || finding.details;
  if (whyText) {
    const why = document.createElement('p');
    why.className = 'outside-reader-finding-why';
    why.textContent = `Why it was flagged: ${whyText}`;
    card.append(why);
  }
  const evidence = finding.evidence || finding.references || [];
  if (evidence.length) {
    const label = document.createElement('b');
    label.textContent = 'Exact evidence';
    const list = document.createElement('ul');
    for (const item of evidence) {
      const row = document.createElement('li');
      const reference = typeof item === 'string' ? item : (item.ref || item.reference || item.id || 'unlabeled reference');
      const ref = document.createElement('code');
      ref.textContent = reference;
      row.append(ref);
      if (typeof item === 'object' && item?.excerpt) {
        const excerpt = document.createElement('blockquote');
        excerpt.textContent = item.excerpt;
        row.append(excerpt);
      }
      list.append(row);
    }
    card.append(label, list);
  }
  const resolutionText = finding.whatWouldResolve || finding.resolveWith || finding.resolution;
  if (resolutionText) {
    const resolution = document.createElement('p');
    resolution.className = 'outside-reader-finding-resolution';
    resolution.textContent = `What could resolve it: ${resolutionText}`;
    card.append(resolution);
  }
  return card;
}

function outsideReaderDisclosure(label, key, openDisclosures, context = '') {
  const details = document.createElement('details');
  details.className = 'outside-reader-inspection-section';
  details.dataset.outsideReaderDisclosure = key;
  const summary = document.createElement('summary');
  summary.textContent = label;
  if (context) summary.setAttribute('aria-label', `${label} for ${context}`);
  summary.dataset.outsideReaderAction = `disclosure:${key}`;
  const content = document.createElement('div');
  content.className = 'outside-reader-inspection-content';
  details.append(summary, content);
  details.open = openDisclosures.has(key);
  return { details, content };
}

function appendOutsideReaderDefinitionField(list, termText, value) {
  const term = document.createElement('dt');
  term.textContent = termText;
  const description = document.createElement('dd');
  description.textContent = value;
  list.append(term, description);
}

function renderOutsideReaderInspection(body, row, inspection, openDisclosures = new Set()) {
  clear(body);
  const current = inspection.reader || row;
  const exactDefinition = {
    id: current.id,
    revision: current.revision,
    name: current.name,
    focus: current.focus,
    cadenceHours: current.cadenceHours,
    source: current.source,
    status: current.status,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    lastRunAt: current.lastRunAt,
    nextRunAt: current.nextRunAt,
    removedAt: current.removedAt,
  };

  const definition = outsideReaderDisclosure('Definition & sources', 'definition', openDisclosures, current.name);
  const fields = document.createElement('dl');
  fields.className = 'outside-reader-definition';
  appendOutsideReaderDefinitionField(fields, 'Focus', current.focus);
  appendOutsideReaderDefinitionField(fields, 'Schedule', `Every ${outsideReaderCadence(current.cadenceHours)}`);
  appendOutsideReaderDefinitionField(fields, 'State', `${current.status} · revision ${current.revision}`);
  const sources = document.createElement('ul');
  sources.className = 'outside-reader-exact-sources';
  for (const label of outsideReaderSelectedNames(current)) {
    const item = document.createElement('li');
    item.textContent = label;
    sources.append(item);
  }
  const sourceHeading = document.createElement('h4');
  sourceHeading.textContent = `Sources (${current.source?.recordIds?.length || 0})`;
  const rawDefinition = outsideReaderDisclosure('Raw definition', 'definition-raw', openDisclosures, current.name);
  const exact = document.createElement('pre');
  exact.className = 'changes-exact';
  exact.textContent = JSON.stringify(exactDefinition, null, 2);
  rawDefinition.content.append(exact);
  definition.content.append(fields, sourceHeading, sources, rawDefinition.details);
  body.append(definition.details);

  const versions = inspection.versions || [];
  const history = outsideReaderDisclosure(`History (${versions.length})`, 'history', openDisclosures, current.name);
  for (const version of versions) {
    const item = document.createElement('div');
    item.className = 'outside-reader-history-row';
    const when = document.createElement('time');
    when.dateTime = version.at;
    when.textContent = `r${version.revision} · ${outsideReaderDate(version.at)}`;
    const copy = document.createElement('span');
    copy.textContent = `${version.action} by ${version.by}`;
    const versionValue = outsideReaderDisclosure(`View revision ${version.revision}`, `version:${version.revision}`, openDisclosures, current.name);
    const versionExact = document.createElement('pre');
    versionExact.className = 'changes-exact';
    versionExact.textContent = JSON.stringify(version.value, null, 2);
    versionValue.content.append(versionExact);
    item.append(when, copy, versionValue.details);
    if (version.revision !== current.revision && current.status !== 'removed' && !current.running) {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'outside-reader-button';
      restore.textContent = 'Restore';
      restore.disabled = outsideReaders.busy;
      restore.dataset.outsideReaderAction = `restore-version:${version.revision}`;
      restore.setAttribute('aria-label', `Restore ${current.name} from definition revision ${version.revision}`);
      restore.addEventListener('click', () => { void restoreOutsideReaderVersion(current, version); });
      item.append(restore);
    }
    history.content.append(item);
  }
  body.append(history.details);

  const retainedFindings = (inspection.findings || []).length
    ? inspection.findings.map(finding => ({ finding, receipt: null }))
    : (inspection.receipts || []).flatMap(receipt => (receipt.findings || []).map(finding => ({ finding, receipt })));
  const leads = outsideReaderDisclosure(`Review leads (${retainedFindings.length})`, 'leads', openDisclosures, current.name);
  for (const item of retainedFindings) leads.content.append(outsideReaderFindingCard(item.finding, item.receipt));
  body.append(leads.details);

  const receipts = inspection.receipts || [];
  const receiptSection = outsideReaderDisclosure(`Run receipts (${receipts.length})`, 'receipts', openDisclosures, current.name);
  receipts.forEach((receipt, index) => {
    const receiptKey = receipt.id || `${receipt.at}:${index}`;
    const receiptView = outsideReaderDisclosure(
      `${outsideReaderOutcomeLabel(receipt)} · ${outsideReaderDate(receipt.at)}`,
      `receipt:${receiptKey}`,
      openDisclosures,
      current.name,
    );
    receiptView.details.classList.add('outside-reader-receipt', receipt.outcome || '');
    if (receipt.provider) {
      const provider = document.createElement('p');
      provider.textContent = `Model: ${receipt.provider}`;
      receiptView.content.append(provider);
    }
    if (receipt.source) {
      const source = document.createElement('p');
      source.textContent = `Source: ${receipt.source.records} records · ${receipt.source.items} items · ${outsideReaderDate(receipt.source.observedAt)}`;
      receiptView.content.append(source);
    }
    if (receipt.note) {
      const note = document.createElement('p');
      note.textContent = receipt.note;
      receiptView.content.append(note);
    }
    const rawReceipt = outsideReaderDisclosure('Raw receipt', `receipt-raw:${receiptKey}`, openDisclosures, current.name);
    const exactReceipt = document.createElement('pre');
    exactReceipt.className = 'changes-exact';
    exactReceipt.textContent = JSON.stringify(receipt, null, 2);
    rawReceipt.content.append(exactReceipt);
    receiptView.content.append(rawReceipt.details);
    receiptSection.content.append(receiptView.details);
  });
  body.append(receiptSection.details);
}

async function loadOutsideReaderInspection(row, body, retry, openDisclosures = new Set()) {
  clear(body);
  body.setAttribute('aria-busy', 'true');
  const loading = document.createElement('p');
  loading.setAttribute('role', 'status');
  loading.textContent = 'Loading inspection…';
  body.append(loading);
  try {
    let inspection = outsideReaders.inspections.get(row.id);
    if (!inspection) {
      const response = await requestOutsideReaderInspection(row.id);
      inspection = response.inspection;
      applyOutsideReaderView(response.outsideReaders, inspection);
    }
    if (!body.isConnected) return true;
    body.removeAttribute('aria-busy');
    renderOutsideReaderInspection(body, row, inspection, openDisclosures);
    restoreOutsideReaderFocus();
    return true;
  } catch (error) {
    if (!body.isConnected) return false;
    body.removeAttribute('aria-busy');
    clear(body);
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = error instanceof Error ? error.message : String(error);
    const retryButton = outsideReaderButton('Retry inspection', () => {
      outsideReaders.pendingFocus = { id: row.id, action: 'inspect' };
      void retry();
    }, {
      actionKey: 'retry-inspection',
      accessibleLabel: `Retry inspection for ${row.name}`,
    });
    body.append(message, retryButton);
    restoreOutsideReaderFocus();
    return false;
  }
}

function outsideReaderButton(label, onClick, {
  danger = false, disabled = false, actionKey = '', accessibleLabel = '',
} = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'outside-reader-button';
  button.textContent = label;
  button.disabled = disabled;
  if (actionKey) button.dataset.outsideReaderAction = actionKey;
  if (accessibleLabel) button.setAttribute('aria-label', accessibleLabel);
  if (danger) button.classList.add('danger');
  button.addEventListener('click', onClick);
  return button;
}

function outsideReaderSelectedNames(row) {
  const choices = new Map(outsideReaderSourceChoices().map(source => [outsideReaderSourceId(source), outsideReaderSourceLabel(source)]));
  return (row.source?.recordIds || []).map(id => choices.get(id) ? `${choices.get(id)} [${id}]` : id);
}

function renderOutsideReaders() {
  const list = byId('outside-reader-list');
  if (!list) return;
  const preserved = captureOutsideReaderRenderState();
  clear(list);
  const rows = outsideReaderRows();
  if (!rows.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = 'No reviews yet.';
    list.append(none);
    return;
  }
  for (const row of rows) {
    const card = document.createElement('article');
    card.className = `outside-reader-card ${row.status}${row.running ? ' running' : ''}`;
    card.dataset.outsideReaderId = row.id;
    card.tabIndex = -1;
    const head = document.createElement('div');
    head.className = 'outside-reader-head';
    const title = document.createElement('h3');
    title.id = `outside-reader-card-title-${row.id}`;
    title.textContent = row.name;
    card.setAttribute('aria-labelledby', title.id);
    const stateLabel = document.createElement('span');
    stateLabel.className = 'outside-reader-state';
    stateLabel.textContent = row.running ? 'running' : row.status;
    const scheduleEdge = row.nextRunAt || row.lastRunAt;
    head.append(title, stateLabel);
    const sourceCount = row.source?.recordIds?.length || 0;
    const schedule = document.createElement('p');
    schedule.className = 'outside-reader-card-meta';
    schedule.textContent = `Every ${outsideReaderCadence(row.cadenceHours)} · ${sourceCount} record${sourceCount === 1 ? '' : 's'} · ${scheduleEdge ? (row.nextRunAt ? `next ${outsideReaderDate(row.nextRunAt)}` : `last ${outsideReaderDate(row.lastRunAt)}`) : 'not run yet'}`;
    card.append(head, schedule);

    if (row.lastReceipt) {
      const receipt = document.createElement('p');
      receipt.className = `outside-reader-last-outcome ${row.lastReceipt.outcome || ''}`;
      receipt.textContent = `Last: ${outsideReaderOutcomeLabel(row.lastReceipt)} · ${outsideReaderDate(row.lastReceipt.at)}`;
      card.append(receipt);
    }

    const actions = document.createElement('div');
    actions.className = 'outside-reader-actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', `Actions for ${row.name}`);
    const disabled = outsideReaders.busy || row.running;
    if (['active', 'paused'].includes(row.status)) actions.append(outsideReaderButton('Run now', () => { void outsideReaderControl('run', row); }, {
      disabled: disabled || !outsideReaders.view?.runnable || state.busy,
      actionKey: 'run',
      accessibleLabel: `Run ${row.name} now`,
    }));
    if (row.status === 'active') actions.append(outsideReaderButton('Pause', () => { void outsideReaderControl('pause', row); }, {
      disabled, actionKey: 'pause', accessibleLabel: `Pause ${row.name}`,
    }));
    if (row.status === 'paused') actions.append(outsideReaderButton('Resume', () => { void outsideReaderControl('resume', row); }, {
      disabled, actionKey: 'resume', accessibleLabel: `Resume ${row.name}`,
    }));
    if (row.status !== 'removed') actions.append(outsideReaderButton('Edit', () => editOutsideReader(row), {
      disabled, actionKey: 'edit', accessibleLabel: `Edit ${row.name}`,
    }));
    if (row.status !== 'removed') actions.append(outsideReaderButton('Remove', () => {
      if (window.confirm(`Remove “${row.name}”? History is kept.`)) void outsideReaderControl('remove', row);
    }, {
      danger: true, disabled, actionKey: 'remove', accessibleLabel: `Remove ${row.name} and keep its history`,
    }));
    if (row.status === 'removed') actions.append(outsideReaderButton('Restore', () => { void outsideReaderControl('restore', row); }, {
      disabled: outsideReaders.busy, actionKey: 'restore', accessibleLabel: `Restore ${row.name} as paused`,
    }));
    card.append(actions);

    const details = document.createElement('details');
    details.className = 'outside-reader-history';
    const summary = document.createElement('summary');
    summary.textContent = 'Inspect';
    summary.dataset.outsideReaderAction = 'inspect';
    summary.setAttribute('aria-label', `Inspect exact definition, receipts, and review leads for ${row.name}`);
    const body = document.createElement('div');
    body.className = 'outside-reader-history-body';
    details.append(summary, body);
    const openDisclosures = preserved.disclosures.get(row.id) || new Set();
    let loaded = false;
    const load = async () => {
      if (loaded) return;
      loaded = true;
      loaded = await loadOutsideReaderInspection(row, body, load, openDisclosures);
    };
    details.addEventListener('toggle', () => {
      if (!details.open || loaded) return;
      void load();
    });
    card.append(details);
    list.append(card);
    if (preserved.open.has(row.id)) {
      details.open = true;
      void load();
    }
  }
  restoreOutsideReaderFocus(preserved.focus);
}

function startOutsideReaderWatch(on) {
  clearInterval(outsideReaders.timer);
  outsideReaders.timer = null;
  if (!on) return;
  outsideReaders.timer = setInterval(async () => {
    if (state.busy || outsideReaders.busy) return;
    try { await refreshOutsideReaderView(); }
    catch { /* The next look tries again. */ }
  }, 45_000);
}

async function refreshOutsideReaderView() {
  const response = await request('/api/outside-readers/view', { method: 'POST', body: {} });
  applyOutsideReaderView(response.outsideReaders);
}

byId('outside-reader-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const definition = outsideReaderDefinitionFromForm();
    const editing = outsideReaders.editing;
    setOutsideReaderBusy(true, editing ? 'Saving the review definition…' : 'Creating the review schedule…');
    const response = await request(editing ? '/api/outside-readers/update' : '/api/outside-readers/create', {
      method: 'POST',
      body: editing
        ? { id: editing.id, expectedRevision: editing.expectedRevision, changes: definition }
        : { definition },
    });
    outsideReaders.view = response.outsideReaders;
    outsideReaders.fingerprint = JSON.stringify(outsideReaders.view);
    outsideReaders.inspections.delete(response.reader.id);
    byId('outside-reader-status').textContent = editing
      ? `Saved “${response.reader.name}” as revision ${response.reader.revision}.`
      : `Created “${response.reader.name}”.`;
    resetOutsideReaderForm();
    renderOutsideReaders();
  } catch (error) {
    byId('outside-reader-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setOutsideReaderBusy(false);
  }
});

byId('outside-reader-source-list').addEventListener('change', event => {
  const selected = selectedOutsideReaderSources();
  if (selected.length <= 24) {
    byId('outside-reader-status').textContent = `${selected.length} selected.`;
    return;
  }
  if (event.target instanceof HTMLInputElement) event.target.checked = false;
  byId('outside-reader-status').textContent = 'Choose at most 24 exact source records.';
});

byId('outside-reader-cancel').addEventListener('click', resetOutsideReaderForm);

byId('outside-reader-export').addEventListener('click', async () => {
  setOutsideReaderBusy(true, 'Preparing export…');
  try {
    const inspections = [];
    for (const row of outsideReaderRows()) {
      const response = await request('/api/outside-readers/inspect', { method: 'POST', body: { id: row.id } });
      inspections.push(response.inspection);
    }
    const { choices: _availableChoices, ...store } = outsideReaders.view || {};
    const value = {
      format: 'fieldwork-outside-reader-export/v1',
      exportedAt: new Date().toISOString(),
      store,
      inspections,
    };
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `fieldwork-outside-reader-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    byId('outside-reader-status').textContent = 'Exported.';
  } catch (error) {
    byId('outside-reader-status').textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setOutsideReaderBusy(false);
  }
});

resetOutsideReaderForm();

// ---- attachments ---------------------------------------------------------------

const ATTACH_LIMITS = { perMessage: 4, imageBytes: 5 * 1024 * 1024, textBytes: 200 * 1024 };
const attachmentImages = new Map();

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsDataURL(file);
  });
}

// Light checks before sending; the room checks again and has the final say.
async function addAttachments(files) {
  if (!state.bootstrap?.capabilities?.attachments) return;
  for (const file of files) {
    if (state.pendingAttachments.length >= ATTACH_LIMITS.perMessage) { showError(new Error(`At most ${ATTACH_LIMITS.perMessage} attachments per message.`)); break; }
    const image = /^image\//.test(file.type);
    const limit = image ? ATTACH_LIMITS.imageBytes : ATTACH_LIMITS.textBytes;
    if (file.size > limit) { showError(new Error(`"${file.name}" is too big (${image ? 'pictures up to 5 MB' : 'text files up to 200 KB'}).`)); continue; }
    try {
      const dataUrl = await readAsDataUrl(file);
      state.pendingAttachments.push({ name: file.name || (image ? 'pasted picture.png' : 'attachment'), image, dataUrl });
    } catch (error) { showError(error); }
  }
  renderAttachmentTray();
}

function renderAttachmentTray() {
  const tray = byId('attachment-tray');
  clear(tray);
  tray.hidden = !state.pendingAttachments.length;
  state.pendingAttachments.forEach((item, index) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    if (item.image) { const image = document.createElement('img'); image.src = item.dataUrl; image.alt = ''; chip.append(image); }
    const name = document.createElement(item.image ? 'span' : 'button');
    name.textContent = item.image ? item.name : `📄 ${item.name}`;
    name.title = item.image ? item.name : `Preview ${item.name}`;
    if (!item.image) {
      name.type = 'button';
      name.className = 'attachment-name';
      name.addEventListener('click', () => viewText(item.name, dataUrlText(item.dataUrl)));
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.textContent = '✕';
    remove.addEventListener('click', () => { state.pendingAttachments.splice(index, 1); renderAttachmentTray(); });
    chip.append(name, remove);
    tray.append(chip);
  });
}

// The room sends the picture itself; it becomes a data URL here because the
// page's security policy allows data: pictures but not blob: ones.
async function fetchAttachmentImage(ref) {
  const response = await fetch('/api/attachments/image', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fieldwork-token': state.token || '' },
    body: JSON.stringify({ ref }),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    let message = `Fieldwork returned ${response.status}.`;
    try { message = (await response.json()).error || message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the picture.'));
    reader.readAsDataURL(blob);
  });
}

function loadAttachmentImage(ref) {
  if (!attachmentImages.has(ref)) {
    // A failure is not remembered, so the next look tries again.
    const loading = fetchAttachmentImage(ref).catch(error => { attachmentImages.delete(ref); throw error; });
    attachmentImages.set(ref, loading);
  }
  return attachmentImages.get(ref);
}

function attachmentViewer({ preserveCollectionRequest = false } = {}) {
  if (!preserveCollectionRequest) beginCollectionViewerRequest();
  let viewer = byId('attachment-viewer');
  if (!viewer) {
    viewer = document.createElement('dialog');
    viewer.id = 'attachment-viewer';
    viewer.className = 'attachment-viewer';
    viewer.addEventListener('click', event => { if (event.target === viewer || event.target.tagName === 'IMG') viewer.close(); });
    viewer.addEventListener('close', () => { collectionState.viewerGeneration += 1; });
    document.body.append(viewer);
  }
  clear(viewer);
  return viewer;
}

function viewAttachment(src) {
  const viewer = attachmentViewer();
  const image = document.createElement('img');
  image.src = src;
  image.alt = 'Attached picture';
  viewer.append(image);
  viewer.showModal();
}

function dataUrlText(dataUrl) {
  try {
    const bytes = Uint8Array.from(atob(String(dataUrl).split(',')[1] || ''), c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch { return ''; }
}

function viewText(name, text) {
  const viewer = attachmentViewer();
  viewer.classList.add('text-view');
  const head = document.createElement('div');
  head.className = 'text-view-head';
  const title = document.createElement('span');
  title.textContent = `📄 ${name}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close preview');
  close.textContent = '✕';
  close.addEventListener('click', () => viewer.close());
  head.append(title, close);
  const body = document.createElement('pre');
  body.textContent = text || '(This file is empty.)';
  viewer.append(head, body);
  viewer.addEventListener('close', () => viewer.classList.remove('text-view'), { once: true });
  viewer.showModal();
}

function messageAttachments(rows) {
  const wrap = document.createElement('div');
  wrap.className = 'message-attachments';
  for (const row of rows) {
    if (row.kind === 'image' && row.src) {
      const image = document.createElement('img');
      image.alt = 'Attached picture';
      image.src = row.src;
      image.addEventListener('click', () => viewAttachment(row.src));
      wrap.append(image);
    } else if (row.kind === 'image') {
      const image = document.createElement('img');
      image.alt = 'Attached picture';
      loadAttachmentImage(row.ref).then(url => { image.src = url; image.addEventListener('click', () => viewAttachment(url)); })
        .catch(() => { image.replaceWith(Object.assign(document.createElement('span'), { className: 'file-chip', textContent: 'Picture no longer available' })); });
      wrap.append(image);
    } else {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'file-chip';
      chip.textContent = `📄 ${row.name}`;
      chip.title = `Preview ${row.name}`;
      chip.addEventListener('click', () => viewText(row.name, row.text));
      wrap.append(chip);
    }
  }
  return wrap;
}

byId('attach-button').addEventListener('click', () => byId('attach-input').click());
byId('attach-input').addEventListener('change', () => {
  void addAttachments([...byId('attach-input').files]);
  byId('attach-input').value = '';
});
elements.input.addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length && state.bootstrap?.capabilities?.attachments) { event.preventDefault(); void addAttachments(files); }
});
elements.composer.addEventListener('dragover', event => {
  if (!state.bootstrap?.capabilities?.attachments || !event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  elements.composer.classList.add('dropping');
});
elements.composer.addEventListener('dragleave', () => elements.composer.classList.remove('dropping'));
elements.composer.addEventListener('drop', event => {
  elements.composer.classList.remove('dropping');
  if (!state.bootstrap?.capabilities?.attachments || !event.dataTransfer?.files?.length) return;
  event.preventDefault();
  void addAttachments([...event.dataTransfer.files]);
});

// ---- moods and custom emoji ------------------------------------------------------

const emojiImages = new Map(); // name -> data URL, fetched once each
const emojiPending = new Map();

function loadEmojiImage(name) {
  if (emojiImages.has(name)) return Promise.resolve(emojiImages.get(name));
  if (!emojiPending.has(name)) {
    emojiPending.set(name, request('/api/expression/emoji/image', { method: 'POST', body: { name } })
      .then(response => { emojiImages.set(name, response.dataUrl); return response.dataUrl; })
      .finally(() => emojiPending.delete(name)));
  }
  return emojiPending.get(name);
}

// Text with :name: for known custom emoji shown as pictures. Everything else
// stays literal text; nothing is ever parsed as HTML.
// Agents misspell emoji names (":spray:" for ":sprout:"). An unknown name that
// shares its first three letters with exactly one known emoji is shown as that
// emoji; anything ambiguous stays as text rather than guessing.
function nearMissEmoji(name, known) {
  if (name.length < 3) return null;
  const candidates = [...known].filter(option => option.slice(0, 3) === name.slice(0, 3));
  return candidates.length === 1 ? candidates[0] : null;
}

// ---- formatted text ------------------------------------------------------------
// A small Markdown reader for messages: paragraphs, headings, lists, quotes,
// code, tables, links, bold, italic and strikethrough, plus custom emoji. It
// builds DOM nodes directly (never HTML strings), so message text cannot become
// markup, and links open only http(s) and mailto addresses.

const mdElement = tag => document.createElement(tag);
const BLOCK_START = /^\s{0,3}(```|~~~|#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s)/;
const RULE_LINE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const leadingSpaces = line => line.length - line.trimStart().length;
// Escapes, `code`, [links](url), bare URLs, **bold**, __bold__, ~~strike~~,
// *italic* and _italic_ (underscores only at word edges, so snake_case and
// :custom_emoji: names stay whole; italics need a letter or digit inside, so
// kaomoji like (*^▽^*) stay faces).
const INLINE_PATTERN = /\\([\\`*_~[\]()#>|!-])|`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)|(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}*_~])|\*\*(?=\S)([^\n]+?)(?<=\S)\*\*|(?<![\w_])__(?=\S)([^\n]+?)(?<=\S)__(?![\w_])|~~(?=\S)([^\n]+?)(?<=\S)~~|(?<![\w*\\])\*(?=[^\s*])(?=[^*\n]*[\p{L}\p{N}])([^\n]*?[^\s*\\])\*(?![\w*])|(?<![\w_\\])_(?=[^\s_])(?=[^_\n]*[\p{L}\p{N}])([^\n]*?[^\s_\\])_(?![\w_])/gu;

function renderRichText(node, text) {
  clear(node);
  node.classList.add('rich');
  const known = new Set((state.expression?.emoji || []).map(row => row.name));
  appendBlocks(node, String(text ?? '').replace(/\r\n?/g, '\n'), known, 0);
}

function isTableStart(lines, index) {
  return index + 1 < lines.length && lines[index].includes('|') && TABLE_DIVIDER.test(lines[index + 1]) && lines[index + 1].includes('-');
}

function appendBlocks(parent, text, known, depth) {
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = /^\s{0,3}(```|~~~)\s*([\w+.-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index += 1;
      const pre = mdElement('pre');
      const code = mdElement('code');
      code.textContent = body.join('\n');
      pre.append(code);
      parent.append(pre);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const node = mdElement(`h${Math.min(6, heading[1].length + 2)}`);
      appendInline(node, heading[2], known);
      parent.append(node);
      index += 1;
      continue;
    }
    if (RULE_LINE.test(line)) { parent.append(mdElement('hr')); index += 1; continue; }
    if (/^\s{0,3}>/.test(line) && depth < 4) {
      const body = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) body.push(lines[index++].replace(/^\s{0,3}>\s?/, ''));
      const quote = mdElement('blockquote');
      appendBlocks(quote, body.join('\n'), known, depth + 1);
      parent.append(quote);
      continue;
    }
    if (LIST_ITEM.test(line) && depth < 6) { index = appendList(parent, lines, index, known, depth); continue; }
    if (isTableStart(lines, index)) { index = appendTable(parent, lines, index, known); continue; }
    const body = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !BLOCK_START.test(lines[index]) && !RULE_LINE.test(lines[index]) && !isTableStart(lines, index)) {
      body.push(lines[index++]);
    }
    const paragraph = mdElement('p');
    body.forEach((row, rowIndex) => { if (rowIndex) paragraph.append(mdElement('br')); appendInline(paragraph, row, known); });
    parent.append(paragraph);
  }
}

function appendList(parent, lines, start, known, depth) {
  const first = LIST_ITEM.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const indent = first[1].length;
  const list = mdElement(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2], 10) !== 1) list.start = parseInt(first[2], 10);
  let index = start;
  while (index < lines.length) {
    const item = LIST_ITEM.exec(lines[index]);
    if (!item || item[1].length !== indent || /\d/.test(item[2]) !== ordered) break;
    const body = [item[3]];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim()) {
        let ahead = index + 1;
        while (ahead < lines.length && !lines[ahead].trim()) ahead += 1;
        if (ahead >= lines.length) { index = ahead; break; }
        if (leadingSpaces(lines[ahead]) > indent) { body.push(''); index += 1; continue; }
        const sibling = LIST_ITEM.exec(lines[ahead]);
        if (sibling && sibling[1].length === indent && /\d/.test(sibling[2]) === ordered) index = ahead;
        break;
      }
      if (leadingSpaces(next) > indent) { body.push(next.slice(Math.min(leadingSpaces(next), indent + 2))); index += 1; continue; }
      if (BLOCK_START.test(next) || RULE_LINE.test(next)) break;
      body.push(next.trim());
      index += 1;
    }
    const entry = mdElement('li');
    appendBlocks(entry, body.join('\n'), known, depth + 1);
    // A tight item reads as a line of text, not a paragraph.
    if (entry.firstChild?.tagName === 'P' && !body.includes('')) entry.firstChild.replaceWith(...entry.firstChild.childNodes);
    list.append(entry);
  }
  parent.append(list);
  return index;
}

function appendTable(parent, lines, start, known) {
  const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  const wrap = mdElement('div');
  wrap.className = 'table-wrap';
  const table = mdElement('table');
  const head = mdElement('thead');
  const headRow = mdElement('tr');
  for (const cell of cells(lines[start])) { const th = mdElement('th'); appendInline(th, cell, known); headRow.append(th); }
  head.append(headRow);
  const body = mdElement('tbody');
  let index = start + 2;
  while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
    const row = mdElement('tr');
    for (const cell of cells(lines[index])) { const td = mdElement('td'); appendInline(td, cell, known); row.append(td); }
    body.append(row);
    index += 1;
  }
  table.append(head, body);
  wrap.append(table);
  parent.append(wrap);
  return index;
}

function appendInline(parent, text, known) {
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > last) appendEmojiText(parent, text.slice(last, match.index), known);
    const [whole, escaped, code, label, href, bare, bold, boldUnder, strike, italic, italicUnder] = match;
    if (escaped !== undefined) {
      // "\_" keeps its backslash so ¯\_(ツ)_/¯ survives; other escapes drop it.
      parent.append(document.createTextNode(escaped === '_' ? '\\_' : escaped));
    } else if (code !== undefined) {
      const node = mdElement('code');
      node.textContent = code;
      parent.append(node);
    } else if (label !== undefined || bare !== undefined) {
      const link = mdElement('a');
      link.href = href ?? bare;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (label !== undefined) appendInline(link, label, known); else link.textContent = bare;
      parent.append(link);
    } else {
      const inner = bold ?? boldUnder ?? strike ?? italic ?? italicUnder;
      const node = mdElement(bold !== undefined || boldUnder !== undefined ? 'strong' : strike !== undefined ? 'del' : 'em');
      appendInline(node, inner, known);
      parent.append(node);
    }
    last = match.index + whole.length;
  }
  if (last < text.length) appendEmojiText(parent, text.slice(last), known);
}

function appendEmojiText(parent, text, known) {
  if (!known.size) { parent.append(document.createTextNode(text)); return; }
  let last = 0;
  for (const match of text.matchAll(/:([a-z0-9_]{2,32}):/g)) {
    const name = known.has(match[1]) ? match[1] : nearMissEmoji(match[1], known);
    if (!name) continue;
    if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
    const image = document.createElement('img');
    image.className = 'custom-emoji';
    image.alt = match[0];
    image.title = name === match[1] ? match[0] : `${match[0]} (shown as :${name}:)`;
    const cached = emojiImages.get(name);
    if (cached) image.src = cached;
    else loadEmojiImage(name).then(url => { image.src = url; }).catch(() => { image.replaceWith(document.createTextNode(match[0])); });
    parent.append(image);
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function moodGlyph(icon) {
  const span = document.createElement('span');
  span.className = 'glyph';
  if (icon?.kind === 'emoji') span.textContent = icon.value;
  else if (icon?.kind === 'image') { const image = document.createElement('img'); image.src = icon.dataUrl; image.alt = ''; span.append(image); }
  return span;
}

function renderExpression() {
  const expression = state.expression;
  const current = expression?.current;
  const agentName = state.look?.agent?.name || 'Your agent';
  const grammar = agentGrammar();
  fillMoodChip(byId('mood-chip'), `${agentName} is`, current, '');
  byId('mood-chip').hidden = !current;
  byId('mood-chip').title = current ? `${agentName} is ${current.name}${current.note ? `: ${current.note}` : ''}` : '';
  const hasMoods = Boolean(expression?.moods?.length);
  fillMoodChip(byId('my-mood-chip'), 'You are', expression?.person, 'set your mood');
  byId('my-mood-chip').hidden = !hasMoods;
  byId('my-mood-chip').title = 'Set your mood';
  if (!expression) return;
  byId('mood-current').textContent = current
    ? `Right now: ${current.name}${current.note ? ` (${current.note})` : ''}. Your agent changes this ${grammar.configured ? `for ${grammar.reflexive}` : 'independently'}.`
    : expression.moods.length ? 'Your agent has not picked a mood yet.' : 'Add moods your agent can choose from, or start with the starter set.';
  byId('mood-starter').hidden = expression.moods.length > 0;
  const moodList = byId('mood-list');
  clear(moodList);
  for (const mood of expression.moods) {
    const row = document.createElement('div');
    row.className = `expression-row${current?.name === mood.name ? ' current' : ''}`;
    const text = document.createElement('div');
    const name = document.createElement('strong');
    if (mood.color) { const swatch = document.createElement('span'); swatch.className = 'swatch'; name.append(swatch); row.dataset.moodColor = mood.color; }
    name.append(document.createTextNode(mood.name));
    const description = document.createElement('small');
    description.textContent = mood.description || '—';
    if (mood.by === 'agent') {
      const maker = document.createElement('span');
      maker.className = 'made-by';
      maker.textContent = `made by ${agentName}`;
      maker.title = `${agentName} made this mood ${grammar.configured ? `for ${grammar.reflexive}` : 'independently'}. Remove it if you don't want it, or save it below to make it yours.`;
      name.append(maker);
    }
    text.append(name, description);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => { void expressionAction('mood/remove', { name: mood.name }, 'mood-status'); });
    row.append(moodGlyph(mood.icon), text, remove);
    moodList.append(row);
  }
  const thinkingLines = expression.thinking || [];
  byId('thinking-note').textContent = thinkingLines.length
    ? `${agentName} chose these. They take turns beside a little animation while ${grammar.subject} ${agentVerb(grammar, 'works', 'work')}.`
    : `${agentName} hasn't chosen any yet, so the room shows a few plain ones; ${grammar.subject} can pick ${grammar.possessiveDeterminer} own words and faces.`;
  const preview = byId('thinking-preview');
  clear(preview);
  for (const line of thinkingLines.length ? thinkingLines : DEFAULT_THINKING) {
    const chip = document.createElement('span');
    chip.className = 'thinking-chip';
    appendEmojiText(chip, line, new Set((expression.emoji || []).map(row => row.name)));
    preview.append(chip);
  }
  byId('thinking-clear').hidden = !thinkingLines.length;
  const emojiList = byId('emoji-list');
  clear(emojiList);
  if (!expression.emoji.length) {
    const none = document.createElement('p');
    none.className = 'settings-note';
    none.textContent = 'No custom emoji yet. Give each one a name and say what it means; your agent can then use it as :name:.';
    emojiList.append(none);
  }
  for (const emoji of expression.emoji) {
    const row = document.createElement('div');
    row.className = 'expression-row';
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    const image = document.createElement('img');
    image.alt = '';
    loadEmojiImage(emoji.name).then(url => { image.src = url; }).catch(() => {});
    glyph.append(image);
    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = `:${emoji.name}:`;
    const description = document.createElement('small');
    description.textContent = emoji.description || '—';
    text.append(name, description);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => { emojiImages.delete(emoji.name); void expressionAction('emoji/remove', { name: emoji.name }, 'emoji-status'); });
    row.append(glyph, text, remove);
    emojiList.append(row);
  }
}

async function expressionAction(action, body, statusId) {
  const status = byId(statusId);
  status.textContent = 'Saving…';
  try {
    const response = await request(`/api/expression/${action}`, { method: 'POST', body });
    state.expression = response.expression;
    renderExpression();
    renderMessages(state.bootstrap.conversation?.messages || [], state.bootstrap.conversation?.omittedMessages || 0);
    status.textContent = 'Saved.';
    return true;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    return false;
  }
}

// "Moss is CURIOUS": a quiet lead-in, then the mood word in its colour.
function fillMoodChip(chip, lead, mood, empty) {
  clear(chip);
  chip.classList.toggle('unset', !mood);
  if (mood?.color) chip.dataset.moodColor = mood.color; else delete chip.dataset.moodColor;
  chip.append(document.createTextNode(lead));
  const word = document.createElement('span');
  word.className = 'mood-word';
  word.textContent = mood ? mood.name : empty;
  chip.append(word);
}

function openMoodPicker() {
  const list = byId('mood-picker-list');
  clear(list);
  for (const mood of state.expression?.moods || []) {
    const button = document.createElement('button');
    button.type = 'button';
    if (mood.color) button.dataset.moodColor = mood.color;
    button.setAttribute('aria-pressed', String(state.expression.person?.name === mood.name));
    const glyph = mood.icon?.kind === 'emoji' ? mood.icon.value : '';
    const label = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = mood.name;
    const description = document.createElement('small');
    description.textContent = mood.description ? ` · ${mood.description}` : '';
    label.append(name, description);
    button.append(document.createTextNode(glyph), label);
    button.addEventListener('click', async () => {
      if (await expressionAction('mood/mine', { name: mood.name }, 'mood-status')) byId('mood-picker').close();
    });
    list.append(button);
  }
  byId('mood-picker').showModal();
}

byId('my-mood-chip').addEventListener('click', openMoodPicker);
byId('mood-picker-close').addEventListener('click', () => byId('mood-picker').close());
byId('mood-picker').addEventListener('click', event => { if (event.target === byId('mood-picker')) byId('mood-picker').close(); });

byId('mood-chip').addEventListener('click', () => {
  byId('settings-button').click();
  selectSettingsPage('expression');
});
byId('mood-starter').addEventListener('click', () => { void expressionAction('mood/starter', {}, 'mood-status'); });
byId('mood-form').addEventListener('submit', async event => {
  event.preventDefault();
  const icon = byId('mood-icon').value.trim();
  const ok = await expressionAction('mood/define', {
    name: byId('mood-name').value, description: byId('mood-description').value,
    icon: icon ? { kind: 'emoji', value: icon } : null,
    color: byId('mood-color').value,
  }, 'mood-status');
  if (ok) byId('mood-form').reset();
});
byId('emoji-form').addEventListener('submit', event => {
  event.preventDefault();
  const file = byId('emoji-file').files?.[0];
  const status = byId('emoji-status');
  if (!file) { status.textContent = 'Choose a picture first.'; return; }
  if (file.size > 64 * 1024) { status.textContent = `Emoji pictures can be at most 64 KB; that one is ${Math.ceil(file.size / 1024)} KB.`; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    const ok = await expressionAction('emoji/add', { name: byId('emoji-name').value, description: byId('emoji-description').value, dataUrl: String(reader.result) }, 'emoji-status');
    if (ok) byId('emoji-form').reset();
  };
  reader.readAsDataURL(file);
});

// ---- Fieldworks ----------------------------------------------------------------

const FIELDWORK_STATUS = {
  running: 'Working…', completed: 'Done', exhausted: 'Used every step', stopped: 'Stopped', failed: 'Failed', interrupted: 'Interrupted',
};

function setMode(mode) {
  state.mode = mode;
  const fieldwork = mode === 'fieldwork';
  elements.modeTalk.setAttribute('aria-selected', String(!fieldwork));
  elements.modeFieldwork.setAttribute('aria-selected', String(fieldwork));
  elements.conversationList.hidden = fieldwork;
  if (fieldwork) elements.archivedConversations.hidden = true;
  elements.fieldworkList.hidden = !fieldwork;
  elements.conversationPanel.hidden = fieldwork;
  elements.fieldworkPanel.hidden = !fieldwork;
  elements.conversationSearch.value = '';
  elements.conversationSearch.placeholder = fieldwork ? 'Find a Fieldwork…' : 'Find a conversation…';
  if (fieldwork) void refreshFieldworks();
  else renderConversations();
}

function renderFieldworkList() {
  const query = elements.conversationSearch.value.trim().toLowerCase();
  const rows = state.fieldworks.filter(row => !query || row.prompt.toLowerCase().includes(query));
  clear(elements.fieldworkList);
  if (!rows.length) {
    const none = document.createElement('p');
    none.className = 'conversation-none';
    none.textContent = query ? 'No Fieldwork matches.' : 'No Fieldworks yet. Press + New to start one.';
    elements.fieldworkList.append(none);
    return;
  }
  for (const row of rows) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'conversation-item';
    if (row.id === state.fieldworkId) item.setAttribute('aria-current', 'true');
    const title = document.createElement('strong');
    title.textContent = row.prompt.replace(/\s+/g, ' ');
    title.title = row.prompt;
    const time = document.createElement('time');
    time.dateTime = row.startedAt;
    time.textContent = conversationTime(row.startedAt);
    const status = document.createElement('span');
    status.className = `status ${row.status}`;
    status.textContent = `${FIELDWORK_STATUS[row.status] ?? row.status} · ${row.stepCount} step${row.stepCount === 1 ? '' : 's'}`;
    item.append(title, time, status);
    item.addEventListener('click', () => { void openFieldwork(row.id); });
    elements.fieldworkList.append(item);
  }
}

function showFieldworkForm(prefill = '') {
  state.fieldworkId = null;
  state.fieldworkCurrent = null;
  elements.fieldworkTitle.textContent = 'A new Fieldwork';
  elements.fieldworkChip.textContent = 'New';
  elements.fieldworkChip.classList.remove('running');
  elements.fieldworkForm.hidden = false;
  elements.fieldworkDetail.hidden = true;
  elements.fieldworkError.hidden = true;
  elements.fieldworkPrompt.value = prefill;
  elements.fieldworkPrompt.focus();
  renderFieldworkList();
}

function renderFieldwork(fieldwork) {
  state.fieldworkId = fieldwork.id;
  state.fieldworkCurrent = fieldwork;
  elements.fieldworkForm.hidden = true;
  elements.fieldworkDetail.hidden = false;
  const running = fieldwork.status === 'running';
  elements.fieldworkTitle.textContent = fieldwork.prompt.replace(/\s+/g, ' ').slice(0, 90);
  elements.fieldworkChip.textContent = FIELDWORK_STATUS[fieldwork.status] ?? fieldwork.status;
  elements.fieldworkChip.classList.toggle('running', running);
  byId('fieldwork-question').textContent = fieldwork.prompt;
  const parts = [`${fieldwork.stepCount ?? fieldwork.steps.length} of ${fieldwork.maxSteps} steps`];
  if (fieldwork.model) parts.push(fieldwork.model);
  parts.push(`started ${formatTime(fieldwork.startedAt)}`);
  byId('fieldwork-meta').textContent = parts.join(' · ');
  const answer = byId('fieldwork-answer');
  answer.classList.toggle('waiting', running || !fieldwork.answer);
  if (!running && fieldwork.answer) renderRichText(answer, fieldwork.answer);
  else {
    answer.classList.remove('rich');
    const grammar = agentGrammar();
    answer.textContent = running ? `This is still running: ${grammar.subject} ${agentVerb(grammar, 'is', 'are')} working on it. You can leave this page open or come back later.`
      : fieldwork.error || 'No write-up was produced.';
  }
  const list = byId('fieldwork-step-list');
  clear(list);
  for (const step of fieldwork.steps) {
    const item = document.createElement('li');
    if (step.kind === 'note') { item.className = 'note'; item.textContent = step.text; }
    else {
      if (step.ok === false) item.className = 'failed';
      item.textContent = `${step.tool}${step.detail ? ` (${step.detail})` : ''}${step.ok === false ? ' — failed' : ''}`;
    }
    list.append(item);
  }
  if (!fieldwork.steps.length) {
    const item = document.createElement('li');
    item.className = 'note';
    const grammar = agentGrammar();
    item.textContent = running ? 'Nothing yet.' : `No tools were used; ${grammar.subject} answered directly.`;
    list.append(item);
  }
  byId('fieldwork-stop').hidden = !running;
  byId('fieldwork-again').hidden = running;
  byId('fieldwork-bring').hidden = running || !fieldwork.answer;
  renderFieldworkList();
  clearTimeout(state.fieldworkTimer);
  if (running) state.fieldworkTimer = setTimeout(() => { void openFieldwork(fieldwork.id, true); }, 2000);
}

async function refreshFieldworks() {
  try {
    const response = await request('/api/fieldworks/list', { method: 'POST', body: {} });
    state.fieldworks = response.fieldworks;
    elements.fieldworkSteps.max = String(response.limits.maxSteps);
    if (state.fieldworkId) renderFieldworkList();
    else if (response.fieldworks.length) await openFieldwork(response.activeFieldworkId ?? response.fieldworks[0].id);
    else showFieldworkForm();
  } catch (error) {
    showError(error);
  }
}

async function openFieldwork(id, quiet = false) {
  try {
    const response = await request('/api/fieldworks/get', { method: 'POST', body: { id } });
    if (quiet && state.fieldworkId !== id) return;
    const index = state.fieldworks.findIndex(row => row.id === id);
    if (index >= 0) state.fieldworks[index] = { ...state.fieldworks[index], status: response.fieldwork.status, stepCount: response.fieldwork.stepCount };
    renderFieldwork(response.fieldwork);
  } catch (error) {
    showError(error);
  }
}

elements.modeTalk.addEventListener('click', () => setMode('talk'));
elements.modeFieldwork.addEventListener('click', () => setMode('fieldwork'));

elements.fieldworkForm.addEventListener('submit', async event => {
  event.preventDefault();
  elements.fieldworkError.hidden = true;
  try {
    const response = await request('/api/fieldworks/start', {
      method: 'POST',
      body: { prompt: elements.fieldworkPrompt.value, maxSteps: Number(elements.fieldworkSteps.value) },
    });
    state.fieldworks = response.fieldworks;
    renderFieldwork(response.fieldwork);
  } catch (error) {
    elements.fieldworkError.textContent = error instanceof Error ? error.message : String(error);
    elements.fieldworkError.hidden = false;
  }
});

byId('fieldwork-stop').addEventListener('click', async () => {
  try { renderFieldwork((await request('/api/fieldworks/stop', { method: 'POST', body: { id: state.fieldworkId } })).fieldwork); }
  catch (error) { showError(error); }
});
byId('fieldwork-again').addEventListener('click', () => {
  const current = state.fieldworks.find(row => row.id === state.fieldworkId);
  showFieldworkForm(current?.prompt ?? '');
});
byId('fieldwork-bring').addEventListener('click', async () => {
  try {
    const response = await request('/api/fieldworks/bring', { method: 'POST', body: { id: state.fieldworkId } });
    setMode('talk');
    applyConversation(response);
    elements.input.focus();
  } catch (error) {
    showError(error);
  }
});

// ---- model picker ------------------------------------------------------------

const effortLabel = effort => ({
  none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra high', max: 'Maximum', ultra: 'Ultra',
}[effort] || effort);

function renderModelEffort() {
  const row = state.modelChoices?.find(choice => choice.id === state.model) ?? null;
  const advertised = Array.isArray(row?.efforts) ? row.efforts : [];
  const current = state.modelEffort ?? '';
  const visible = state.modelEffortConfigurable === true && (advertised.length > 0 || current);
  elements.modelEffortForm.hidden = !visible;
  if (!visible) return;

  clear(elements.modelEffort);
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = row?.defaultEffort
    ? `Provider default (${effortLabel(row.defaultEffort)})`
    : 'Provider default';
  elements.modelEffort.append(defaultOption);
  for (const option of advertised) {
    const item = document.createElement('option');
    item.value = option.id;
    item.textContent = effortLabel(option.id);
    if (option.description) item.title = option.description;
    elements.modelEffort.append(item);
  }
  if (current && !advertised.some(option => option.id === current)) {
    const stale = document.createElement('option');
    stale.value = current;
    stale.textContent = `${effortLabel(current)} (not currently advertised)`;
    elements.modelEffort.append(stale);
  }
  elements.modelEffort.value = current;
  // If a previously saved value disappears from the service catalogue, keep
  // the one safe exit available: returning to provider default.
  elements.modelEffort.disabled = advertised.length === 0 && !current;
  elements.modelEffortApply.disabled = elements.modelEffort.value === current;
  elements.modelEffortStatus.textContent = current ? `Using ${effortLabel(current)}` : 'Using provider default';
  elements.modelEffortNote.textContent = row?.effortSource === 'catalogue'
    ? `This model advertises these choices${row.defaultEffort ? ` and defaults to ${effortLabel(row.defaultEffort)}` : ''}. Higher effort may take longer and use more tokens.`
    : row?.effortSource === 'generic'
      ? 'This service does not advertise model-specific support. Fieldwork sends an explicit choice as reasoning_effort; an unsupported model will return a provider error.'
      : 'This model does not currently advertise reasoning-effort choices.';
}

function renderModel(model) {
  const switchable = Boolean(model?.switchable);
  elements.modelSection.hidden = !switchable;
  elements.modelChip.hidden = !switchable;
  if (!switchable) return;
  const access = state.bootstrap?.health?.provider?.access;
  const available = model.available !== false && access?.status !== 'missing';
  state.model = model.current;
  state.modelPersistent = model.persistent === true;
  state.modelAvailable = available;
  state.modelEffort = model.effort ?? null;
  state.modelEffortConfigurable = model.effortConfigurable === true;
  elements.modelChip.textContent = model.current;
  elements.modelCurrent.textContent = model.current;
  elements.modelCurrent.title = model.current;
  setText(elements.providerService, access?.label, 'Managed by host');
  const accessLabel = access?.status === 'missing'
    ? 'API key missing'
    : access?.kind === 'subscription'
      ? 'Codex sign-in'
      : access?.kind === 'api-key'
        ? access?.source === 'saved' ? 'Saved API key' : 'Environment API key'
        : access?.status === 'not-needed'
          ? 'No key needed'
          : 'Managed by host';
  setText(elements.providerAccess, accessLabel);
  elements.providerHelp.textContent = access?.help || '';
  elements.modelBrowse.disabled = !available;
  elements.modelChip.disabled = !available;
  elements.modelStatus.textContent = available
    ? (state.modelPersistent ? 'Saved across restarts' : 'Current process only')
    : state.bootstrap?.capabilities?.manageConnection
      ? 'Add the API key below; Fieldwork will restart cleanly'
      : 'Add the API key, then fully stop and start Fieldwork';
  elements.modelChip.title = available
    ? `Model: ${model.current}. Click to change.`
    : (access?.help || 'This model is not available.');
  renderModelEffort();
}

function applyModelResponse(response) {
  const model = { ...response.model, switchable: true, available: true };
  state.bootstrap = { ...state.bootstrap, model, ...(response.health ? { health: response.health } : {}) };
  renderModel(model);
  if (response.health) renderHealth(state.bootstrap);
}

const MODEL_ROWS_SHOWN = 250;

// The service's model list, fetched once per page and reused by the browser.
async function loadModelChoices() {
  if (elements.modelSection.hidden || !state.modelAvailable) return [];
  if (state.modelChoices) return state.modelChoices;
  elements.modelStatus.textContent = 'Loading models…';
  try {
    const response = await request('/api/models', { method: 'POST', body: {} });
    state.modelChoices = response.model.choices;
    state.modelEffort = response.model.effort ?? null;
    state.modelEffortConfigurable = response.model.effortConfigurable === true;
    elements.modelStatus.textContent = `${state.modelChoices.length} available${state.modelPersistent ? ' · saved across restarts' : ''}`;
    renderModelEffort();
    return state.modelChoices;
  } catch (error) {
    elements.modelStatus.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

// "openai/gpt-x" belongs to "openai"; a plain ID has no maker to group by.
const modelMaker = id => (id.includes('/') ? id.slice(0, id.indexOf('/')) : '');

function renderModelList() {
  const rows = state.modelChoices || [];
  const query = elements.modelSearch.value.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const matches = rows.filter(row => {
    const haystack = `${row.id} ${row.label}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const ordered = [...matches].sort((a, b) => byName(modelMaker(a.id), modelMaker(b.id)) || byName(a.label, b.label));
  clear(elements.modelList);
  elements.modelCount.textContent = query ? `${matches.length} of ${rows.length}` : `${rows.length} models`;
  if (!ordered.length) {
    const none = document.createElement('p');
    none.className = 'model-none';
    none.textContent = 'No model matches that search.';
    elements.modelList.append(none);
    return;
  }
  let group = null;
  for (const row of ordered.slice(0, MODEL_ROWS_SHOWN)) {
    const maker = modelMaker(row.id);
    if (maker !== group) {
      group = maker;
      if (maker || ordered.some(other => modelMaker(other.id))) {
        const heading = document.createElement('p');
        heading.className = 'model-group';
        heading.textContent = maker || 'Other';
        elements.modelList.append(heading);
      }
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'model-row';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(row.id === state.model));
    const name = document.createElement('strong');
    name.textContent = row.label || row.id;
    const id = document.createElement('code');
    id.textContent = row.id;
    item.append(name, id);
    if (row.id === state.model) {
      const mark = document.createElement('em');
      mark.textContent = 'in use';
      item.append(mark);
    }
    item.addEventListener('click', () => { void chooseModel(row.id); });
    elements.modelList.append(item);
  }
  if (ordered.length > MODEL_ROWS_SHOWN) {
    const more = document.createElement('p');
    more.className = 'model-more';
    more.textContent = `Showing ${MODEL_ROWS_SHOWN} of ${ordered.length}. Type to narrow it down.`;
    elements.modelList.append(more);
  }
}

async function openModelBrowser() {
  elements.modelSearch.value = '';
  elements.modelDialogStatus.textContent = 'Loading models…';
  clear(elements.modelList);
  elements.modelDialog.showModal();
  elements.modelSearch.focus();
  try {
    await loadModelChoices();
    elements.modelDialogStatus.textContent = 'Click a model to use it from the next message.';
    renderModelList();
  } catch (error) {
    elements.modelDialogStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function chooseModel(id) {
  if (id === state.model) { elements.modelDialog.close(); return; }
  elements.modelDialogStatus.textContent = `Switching to ${id}…`;
  try {
    const response = await request('/api/model', { method: 'POST', body: { id } });
    applyModelResponse(response);
    elements.modelStatus.textContent = `Now using ${response.model.current}${response.model.persistent ? ' · saved across restarts' : ''}`;
    elements.modelDialog.close();
  } catch (error) {
    elements.modelDialogStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

elements.modelEffort.addEventListener('change', () => {
  elements.modelEffortApply.disabled = elements.modelEffort.value === (state.modelEffort ?? '');
});

elements.modelEffortForm.addEventListener('submit', async event => {
  event.preventDefault();
  const effort = elements.modelEffort.value || null;
  if (effort === (state.modelEffort ?? null)) return;
  elements.modelEffortApply.disabled = true;
  elements.modelEffortStatus.textContent = 'Applying…';
  try {
    const response = await request('/api/model/effort', { method: 'POST', body: { effort } });
    applyModelResponse(response);
    elements.modelEffortStatus.textContent = effort
      ? `Using ${effortLabel(effort)}${response.model.persistent ? ' · saved across restarts' : ''}`
      : `Using provider default${response.model.persistent ? ' · saved across restarts' : ''}`;
  } catch (error) {
    elements.modelEffortStatus.textContent = error instanceof Error ? error.message : String(error);
    elements.modelEffortApply.disabled = false;
  }
});

elements.modelChip.addEventListener('click', () => { void openModelBrowser(); });
elements.modelBrowse.addEventListener('click', () => { void openModelBrowser(); });
byId('model-dialog-close').addEventListener('click', () => elements.modelDialog.close());
elements.modelSearch.addEventListener('input', renderModelList);
// Enter picks the first match, so typing a name and pressing Enter is enough.
elements.modelSearch.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  elements.modelList.querySelector('.model-row')?.click();
});
// A click on the dimmed backdrop closes the window.
elements.modelDialog.addEventListener('click', event => { if (event.target === elements.modelDialog) elements.modelDialog.close(); });

// ---- restarting and stopping Fieldwork ---------------------------------------------

function lifecycleScreen(titleText, bodyText) {
  const screen = document.createElement('div');
  screen.className = 'lifecycle-screen';
  const card = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = titleText;
  const text = document.createElement('p');
  text.textContent = bodyText;
  card.append(title, text);
  screen.append(card);
  document.body.append(screen);
  return { screen, text };
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForRestart({
  timeoutMs = 30_000,
  timeoutMessage = 'Fieldwork did not come back within 30 seconds. Start it again with Start Fieldwork.',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  await pause(250);
  while (Date.now() < deadline) {
    try {
      const bootstrap = await request('/api/bootstrap');
      if (bootstrap.health?.status === 'ready') return;
    } catch { /* The old process going away is an expected part of a restart. */ }
    await pause(250);
  }
  throw new Error(timeoutMessage);
}

elements.restart.addEventListener('click', async () => {
  if (!window.confirm('Restart Fieldwork? Saved conversations, memory, and files stay put. A reply still being written will stop.')) return;
  try { await request('/api/restart', { method: 'POST', body: {} }); }
  catch (error) { showError(error); return; }
  const screen = lifecycleScreen('Fieldwork is restarting', 'Everything saved stays put. Waiting for the local room to come back…');
  try {
    await waitForRestart();
    window.location.reload();
  } catch (error) {
    screen.text.textContent = error instanceof Error ? error.message : String(error);
  }
});

byId('stop-button').addEventListener('click', async () => {
  if (!window.confirm('Stop Fieldwork? Everything is saved. You can start it again with Start Fieldwork.')) return;
  try { await request('/api/shutdown', { method: 'POST', body: {} }); }
  catch (error) { showError(error); return; }
  lifecycleScreen('Fieldwork has stopped', 'Everything is saved. To come back, start it again with Start Fieldwork, then reload this page.');
});

// ---- the tour ------------------------------------------------------------------
// The room keeps its own text short; this walks a newcomer through each part,
// outlining it while the card explains it. Steps whose part is hidden are skipped.

const TOUR_SEEN = 'fieldwork-tour-seen-v1';
const tourSteps = [
  { title: 'Welcome to Fieldwork', text: "This is your agent's room, running on your own computer. Here is a quick look around; you can open this again any time with the ? button." },
  { target: '.sidebar', title: 'Conversations', text: "Every conversation is saved in your agent's folder and listed here, newest first. \"+ New\" starts a fresh one; the search box finds one by its title." },
  { target: '#mode-switch', title: 'Talk and Fieldwork', text: () => { const grammar = agentGrammar(); return `Talk is for conversations. A Fieldwork is a question or task; in the background, ${grammar.subject} ${agentVerb(grammar, 'works', 'work')} on it ${grammar.configured ? `by ${grammar.reflexive}` : 'independently'}. You read the write-up when the Fieldwork is done, see how it got there, and can bring it into a conversation.`; } },
  { target: '#messages', title: 'The chat', text: () => { const grammar = agentGrammar(); return `Your messages and the agent's replies appear as they're written. While ${grammar.subject} ${agentVerb(grammar, 'works', 'work')}, you'll see a little animation; your agent can choose ${grammar.possessiveDeterminer} words. A small \"Used a tool\" line means the agent did something, like checking ${grammar.possessiveDeterminer} memory or writing a note.`; } },
  { target: '#composer', title: 'Writing', text: 'Type here and press Enter to send. Shift+Enter starts a new line. 📎 Attach adds pictures or text files; you can also drop them here or paste a picture. Click a file to preview it.' },
  { target: '#mood-chip', title: 'Moods', text: () => { const grammar = agentGrammar(); return `How your agent is feeling: ${grammar.subject} ${agentVerb(grammar, 'picks', 'pick')} from moods you set up under Settings → Moods & emoji, each with its own colour, and can make a few of ${grammar.possessiveDeterminer} own. Click \"You are\" beside the agent mood to share your own; your agent is told.`; } },
  { target: '#model-chip', title: 'The model', text: 'The model your agent is thinking with. Click it to pick a different one; the change applies from the next message.' },
  { target: '#tab-health', tab: 'tab-health', title: 'Health', text: () => { const grammar = agentGrammar(); return `Your agent's profile: the \"roots\" files in ${grammar.possessiveDeterminer} folder that say who ${grammar.subject} ${agentVerb(grammar, 'is', 'are')}, plus the tools you gave ${grammar.object}. Click a root to edit it; every save keeps the version before it, so you can always go back.`; } },
  { target: '#tab-memory', tab: 'tab-memory', title: 'Memory', text: () => { const grammar = agentGrammar(); return `What your agent wrote down to remember. Search it here. \"History\" also shows memories ${grammar.subject} later corrected or forgot.`; } },
  { target: '#tab-receipts', tab: 'tab-receipts', title: 'Receipts', text: 'A record of each reply: which steps ran and which tools were used. Handy when you want to check what happened.' },
  { target: '#settings-button', title: 'Settings', text: 'Open the control room: connection, bridges, agents, names/icons/pronouns, agent-authored guides, moods and emoji, social check-ins, task heartbeats, goals and promises, the outside reader, appearance, and recoverable resets.' },
  { target: '#restart-button', title: 'Restarting Fieldwork', text: 'This cleanly restarts the local room without erasing conversations, memory, roots, or workspace files.' },
  { target: '#stop-button', title: 'Stopping Fieldwork', text: 'This button stops Fieldwork and saves everything. Use it if you closed the window Fieldwork started in.' },
  { title: 'Make it yours', text: () => { const grammar = agentGrammar(); return `Your agent starts blank. Open Health and click identity, relationships and voice to write who ${grammar.subject} ${agentVerb(grammar, 'is', 'are')}, who ${grammar.subject} ${agentVerb(grammar, 'knows', 'know')}, and how ${grammar.subject} ${agentVerb(grammar, 'talks', 'talk')}.`; } },
];
const tour = { index: 0, lit: null, card: byId('tour') };

function tourVisible(step) {
  if (!step.target) return true;
  const node = document.querySelector(step.target);
  return Boolean(node) && !node.hidden && node.getClientRects().length > 0;
}

function showTourStep(index) {
  const steps = tourSteps.filter(tourVisible);
  tour.index = Math.max(0, Math.min(index, steps.length - 1));
  const step = steps[tour.index];
  tour.lit?.classList.remove('tour-target');
  tour.lit = null;
  if (step.tab) selectTab(byId(step.tab));
  if (step.target) {
    tour.lit = document.querySelector(step.target);
    tour.lit.classList.add('tour-target');
    tour.lit.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  byId('tour-step').textContent = `${tour.index + 1} of ${steps.length}`;
  byId('tour-title').textContent = step.title;
  byId('tour-text').textContent = typeof step.text === 'function' ? step.text() : step.text;
  byId('tour-back').hidden = tour.index === 0;
  const last = tour.index === steps.length - 1;
  byId('tour-next').firstElementChild.textContent = last ? 'Done' : 'Next';
  tour.card.hidden = false;
  byId('tour-next').focus();
}

function closeTour() {
  tour.lit?.classList.remove('tour-target');
  tour.lit = null;
  tour.card.hidden = true;
  selectTab(byId('tab-health'));
  byId('tour-button').classList.remove('nudge');
  try { window.localStorage.setItem(TOUR_SEEN, '1'); } catch { /* The tour simply offers itself again. */ }
}

byId('tour-button').addEventListener('click', () => showTourStep(0));
byId('tour-close').addEventListener('click', closeTour);
byId('tour-back').addEventListener('click', () => showTourStep(tour.index - 1));
byId('tour-next').addEventListener('click', () => {
  if (tour.index >= tourSteps.filter(tourVisible).length - 1) closeTour();
  else showTourStep(tour.index + 1);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !tour.card.hidden) closeTour(); });

function offerTourOnce() {
  let seen = false;
  try { seen = window.localStorage.getItem(TOUR_SEEN) === '1'; } catch { seen = true; }
  if (seen) return;
  byId('tour-button').classList.add('nudge');
  showTourStep(0);
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    selectTab(tabs[next], true);
  });
});

refresh().then(offerTourOnce).catch(showError);

byId('thinking-clear').addEventListener('click', () => { void expressionAction('thinking/clear', {}, 'thinking-note'); });
