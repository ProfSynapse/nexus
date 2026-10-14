// Standalone simulation only. No persistence, provider calls, or plugin integration.
// Markup mirrors what Obsidian 1.13+ renders for Setting / SettingGroup and the control components,
// captured from the running app. Model capabilities mirror the registry (supportsThinking,
// supportsSamplingParams, contextWindow).

const paths = {
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  plug: '<path d="M12 22v-5M9 8V2m6 6V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  'pencil-line': '<path d="M12 20h9"/><path d="M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.85.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.85Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'wifi-off': '<path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M5 12.86a10 10 0 0 1 5.17-2.69M19 12.86a10 10 0 0 0-2.01-1.53M2 8.82a15 15 0 0 1 4.18-2.65M22 8.82a15 15 0 0 0-11.29-3.76M2 2l20 20"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8m8 4H8m8 4H8"/>',
  'sliders-horizontal': '<path d="M21 4h-7m-4 0H3m18 8h-9m-4 0H3m18 8h-5m-4 0H3M14 2v4M8 10v4m8 4v4"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  bot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2m16 0h2m-7-1v2m-6-2v2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  'file-input': '<path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4M2 15h10m-3 3 3-3-3-3"/>',
  'scan-search': '<path d="M3 7V5a2 2 0 0 1 2-2h2m10 0h2a2 2 0 0 1 2 2v2m0 10v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>',
};
const ic = (name, cls = '') => `<span class="nexus-icon ${cls}" data-icon="${name}"><svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg></span>`;

/* ---------------- model registry sample ---------------- */
const MODELS = {
  Anthropic: [
    { name: 'Claude Opus 5.5', think: true, temp: false, ctx: 1000000 },
    { name: 'Claude Sonnet 5.5', think: true, temp: false, ctx: 1000000 },
    { name: 'Claude Haiku 5.5', think: true, temp: false, ctx: 1000000 },
    { name: 'Claude Opus 4.6', think: true, temp: true, ctx: 200000 },
  ],
  'Mistral AI': [
    { name: 'Mistral Large Latest', think: false, temp: true, ctx: 128000 },
    { name: 'Magistral Medium', think: true, temp: true, ctx: 40000 },
  ],
};
const THINK = ['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max'];
const WORKSPACES = ['None', 'Daily Notes & Workflow', 'On Networks', 'Personal Operations', 'House Weatherization', 'Job Search Command Center'];
const PROMPTS = ['None', 'meditations-on-alignment', 'job-application-materials'];

const st = {
  surface: 'defaults',
  open: new Set(),
  semantic: 'on',
  connector: false,
  other: false,
  os: 'mac',
  node: true,
  page: null, // null | 'gs' | 'gs-chat' | 'gs-agents'
  chat: { provider: 'Anthropic', model: 'Claude Opus 5.5', think: 'High', temp: 0.5, ctx: 1000000 },
  agent: { provider: 'Anthropic', model: 'Claude Haiku 5.5', think: 'Off', temp: 0.5, ctx: 1000000 },
  web: false,
  workspace: { defaults: 'None', chat: 'On Networks' },
  workflow: 'None',
  prompt: 'None',
  pdf: true,
  pdfMode: 'Text extraction',
  pdfAuto: false,
};
const spec = m => MODELS[m.provider].find(x => x.name === m.model);
const CTX_PRESETS = [32000, 64000, 128000, 200000, 350000, 750000, 1000000];
// Presets up to the model's limit; the limit itself is always offered (covers small local models).
const ctxChoices = max => [...new Set([...CTX_PRESETS.filter(n => n < max), max])];
const fmtCtx = n => n >= 1000000 ? `${n / 1000000}M` : `${Math.round(n / 1000)}K`;
const isChat = () => st.surface === 'chat';

/* ---------------- Obsidian component markup ---------------- */
const opts = (arr, v) => arr.map(o => `<option${o === v ? ' selected' : ''}>${o}</option>`).join('');
const dropdown = (key, arr, v, disabled = false) => `<select class="dropdown" data-key="${key}" data-component="DropdownComponent"${disabled ? ' disabled' : ''}>${opts(arr, v)}</select>`;
const toggle = (key, on) => `<label class="checkbox-container${on ? ' is-enabled' : ''}" tabindex="0" data-toggle="${key}" data-component="ToggleComponent"><input type="checkbox" tabindex="-1"${on ? ' checked' : ''}></label>`;
const extraButton = (icon, label, attrs = '') => `<div class="clickable-icon extra-setting-button" tabindex="0" role="button" aria-label="${label}" data-component="ExtraButtonComponent" ${attrs}>${ic(icon)}</div>`;
const button = (text, cls = '', attrs = '') => `<button class="${cls}" data-component="ButtonComponent" ${attrs}>${text}</button>`;
const slider = (key, value, label, min, max, step, { disabled = false } = {}) =>
  `<span class="slider-value">${label}</span><input class="slider" type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-range="${key}" data-component="SliderComponent"${disabled ? ' disabled' : ''} aria-label="${key}">`;
