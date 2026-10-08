/* Standalone simulation: never sends requests or stores credentials. */
const $ = id => document.getElementById(id);
const agents = [{ id: 1, name: 'My Hermes', url: 'https://hermes.example.com/v1', key: '', description: '', enabled: true }, { id: 2, name: 'Team Hermes', url: 'https://team.example.com/v1', key: '', description: 'Help with our team’s projects and day-to-day tasks.', enabled: false }];
let selected = null;
let timer = null;
let revision = 0;
const editIcon = '<svg data-icon="edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z"/></svg>';
const closeIcon = '<svg data-icon="x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg>';
$('close-x').innerHTML = closeIcon;
function switchValue(button, value) { button.classList.toggle('is-enabled', value); button.setAttribute('aria-checked', String(value)); }
function cards(empty = false) {
 $('agent-cards').replaceChildren(); $('empty-note').hidden = !empty && agents.length > 0;
 if (empty) return;
 agents.forEach(agent => {
  const card = document.createElement('article'); card.className = 'agent-management-card';
  card.innerHTML = '<div class="agent-management-card-header"><div class="agent-management-card-title"></div><div class="agent-management-card-actions"><button class="checkbox-container" role="switch"></button><button class="clickable-icon"></button></div></div><div class="agent-management-card-description"></div><div class="remote-agent-address"></div>';
  card.querySelector('.agent-management-card-title').textContent = agent.name;
  card.querySelector('.agent-management-card-description').textContent = agent.description || 'General-purpose assistant';
  card.querySelector('.remote-agent-address').textContent = `Hermes · ${agent.url}`;
  const enabled = card.querySelector('[role="switch"]'); enabled.setAttribute('aria-label', `Enable ${agent.name}`); switchValue(enabled, agent.enabled); enabled.onclick = () => { agent.enabled = !agent.enabled; switchValue(enabled, agent.enabled); };
  const edit = card.querySelector('.clickable-icon'); edit.innerHTML = editIcon; edit.setAttribute('aria-label', `Configure ${agent.name}`); edit.onclick = () => open(agent);
  $('agent-cards').append(card);
 });
}
function open(agent) {
 selected = agent; revision++; clearTimeout(timer); $('modal-layer').hidden = false; $('agent-pane').inert = true;
 $('modal-title').textContent = agent.name ? `Configure ${agent.name}` : 'Add remote agent';
 $('agent-name').value = agent.name; $('agent-url').value = agent.url; $('agent-key').value = agent.key; $('agent-description').value = agent.description; switchValue($('agent-enabled'), agent.enabled);
 $('test-status').hidden = true; $('save-status').textContent = 'Ready · mock only'; $('test-agent').disabled = false; $('test-agent').textContent = 'Test connection'; document.querySelector('.modal').focus();
}
function save() {
 if (!selected) return;
 Object.assign(selected, { name: $('agent-name').value, url: $('agent-url').value, key: $('agent-key').value, description: $('agent-description').value, enabled: $('agent-enabled').getAttribute('aria-checked') === 'true' });
 $('save-status').textContent = 'Updated in this mock · not persisted';
}
function close() { save(); if (selected && selected.name && selected.url && !agents.includes(selected)) agents.push(selected); revision++; clearTimeout(timer); $('modal-layer').hidden = true; $('agent-pane').inert = false; $('mock-state').value = 'list'; cards(); }
function status(phase) {
 const messages = { testing: 'Checking the server…', ready: 'Connection ready. This server supports remote tasks.', limited: 'Server reached, but remote tasks are unavailable. Check the Hermes server setup.', error: 'Could not connect. Check the server URL and API key, then try again.' };
 $('test-status').hidden = false; $('test-status').textContent = messages[phase]; $('test-status').dataset.status = phase === 'ready' ? 'connected' : phase === 'error' ? 'auth' : 'manual'; $('test-agent').disabled = phase === 'testing'; $('test-agent').textContent = phase === 'testing' ? 'Testing…' : 'Test connection';
}
$('add-agent').onclick = () => { open({ id: Date.now(), name: '', url: '', key: '', description: '', enabled: true }); $('mock-state').value = 'setup'; };
$('test-agent').onclick = () => {
 try { const url = new URL($('agent-url').value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error(); if (url.username || url.password || url.search || url.hash) throw new Error(); }
 catch { status('error'); $('test-status').textContent = 'Enter a full HTTPS server URL, or use HTTP for localhost. Leave credentials, queries, and fragments out of the address.'; return; }
 const current = ++revision; status('testing'); timer = setTimeout(() => { if (revision === current) status('ready'); }, 1000);
};
['agent-name', 'agent-url', 'agent-key', 'agent-description'].forEach(id => $(id).oninput = () => { save(); if (id === 'agent-url' || id === 'agent-key') { revision++; clearTimeout(timer); $('test-status').hidden = true; $('test-agent').disabled = false; $('test-agent').textContent = 'Test connection'; } });
$('agent-enabled').onclick = () => { switchValue($('agent-enabled'), $('agent-enabled').getAttribute('aria-checked') !== 'true'); save(); };
$('close-agent').onclick = close; $('close-x').onclick = close;
$('mock-state').onchange = event => { const phase = event.target.value; if (phase === 'list' || phase === 'empty') { close(); cards(phase === 'empty'); $('mock-state').value = phase; } else if (phase === 'setup') $('add-agent').click(); else { open(agents[0]); status(phase); $('mock-state').value = phase; } };
$('mock-theme').onclick = () => { const light = document.body.classList.toggle('theme-light'); document.body.classList.toggle('theme-dark', !light); $('mock-theme').textContent = light ? 'Dark theme' : 'Light theme'; };
$('mock-device').onchange = event => { const phone = event.target.value === 'mobile'; $('mock-device-frame').classList.toggle('is-phone', phone); document.body.classList.toggle('is-mobile', phone); };
document.onkeydown = event => { if (event.key === 'Escape' && !$('modal-layer').hidden) close(); };
cards();
if (innerWidth < 600) { $('mock-device').value = 'mobile'; $('mock-device').dispatchEvent(new Event('change')); }
