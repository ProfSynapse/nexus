const stateSelect = document.getElementById('mock-state-select');
const stateCaption = document.getElementById('mock-state-caption');
const statusText = document.getElementById('mock-status-text');
const themeToggle = document.getElementById('mock-theme-toggle');
const deviceToggle = document.getElementById('mock-device-toggle');
const deviceLabel = document.getElementById('mock-device-label');
const permissionTrigger = document.getElementById('chat-permission-trigger');
const permissionMenu = document.getElementById('chat-permission-menu');
const permissionLabel = document.getElementById('chat-permission-label');
const modalLayer = document.getElementById('mock-modal-layer');

const captions = {
  'permission-modes': 'Three outcome-based modes; hard Nexus guards remain in force in every mode.',
  approval: 'A reversible vault edit is waiting for one-operation approval.',
  'mixed-batch': 'The read completes while only the mutation waits for approval.',
  approved: 'Approval is scoped to one operation ID, signature, and fixed parameter set.',
  denied: 'Denial settles the operation without changing the note.',
  cancelled: 'Conversation changes, aborts, and plugin unload cancel pending approvals.',
  stale: 'Changing parameters invalidates an earlier approval request.',
  error: 'Approval failures settle safely and offer an explicit recovery path.',
  running: 'Running and completed rows keep the same footprint to avoid layout jumps.',
  completed: 'The terminal state names receipt and undo availability.',
  'one-change': 'A compact turn summary keeps the changed path, diff, and undo together.',
  'multi-change': 'Captured and unsupported entries stay legible in one summary.',
  diff: 'Text diff inspection uses a focused modal and a scrollable phone-safe view.',
  'undo-confirm': 'Undo confirms the exact captured scope before mutating anything.',
  'undo-success': 'Successful undo names what was restored.',
  'undo-conflict': 'A later user edit blocks the entire undo before any file changes.',
  'missing-preimage': 'Missing artifacts degrade undo without breaking conversation history.',
  'keyboard-focus': 'Visible focus and a predictable Tab order are part of the contract.'
};

const statusByState = {
  'permission-modes': 'Supervised mode',
  approval: 'Waiting for approval',
  'mixed-batch': '1 operation waiting',
  approved: 'Approval received',
  denied: 'Operation denied',
  cancelled: 'Approval cancelled',
  stale: 'Approval expired',
  error: 'Approval failed safely',
  running: 'Updating Nexus roadmap',
  completed: 'Updated Nexus roadmap',
  'one-change': '1 file changed',
  'multi-change': '3 files changed',
  diff: 'Reviewing text diff',
  'undo-confirm': 'Undo awaiting confirmation',
  'undo-success': 'Changes undone',
  'undo-conflict': 'Undo blocked by conflict',
  'missing-preimage': 'Undo unavailable',
  'keyboard-focus': 'Keyboard focus preview'
};

const modalStates = new Set(['diff', 'undo-confirm', 'undo-success', 'undo-conflict']);

function setState(state) {
  permissionMenu.hidden = true;
  permissionTrigger.setAttribute('aria-expanded', 'false');

  const runtimeState = modalStates.has(state)
    ? (state === 'undo-confirm' || state === 'undo-conflict' ? 'multi-change' : 'one-change')
    : state;

  document.querySelectorAll('.runtime-state').forEach((element) => {
    element.classList.toggle('is-active', element.dataset.state === runtimeState);
  });

  document.querySelectorAll('.modal-state').forEach((element) => {
    element.classList.toggle('is-active', element.dataset.modalState === state);
  });

  modalLayer.hidden = !modalStates.has(state);
  stateSelect.value = state;
  stateCaption.textContent = captions[state];
  statusText.textContent = statusByState[state];

  if (state === 'keyboard-focus') {
    requestAnimationFrame(() => document.querySelector('.mock-force-focus')?.focus());
  } else if (modalStates.has(state)) {
    requestAnimationFrame(() => document.querySelector('.tool-change-modal__close')?.focus());
  }
}

function setMode(mode) {
  const labels = {
    supervised: 'Supervised',
    'allow-vault-edits': 'Allow vault edits',
    'full-access': 'Full access'
  };
  permissionLabel.textContent = labels[mode];
  document.querySelectorAll('[data-mode-choice]').forEach((button) => {
    const selected = button.dataset.modeChoice === mode;
    button.classList.toggle('is-selected', selected);
    if (button.getAttribute('role') === 'menuitemradio') {
      button.setAttribute('aria-checked', String(selected));
    }
    const existing = button.querySelector('.chat-permission-option__check');
    if (existing) existing.remove();
    if (selected && button.classList.contains('chat-permission-option')) {
      const marker = document.createElement('span');
      marker.className = 'chat-permission-option__check';
      marker.textContent = 'Selected';
      button.appendChild(marker);
    }
  });
  permissionMenu.hidden = true;
  permissionTrigger.setAttribute('aria-expanded', 'false');
}

stateSelect.addEventListener('change', () => setState(stateSelect.value));

themeToggle.addEventListener('click', () => {
  const light = document.body.classList.toggle('theme-light');
  document.body.classList.toggle('theme-dark', !light);
  themeToggle.textContent = light ? 'Dark theme' : 'Light theme';
  themeToggle.setAttribute('aria-pressed', String(light));
});

deviceToggle.addEventListener('click', () => {
  const phone = document.body.classList.toggle('mock-phone-mode');
  deviceToggle.textContent = phone ? 'Desktop width' : 'Phone width';
  deviceToggle.setAttribute('aria-pressed', String(phone));
  deviceLabel.textContent = phone ? 'Phone chat · 390 px' : 'Desktop chat · 900 px';
});

permissionTrigger.addEventListener('click', () => {
  const opening = permissionMenu.hidden;
  permissionMenu.hidden = !opening;
  permissionTrigger.setAttribute('aria-expanded', String(opening));
});

document.querySelectorAll('[data-mode-choice]').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.modeChoice));
});

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'approve') setState('approved');
  if (action === 'deny') setState('denied');
  if (action === 'show-modes') setState('permission-modes');
  if (action === 'show-diff') setState('diff');
  if (action === 'undo') setState('undo-confirm');
  if (action === 'confirm-undo') setState('undo-success');
  if (action === 'close-modal') setState('one-change');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalLayer.hidden) {
    setState('one-change');
  }
});

setMode('supervised');
setState(stateSelect.value);
