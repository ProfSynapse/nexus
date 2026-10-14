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

/** "1 note", "4,512 notes". */
function countOf(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

export const SEMANTIC_COPY = {
  toggle: 'Semantic search',
  toggleDesc: 'Find notes and past chats by meaning, not just exact words. Runs on this device.',
  index: 'Index',
  indexOnDesc: 'Kept up to date as notes and chats change.',
  indexOffDesc: 'Kept on this device, so turning search back on only re-indexes notes that changed.',
  indexCounts: (notes: number, chats: number): string => `${countOf(notes, 'note')} · ${countOf(chats, 'chat')}`,
  indexPaused: (notes: number): string => `Paused · ${countOf(notes, 'note')}`,
  indexPausedUnknown: 'Paused',
  noIndex: 'No index on this device',
  starting: 'Starting',
  indexing: 'Indexing',
  /** Description of the Indexing row, from the queue's estimate in seconds. */
  indexingDesc: (secondsLeft: number | null): string => {
    if (secondsLeft === null || !Number.isFinite(secondsLeft) || secondsLeft <= 0) return 'You can keep working.';
    if (secondsLeft < 60) return 'Less than a minute left. You can keep working.';
    const minutes = Math.round(secondsLeft / 60);
    return `About ${minutes} minute${minutes === 1 ? '' : 's'} left. You can keep working.`;
  },
  indexingPausedDesc: 'Paused. Resume indexing whenever you like.',
  indexingProgress: (done: number, total: number): string => `${done.toLocaleString()} / ${total.toLocaleString()}`,
  pauseIndexing: 'Pause indexing',
  resumeIndexing: 'Resume indexing',
  deleteIndex: 'Delete index',
  deleteIndexDesc: 'Frees the space it uses. Turning search back on re-indexes the whole vault.',
  deleteFailed: 'The search index could not be deleted.',
  loadFailed: "Couldn't load the search model",
  /** Description of the load-failure row when the queue gave no detail. */
  loadFailedDesc: 'Semantic search is on, but nothing can be indexed or searched until the model loads.',
  tryAgain: 'Try again',
  retryFailed: 'Semantic search could not start. Restart Obsidian to try again.',
  applyFailed: 'The semantic search setting could not be applied. Restart Obsidian to apply it.'
} as const;

/** The confirmation shown before semantic search is turned off. */
export const SEMANTIC_OFF_MODAL_COPY = {
  title: 'Turn off semantic search?',
  lede: 'Nexus will match exact words only.',
  bullets: [
    'Vault search falls back to keyword matching, and agents stop being offered semantic search.',
    'Searching past chats by meaning stops working.',
    'Note suggestions in chat use file names only.'
  ],
  note: 'Your index stays on this device, so turning it back on is quick.',
  cancel: 'Cancel',
  confirm: 'Turn off'
} as const;

/** The confirmation shown before the search index is deleted (owner decision 6). */
export const SEMANTIC_DELETE_MODAL_COPY = {
  title: 'Delete the search index?',
  body: SEMANTIC_COPY.deleteIndexDesc,
  cancel: 'Cancel',
  confirm: 'Delete'
} as const;

export const VIDEO_COPY = {
  aspectRatio: 'Aspect ratio',
  resolution: 'Resolution',
  noProviders: 'No video providers available',
  selectProvider: 'Select a video provider first',
  selectModel: 'Select a video model first'
} as const;