function setting(name, desc, control, mods = '') {
  return `<div class="setting-item ${mods}" data-component="Setting"><div class="setting-item-info"><div class="setting-item-name">${name}</div><div class="setting-item-description">${desc}</div></div><div class="setting-item-control">${control}</div></div>`;
}
// Plain block: an Obsidian SettingGroup with no heading.
// Folds: the plugin's shared Accordion (src/components/Accordion.ts), restyled. The same component
// is used for Get started, so every accordion in Nexus looks and behaves the same.
function group(id, { icon, title, summary, body, collapsible = true }) {
  if (!collapsible) return `<div class="setting-group" data-component="SettingGroup"><div class="setting-items">${body}</div></div>`;
  const open = st.open.has(id);
  return `<div class="nexus-accordion${open ? ' is-open' : ''}" data-component="Accordion">
    <button class="nexus-accordion-toggle" data-fold="${id}" aria-expanded="${open}" aria-controls="acc-${id}">
      ${ic(icon, 'nexus-accordion-icon')}<span class="nexus-accordion-text"><span class="nexus-accordion-title">${title}</span>${open ? '' : `<span class="nexus-accordion-summary">${summary}</span>`}</span>${ic(open ? 'chevron-up' : 'chevron-down', 'nexus-accordion-chevron')}
    </button>
    <div class="nexus-accordion-content setting-group" id="acc-${id}"${open ? '' : ' hidden'}><div class="setting-items">${body}</div></div>
  </div>`;
}
const subhead = t => `<div class="setting-item nexus-subhead"><div class="setting-item-info"><div class="setting-item-name">${t}</div></div></div>`;

/* ---------------- model rows driven by capabilities ---------------- */
function coreRows(key) {
  const m = st[key];
  const s = spec(m);
  return setting('Provider', '', dropdown(`${key}.provider`, Object.keys(MODELS), m.provider))
    + setting('Model', '', dropdown(`${key}.model`, MODELS[m.provider].map(x => x.name), m.model))
    + (s.think ? setting('Thinking', '', dropdown(`${key}.think`, THINK, m.think)) : '');
}
function tuningRows(key) {
  const m = st[key];
  const s = spec(m);
  const ctx = Math.min(m.ctx, s.ctx);
  const temp = s.temp
    ? setting('Creativity', 'Lower is more focused, higher is more creative.', slider(`${key}.temp`, m.temp, m.temp.toFixed(1), 0, 1, 0.1))
    : setting('Creativity', `${m.model} sets its own temperature.`, slider(`${key}.temp`, 0.5, '—', 0, 1, 0.1, { disabled: true }), 'is-disabled');
  // SliderComponent over preset steps: setLimits(0, steps - 1, 1); the readout shows the preset size.
  const steps = ctxChoices(s.ctx);
  const idx = Math.max(0, steps.indexOf(ctx));
  return temp + setting('Context window', 'Older messages are summarized past this size.',
    `<span class="slider-value nexus-ctx-value">${fmtCtx(ctx)}</span><input class="slider" type="range" min="0" max="${steps.length - 1}" step="1" value="${idx}" data-ctx="${key}" data-component="SliderComponent" aria-label="Context window" aria-valuetext="${fmtCtx(ctx)} tokens"${steps.length < 2 ? ' disabled' : ''}>`);
}
const tuningSummary = key => {
  const m = st[key]; const s = spec(m);
  return [s.temp ? `Creativity ${m.temp.toFixed(1)}` : 'Fixed temperature', `${fmtCtx(Math.min(m.ctx, s.ctx))} context`];
};

