const stateButtons = Array.from(document.querySelectorAll('[data-state-button]'));
const messagesEl = document.querySelector('[data-role="messages"]');
const statusTextEl = document.querySelector('[data-role="live-status-text"]');
const stopButton = document.querySelector('[data-role="stop-live"]');
const liveEntryButton = document.querySelector('.chat-live-entry');
const waveformEl = document.querySelector('[data-role="live-waveform"]');

const baseMessages = [
  {
    role: 'user',
    text: 'Can you help me think through the voice mode UX without making the composer noisy?'
  },
  {
    role: 'assistant',
    text: 'I would keep voice mode as a composer state and let the message stream stay unchanged.'
  }
];

const stateMessages = {
  normal: {
    status: '',
    additions: []
  },
  connecting: {
    status: 'Connecting live voice...',
    additions: []
  },
  listening: {
    status: 'Listening',
    additions: [
      { role: 'assistant', text: 'I am ready. Start talking whenever you want to steer the conversation.' }
    ]
  },
  'user-speaking': {
    status: 'Transcribing your speech...',
    additions: [
      { role: 'user', text: 'What if the waveform stays in the composer and the transcript just appears here?', partial: true }
    ]
  },
  'assistant-speaking': {
    status: 'Nexus is speaking...',
    additions: [
      { role: 'user', text: 'What if the waveform stays in the composer and the transcript just appears here?' },
      { role: 'assistant', text: 'That keeps the live session visible without creating a second chat surface. The composer becomes the control layer, while messages remain the record.', partial: true }
    ]
  },
  error: {
    status: 'Live voice connection failed. Stop and try again.',
    additions: []
  }
};

function createMessage(message) {
  const article = document.createElement('article');
  article.className = `message message-${message.role}`;
  if (message.partial) {
    article.classList.add('is-partial');
  }

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = message.text;
  article.appendChild(bubble);

  return article;
}

function renderMessages(state) {
  if (!messagesEl) return;

  messagesEl.replaceChildren();
  const messages = [...baseMessages, ...(stateMessages[state]?.additions ?? [])];
  messages.forEach(message => messagesEl.appendChild(createMessage(message)));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function buildWaveformBars() {
  if (!waveformEl) return;

  waveformEl.replaceChildren();

  const barCount = 72;
  const center = (barCount - 1) / 2;

  for (let index = 0; index < barCount; index += 1) {
    const distanceFromCenter = Math.abs(index - center) / center;
    const sine = Math.sin((index / (barCount - 1)) * Math.PI);
    const jagged = [0.36, 0.92, 0.52, 1.2, 0.42, 0.78, 1.34, 0.58][index % 8];
    const assistantWave = 0.42 + (sine * 0.86);
    const connectWave = index % 9 === 0 || index % 9 === 1 ? 1.05 : 0.34 + ((index % 5) * 0.08);

    const bar = document.createElement('span');
    bar.className = 'wave-bar';
    bar.style.setProperty('--bar-index', String(index));
    bar.style.setProperty('--listen-min', (0.16 + sine * 0.08).toFixed(2));
    bar.style.setProperty('--listen-max', (0.28 + sine * 0.24).toFixed(2));
    bar.style.setProperty('--connect-scale', connectWave.toFixed(2));
    bar.style.setProperty('--user-min', Math.max(0.18, jagged * 0.32).toFixed(2));
    bar.style.setProperty('--user-mid', Math.max(0.3, jagged * 0.58).toFixed(2));
    bar.style.setProperty('--user-peak', Math.min(1.45, jagged).toFixed(2));
    bar.style.setProperty('--assistant-min', (0.32 + (1 - distanceFromCenter) * 0.22).toFixed(2));
    bar.style.setProperty('--assistant-mid', (0.48 + assistantWave * 0.32).toFixed(2));
    bar.style.setProperty('--assistant-peak', (0.62 + assistantWave * 0.58).toFixed(2));
    waveformEl.appendChild(bar);
  }
}

function setState(state) {
  document.body.dataset.state = state;

  stateButtons.forEach(button => {
    button.classList.toggle('is-active', button.dataset.stateButton === state);
  });

  if (statusTextEl) {
    statusTextEl.textContent = stateMessages[state]?.status ?? '';
  }

  renderMessages(state);
}

stateButtons.forEach(button => {
  button.addEventListener('click', () => {
    const state = button.dataset.stateButton;
    if (state) {
      setState(state);
    }
  });
});

stopButton?.addEventListener('click', () => {
  setState('normal');
});

liveEntryButton?.addEventListener('click', () => {
  setState('connecting');
  window.setTimeout(() => {
    if (document.body.dataset.state === 'connecting') {
      setState('listening');
    }
  }, 900);
});

buildWaveformBars();
setState('normal');
