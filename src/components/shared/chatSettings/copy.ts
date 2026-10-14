/**
 * User-facing copy for Defaults and Chat settings, held as constants so tests
 * can assert against the same strings the UI renders. Source: the "Essentials +
 * folds" design in docs/plans/defaults-settings-redesign-plan.md (Appendix A and
 * the owner decisions).
 */

export const FOLD_TITLES = {
  chatOptions: 'Chat options',
  context: 'Context',
  subagents: 'Subagents',
  images: 'Images',
  video: 'Video',
  voice: 'Voice',
  fileConversion: 'File conversion',
  semanticSearch: 'Semantic search'
} as const;

export const FOLD_ICONS = {
  chatOptions: 'sliders-horizontal',
  context: 'layers',
  subagents: 'bot',
  images: 'image',
  video: 'film',
  voice: 'mic',
  fileConversion: 'file-input',
  semanticSearch: 'scan-search'
} as const;

/** Stable fold ids; also the keys remembered by FoldStateStore. */
export const FOLD_IDS = {
  chatOptions: 'chat-options',
  context: 'context',
  subagents: 'subagents',
  images: 'images',
  video: 'video',
  voice: 'voice',
  fileConversion: 'file-conversion',
  semanticSearch: 'semantic'
} as const;

export const COPY = {
  provider: 'Provider',
  model: 'Model',
  thinking: 'Thinking',
  creativity: 'Creativity',
  creativityDesc: 'Lower is more focused, higher is more creative.',
  /** Creativity row description for a model that rejects temperature. */
  creativityFixedDesc: (modelName: string): string => `${modelName} sets its own temperature.`,
  /** Creativity readout while the model sets its own temperature. */
  creativityFixedReadout: '—',
  fixedTemperature: 'Fixed temperature',
  contextWindow: 'Context window',
  contextWindowDesc: 'Older messages are summarized past this size.',
  /** Screen-reader text for a Context window readout such as "200K". */
  contextWindowValueText: (readout: string): string => `${readout} tokens`,
  webSearch: 'Web search',
  webSearchDesc: 'Let the model search the web when needed.',
  webSearchGeminiDesc: 'Available with Gemini 3 or newer when Nexus tools are enabled.',
  workspace: 'Workspace',
  workflow: 'Workflow',
  workflowDesc: 'Loads its instructions and tools. Steps run only when you ask.',
  prompt: 'Prompt',
  contextNotes: 'Context notes',
  addNote: 'Add note',
  removeNote: (name: string): string => `Remove ${name}`,
  usedFor: 'Used for',
  usedForDesc: 'Subagents, saved prompts and automations. Must be a cloud model.',
  noProviders: 'No providers enabled',
  noCloudProviders: 'No cloud providers enabled',
  none: 'None'
} as const;

export const VOICE_COPY = {
  transcription: 'Transcription',
  readAloud: 'Read aloud',
  liveVoice: 'Live voice',
  transcriptionProviderDesc: 'Chat microphone and audio files.',
  voice: 'Voice',
  output: 'Output',
  savedAudioFolder: 'Saved audio folder',
  savedAudioFolderDesc: 'Inside the Nexus data folder.',
  noLiveVoice: 'None of your providers offer live voice.',
  noLiveVoiceOption: 'None available',
  noSpeech: 'No speech providers available',
  transcriptionLoading: 'Loading transcription models...',
  transcriptionUnavailable: 'Transcription models are not available.'
} as const;

export const FILE_CONVERSION_COPY = {
  fileImport: 'File import',
  fileImportDesc: 'Drop PDFs or audio into chat to turn them into notes.',
  readingMethod: 'Reading method',
  readingMethodDesc: 'Text is free. Vision reads scanned pages with a model.',
  textExtraction: 'Text extraction',
  vision: 'Vision',
  visionProvider: 'Vision provider',
  visionModel: 'Vision model',
  autoConvert: 'Convert new files automatically',
  autoConvertDesc: 'Adds a Markdown note next to each PDF, document or audio file added to the vault.',
  visionUnavailable: 'Vision models could not be loaded.'
} as const;

export const SEMANTIC_COPY = {
  toggle: 'Semantic search',
  toggleDesc: 'Find notes and past chats by meaning, not just exact words. Runs on this device.',
  restartNotice: (enabled: boolean): string =>
    `Semantic search ${enabled ? 'turned on' : 'turned off'}. Restart Obsidian to apply.`
} as const;

export const VIDEO_COPY = {
  aspectRatio: 'Aspect ratio',
  resolution: 'Resolution',
  noProviders: 'No video providers available',
  selectProvider: 'Select a video provider first',
  selectModel: 'Select a video model first'
} as const;
