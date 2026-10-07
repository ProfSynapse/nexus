/* Standalone design simulation. No fetch, plugin access, or persistent storage. */
const $ = id => document.getElementById(id);
const glyphs = {
  network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-4h14v4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z"/>',
  x: '<path d="m18 6-12 12M6 6l12 12"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-5 5V5a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2Z"/>',
  'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
  'circle-alert': '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  loader: '<path d="M12 2a10 10 0 1 1-10 10"/>',
};
function icon(name) { return `<svg data-icon="${name}" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name] || glyphs.edit}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const state = { phase: 'setup', models: [], enabled: false, timer: null, toastTimer: null, lastFocus: null, endpointId: null, view: 'list' };
let nextEndpoint = 3;
const endpoints = [
  { id: 'hermes-1', name: 'My Hermes', url: 'https://my-hermes.example.com/v1', key: 'mock-hermes-key', phase: 'connected', enabled: true, models: [sampleModel('hermes-agent')] },
  { id: 'models-2', name: 'Home models', url: 'https://models.example.com/v1', key: '', phase: 'connected', enabled: true, models: [sampleModel('local-model')] },
];
function persistEndpoint() {
  if (!state.endpointId || state.view !== 'form') return;
  const endpoint = endpoints.find(item => item.id === state.endpointId);
  if (!endpoint) return;
  Object.assign(endpoint, { name: $('connection-name').value, url: $('connection-url').value, key: $('connection-key').value, phase: state.phase, enabled: state.enabled, models: state.models });
}
function showEndpointList() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; state.phase = 'setup'; }
  persistEndpoint(); state.view = 'list'; $('endpoint-list-view').hidden = false; $('endpoint-form-view').hidden = true;
  $('modal-title').textContent = 'Configure OpenAI-compatible'; $('provider-intro').textContent = 'Connect an OpenAI-compatible endpoint to Nexus.';
  $('mock-state').value = 'connections'; renderEndpointList();
}
function renderEndpointList() {
  $('endpoint-list').replaceChildren();
  endpoints.forEach(endpoint => {
    const row = document.createElement('article'); row.className = 'agent-management-card';
    row.innerHTML = '<div class="agent-management-card-header"><div class="agent-management-card-title"></div><div class="agent-management-card-actions"><button class="checkbox-container" role="switch"></button><button class="clickable-icon" aria-label="Edit endpoint"></button></div></div><div class="agent-management-card-description"></div><div class="nexus-endpoint-address"></div>';
    row.querySelector('.agent-management-card-title').textContent = endpoint.name || 'New endpoint';
    const enabledModels = endpoint.models.filter(model => model.enabled);
    row.querySelector('.agent-management-card-description').textContent = `${enabledModels.length} ${enabledModels.length === 1 ? 'model' : 'models'} enabled`;
    row.querySelector('.nexus-endpoint-address').textContent = endpoint.url || 'Address not configured';
    const edit = row.querySelector('.clickable-icon'); edit.innerHTML = icon('edit'); edit.setAttribute('aria-label', `Edit ${endpoint.name || 'new endpoint'}`); edit.addEventListener('click', () => editEndpoint(endpoint.id));
    const enabled = row.querySelector('[role="switch"]'); enabled.setAttribute('aria-label', `Enable ${endpoint.name || 'new endpoint'}`); toggle(enabled, endpoint.enabled);
    enabled.addEventListener('click', () => { endpoint.enabled = !endpoint.enabled; toggle(enabled, endpoint.enabled); toast('Endpoint enabled state updated in this mock.'); });
    $('endpoint-list').append(row);
  });
}
function editEndpoint(id) {
  persistEndpoint(); const endpoint = endpoints.find(item => item.id === id); if (!endpoint) return;
  state.endpointId = id; state.view = 'form'; state.phase = endpoint.phase; state.models = endpoint.models; state.enabled = endpoint.enabled;
  $('endpoint-list-view').hidden = true; $('endpoint-form-view').hidden = false;
  $('modal-title').textContent = endpoint.name ? `Configure ${endpoint.name}` : 'Add endpoint';
  $('provider-intro').textContent = 'Use the API base address supplied by your server or provider.';
  $('connection-name').value = endpoint.name; $('connection-url').value = endpoint.url; $('connection-key').value = endpoint.key;
  $('manual-section').open = false; $('manual-error').hidden = true;
  renderStatus(); renderModels(); $('mock-state').value = state.phase;
}
function newEndpoint() {
  persistEndpoint(); const id = `custom-${nextEndpoint++}`;
  endpoints.push({ id, name: '', url: '', key: '', phase: 'setup', enabled: false, models: [] });
  editEndpoint(id);
}
const providers = [
  ['Nexus (Local)', false, 'local'], ['Ollama', false, 'local'], ['LM Studio', true, 'local'], ['OpenAI-compatible', false, 'local', true],
  ['OpenAI', true, 'cloud'], ['Anthropic', true, 'cloud'], ['Google AI', false, 'cloud'], ['Mistral AI', false, 'cloud'], ['Groq', false, 'cloud'], ['DeepSeek', false, 'cloud'], ['Deepgram', false, 'cloud'], ['AssemblyAI', false, 'cloud'], ['OpenRouter', true, 'cloud'], ['Requesty', false, 'cloud'], ['Perplexity', false, 'cloud'], ['GitHub Copilot', false, 'cloud'],
];
function toast(text) { $('mock-toast').textContent = text; $('mock-toast').hidden = false; clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { $('mock-toast').hidden = true; }, 3200); }
function markSaved() { persistEndpoint(); $('save-status').textContent = 'Updated in this mock · not persisted'; updatePickerNote(); }
function toggle(button, value) { button.classList.toggle('is-enabled', value); button.setAttribute('aria-checked', String(value)); }
function renderCards() {
  $('local-cards').replaceChildren(); $('cloud-cards').replaceChildren();
  providers.forEach(([name, configured, group, custom]) => {
    const card = document.createElement('article');
    card.className = `agent-management-card${custom ? ' nexus-custom-provider-card' : ''}`;
    card.dataset.provider = name.toLowerCase();
    card.dataset.desktopOnly = String((group === 'local' && !custom) || ['Deepgram', 'AssemblyAI', 'GitHub Copilot'].includes(name));
    card.innerHTML = `<div class="agent-management-card-header"><div class="agent-management-card-title">${name}${custom ? '<span class="nexus-provider-new">NEW</span>' : ''}</div><div class="agent-management-card-actions"><button class="checkbox-container" role="switch" aria-label="Enable ${name}" aria-checked="false"></button><button class="clickable-icon agent-management-edit-btn" aria-label="Configure ${name}">${icon('edit')}</button></div></div><div class="agent-management-card-description"></div>`;
    card.querySelector('.agent-management-card-description').textContent = custom ? `${endpoints.length} endpoints · local or hosted` : configured ? 'Configured' : 'Not configured';
    const switchButton = card.querySelector('[role="switch"]');
    if (custom) switchButton.remove();
    else {
    toggle(switchButton, configured);
    switchButton.addEventListener('click', () => {
      toggle(switchButton, switchButton.getAttribute('aria-checked') !== 'true');
      toast('Provider enabled state updated in this mock.');
    });
    }
    card.querySelector('.agent-management-edit-btn').addEventListener('click', () => custom ? openModal() : toast(`${name} is existing UI context. Open the new OpenAI-compatible card to review this proposal.`));
    $(`${group}-cards`).append(card);
  });
  filterCards();
}
function filterCards() {
  let total = 0;
  document.querySelectorAll('[data-group]').forEach(group => {
    let count = 0;
    group.querySelectorAll('[data-provider]').forEach(card => { card.hidden = !card.dataset.provider.includes($('provider-search').value.toLowerCase()) || ($('mock-device').value === 'mobile' && card.dataset.desktopOnly === 'true'); if (!card.hidden) count++; });
    group.hidden = count === 0; total += count;
  });
  $('search-empty').hidden = total > 0;
}
function openModal() {
  state.lastFocus = document.activeElement; $('modal-layer').hidden = false; $('provider-pane').inert = true;
  showEndpointList(); setTimeout(() => document.querySelector('.modal').focus(), 0);
}
function closeModal() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; state.phase = 'setup'; renderStatus(); }
  persistEndpoint();
  $('modal-layer').hidden = true; $('provider-pane').inert = false; $('mock-state').value = 'providers'; renderCards();
  if (state.lastFocus?.isConnected) state.lastFocus.focus();
}
function renderStatus(message) {
  const phases = {
    connecting: ['loader', 'Connecting…', 'Checking your server and looking for models.'],
    connected: ['circle-check', 'Model list received', 'Choose the models to show in your model picker.'],
    auth: ['circle-alert', 'Authentication failed', 'The server rejected the API key (401). Check your key, then connect again.'],
    manual: ['circle-alert', 'Model discovery unavailable', 'This endpoint did not return a model list. Add a model ID to continue.'],
  };
  const status = $('connection-status'); status.hidden = state.phase === 'setup' && !message;
  if (!status.hidden) {
    const [glyph, title, detail] = message ? ['circle-alert', 'Check the connection details', message] : phases[state.phase];
    status.dataset.status = message ? 'auth' : state.phase;
    status.replaceChildren(); const picture = document.createElement('span'); picture.innerHTML = icon(glyph); status.append(picture);
    const content = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = title; const p = document.createElement('p'); p.textContent = detail; content.append(strong, p); status.append(content);
  }
  $('connect-button').disabled = state.phase === 'connecting';
  $('connect-button').textContent = state.phase === 'connecting' ? 'Connecting…' : state.phase === 'setup' ? 'Connect' : 'Connect again';
  $('connection-hint').textContent = state.phase === 'connecting' ? 'Simulated network request…' : 'Discover the models your server offers.';
}
function sampleModel(id, source = 'Discovered') { return { id, source, enabled: true }; }
function renderModels() {
  $('model-section').hidden = state.models.length === 0;
  $('model-count').textContent = `${state.models.filter(m => m.enabled).length} enabled`;
  $('models-list').replaceChildren();
  state.models.forEach(model => {
    const item = document.createElement('div'); item.className = 'model-item';
    item.innerHTML = '<div class="llm-provider-model-row"><div><div class="llm-provider-model-name"></div><div class="llm-provider-model-source"></div></div><button class="checkbox-container" role="switch" aria-checked="true"></button></div>';
    item.querySelector('.llm-provider-model-name').textContent = model.id;
    item.querySelector('.llm-provider-model-source').textContent = model.source;
    const enabled = item.querySelector('[role="switch"]'); enabled.setAttribute('aria-label', `Enable ${model.id}`); toggle(enabled, model.enabled);
    enabled.addEventListener('click', () => { model.enabled = !model.enabled; toggle(enabled, model.enabled); $('model-count').textContent = `${state.models.filter(m => m.enabled).length} enabled`; markSaved(); });
    $('models-list').append(item);
  });
  updatePickerNote();
}
function updatePickerNote() {
  const enabled = state.models.filter(m => m.enabled); $('picker-note').hidden = enabled.length === 0;
  $('picker-label').textContent = enabled.length ? `Use in chat or delegate a task: ${$('connection-name').value || 'OpenAI-compatible'} → ${enabled[0].id}${enabled.length > 1 ? ` (+${enabled.length - 1} more)` : ''}` : '';
}
function applyPreview(phase) {
  clearTimeout(state.timer); state.timer = null;
  if (phase === 'providers') { closeModal(); return; }
  openModal();
  if (phase === 'connections') return;
  if (phase === 'setup') newEndpoint(); else {
    editEndpoint('hermes-1'); state.phase = phase;
    state.models = phase === 'connected' ? [sampleModel('hermes-agent')] : [];
    state.enabled = phase === 'connected';
    if (phase === 'manual') $('manual-section').open = true;
  }
  $('save-status').textContent = 'Ready · mock only'; $('mock-state').value = phase;
  renderStatus(); renderModels();
}
function validateBaseUrl(value) {
  const raw = value.trim();
  let url;
  try { url = new URL(raw); } catch { return 'Enter a full API base URL, such as https://my-server.example/v1.'; }
  if (!['https:', 'http:'].includes(url.protocol)) return 'Use an HTTPS address, or HTTP for a server on this device.';
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && !loopback) return 'Use HTTPS for a hosted or network server. HTTP is supported only for localhost or a loopback address on this device.';
  if (url.username || url.password) return 'Remove the username and password from the address. Enter your key in the API key field.';
  if (raw.includes('?') || raw.includes('#')) return 'Use the base address without a query string or fragment.';
  if (/\/(?:(?:chat\/)?completions|models)\/?$/i.test(url.pathname)) return 'Enter the API base address, such as /v1, without a /models, /chat/completions, or /completions ending.';
  return '';
}
$('connect-button').addEventListener('click', () => {
  const urlError = validateBaseUrl($('connection-url').value);
  if (urlError) { renderStatus(urlError); $('connection-url').focus(); return; }
  state.phase = 'connecting'; $('mock-state').value = 'connecting'; renderStatus();
  state.timer = setTimeout(() => { state.timer = null; state.phase = 'connected'; state.enabled = true; if (!state.models.length) state.models = [sampleModel('local-model')]; $('mock-state').value = 'connected'; renderStatus(); renderModels(); markSaved(); }, 1200);
});
$('add-model').addEventListener('click', () => {
  const id = $('manual-id').value.trim(); const error = $('manual-error'); error.hidden = true;
  if (!id || state.models.some(model => model.id === id)) { error.textContent = id ? 'This model is already in the list.' : 'Enter a model ID.'; error.hidden = false; return; }
  const urlError = validateBaseUrl($('connection-url').value);
  if (urlError) { error.textContent = urlError; error.hidden = false; return; }
  state.models.push(sampleModel(id, 'Added manually')); state.enabled = true; $('manual-id').value = ''; renderModels(); markSaved(); toast('Model added in this mock.');
});
$('manual-id').addEventListener('keydown', event => { if (event.key === 'Enter') $('add-model').click(); });
$('show-key').addEventListener('click', () => { const show = $('connection-key').type === 'password'; $('connection-key').type = show ? 'text' : 'password'; $('show-key').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key'); });
$('close-x').addEventListener('click', closeModal); $('close-button').addEventListener('click', closeModal);
$('mock-state').addEventListener('change', event => applyPreview(event.target.value));
$('mock-theme').addEventListener('click', () => { const light = document.body.classList.toggle('theme-light'); document.body.classList.toggle('theme-dark', !light); $('mock-theme').textContent = light ? 'Dark theme' : 'Light theme'; $('mock-theme').setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme'); });
$('mock-device').addEventListener('change', event => { const phone = event.target.value === 'mobile'; $('mock-device-frame').classList.toggle('is-phone', phone); document.body.classList.toggle('is-mobile', phone); filterCards(); });
$('provider-search').addEventListener('input', filterCards);
$('add-endpoint').addEventListener('click', newEndpoint);
$('back-endpoints').addEventListener('click', showEndpointList);
$('connection-name').addEventListener('change', markSaved);
['connection-url', 'connection-key'].forEach(id => $(id).addEventListener('input', () => { clearTimeout(state.timer); state.timer = null; state.phase = 'setup'; $('mock-state').value = 'setup'; renderStatus(); $('save-status').textContent = 'Connection changed · connect to check'; persistEndpoint(); }));
document.querySelectorAll('[data-demo-toggle]').forEach(button => button.addEventListener('click', () => { toggle(button, button.getAttribute('aria-checked') !== 'true'); toast('Secure storage preference changed only in this mock.'); }));
document.addEventListener('keydown', event => {
  if ($('modal-layer').hidden) return;
  if (event.key === 'Escape') closeModal();
  if (event.key === 'Tab' && $('modal-layer').contains(document.activeElement)) {
    const focusable = [...document.querySelector('.modal').querySelectorAll('button, input, select, summary')].filter(el => !el.disabled && el.getClientRects().length);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
renderCards();
if (window.innerWidth < 600) { $('mock-device').value = 'mobile'; $('mock-device').dispatchEvent(new Event('change')); }