/* ---------------- semantic search states ---------------- */
function semanticGroup() {
  const on = st.semantic !== 'off';
  let body = setting('Semantic search', 'Find notes and past chats by meaning, not just exact words. Runs on this device.', toggle('semantic', on), 'mod-toggle');
  if (st.semantic === 'on' || st.semantic === 'confirm') {
    body += setting('Index', 'Kept up to date as notes and chats change.', '<div class="setting-item-value">4,512 notes · 318 chats</div>');
  } else if (st.semantic === 'indexing') {
    body += setting('Indexing', 'About 4 minutes left. You can keep working.',
      `<div class="setting-progress-bar" data-component="ProgressBarComponent" role="progressbar" aria-valuenow="42" aria-valuemin="0" aria-valuemax="100"><div class="setting-progress-bar-inner" style="width:42%"></div></div><div class="setting-item-value">1,904 / 4,512</div>${extraButton('pause', 'Pause indexing')}`);
  } else {
    body += setting('Index', 'Kept on this device, so turning search back on only re-indexes notes that changed.', '<div class="setting-item-value">Paused · 4,512 notes</div>')
      + setting('Delete index', 'Frees the space it uses. Turning search back on re-indexes the whole vault.', button('Delete index', 'mod-warning'))
      + `<div class="nexus-mock-flag-row"><span class="mock-flag">NEEDS CODE</span> There is no delete path today. Vectors stay in SQLite until “Rebuild cache”.</div>`;
  }
  const summary = { on: 'On · 4,512 notes', indexing: 'Indexing · 42%', confirm: 'On · 4,512 notes', off: 'Off · index kept' }[st.semantic];
  return group('semantic', { icon: 'scan-search', title: 'Semantic search', summary, body });
}
function confirmModal() {
  return `<div class="mock-modal-layer"><div class="modal mod-confirm" data-component="Modal" role="dialog" aria-label="Turn off semantic search?">
    <div class="modal-close-button" aria-label="Close">${ic('x')}</div>
    <div class="modal-title">Turn off semantic search?</div>
    <div class="modal-content">
      <p>Nexus will match exact words only.</p>
      <ul>
        <li>Vault search falls back to keyword matching, and agents stop being offered semantic search.</li>
        <li>Searching past chats by meaning stops working.</li>
        <li>Note suggestions in chat use file names only.</li>
      </ul>
      <p class="mod-muted">Your index stays on this device, so turning it back on is quick.</p>
    </div>
    <div class="modal-button-container">${button('Cancel', '', 'data-semantic-set="on"')}${button('Turn off', 'mod-warning', 'data-semantic-set="off"')}</div>
  </div></div>`;
}

const OS = {
  mac: { node: '/opt/homebrew/bin/node', connector: '/Users/you/Documents/Vault/.obsidian/plugins/nexus/connector.js', version: 'v24.11.0' },
  win: { node: 'C:\\Program Files\\nodejs\\node.exe', connector: 'C:\\Users\\you\\Documents\\Vault\\.obsidian\\plugins\\nexus\\connector.js', version: 'v24.11.0' },
  linux: { node: '/usr/bin/node', connector: '/home/you/Vault/.obsidian/plugins/nexus/connector.js', version: 'v24.11.0' },
};
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// Same values Nexus writes for one-click apps: the resolved absolute node path and connector path,
// serialised with JSON.stringify so Windows backslashes are escaped.
const configJson = () => JSON.stringify({ mcpServers: { 'nexus-professor-synapse': { command: OS[st.os].node, args: [OS[st.os].connector] } } }, null, 2);

