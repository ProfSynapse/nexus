// Standalone simulation only. No persistence, provider calls, or plugin integration.
// Every option renders the same field inventory: the Defaults tab and ChatSettingsModal as they ship today.

const paths = {
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevrons-up-down': '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8m8 4H8m8 4H8"/>',
  sparkles: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/>',
  bot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2m16 0h2m-7-1v2m-6-2v2"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  scale: '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1ZM2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
  brain: '<path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/>',
  'sliders-horizontal': '<path d="M21 4h-7m-4 0H3m18 8h-9m-4 0H3m18 8h-5m-4 0H3M14 2v4M8 10v4m8 4v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
};
const ic = name => `<span class="nexus-icon" data-icon="${name}"><svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg></span>`;

/* ---------------- field inventory (matches what ships) ---------------- */
const THINK = ['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max'];
const WORKSPACES = ['None', 'Daily Notes & Workflow', 'On Networks', 'Personal Operations', 'House Weatherization', 'Job Search Command Center'];
const PROMPTS = ['None', 'meditations-on-alignment', 'job-application-materials'];
const PROVIDERS = ['Anthropic', 'OpenRouter', 'Google AI'];

const sections = [
  { id: 'chat', name: 'Chat model', short: 'Chat', icon: 'sparkles' },
  { id: 'context', name: 'Context', short: 'Context', icon: 'box' },
  { id: 'agent', name: 'Subagents', short: 'Subagents', icon: 'bot', desc: 'Model for subagents, saved prompts and automations. Must be a cloud model.' },
  { id: 'image', name: 'Images', short: 'Images', icon: 'image' },
  { id: 'video', name: 'Video', short: 'Video', icon: 'film', only: 'defaults' },
  { id: 'voice', name: 'Voice', short: 'Voice', icon: 'mic' },
  { id: 'files', name: 'Files and search', short: 'Files', icon: 'file', only: 'defaults' },
];

