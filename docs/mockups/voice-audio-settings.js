const scenarios = {
  none: {
    values: {
      transcriptionProvider: '',
      transcriptionModel: '',
      speechProvider: '',
      speechModel: '',
      speechVoice: '',
      realtimeProvider: '',
      realtimeModel: '',
      realtimeVoice: ''
    },
    disabled: {
      transcription: true,
      speech: true,
      realtime: true
    },
    warning: 'Enable a transcription, speech, or realtime provider to use voice features.'
  },
  auto: {
    values: {
      transcriptionProvider: 'openai',
      transcriptionModel: 'whisper-1',
      speechProvider: 'openai',
      speechModel: 'gpt-4o-mini-tts',
      speechVoice: 'marin',
      realtimeProvider: 'openai',
      realtimeModel: 'gpt-realtime-2',
      realtimeVoice: 'marin'
    },
    disabled: {
      transcription: false,
      speech: false,
      realtime: false
    },
    warning: ''
  },
  user: {
    values: {
      transcriptionProvider: 'groq',
      transcriptionModel: 'whisper-large-v3-turbo',
      speechProvider: 'elevenlabs',
      speechModel: 'eleven_multilingual_v2',
      speechVoice: 'sarah',
      realtimeProvider: 'google',
      realtimeModel: 'gemini-3.1-flash-live-preview',
      realtimeVoice: ''
    },
    disabled: {
      transcription: false,
      speech: false,
      realtime: false
    },
    warning: ''
  },
  invalid: {
    values: {
      transcriptionProvider: 'openai',
      transcriptionModel: 'whisper-1',
      speechProvider: 'elevenlabs',
      speechModel: 'eleven_multilingual_v2',
      speechVoice: 'sarah',
      realtimeProvider: 'google',
      realtimeModel: 'gemini-3.1-flash-live-preview',
      realtimeVoice: ''
    },
    disabled: {
      transcription: false,
      speech: false,
      realtime: false
    },
    warning: 'Selected voice providers are no longer available. Keep the user selection visible and ask them to choose a working provider.'
  }
};

const role = (name) => document.querySelector(`[data-role="${name}"]`);
const scenarioButtons = Array.from(document.querySelectorAll('.scenario-button'));

function setSelect(name, value, disabled) {
  const element = role(name);
  element.value = value;
  element.disabled = disabled;
}

function renderScenario(name) {
  const scenario = scenarios[name];

  scenarioButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.scenario === name);
  });

  setSelect('transcription-provider', scenario.values.transcriptionProvider, scenario.disabled.transcription);
  setSelect('transcription-model', scenario.values.transcriptionModel, scenario.disabled.transcription);
  setSelect('speech-provider', scenario.values.speechProvider, scenario.disabled.speech);
  setSelect('speech-model', scenario.values.speechModel, scenario.disabled.speech);
  setSelect('speech-voice', scenario.values.speechVoice, scenario.disabled.speech);
  setSelect('realtime-provider', scenario.values.realtimeProvider, scenario.disabled.realtime);
  setSelect('realtime-model', scenario.values.realtimeModel, scenario.disabled.realtime);
  setSelect('realtime-voice', scenario.values.realtimeVoice, scenario.disabled.realtime);

  const warning = role('warning');
  warning.textContent = scenario.warning;
  warning.classList.toggle('is-hidden', scenario.warning.length === 0);
}

scenarioButtons.forEach((button) => {
  button.addEventListener('click', () => {
    renderScenario(button.dataset.scenario || 'none');
  });
});

renderScenario('none');