/* ---------------- Get started pages (in place of the tab, with a back button) ---------------- */
const backButton = (label, to) => `<button class="clickable-icon nexus-back-button" data-page="${to}" data-component="BackButton">${ic('chevron-left', 'nexus-back-button-icon')}<span>${label}</span></button>`;
const navRow = (icon, name, desc, to, value = '') => `<div class="setting-item mod-navigable" role="button" tabindex="0" data-page="${to}" data-component="Setting"><div class="setting-item-info"><div class="setting-item-name">${ic(icon, 'nexus-accordion-icon')}${name}</div><div class="setting-item-description">${desc}</div></div><div class="setting-item-control">${value ? `<div class="setting-item-value">${value}</div>` : ''}<div class="setting-item-chevron">${ic('chevron-right')}</div></div></div>`;
const status = (ok, text) => `<div class="setting-item-value nexus-status${ok ? ' is-ok' : ''}">${ok ? ic('circle-check') : ''}${text}</div>`;
const step = (n, name, desc, control) => setting(`<span class="nexus-step">${n}</span>${name}`, desc, control);
function getStartedPage() {
  const head = (back, backTo, title) => `<div class="nexus-page-head">${backButton(back, backTo)}<h2 class="nexus-page-title">${title}</h2></div>`;
  if (st.page === 'gs-chat') {
    return head('Get started', 'gs', 'Chat inside Obsidian')
      + `<div class="setting-group" data-component="SettingGroup"><div class="setting-items">`
      + step(1, 'Connect a model provider', 'An API key, a sign-in, or a local model such as Ollama.', status(true, 'Connected') + button('Open providers'))
      + step(2, 'Open the chat', 'From the ribbon icon or the “Nexus: Open chat” command.', button('Open chat', 'mod-cta'))
      + step(3, 'Start chatting', 'Ask about your notes. Nexus can read, search and edit them.', '')
      + `</div></div>`;
  }
  if (st.page === 'gs-agents') {
    const o = OS[st.os];
    const need = st.node ? '' : ' disabled';
    const blocked = st.node ? '' : status(false, 'Needs Node.js');
    return head('Get started', 'gs', 'Connect an external agent')
      + `<p class="nexus-page-lede">Let apps outside Obsidian use your vault through Nexus.</p>`
      + `<div class="setting-group" data-component="SettingGroup"><div class="setting-items">`
      + (st.node
        ? setting('Node.js', `Runs the connector. Found ${o.version} at <code>${esc(o.node)}</code>.`, status(true, 'Found'))
        : setting('Node.js', 'Every agent connection runs through Node.js, and it isn’t installed or Nexus can’t find it. Install it, then check again.', button('Install Node.js', 'mod-cta') + button('Check again', '', 'data-node-check'), 'nexus-node-missing'))
      + `</div></div>`
      + `<div class="setting-group nexus-gs-apps" data-component="SettingGroup"><div class="setting-items">`
      + setting('Claude Desktop', '', st.node ? status(true, 'Connected') + button('Open config') : blocked)
      + setting('Codex', '', (st.node ? status(false, 'Ready') : blocked) + button('Connect', 'mod-cta', need))
      + setting('Antigravity', '', (st.node ? status(false, 'Ready') : blocked) + button('Connect', 'mod-cta', need))
      + `<div class="setting-item nexus-other-row" role="button" tabindex="0" data-other aria-expanded="${st.other}" data-component="Setting"><div class="setting-item-info"><div class="setting-item-name">Other agents</div><div class="setting-item-description">Cursor, Cline, Copilot, Windsurf and others. Four steps.</div></div><div class="setting-item-control">${extraButton(st.other ? 'chevron-up' : 'chevron-down', st.other ? 'Hide steps' : 'Show steps')}</div></div>`
      + (!st.other ? '' : `<div class="nexus-other-steps">`
      + step(1, 'Create the connector file', 'connector.js lets the app talk to this vault. It goes in the Nexus plugin folder.', status(st.connector, st.connector ? 'Created' : '') + (st.connector ? '' : button('Create', 'mod-cta', 'data-connector' + need)))
      + step(2, 'Copy the config', `The Nexus entry for the app’s MCP settings, with this computer’s paths.<pre class="nexus-code">${st.node ? esc(configJson()) : 'Install Node.js first. The config needs its location.'}</pre>`, button('Copy config', '', need))
      + step(3, 'Add it to your app', `Paste it into the app’s MCP settings yourself, or paste this prompt into the agent and let it make the change.<pre class="nexus-code nexus-prompt">${st.node ? esc(`Add an MCP server to your configuration. Name: nexus-professor-synapse. Command: ${o.node}. Args: ["${o.connector}"]. Use these paths exactly. Merge it into the existing mcpServers and keep any servers already there. Then tell me where you saved it.`) : 'Install Node.js first.'}</pre>`, button('Copy prompt', '', need))
      + step(4, 'Restart the app', 'Quit and reopen it so it loads Nexus. Then ask it to list your vault’s folders to check.', '')
      + `</div>`)
      + `</div></div>`
      + `<div class="setting-group nexus-gs-cli" data-component="SettingGroup"><div class="setting-items">`
      + setting(`${ic('terminal', 'nexus-accordion-icon')}Command line`, 'Lets Claude Code, Cursor and Codex use Nexus without MCP.', status(false, 'Not installed') + button('Install'))
      + setting('Claude Code skills', '~/.claude/skills', toggle('x', true), 'mod-toggle nexus-child-row nexus-path-row')
      + setting('Cursor skills', '~/.cursor/skills', toggle('x', false), 'mod-toggle nexus-child-row nexus-path-row')
      + setting('Codex AGENTS.md', '~/.codex/AGENTS.md', toggle('x', true), 'mod-toggle nexus-child-row nexus-path-row')
      + `</div></div>`;
  }
  const can = [['pencil-line', 'Read, create and edit notes'], ['search', 'Search by keyword or by meaning'], ['layers', 'Remember context with workspaces'], ['folder', 'Organize files and folders'], ['bot', 'Run saved prompts and subagents'], ['wifi-off', 'Work offline with local models']];
  return head('Settings', '', 'Get started')
    + `<p class="nexus-page-lede">Nexus is an assistant that lives in your vault. It reads and writes your notes, searches them, and remembers context between conversations. Your data stays in your vault.</p>`
    + `<ul class="nexus-can">${can.map(([i, t]) => `<li>${ic(i)}<span>${t}</span></li>`).join('')}</ul>`
    + `<div class="setting-item setting-item-heading nexus-gs-heading"><div class="setting-item-info"><div class="setting-item-name">Choose your setup</div><div class="setting-item-description">Pick one, or use both.</div></div></div>`
    + `<div class="setting-group" data-component="SettingGroup"><div class="setting-items">`
    + navRow('message-square', 'Chat inside Obsidian', 'Connect a model provider and chat in a side panel.', 'gs-chat', 'Ready')
    + navRow('plug', 'Connect an external agent', 'Claude Desktop, Codex, Cursor and more use your vault.', 'gs-agents', '2 connected')
    + `</div></div>`;
}