const fields = [
  { id: 'chat-model', sec: 'chat', name: 'Model', kind: 'model', value: 'Claude Opus 5.5', chatValue: 'Claude Sonnet 5.5', provider: 'Anthropic', common: true },
  { id: 'chat-thinking', sec: 'chat', name: 'Thinking', kind: 'select', opts: THINK, value: 'High', common: true, desc: 'Off turns reasoning off. Hidden for models that can’t reason.' },
  { id: 'creativity', sec: 'chat', name: 'Creativity', kind: 'slider', value: '0.5', min: 0, max: 1, step: 0.1, desc: 'Lower is more focused, higher is more creative.' },
  { id: 'chat-context', sec: 'chat', name: 'Context window', kind: 'slider', value: '1M tokens', min: 0, max: 100, step: 1, desc: 'Older messages are summarized past this size.' },
  { id: 'web-search', sec: 'chat', name: 'Web search', kind: 'toggle', value: false, only: 'chat', desc: 'Let the model search the web when needed.' },
  { id: 'workspace', sec: 'context', name: 'Workspace', kind: 'select', opts: WORKSPACES, value: 'None', chatValue: 'On Networks', common: true },
  { id: 'workflow', sec: 'context', name: 'Workflow', kind: 'select', opts: ['None', 'Episode prep'], value: 'None', only: 'chat', desc: 'Loads its instructions and tools. Steps run only when you ask.' },
  { id: 'prompt', sec: 'context', name: 'Prompt', kind: 'select', opts: PROMPTS, value: 'None', common: true },
  { id: 'notes', sec: 'context', name: 'Context notes', kind: 'notes', value: ['Vault Map of Content', 'AGENTS'] },
  { id: 'agent-model', sec: 'agent', name: 'Model', kind: 'model', value: 'Claude Haiku 5.5', provider: 'OpenRouter' },
  { id: 'agent-thinking', sec: 'agent', name: 'Thinking', kind: 'select', opts: THINK, value: 'Off' },
  { id: 'image-model', sec: 'image', name: 'Image model', kind: 'model', value: 'Gemini 3.1 Flash Image', provider: 'Google AI' },
  { id: 'video-model', sec: 'video', name: 'Video model', kind: 'model', value: 'Veo 3.1', provider: 'Google AI' },
  { id: 'video-aspect', sec: 'video', name: 'Aspect ratio', kind: 'select', opts: ['16:9', '9:16'], value: '16:9' },
  { id: 'video-res', sec: 'video', name: 'Resolution', kind: 'select', opts: ['720p', '1080p'], value: '720p' },
  { id: 'stt-model', sec: 'voice', name: 'Transcription', kind: 'model', value: 'Deepgram Nova-3', provider: 'OpenRouter', desc: 'Chat microphone and audio files.' },
  { id: 'tts-model', sec: 'voice', name: 'Read-aloud model', kind: 'model', value: 'HeyGen Voice', provider: 'OpenRouter' },
  { id: 'tts-voice', sec: 'voice', name: 'Read-aloud voice', kind: 'select', opts: ['Provider default', 'Alloy', 'Verse'], value: 'Alloy' },
  { id: 'audio-folder', sec: 'voice', name: 'Saved audio folder', kind: 'text', value: 'audio', only: 'defaults', desc: 'Inside the Nexus data folder.' },
  { id: 'live-model', sec: 'voice', name: 'Live voice model', kind: 'model', value: 'None available', provider: '', disabled: true, desc: 'None of your providers offer live voice.' },
  { id: 'live-output', sec: 'voice', name: 'Live voice output', kind: 'select', opts: ['Provider default'], value: 'Provider default', disabled: true },
  { id: 'pdf-enable', sec: 'files', name: 'PDF import', kind: 'toggle', value: true, only: 'defaults', desc: 'Drop PDFs into chat to turn them into notes.' },
  { id: 'pdf-mode', sec: 'files', name: 'Reading method', kind: 'select', opts: ['Text extraction', 'Vision'], value: 'Text extraction', only: 'defaults', desc: 'Text is free. Vision reads scanned pages with a model.', parent: 'pdf-enable' },
  { id: 'pdf-ocr', sec: 'files', name: 'Vision model', kind: 'model', value: 'Gemini 3 Flash', provider: 'Google AI', only: 'defaults', desc: 'Only used with Vision.', parent: 'pdf-enable' },
  { id: 'pdf-auto', sec: 'files', name: 'Convert new PDFs automatically', kind: 'toggle', value: false, only: 'defaults', desc: 'Adds a Markdown note next to each new PDF.', parent: 'pdf-enable' },
  { id: 'embeddings', sec: 'files', name: 'Semantic search', kind: 'toggle', value: true, only: 'defaults', desc: 'Local embeddings, about 23 MB. Applies after restart.' },
];
const F = Object.fromEntries(fields.map(f => [f.id, f]));
const secOnly = id => sections.find(x => x.id === id)?.only;
const onlyOf = x => x.only || (x.sec ? secOnly(x.sec) : undefined);
const inSurface = (x, s) => !onlyOf(x) || onlyOf(x) === s;
const secsFor = s => sections.filter(x => inSurface(x, s));
const fieldsFor = (s, sec) => fields.filter(f => inSurface(f, s) && (!sec || f.sec === sec));
const val = (f, s) => (s === 'chat' && f.chatValue) ? f.chatValue : f.value;
const show = (f, s) => {
  const v = val(f, s);
  if (f.kind === 'toggle') return v ? 'On' : 'Off';
  if (f.kind === 'notes') return `${v.length} notes`;
  return v;
};
const summary = (secId, s, n = 3) => fieldsFor(s, secId).filter(f => !f.disabled).slice(0, n).map(f => {
  if (f.id.endsWith('thinking')) return `${show(f, s)} thinking`;
  if (f.kind === 'toggle') return `${f.name} ${show(f, s).toLowerCase()}`;
  return show(f, s);
}).join(' · ');

