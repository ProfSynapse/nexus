const scenarios = {
  none: {
    providers: [
      { name: 'OpenAI', caps: 'Speech, realtime', state: 'Missing key', ready: false },
      { name: 'Google', caps: 'Transcription, speech, realtime', state: 'Disabled', ready: false },
      { name: 'ElevenLabs app', caps: 'Speech, realtime agent', state: 'Not installed', ready: false },
      { name: 'OpenRouter', caps: 'Speech only', state: 'Disabled', ready: false }
    ],
    status: {
      input: { label: 'Locked', kind: 'locked' },
      speech: { label: 'Locked', kind: 'locked' },
      realtime: { label: 'Locked', kind: 'locked' }
    },
    values: {
      transcription: '',
      inputMode: 'auto',
      speech: '',
      speechVoice: '',
      realtime: '',
      realtimeVoice: ''
    },
    disabled: {
      transcription: true,
      speech: true,
      speechVoice: true,
      speechOptions: true,
      realtime: true,
      realtimeVoice: true
    },
    resolution: {
      transcription: 'No configured provider',
      speech: 'No configured provider',
      realtime: 'No configured provider'
    },
    warning: 'No providers are configured for voice or audio.',
    liveReady: false
  },
  auto: {
    providers: [
      { name: 'OpenAI', caps: 'Speech, realtime', state: 'Ready', ready: true },
      { name: 'Google', caps: 'Transcription, speech, realtime', state: 'Ready', ready: true },
      { name: 'ElevenLabs app', caps: 'Speech, realtime agent', state: 'Disabled', ready: false },
      { name: 'OpenRouter', caps: 'Speech only', state: 'Ready', ready: true }
    ],
    status: {
      input: { label: 'Ready', kind: 'ready' },
      speech: { label: 'Auto', kind: 'ready' },
      realtime: { label: 'Auto', kind: 'ready' }
    },
    values: {
      transcription: 'openai',
      inputMode: 'auto',
      speech: 'openai',
      speechVoice: 'marin',
      realtime: 'openai',
      realtimeVoice: 'marin'
    },
    disabled: {
      transcription: false,
      speech: false,
      speechVoice: false,
      speechOptions: false,
      realtime: false,
      realtimeVoice: false
    },
    resolution: {
      transcription: 'Auto: OpenAI · Whisper 1',
      speech: 'Auto: OpenAI · GPT-4o mini TTS · Marin',
      realtime: 'Auto: OpenAI · GPT Realtime 2 · Marin'
    },
    warning: '',
    liveReady: true
  },
  user: {
    providers: [
      { name: 'OpenAI', caps: 'Speech, realtime', state: 'Ready', ready: true },
      { name: 'Google', caps: 'Transcription, speech, realtime', state: 'Ready', ready: true },
      { name: 'ElevenLabs app', caps: 'Speech, realtime agent', state: 'Ready', ready: true },
      { name: 'OpenRouter', caps: 'Speech only', state: 'Ready', ready: true }
    ],
    status: {
      input: { label: 'Ready', kind: 'ready' },
      speech: { label: 'User', kind: 'ready' },
      realtime: { label: 'User', kind: 'ready' }
    },
    values: {
      transcription: 'groq',
      inputMode: 'user',
      speech: 'elevenlabs',
      speechVoice: 'sarah',
      realtime: 'google',
      realtimeVoice: ''
    },
    disabled: {
      transcription: false,
      speech: false,
      speechVoice: false,
      speechOptions: false,
      realtime: false,
      realtimeVoice: false
    },
    resolution: {
      transcription: 'User: Groq · Whisper Large v3 Turbo',
      speech: 'User: ElevenLabs · Eleven Multilingual v2 · Sarah',
      realtime: 'User: Google · Gemini 3.1 Flash Live Preview'
    },
    warning: '',
    liveReady: true
  },
  invalid: {
    providers: [
      { name: 'OpenAI', caps: 'Speech, realtime', state: 'Ready', ready: true },
      { name: 'Google', caps: 'Transcription, speech, realtime', state: 'Disabled', ready: false, invalid: true },
      { name: 'ElevenLabs app', caps: 'Speech, realtime agent', state: 'Missing permission', ready: false, invalid: true },
      { name: 'OpenRouter', caps: 'Speech only', state: 'Ready', ready: true }
    ],
    status: {
      input: { label: 'Ready', kind: 'ready' },
      speech: { label: 'Invalid', kind: 'invalid' },
      realtime: { label: 'Invalid', kind: 'invalid' }
    },
    values: {
      transcription: 'openai',
      inputMode: 'user',
      speech: 'elevenlabs',
      speechVoice: 'sarah',
      realtime: 'google',
      realtimeVoice: ''
    },
    disabled: {
      transcription: false,
      speech: false,
      speechVoice: false,
      speechOptions: false,
      realtime: false,
      realtimeVoice: false
    },
    resolution: {
      transcription: 'User: OpenAI · Whisper 1',
      speech: 'Invalid: ElevenLabs app is enabled but lacks TTS permission',
      realtime: 'Invalid: Google realtime is selected but Google is disabled'
    },
    warning: 'Selected voice defaults are unavailable. Nexus should keep the user selection and ask for a fix instead of silently switching providers.',
    liveReady: false
  }
};