/* ---------------- the surface ---------------- */
function body() {
  const chat = isChat();
  const ws = st.workspace[st.surface];
  const notes = chat ? ['Episode 05 outline', 'Vault Map of Content', 'AGENTS'] : ['Vault Map of Content', 'AGENTS'];
  let h = group('main', { body: coreRows('chat'), collapsible: false });

  h += group('chat-options', {
    icon: 'sliders-horizontal', title: 'Chat options',
    summary: [...tuningSummary('chat'), ...(chat ? [`Web search ${st.web ? 'on' : 'off'}`] : [])].join(' · '),
    body: tuningRows('chat') + (chat ? setting('Web search', 'Let the model search the web when needed.', toggle('web', st.web), 'mod-toggle') : ''),
  });

  h += group('context', {
    icon: 'layers', title: 'Context',
    summary: [ws === 'None' ? 'No workspace' : ws, st.prompt === 'None' ? 'No prompt' : st.prompt, `${notes.length} notes`].join(' · '),
    body: setting('Workspace', '', dropdown('workspace', WORKSPACES, ws))
      + (chat ? setting('Workflow', 'Loads its instructions and tools. Steps run only when you ask.', dropdown('workflow', ['None', 'Episode prep'], st.workflow)) : '')
      + setting('Prompt', '', dropdown('prompt', PROMPTS, st.prompt))
      + setting('Context notes', '', button('Add note'))
      + notes.map(n => setting(`${ic('file-text', 'nexus-note-icon')}${n}`, '', extraButton('x', `Remove ${n}`), 'nexus-note-row')).join(''),
  });

  const a = st.agent; const as = spec(a);
  h += group('subagents', {
    icon: 'bot', title: 'Subagents',
    summary: [a.model, as.think ? (a.think === 'Off' ? 'Thinking off' : `${a.think} thinking`) : null, ...tuningSummary('agent')].filter(Boolean).join(' · '),
    body: setting('Used for', 'Subagents, saved prompts and automations. Must be a cloud model.', '', 'nexus-note')
      + coreRows('agent') + tuningRows('agent'),
  });

  h += group('images', { icon: 'image', title: 'Images', summary: 'Gemini 3.1 Flash Image',
    body: setting('Provider', '', dropdown('x', ['Google AI', 'OpenAI', 'OpenRouter'], 'Google AI')) + setting('Model', '', dropdown('x', ['Gemini 3.1 Flash Image'], 'Gemini 3.1 Flash Image')) });

  if (!chat) {
    h += group('video', { icon: 'film', title: 'Video', summary: 'Veo 3.1 · 16:9 · 720p',
      body: setting('Provider', '', dropdown('x', ['Google AI'], 'Google AI')) + setting('Model', '', dropdown('x', ['Veo 3.1'], 'Veo 3.1'))
        + setting('Aspect ratio', '', dropdown('x', ['16:9', '9:16'], '16:9')) + setting('Resolution', '', dropdown('x', ['720p', '1080p'], '720p')) });
  }

  h += group('voice', { icon: 'mic', title: 'Voice', summary: 'Deepgram Nova-3 · HeyGen Voice (Alloy)',
    body: subhead('Transcription')
      + setting('Provider', 'Chat microphone and audio files.', dropdown('x', ['OpenRouter', 'Deepgram', 'AssemblyAI'], 'OpenRouter')) + setting('Model', '', dropdown('x', ['Deepgram Nova-3'], 'Deepgram Nova-3'))
      + subhead('Read aloud')
      + setting('Provider', '', dropdown('x', ['OpenRouter'], 'OpenRouter')) + setting('Model', '', dropdown('x', ['HeyGen Voice'], 'HeyGen Voice')) + setting('Voice', '', dropdown('x', ['Provider default', 'Alloy', 'Verse'], 'Alloy'))
      + (chat ? '' : setting('Saved audio folder', 'Inside the Nexus data folder.', '<input type="text" spellcheck="false" value="audio" data-component="TextComponent" aria-label="Saved audio folder">'))
      + subhead('Live voice')
      + setting('Provider', 'None of your providers offer live voice.', dropdown('x', ['None available'], 'None available', true), 'is-disabled')
      + setting('Model', '', dropdown('x', ['—'], '—', true), 'is-disabled') + setting('Output', '', dropdown('x', ['Provider default'], 'Provider default', true), 'is-disabled') });

  if (!chat) {
    const vision = st.pdfMode === 'Vision';
    h += group('file-conversion', { icon: 'file-input', title: 'File conversion',
      summary: st.pdf ? `PDF import on · ${st.pdfMode}${st.pdfAuto ? ' · auto-convert' : ''}` : 'PDF import off',
      body: setting('PDF import', 'Drop PDFs into chat to turn them into notes.', toggle('pdf', st.pdf), 'mod-toggle')
        + (st.pdf ? setting('Reading method', 'Text is free. Vision reads scanned pages with a model.', dropdown('pdfMode', ['Text extraction', 'Vision'], st.pdfMode))
          + (vision ? setting('Vision provider', '', dropdown('x', ['Google AI', 'OpenRouter'], 'Google AI')) + setting('Vision model', '', dropdown('x', ['Gemini 3 Flash'], 'Gemini 3 Flash')) : '')
          + setting('Convert new PDFs automatically', 'Adds a Markdown note next to each PDF added to the vault.', toggle('pdfAuto', st.pdfAuto), 'mod-toggle') : '') });
    h += semanticGroup();
  }
  return h;
}

