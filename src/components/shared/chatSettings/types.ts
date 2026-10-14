import type {
  DefaultRealtimeVoiceModelSettings,
  DefaultSpeechModelSettings,
  LLMProviderSettings,
  ThinkingEffort,
  VoiceDefaultSelectionSource
} from '../../../types/llm/ProviderTypes';
import type { VideoAspectRatio, VideoResolution } from '../../../services/llm/types/VideoTypes';

/** Which screen the shared renderer is drawing. */
export type SettingsSurface = 'defaults' | 'chat';

/**
 * Current settings state edited by the shared renderer. Defaults persists it to
 * plugin settings; Chat settings applies it to the open conversation.
 */
export interface ChatSettings {
  provider: string;
  model: string;
  contextWindowOverrides?: Record<string, number>;
  webSearch?: boolean;
  // Subagent model - used for subagents, saved prompts and automations
  agentProvider?: string;
  agentModel?: string;
  thinking: {
    enabled: boolean;
    effort: ThinkingEffort;
  };
  // Subagent model thinking settings (separate from chat model)
  agentThinking?: {
    enabled: boolean;
    effort: ThinkingEffort;
  };
  temperature: number; // 0.0-1.0, controls randomness
  imageProvider: 'google' | 'openrouter' | 'openai';
  imageModel: string;
  speechProvider?: DefaultSpeechModelSettings['provider'];
  speechModel?: DefaultSpeechModelSettings['model'];
  speechVoice?: DefaultSpeechModelSettings['voice'];
  /** 'user' once the user picks read-aloud settings by hand; Defaults persists only then. */
  speechSource?: VoiceDefaultSelectionSource;
  realtimeVoiceProvider?: DefaultRealtimeVoiceModelSettings['provider'];
  realtimeVoiceModel?: DefaultRealtimeVoiceModelSettings['model'];
  realtimeVoiceVoice?: DefaultRealtimeVoiceModelSettings['voice'];
  /** 'user' once the user picks live voice settings by hand; Defaults persists only then. */
  realtimeVoiceSource?: VoiceDefaultSelectionSource;
  transcriptionProvider?: string;
  transcriptionModel?: string;
  /** Defaults only: text-to-video default, persisted through the Defaults save queue. */
  videoProvider?: 'google' | 'openrouter';
  videoModel?: string;
  videoAspectRatio?: VideoAspectRatio;
  videoResolution?: VideoResolution;
  workspaceId: string | null;
  workflowId?: string | null;
  promptId: string | null;
  contextNotes: string[];
}

/**
 * Available options for dropdowns
 */
export interface ChatSettingsOptions {
  workspaces: Array<{
    id: string;
    name: string;
    /** Canonical prompt binding (name or ID); preferred over context.dedicatedAgent. */
    dedicatedAgentId?: string;
    context?: {
      workflows?: Array<{ id: string; name: string; when?: string }>;
      dedicatedAgent?: {
        agentId: string;
        agentName: string;
      };
    };
  }>;
  prompts: Array<{ id: string; name: string }>;
}

/**
 * What a fold supplied by the host surface (Video, File conversion, Semantic
 * search on Defaults) can reach. Everything is live: `settings` is the object
 * the renderer edits, and `redraw()` re-renders only this fold's rows.
 */
export interface FoldHost {
  readonly settings: ChatSettings;
  readonly llmProviderSettings: LLMProviderSettings;
  readonly surface: SettingsSurface;
  notifyChange(): void;
  setSummary(summary: string): void;
  redraw(): void;
  registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    callback: (event: HTMLElementEventMap[K]) => unknown
  ): void;
}

/** A fold the host surface adds after the shared ones. */
export interface FoldDefinition {
  id: string;
  title: string;
  icon: string;
  /** Fill the fold's (already emptied) `setting-items` list and set its summary. */
  render(itemsEl: HTMLElement, host: FoldHost): void;
  destroy?(): void;
}