const role = (name) => document.querySelector(`[data-role="${name}"]`);
const scenarioButtons = Array.from(document.querySelectorAll('.scenario-button'));

function setStatus(element, state) {
  element.textContent = state.label;
  element.classList.remove('is-ready', 'is-invalid');
  if (state.kind === 'ready') element.classList.add('is-ready');
  if (state.kind === 'invalid') element.classList.add('is-invalid');
}

function setSelect(name, value, disabled) {
  const element = role(name);
  element.value = value;
  element.disabled = disabled;
}

function renderProviders(providers) {
  const list = role('provider-list');
  list.innerHTML = '';

  providers.forEach((provider) => {
    const item = document.createElement('div');
    item.className = 'provider-item';
    if (provider.ready) item.classList.add('is-ready');
    if (provider.invalid) item.classList.add('is-invalid');

    const dot = document.createElement('span');
    dot.className = 'provider-dot';
    dot.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = provider.name;
    const caps = document.createElement('span');
    caps.className = 'provider-caps';
    caps.textContent = provider.caps;
    copy.append(name, caps);

    const state = document.createElement('span');
    state.className = 'provider-state';
    state.textContent = provider.state;

    item.append(dot, copy, state);
    list.appendChild(item);
  });
}

function renderScenario(name) {
  const scenario = scenarios[name];

  scenarioButtons.forEach((button) => {
    const isActive = button.dataset.scenario === name;
    button.classList.toggle('is-active', isActive);
  });

  renderProviders(scenario.providers);
  setStatus(role('voice-input-status'), scenario.status.input);
  setStatus(role('read-aloud-status'), scenario.status.speech);
  setStatus(role('live-voice-status'), scenario.status.realtime);

  setSelect('transcription-select', scenario.values.transcription, scenario.disabled.transcription);
  setSelect('voice-input-mode', scenario.values.inputMode, scenario.disabled.transcription);
  setSelect('speech-select', scenario.values.speech, scenario.disabled.speech);
  setSelect('speech-voice', scenario.values.speechVoice, scenario.disabled.speechVoice);
  setSelect('realtime-select', scenario.values.realtime, scenario.disabled.realtime);
  setSelect('realtime-voice', scenario.values.realtimeVoice, scenario.disabled.realtimeVoice);
  role('speech-speed').disabled = scenario.disabled.speechOptions;
  role('speech-style').disabled = scenario.disabled.speechOptions;
  role('skip-frontmatter').disabled = scenario.disabled.speechOptions;

  role('transcription-resolution').textContent = scenario.resolution.transcription;
  role('speech-resolution').textContent = scenario.resolution.speech;
  role('realtime-resolution').textContent = scenario.resolution.realtime;

  const warningPanel = role('warning-panel');
  warningPanel.classList.toggle('is-hidden', scenario.warning.length === 0);
  role('warning-copy').textContent = scenario.warning;

  const livePreview = role('live-preview');
  livePreview.classList.toggle('is-ready', scenario.liveReady);
  role('live-preview-title').textContent = scenario.liveReady ? 'Live voice ready' : 'Live voice unavailable';
  role('live-preview-copy').textContent = scenario.liveReady
    ? 'This button would appear in chat when the selected realtime provider is usable.'
    : 'Enable a realtime-capable provider to unlock this control.';
}

scenarioButtons.forEach((button) => {
  button.addEventListener('click', () => {
    renderScenario(button.dataset.scenario || 'none');
  });
});

role('speech-speed').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  role('speech-speed-label').textContent = `${value.toFixed(2)}x`;
});

renderScenario('none');