function frame(inner) {
  if (!isChat()) {
    return `<div class="mock-settings-window"><div class="vertical-tab-content">
      ${st.page ? getStartedPage() : `<div class="mock-preview-label">Get started: replaces the accordion above the tabs</div>
      <div class="setting-group nexus-get-started" data-component="SettingGroup"><div class="setting-items">${navRow('rocket', 'Get started', 'Set up chat in Obsidian, or connect Claude Desktop, Codex and other agents.', 'gs')}</div></div>
      <div class="mock-unchanged mock-unchanged-after" aria-hidden="true"><span class="mock-unchanged-label">Unchanged</span><span class="is-active">Defaults</span><span>Workspaces</span><span>Instructions</span><span>Providers</span><span>Remote agents</span><span>Apps</span><span>Data</span></div>
      <div class="nexus-defaults">${inner}</div>`}</div>${st.semantic === 'confirm' ? confirmModal() : ''}</div>`;
  }
  return `<div class="mock-chat-window"><div class="mock-chat-behind" aria-hidden="true"><div></div><div></div><div></div></div>
    <div class="modal chat-settings-modal" data-component="Modal" role="dialog" aria-label="Chat settings">
      <div class="modal-close-button" aria-label="Close">${ic('x')}</div>
      <div class="modal-title">Chat settings</div>
      <div class="modal-content chat-settings-renderer">${inner}</div>
      <div class="modal-button-container">${button('Cancel')}${button('Save', 'mod-cta')}</div>
    </div></div>`;
}

