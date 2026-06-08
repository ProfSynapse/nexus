export type LiveVoiceComposerState =
  | 'inactive'
  | 'connecting'
  | 'listening'
  | 'user-speaking'
  | 'assistant-speaking'
  | 'error';

export interface LiveVoiceStatus {
  state: LiveVoiceComposerState;
  text?: string;
}