/* ---------------- control + row primitives (Obsidian Setting shape) ---------------- */
const opts = (arr, v) => arr.map(o => `<option${o === v ? ' selected' : ''}>${o}</option>`).join('');
function control(f, s, o = {}) {
  const v = val(f, s);
  const dis = f.disabled ? ' disabled' : '';
  switch (f.kind) {
    case 'model': return `<button class="nexus-model-button"${dis}>${v}${ic('chevrons-up-down')}</button>`;
    case 'select': return `<select class="dropdown"${dis} aria-label="${f.name}">${opts(f.opts, v)}</select>`;
    case 'toggle': return `<div class="checkbox-container${v ? ' is-enabled' : ''}" role="switch" aria-checked="${!!v}" aria-label="${f.name}" tabindex="0" data-toggle="${f.id}"></div>`;
    case 'slider': return `<span class="nexus-slider-value">${v}</span><input class="slider" type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${f.id === 'creativity' ? 0.5 : 100}" aria-label="${f.name}" data-slider="${f.id}">`;
    case 'text': return `<input type="text" value="${v}" aria-label="${f.name}">`;
    case 'notes': return `<button>${o.compact ? 'Edit' : 'Add note'}</button>`;
  }
  return '';
}
function row(f, s, o = {}) {
  const desc = o.desc !== undefined ? o.desc : (f.kind === 'model' && f.provider ? f.provider : (f.desc || ''));
  const name = o.name || f.name;
  const cls = ['setting-item', f.disabled ? 'is-disabled' : '', f.parent ? 'nexus-child' : '', o.cls || ''].join(' ');
  let html = `<div class="${cls}" data-field="${f.id}" data-sec="${f.sec}" data-text="${(f.name + ' ' + desc + ' ' + f.sec).toLowerCase().replace(/"/g, '')}">
    <div class="setting-item-info"><div class="setting-item-name">${name}</div>${desc ? `<div class="setting-item-description">${desc}</div>` : ''}</div>
    <div class="setting-item-control">${o.control !== undefined ? o.control : control(f, s, o)}</div></div>`;
  if (f.kind === 'notes' && !o.compact) {
    const list = s === 'chat' ? ['Episode 05 outline', ...f.value] : f.value;
    html += list.map(n => `<div class="setting-item nexus-note-item" data-sec="${f.sec}" data-text="notes ${n.toLowerCase()}"><div class="setting-item-info"><div class="setting-item-name">${ic('file-text')}${n}</div></div><div class="setting-item-control"><button class="clickable-icon" aria-label="Remove ${n}">${ic('x')}</button></div></div>`).join('');
  }
  return html;
}
function splitModelRows(f, s) {
  return row(f, s, { name: f.sec === 'chat' || f.sec === 'agent' ? 'Provider' : `${f.name.replace(/ model$/, '')} provider`, desc: '', control: `<select class="dropdown"${f.disabled ? ' disabled' : ''}>${opts(f.provider ? PROVIDERS : ['None available'], f.provider || 'None available')}</select>` })
    + row(f, s, { desc: '', control: `<select class="dropdown"${f.disabled ? ' disabled' : ''}><option>${val(f, s)}</option></select>` });
}
const heading = (name, desc = '', ctl = '') => `<div class="setting-item setting-item-heading"><div class="setting-item-info"><div class="setting-item-name">${name}</div>${desc ? `<div class="setting-item-description">${desc}</div>` : ''}</div>${ctl ? `<div class="setting-item-control">${ctl}</div>` : ''}</div>`;
const lede = s => s === 'defaults'
  ? '<p class="nexus-defaults-lede">Used when you start a new chat.</p>'
  : '';

/* ---------------- state ---------------- */
const st = { variant: 0, surface: 'defaults', overview: true, v3: null, v4: 'chat', v8: 'chat', preset: 'deep', v9: '', v9sec: 'all', v10: ['chat-model', 'workspace'] };