/* ---------------- side notes ---------------- */
function context() {
  const common = `<h2>Built from Obsidian parts</h2><ul>
    <li><strong>SettingGroup</strong> for every block: a rounded card with its heading outside, like Obsidian’s own Appearance tab.</li>
    <li><strong>Setting</strong> rows with <strong>DropdownComponent</strong>, <strong>ToggleComponent</strong>, <strong>SliderComponent</strong>, <strong>TextComponent</strong>, <strong>ButtonComponent</strong> and <strong>ExtraButtonComponent</strong> for reset and remove.</li>
    <li><strong>Context window</strong> is a SliderComponent that snaps to set sizes: 32K, 64K, 128K, 200K, 350K, 750K, 1M. Sizes above the model’s limit are left out, and the model’s own limit is always the last stop. Small local models (LM Studio, WebLLM), which can be under 32K, get a single stop and the slider is disabled.</li>
    <li><strong>Folds use the plugin’s existing Accordion</strong> (<code>src/components/Accordion.ts</code>), restyled, so every accordion in Nexus matches.</li>
    <li><strong>Node.js comes first</strong> on the external agent page. It uses the existing lookup (<code>which</code>, or <code>where</code> on Windows). If Node is missing, every Connect, Create and Copy is disabled with “Needs Node.js”. Today the copyable config falls back to a bare <code>node</code>, which often fails on macOS because apps opened from the Dock don’t see the terminal’s PATH.</li>
    <li><strong>Config, prompt and paths follow the OS.</strong> They use the absolute Node and connector paths for this computer, written with <code>JSON.stringify</code> so Windows backslashes are escaped. The copied prompt says “use these paths exactly”. Use the OS and Node.js switches above to check each case.</li>
    <li><strong>Get started is one row</strong> above the tabs; the whole row opens a page in place of the tab, with the plugin’s existing BackButton: intro → choose a setup → <em>Chat inside Obsidian</em> or <em>Connect an external agent</em>. Each step back goes up one level.</li>
    <li><strong>Chat settings</strong> stays an Obsidian <strong>Modal</strong> with the standard close button and Cancel / Save.</li>
  </ul>`;
  const semantic = isChat() ? '' : `<h2>Turning off semantic search</h2>
    <p class="mock-p">It’s on by default and almost everyone has it on, so turning it off should be deliberate and easy to undo.</p>
    <ul>
      <li><strong>Ask first.</strong> A confirmation modal explains what gets worse. Switch the state above to see it.</li>
      <li><strong>Keep the index.</strong> Turning it back on only re-indexes notes that changed, which is how re-enabling works today.</li>
      <li><strong>Deleting the index is a separate, explicit button.</strong> <span class="mock-flag">NEEDS CODE</span></li>
      <li><strong>Apply right away.</strong> Stop the watchers and unload the model without a restart. <span class="mock-flag">NEEDS CODE</span> Today it only takes effect after restarting Obsidian.</li>
      <li><strong>Show index status</strong> using <code>getStats()</code> and the indexing queue’s progress, which already exist but no screen uses.</li>
    </ul>
    <h2>Problems this surfaced</h2>
    <ul class="mock-warn">
      <li>When it’s off, search tools still offer semantic search to agents, and the error they get back says it is “still initializing”.</li>
      <li>Index entries for notes deleted while it was off are never removed.</li>
      <li>Five places look up an <code>embeddingService</code> that nothing registers, so searching past chats and semantic note suggestions may never work, even when it’s on. Worth checking before anything else.</li>
    </ul>`;
  document.getElementById('mock-context').innerHTML = common + semantic
    + '<p class="mock-caption">Model capabilities come from the registry: Opus, Sonnet and Haiku 5.5 reject temperature, Opus 4.6 accepts it, Mistral Large can’t reason, and Magistral Medium has a 40K context.</p>';
}

