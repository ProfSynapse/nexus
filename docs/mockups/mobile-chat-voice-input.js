const stateButtons = Array.from(document.querySelectorAll('[data-state]'));
const composerShell = document.querySelector('[data-role="composer-shell"]');
const chatInput = document.querySelector('[data-role="chat-input"]');
const composerButton = document.querySelector('[data-role="composer-button"]');
const buttonIcon = document.querySelector('[data-role="button-icon"]');
const voiceVisual = document.querySelector('[data-role="voice-visual"]');

const STATES = {
  'mic-ready': {
    recording: false,
    text: '',
    placeholder: 'Type your message...',
    buttonLabel: 'Start recording',
    buttonClass: '',
    icon: 'mic'
  },
  recording: {
    recording: true,
    text: '',
    placeholder: 'Type your message...',
    buttonLabel: 'Stop recording',
    buttonClass: 'stop-mode',
    icon: 'stop'
  },
  'draft-filled': {
    recording: false,
    text: 'Can you tighten the mobile glass composer and keep the voice state minimal?',
    placeholder: 'Type your message...',
    buttonLabel: 'Send message',
    buttonClass: '',
    icon: 'send'
  }
};

function buildVoiceBars() {
  if (!(voiceVisual instanceof HTMLElement)) {
    return;
  }

  const computedStyle = window.getComputedStyle(voiceVisual);
  const paddingLeft = Number.parseFloat(computedStyle.paddingLeft || '0');
  const paddingRight = Number.parseFloat(computedStyle.paddingRight || '0');
  const availableWidth = voiceVisual.clientWidth - paddingLeft - paddingRight;

  if (availableWidth <= 0) {
    return;
  }

  const gap = 4;
  const barWidth = 3;
  const barSlot = barWidth + gap;
  const count = Math.max(12, Math.floor(availableWidth / barSlot));

  voiceVisual.replaceChildren();

  for (let index = 0; index < count; index += 1) {
    const bar = document.createElement('span');
    bar.className = 'chat-voice-bar';

    const phase = index % 8;
    const heights = [10, 14, 20, 28, 18, 24, 16, 12];
    bar.style.setProperty('--bar-height', `${heights[phase]}px`);
    bar.style.setProperty('--bar-delay', `${index * 55}ms`);

    voiceVisual.appendChild(bar);
  }
}

function setButtonIcon(kind) {
  if (!(buttonIcon instanceof SVGElement)) {
    return;
  }

  buttonIcon.replaceChildren();

  const pathsByKind = {
    mic: [
      'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z',
      'M19 10a7 7 0 0 1-14 0',
      'M12 17v4',
      'M8 21h8'
    ],
    stop: [
      'M7 7h10v10H7z'
    ],
    send: [
      'M12 5v14',
      'm19 12-7-7-7 7'
    ]
  };

  const paths = pathsByKind[kind] || pathsByKind.send;
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    buttonIcon.appendChild(path);
  }
}

function applyState(stateName) {
  const state = STATES[stateName];
  if (!state) {
    return;
  }

  if (composerShell instanceof HTMLElement) {
    composerShell.classList.toggle('is-recording', state.recording);
  }

  if (chatInput instanceof HTMLElement) {
    chatInput.textContent = state.text;
    chatInput.setAttribute('data-placeholder', state.placeholder);
  }

  if (composerButton instanceof HTMLButtonElement) {
    composerButton.className = `chat-send-button clickable-icon ${state.buttonClass}`.trim();
    composerButton.setAttribute('aria-label', state.buttonLabel);
  }

  setButtonIcon(state.icon);
  buildVoiceBars();

  stateButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.state === stateName);
  });
}

stateButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.state) {
      applyState(button.dataset.state);
    }
  });
});

if (typeof ResizeObserver !== 'undefined' && voiceVisual instanceof HTMLElement) {
  const observer = new ResizeObserver(() => buildVoiceBars());
  observer.observe(voiceVisual);
} else {
  window.addEventListener('resize', buildVoiceBars);
}

applyState('mic-ready');