/* ---------------- the ten options ---------------- */
const variants = [
  {
    name: 'Tidy list',
    tag: 'Smallest change',
    idea: 'Today’s single page with the rough edges fixed. The sections are ordered by how often they’re used, and each uses an Obsidian heading instead of a boxed panel.',
    good: ['Almost a pure restyle, with no new navigation to learn.', 'Matches every other Obsidian plugin’s settings page.'],
    cost: ['Still one long page with about 27 rows in Defaults.', 'Provider and model stay as separate dropdowns.'],
    build: 'Plain Setting rows with setHeading(). Merges the Reasoning toggle and Effort slider into one Thinking dropdown, and shows each slider value once instead of twice.',
    render(s) {
      return lede(s) + secsFor(s).map(sec => heading(sec.name, sec.desc) + fieldsFor(s, sec.id).map(f => f.kind === 'model' ? splitModelRows(f, s) : row(f, s)).join('')).join('');
    },
  },
  {
    name: 'Essentials + folds',
    tag: 'Progressive disclosure',
    idea: 'The four settings people actually change sit at the top. Every other section is folded, and its summary line shows the current values, so you can check them without opening it.',
    good: ['Short on first open. The common path takes no scrolling.', 'The summary lines make a quick audit possible.'],
    cost: ['Two places to look for chat settings (the top block and the Chat model fold).', 'Folded content is hidden from Ctrl+F.'],
    build: 'Setting rows inside <details> elements. Remembers which folds are open, per NN/g guidance. One merged model picker per job.',
    render(s) {
      const common = fields.filter(f => f.common && inSurface(f, s));
      let h = lede(s) + heading(s === 'chat' ? 'This chat' : 'New chats') + common.map(f => row(f, s)).join('');
      h += secsFor(s).map(sec => {
        const rest = fieldsFor(s, sec.id).filter(f => !f.common);
        if (!rest.length) return '';
        const label = sec.id === 'chat' ? 'More chat options' : sec.id === 'context' ? 'More context' : sec.name;
        return `<details class="nexus-fold"><summary>${ic('chevron-right')}<span class="nexus-fold-name">${label}</span><span class="nexus-fold-summary">${rest.slice(0, 3).map(f => show(f, s)).join(' · ')}</span></summary><div class="nexus-fold-body">${rest.map(f => row(f, s)).join('')}</div></details>`;
      }).join('');
      return h;
    },
  },
  {
    name: 'Drill-in pages',
    tag: 'Native sub-pages',
    idea: 'A short index with one row per section. Each row shows its current values. Clicking a row opens that section on its own page.',
    good: ['The index fits on one screen.', 'Fits Obsidian 1.13 settings pages, so each setting shows up in Obsidian’s settings search.'],
    cost: ['Changing anything takes a click to reach the page first.', 'Inside the chat modal, pages feel heavier than in Settings.'],
    build: 'Uses Obsidian 1.13’s declarative page type in Settings (raises minAppVersion from 1.10) and an in-modal back stack in Chat settings.',
    render(s) {
      if (st.v3) {
        const sec = sections.find(x => x.id === st.v3);
        return `<div class="nexus-page-header"><button class="clickable-icon" data-v3="" aria-label="Back">${ic('chevron-left')}</button><span class="nexus-page-crumb">${s === 'chat' ? 'Chat settings' : 'Defaults'}</span><span class="nexus-page-sep">/</span><h3>${sec.name}</h3></div>`
          + (sec.desc ? `<p class="nexus-defaults-lede">${sec.desc}</p>` : '')
          + fieldsFor(s, sec.id).map(f => row(f, s)).join('');
      }
      return lede(s) + secsFor(s).map(sec => `<div class="setting-item nexus-nav-row" data-v3="${sec.id}" role="button" tabindex="0">
        <div class="setting-item-info"><div class="setting-item-name">${ic(sec.icon)}${sec.name}</div><div class="setting-item-description">${summary(sec.id, s)}</div></div>
        <div class="setting-item-control">${ic('chevron-right')}</div></div>`).join('');
    },
  },
  {
    name: 'Section sidebar',
    tag: 'Master–detail',
    idea: 'A small section list on the left and the chosen section on the right. In the chat modal the list becomes a row of tabs.',
    good: ['Everything is one click away, and the section list never scrolls away.', 'Each pane is short.'],
    cost: ['It’s a second sidebar inside Obsidian’s own settings sidebar.', 'Narrow panes on small windows. Phone width falls back to tabs.'],
    build: 'A custom two-column layout inside the tab with Setting rows in the pane. No new primitives needed.',
    render(s) {
      const list = secsFor(s);
      if (!list.find(x => x.id === st.v4)) st.v4 = 'chat';
      const nav = list.map(sec => `<button class="nexus-side-item${sec.id === st.v4 ? ' is-active' : ''}" data-v4="${sec.id}">${ic(sec.icon)}<span>${sec.short}</span></button>`).join('');
      const sec = list.find(x => x.id === st.v4);
      return `<div class="nexus-side-layout${s === 'chat' ? ' is-tabs' : ''}"><nav class="nexus-side-nav">${nav}</nav><div class="nexus-side-pane">${heading(sec.name, sec.desc)}${fieldsFor(s, sec.id).map(f => row(f, s)).join('')}</div></div>`;
    },
  },
  {
    name: 'Model routing table',
    tag: 'Everything at a glance',
    idea: 'Nexus uses up to eight different models, each for a different job. One table lists each job, the model doing it, and that job’s options. Chat behaviour, context and file settings go underneath.',
    good: ['Every model choice is visible at once, so it’s obvious which jobs aren’t set up.', 'Matches how power users think about it: one model per job.'],
    cost: ['Dense. Can look technical to new users.', 'The table turns into stacked cards on phones.'],
    build: 'A custom table. Model cells open a searchable SuggestModal, and option cells are compact dropdowns.',
    render(s) {
      const jobs = [
        ['Chat', 'chat-model', ['chat-thinking']], ['Subagents', 'agent-model', ['agent-thinking']], ['Images', 'image-model', []],
        ['Video', 'video-model', ['video-aspect', 'video-res']], ['Transcription', 'stt-model', []], ['Read aloud', 'tts-model', ['tts-voice']],
        ['Live voice', 'live-model', ['live-output']], ['PDF vision', 'pdf-ocr', []],
      ].filter(([, m]) => inSurface(F[m], s));
      const table = `<table class="nexus-jobs"><thead><tr><th>Job</th><th>Model</th><th>Options</th></tr></thead><tbody>${jobs.map(([job, m, o]) => {
        const f = F[m];
        return `<tr class="${f.disabled ? 'is-disabled' : ''}"><td class="nexus-jobs-job">${job}</td><td><button class="nexus-model-button"${f.disabled ? ' disabled' : ''}>${val(f, s)}${ic('chevrons-up-down')}</button>${f.provider ? `<div class="nexus-jobs-provider">${f.provider}</div>` : ''}</td><td class="nexus-jobs-opts">${o.map(id => { const x = F[id]; return `<label><span>${x.name.replace('Read-aloud voice', 'Voice').replace('Live voice output', 'Output')}</span><select class="dropdown"${x.disabled ? ' disabled' : ''}>${opts(x.opts, val(x, s))}</select></label>`; }).join('') || '<span class="nexus-jobs-none">—</span>'}</td></tr>`;
      }).join('')}</tbody></table>`;
      const behavior = ['creativity', 'chat-context', 'web-search'].map(id => F[id]).filter(f => inSurface(f, s));
      const files = fieldsFor(s, 'files').filter(f => f.id !== 'pdf-ocr').concat(inSurface(F['audio-folder'], s) ? [F['audio-folder']] : []);
      return lede(s) + table + heading('Chat behaviour') + behavior.map(f => row(f, s)).join('')
        + heading('Context') + fieldsFor(s, 'context').map(f => row(f, s)).join('')
        + (files.length ? heading('Files and storage') + files.map(f => row(f, s)).join('') : '');
    },
  },
  {
    name: 'Presets',
    tag: 'Pick a mode',
    idea: 'Three presets set the chat model, thinking and creativity in one click. "Custom" opens every setting. Context and the other models sit below the presets.',
    good: ['Newcomers decide in one click without learning what "effort" means.', 'Power users still get every setting under Custom.'],
    cost: ['Presets are a new idea that has to be named and maintained, and the models in them go out of date.', 'Changing any single value quietly turns the preset into "Custom".'],
    build: 'Presets only write existing settings keys; nothing new is stored. The active preset is worked out by matching the current values.',
    render(s) {
      const ps = [
        ['quick', 'Quick', 'zap', 'Claude Haiku 5.5', 'Thinking off · creativity 0.3'],
        ['balanced', 'Balanced', 'scale', 'Claude Sonnet 5.5', 'Medium thinking · creativity 0.5'],
        ['deep', 'Deep', 'brain', 'Claude Opus 5.5', 'High thinking · creativity 0.5'],
        ['custom', 'Custom', 'sliders-horizontal', 'Your choice', 'Set everything yourself'],
      ];
      const cards = `<div class="nexus-presets" role="radiogroup" aria-label="Chat preset">${ps.map(([id, n, i, m, d]) => `<button class="nexus-preset${st.preset === id ? ' is-selected' : ''}" role="radio" aria-checked="${st.preset === id}" data-preset="${id}">${ic(i)}<strong>${n}</strong><span class="nexus-preset-model">${m}</span><span class="nexus-preset-desc">${d}</span></button>`).join('')}</div>`;
      const chatRows = fieldsFor(s, 'chat').filter(f => f.id !== 'web-search').map(f => row(f, s)).join('');
      const others = ['agent', 'image', 'video', 'voice'].filter(id => inSurface(sections.find(x => x.id === id), s));
      return lede(s) + cards
        + `<details class="nexus-fold"${st.preset === 'custom' ? ' open' : ''}><summary>${ic('chevron-right')}<span class="nexus-fold-name">Customize</span><span class="nexus-fold-summary">${summary('chat', s, 4)}</span></summary><div class="nexus-fold-body">${chatRows}</div></details>`
        + (s === 'chat' ? row(F['web-search'], s) : '')
        + heading('Context') + fieldsFor(s, 'context').map(f => row(f, s)).join('')
        + `<details class="nexus-fold"><summary>${ic('chevron-right')}<span class="nexus-fold-name">Other models</span><span class="nexus-fold-summary">Subagents, images${s === 'defaults' ? ', video' : ''}, voice</span></summary><div class="nexus-fold-body">${others.map(id => heading(sections.find(x => x.id === id).name) + fieldsFor(s, id).map(f => row(f, s)).join('')).join('')}</div></details>`
        + (s === 'defaults' ? heading('Files and search') + fieldsFor(s, 'files').map(f => row(f, s)).join('') : '');
    },
  },
  {
    name: 'Plain sentences',
    tag: 'Reads like English',
    idea: 'The settings are written as sentences, with each choice an inline dropdown. Anything that doesn’t fit a sentence goes in a short "Details" list below.',
    good: ['Very approachable. Explains what each setting does as you read it.', 'Distinctive without being decorative.'],
    cost: ['Harder to scan for one specific setting.', 'Inline dropdowns wrap awkwardly at narrow widths, and the sentences need care to translate.'],
    build: 'Custom inline tokens: native selects styled as underlined text, and buttons for the model pickers. A details list uses Setting rows.',
    render(s) {
      const t = id => { const f = F[id]; const v = val(f, s); return f.kind === 'model' ? `<button class="nexus-token">${v}</button>` : `<select class="nexus-token" aria-label="${f.name}">${opts(f.opts, v)}</select>`; };
      const onoff = (id, a, b) => `<select class="nexus-token" aria-label="${F[id].name}"><option${val(F[id], s) ? ' selected' : ''}>${a}</option><option${val(F[id], s) ? '' : ' selected'}>${b}</option></select>`;
      const p = [];
      p.push(`${s === 'chat' ? 'This chat uses' : 'New chats use'} ${t('chat-model')} with ${t('chat-thinking')} thinking.`);
      p.push(`${s === 'chat' ? 'It works' : 'They start'} in ${t('workspace')}${s === 'chat' ? ` with the ${t('workflow')} workflow,` : ''} using ${t('prompt')} as the prompt.`);
      if (s === 'chat') p.push(`Web search is ${onoff('web-search', 'allowed', 'off')}.`);
      p.push(`Subagents run on ${t('agent-model')} with ${t('agent-thinking')} thinking.`);
      p.push(`Images come from ${t('image-model')}${s === 'defaults' ? `, and video from ${t('video-model')} at ${t('video-aspect')} ${t('video-res')}` : ''}.`);
      p.push(`Dictation uses ${t('stt-model')}. Read aloud uses ${t('tts-model')} with the ${t('tts-voice')} voice.`);
      if (s === 'defaults') p.push(`Dropped PDFs are ${onoff('pdf-enable', 'imported', 'ignored')} using ${t('pdf-mode')}, and new PDFs ${onoff('pdf-auto', 'are', 'aren’t')} converted automatically.`);
      const details = ['creativity', 'chat-context', 'notes', 'live-model', 'live-output', 'pdf-ocr', 'audio-folder', 'embeddings'].map(id => F[id]).filter(f => inSurface(f, s));
      return lede(s) + `<div class="nexus-sentences">${p.map(x => `<p>${x}</p>`).join('')}</div>` + heading('Details') + details.map(f => row(f, s)).join('');
    },
  },
  {
    name: 'Tiles',
    tag: 'Visual dashboard',
    idea: 'Each section is a tile showing its main value large. Clicking a tile opens its settings in a panel under the grid.',
    good: ['Friendly and easy to scan; the most "designed" option.', 'Easy to show a warning on a tile, such as "No model available".'],
    cost: ['Takes more space for the same information.', 'Opening a panel under the grid moves the content below it.'],
    build: 'A custom CSS grid of buttons, with an editor panel of Setting rows. On phones, the tiles stack into two columns.',
    render(s) {
      const list = secsFor(s);
      if (!list.find(x => x.id === st.v8)) st.v8 = 'chat';
      const main = { chat: 'chat-model', context: 'workspace', agent: 'agent-model', image: 'image-model', video: 'video-model', voice: 'stt-model', files: 'pdf-mode' };
      const tiles = list.map(sec => { const f = F[main[sec.id]]; const sub = summary(sec.id, s).split(' · ').slice(1, 3).join(' · ');
        return `<button class="nexus-tile${st.v8 === sec.id ? ' is-active' : ''}" data-v8="${sec.id}" aria-expanded="${st.v8 === sec.id}"><span class="nexus-tile-head">${ic(sec.icon)}${sec.short}</span><span class="nexus-tile-value">${show(f, s)}</span><span class="nexus-tile-sub">${sub || '&nbsp;'}</span></button>`; }).join('');
      const sec = list.find(x => x.id === st.v8);
      return lede(s) + `<div class="nexus-tiles">${tiles}</div><div class="nexus-tile-panel">${heading(sec.name, sec.desc, `<button class="clickable-icon" data-v8="" aria-label="Close">${ic('x')}</button>`)}${fieldsFor(s, sec.id).map(f => row(f, s)).join('')}</div>`;
    },
  },
  {
    name: 'Search first',
    tag: 'Find, don’t browse',
    idea: 'A search box and section filter chips over one flat list. Each row carries a section tag, so the list stays readable while filtered.',
    good: ['The fastest way to reach a setting if you know roughly what it’s called.', 'Scales as more settings are added.'],
    cost: ['No sense of hierarchy, and every row looks equally important.', 'Duplicates Obsidian’s own settings search (1.13+).'],
    build: 'A text input and chips filter Setting rows on the client. Each row carries data-section and searchable text.',
    render(s) {
      const chips = [['all', 'All']].concat(secsFor(s).map(x => [x.id, x.short])).map(([id, n]) => `<button class="nexus-chip${st.v9sec === id ? ' is-active' : ''}" data-v9sec="${id}">${n}</button>`).join('');
      const items = fieldsFor(s).map(f => { const sec = sections.find(x => x.id === f.sec);
        return row(f, s, { name: `${f.name}<span class="nexus-tag">${sec.short}</span>` }); }).join('');
      return lede(s) + `<div class="nexus-search">${ic('search')}<input type="search" placeholder="Search ${s === 'chat' ? 'chat settings' : 'defaults'}…" value="${st.v9}" data-v9 aria-label="Search settings"></div><div class="nexus-chips">${chips}</div><div class="nexus-search-results">${items}</div><div class="nexus-empty" data-v9-empty hidden>No settings match.</div>`;
    },
    after() { applySearch(); },
  },
  {
    name: 'Defaults vs this chat',
    tag: 'Scope made explicit',
    idea: 'Defaults splits what each chat can change from what applies everywhere. Chat settings lists only what this chat changed, each with a reset. Everything else sits in a quiet "using defaults" list, where one click overrides a setting.',
    good: ['Removes the confusion over whether a change affects only this chat or every chat.', 'The chat modal is usually two or three rows long.'],
    cost: ['A new idea, overrides, that needs one clear sentence of explanation.', 'Defaults gains a second grouping on top of the sections.'],
    build: 'Uses the per-conversation settings that already exist; an override is any value that differs from the global default. Changes apply as soon as they’re made, with a Done button.',
    render(s) {
      if (s === 'defaults') {
        const perChat = fields.filter(f => inSurface(f, 'defaults') && inSurface(f, 'chat'));
        const global = fields.filter(f => onlyOf(f) === 'defaults');
        return lede(s)
          + heading('New chats start with', 'Any chat can change these from its own settings.') + perChat.map(f => row(f, s)).join('')
          + heading('Everywhere', 'These apply to every chat and can’t be changed per chat.') + global.map(f => row(f, s)).join('');
      }
      const changed = st.v10.map(id => F[id]);
      const rest = fieldsFor('chat').filter(f => !st.v10.includes(f.id));
      const defVal = { 'chat-model': 'Claude Opus 5.5', workspace: 'None' };
      return `<div class="nexus-scope-note">${ic('sparkles')}<span>Changes apply right away, to this chat only.</span></div>`
        + heading('Changed for this chat')
        + changed.map(f => row(f, 'chat', { desc: `Default: ${defVal[f.id] ?? show(f, 'defaults')}`, cls: 'is-override', control: control(f, 'chat') + `<button class="clickable-icon" data-v10-reset="${f.id}" aria-label="Reset ${f.name} to default">${ic('rotate-ccw')}</button>` })).join('')
        + heading('Using your defaults', 'Click one to change it for this chat.')
        + `<div class="nexus-inherited">${rest.map(f => `<button class="nexus-inherited-row" data-v10-add="${f.id}"><span>${f.sec === 'agent' ? `Subagent ${f.name.toLowerCase()}` : f.name}</span><span>${show(f, 'chat')}</span>${ic('plus')}</button>`).join('')}</div>`;
    },
    chatFooter: '<button class="mod-muted">Edit defaults…</button><span class="mock-spacer"></span><button class="mod-cta">Done</button>',
  },
];