/* ---------------- wiring ---------------- */
const stage = document.getElementById('mock-stage');
function render() {
  const scroller = stage.querySelector('.vertical-tab-content, .modal-content');
  const top = scroller ? scroller.scrollTop : 0;
  stage.innerHTML = frame(body());
  // Mock-only labels naming the Obsidian component behind each control (shown with "Label components").
  stage.querySelectorAll('[data-component]').forEach(el => {
    const name = el.dataset.component;
    if (name === 'Setting') return;
    const tag = document.createElement('span');
    tag.className = 'mock-comp-tag';
    tag.textContent = name;
    if (name === 'SettingGroup' || name === 'Modal' || name === 'Accordion') { tag.classList.add('is-group'); el.prepend(tag); } else el.before(tag);
  });
  const next = stage.querySelector('.vertical-tab-content, .chat-settings-renderer');
  if (next) next.scrollTop = top;
  document.querySelectorAll('[data-surface]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.surface === st.surface)));
  document.getElementById('mock-semantic-wrap').hidden = isChat();
  document.getElementById('mock-semantic').value = st.semantic;
  document.getElementById('mock-os').value = st.os;
  document.getElementById('mock-node').value = st.node ? 'found' : 'missing';
  context();
}

stage.addEventListener('change', e => {
  const key = e.target.dataset.key;
  if (!key || key === 'x') return;
  const [a, b] = key.split('.');
  if (b) {
    st[a][b] = e.target.value;
    if (b === 'provider' || b === 'model') { if (b === 'provider') st[a].model = MODELS[st[a].provider][0].name; st[a].ctx = spec(st[a]).ctx; }
  } else if (a === 'workspace') st.workspace[st.surface] = e.target.value;
  else st[a] = e.target.value;
  render();
});
stage.addEventListener('input', e => {
  const c = e.target.dataset.ctx;
  if (c) {
    st[c].ctx = ctxChoices(spec(st[c]).ctx)[Number(e.target.value)];
    e.target.closest('.setting-item-control').querySelector('.slider-value').textContent = fmtCtx(st[c].ctx);
    e.target.setAttribute('aria-valuetext', `${fmtCtx(st[c].ctx)} tokens`);
    return;
  }
  const r = e.target.dataset.range;
  if (!r) return;
  const [a, b] = r.split('.');
  st[a].temp = Number(e.target.value);
  e.target.closest('.setting-item-control').querySelector('.slider-value').textContent = st[a].temp.toFixed(1);
});
stage.addEventListener('click', e => {
  const fold = e.target.closest('[data-fold]');
  if (fold) { const id = fold.dataset.fold; st.open.has(id) ? st.open.delete(id) : st.open.add(id); render(); return; }
  if (e.target.closest('[data-other]')) { st.other = !st.other; render(); return; }
  if (e.target.closest('[data-node-check]')) { st.node = true; render(); return; }
  if (e.target.closest('[data-connector]')) { st.connector = true; render(); return; }
  const pg = e.target.closest('[data-page]');
  if (pg) { st.page = pg.dataset.page || null; stage.innerHTML = ''; render(); return; }
  const set = e.target.closest('[data-semantic-set]');
  if (set) { st.semantic = set.dataset.semanticSet; render(); return; }
  const t = e.target.closest('[data-toggle]');
  if (!t) return;
  e.preventDefault();
  const key = t.dataset.toggle;
  if (key === 'x') { t.classList.toggle('is-enabled'); return; }
  if (key === 'semantic') st.semantic = st.semantic === 'off' ? 'indexing' : 'confirm';
  else st[key] = !st[key];
  render();
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.checkbox-container, [role="button"]')) { e.preventDefault(); e.target.click(); }
  if (e.key === 'Escape' && st.semantic === 'confirm') { st.semantic = 'on'; render(); }
});
document.querySelectorAll('[data-surface]').forEach(b => b.addEventListener('click', () => { st.surface = b.dataset.surface; stage.innerHTML = ''; render(); }));
document.getElementById('mock-os').addEventListener('change', e => { st.os = e.target.value; st.page = 'gs-agents'; render(); });
document.getElementById('mock-node').addEventListener('change', e => { st.node = e.target.value === 'found'; st.page = 'gs-agents'; render(); });
document.getElementById('mock-semantic').addEventListener('change', e => { st.semantic = e.target.value; st.open.add('semantic'); render(); });
document.getElementById('mock-expand').addEventListener('click', e => {
  const all = ['chat-options', 'context', 'subagents', 'images', 'video', 'voice', 'file-conversion', 'semantic'];
  const opening = st.open.size < 3;
  st.open = opening ? new Set(all) : new Set();
  e.currentTarget.textContent = opening ? 'Close all folds' : 'Open all folds';
  render();
});
document.getElementById('mock-annotate').addEventListener('click', e => {
  const on = document.body.classList.toggle('mock-annotate');
  e.currentTarget.setAttribute('aria-pressed', String(on));
});
document.getElementById('mock-theme').addEventListener('click', e => {
  const light = document.body.classList.toggle('theme-light');
  document.body.classList.toggle('theme-dark', !light);
  e.currentTarget.setAttribute('aria-pressed', String(light));
});
document.getElementById('mock-phone').addEventListener('click', e => {
  const on = document.body.classList.toggle('is-mobile');
  e.currentTarget.setAttribute('aria-pressed', String(on));
});

render();