/* ---------------- surface frames ---------------- */
function frame(v, s, body) {
  if (s === 'defaults') {
    return `<div class="mock-settings-window"><div class="vertical-tab-content">
      <div class="mock-unchanged" aria-hidden="true"><span class="mock-unchanged-label">Unchanged</span><span class="is-active">Defaults</span><span>Workspaces</span><span>Instructions</span><span>Providers</span><span>Remote agents</span><span>Apps</span><span>Data</span></div>
      <div class="nexus-defaults">${body}</div></div></div>`;
  }
  const footer = v.chatFooter || '<button class="mod-muted">Cancel</button><span class="mock-spacer"></span><button class="mod-cta">Save</button>';
  return `<div class="mock-chat-window"><div class="mock-chat-behind" aria-hidden="true"><div></div><div></div><div></div></div>
    <div class="modal chat-settings-modal" role="dialog" aria-label="Chat settings">
      <div class="modal-header"><div class="modal-title">Chat settings</div><button class="clickable-icon" aria-label="Close">${ic('x')}</button></div>
      <div class="modal-content chat-settings-renderer">${body}</div>
      <div class="modal-button-container">${footer}</div>
    </div></div>`;
}

/* ---------------- page wiring ---------------- */
const $ = id => document.getElementById(id);
const variantSel = $('mock-variant');
variantSel.innerHTML = variants.map((v, i) => `<option value="${i}">${i + 1}. ${v.name}</option>`).join('');

function renderContext(v, i) {
  $('mock-context').innerHTML = `<div class="mock-variant-num">Option ${i + 1} of 10</div><h2>${v.name}</h2><div class="mock-variant-tag">${v.tag}</div>
    <p>${v.idea}</p><h3>Good</h3><ul>${v.good.map(x => `<li>${x}</li>`).join('')}</ul>
    <h3>Trade-offs</h3><ul>${v.cost.map(x => `<li>${x}</li>`).join('')}</ul><h3>Build notes</h3><p class="mock-build">${v.build}</p>
    <div class="mock-nav"><button data-step="-1">← Previous</button><button data-step="1">Next →</button></div>`;
}
function renderStage() {
  const v = variants[st.variant];
  $('mock-stage').innerHTML = frame(v, st.surface, v.render(st.surface));
  renderContext(v, st.variant);
  v.after?.();
}
function renderOverview() {
  $('mock-overview-grid').innerHTML = variants.map((v, i) => `<div class="mock-thumb" data-open="${i}" role="button" tabindex="0" aria-label="Open option ${i + 1}: ${v.name}">
    <div class="mock-thumb-view"><div class="mock-thumb-inner">${frame(v, st.surface, v.render(st.surface))}</div></div>
    <div class="mock-thumb-meta"><span class="mock-thumb-num">${i + 1}</span><strong>${v.name}</strong><span>${v.tag}</span></div></div>`).join('');
}
function render() {
  $('mock-overview-grid').hidden = !st.overview;
  $('mock-detail').hidden = st.overview;
  $('mock-overview').setAttribute('aria-pressed', String(st.overview));
  variantSel.value = String(st.variant);
  document.querySelectorAll('[data-surface]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.surface === st.surface)));
  if (st.overview) renderOverview(); else renderStage();
}
function applySearch() {
  const q = st.v9.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('.nexus-search-results > .setting-item').forEach(el => {
    const ok = (st.v9sec === 'all' || el.dataset.sec === st.v9sec) && (!q || el.dataset.text.includes(q));
    el.hidden = !ok; if (ok) shown++;
  });
  const empty = document.querySelector('[data-v9-empty]');
  if (empty) empty.hidden = shown > 0;
}

document.addEventListener('click', e => {
  const t = e.target;
  const open = t.closest('[data-open]');
  if (open) { st.variant = Number(open.dataset.open); st.overview = false; render(); window.scrollTo({ top: $('mock-detail').offsetTop - 16 }); return; }
  if (t.closest('#mock-overview')) { st.overview = !st.overview; render(); return; }
  const surf = t.closest('[data-surface]');
  if (surf) { st.surface = surf.dataset.surface; st.v3 = null; render(); return; }
  const step = t.closest('[data-step]');
  if (step) { st.variant = (st.variant + Number(step.dataset.step) + 10) % 10; st.v3 = null; render(); return; }
  const v3 = t.closest('[data-v3]'); if (v3) { st.v3 = v3.dataset.v3 || null; renderStage(); return; }
  const v4 = t.closest('[data-v4]'); if (v4) { st.v4 = v4.dataset.v4; renderStage(); return; }
  const v8 = t.closest('[data-v8]');
  if (v8) { st.v8 = v8.dataset.v8 || (st.v8 ? '' : 'chat'); if (!st.v8) { document.querySelector('.nexus-tile-panel').hidden = true; document.querySelectorAll('.nexus-tile').forEach(x => x.classList.remove('is-active')); } else renderStage(); return; }
  const preset = t.closest('[data-preset]'); if (preset) { st.preset = preset.dataset.preset; renderStage(); return; }
  const v9sec = t.closest('[data-v9sec]'); if (v9sec) { st.v9sec = v9sec.dataset.v9sec; document.querySelectorAll('[data-v9sec]').forEach(c => c.classList.toggle('is-active', c === v9sec)); applySearch(); return; }
  const add = t.closest('[data-v10-add]'); if (add) { st.v10.push(add.dataset.v10Add); renderStage(); return; }
  const reset = t.closest('[data-v10-reset]'); if (reset) { st.v10 = st.v10.filter(id => id !== reset.dataset.v10Reset); renderStage(); return; }
  const tg = t.closest('.checkbox-container');
  if (tg && !t.closest('.mock-thumb')) {
    const on = !tg.classList.contains('is-enabled');
    tg.classList.toggle('is-enabled', on); tg.setAttribute('aria-checked', String(on));
    if (tg.dataset.toggle === 'pdf-enable') document.querySelectorAll('.mock-stage [data-field].nexus-child').forEach(r => { if (F[r.dataset.field]?.parent === 'pdf-enable') r.hidden = !on; });
  }
});
document.addEventListener('input', e => {
  if (e.target.matches('[data-v9]')) { st.v9 = e.target.value; applySearch(); }
  if (e.target.matches('[data-slider]')) {
    const out = e.target.previousElementSibling;
    out.textContent = e.target.dataset.slider === 'creativity' ? Number(e.target.value).toFixed(1) : (e.target.value >= 100 ? '1M tokens' : `${Math.max(8, Math.round(e.target.value * 10))}K tokens`);
  }
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"], .checkbox-container')) { e.preventDefault(); e.target.click(); }
  if (!st.overview && !e.target.matches('input, select') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { st.variant = (st.variant + (e.key === 'ArrowRight' ? 1 : -1) + 10) % 10; st.v3 = null; render(); }
});
variantSel.addEventListener('change', () => { st.variant = Number(variantSel.value); st.overview = false; st.v3 = null; render(); });
$('mock-theme').addEventListener('click', e => {
  const light = document.body.classList.toggle('theme-light');
  document.body.classList.toggle('theme-dark', !light);
  e.currentTarget.setAttribute('aria-pressed', String(light));
});
$('mock-phone').addEventListener('click', e => {
  const on = document.body.classList.toggle('is-mobile');
  e.currentTarget.setAttribute('aria-pressed', String(on));
});

render();
