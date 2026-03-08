/**
 * App Types — Type definitions for the Apps system
 *
 * Apps are installable tool modules (e.g., ElevenLabs, GitHub, Notion)
 * that plug into the existing getTools/useTools two-tool architecture.
 */

/**
 * Declares a credential field that an app requires.
 * Used by the settings UI to auto-generate input forms.
 */
export interface AppCredentialField {
  /** Storage key, e.g. "apiKey", "webhookUrl" */
  key: string;
  /** Human-readable label for the settings UI */
  label: string;
  /** Input type for the settings UI */
  type: 'password' | 'text';
  /** Whether this credential is required to use the app */
  required: boolean;
  /** Help text shown below the input */
  description?: string;
  /** Placeholder text for the input */
  placeholder?: string;
}

/**
 * Declares a tool that an app provides.
 * The actual tool implementation lives in the agent class.
 */
export interface AppToolDeclaration {
  /** Tool slug as used in getTools/useTools */
  slug: string;
  /** Short description */
  description: string;
}

/**
 * App manifest — declares identity, credentials, and tools.
 * Every app agent provides this as a static declaration.
 */
export interface AppManifest {
  /** Unique identifier, e.g. "elevenlabs", "github" */
  id: string;
  /** Display name shown in settings */
  name: string;
  /** Short description of what this app provides */
  description: string;
  /** Semver version */
  version: string;
  /** Author info */
  author: string;
  /** Agent name used in getTools/useTools (defaults to id) */
  agentName?: string;
  /** Credentials this app requires */
  credentials: AppCredentialField[];
  /** Tools this app provides */
  tools: AppToolDeclaration[];
  /** Optional: URL for documentation/help */
  docsUrl?: string;
}

/**
 * Per-app configuration stored in plugin settings.
 */
export interface AppConfig {
  /** Whether the app is enabled */
  enabled: boolean;
  /** Stored credential values */
  credentials: Record<string, string>;
  /** App-specific settings (e.g., default model selection) */
  settings?: Record<string, string>;
  /** ISO timestamp of when the app was installed */
  installedAt: string;
  /** App version at install time */
  installedVersion: string;
}

/**
 * Top-level apps settings, stored in MCPSettings.
 */
export interface AppsSettings {
  /** Map of app ID to its configuration */
  apps: Record<string, AppConfig>;
}

/**
 * ElevenLabs model language entry from the /v1/models API.
 */
export interface ElevenLabsModelLanguage {
  language_id: string;
  name: string;
}

/**
 * ElevenLabs model entry from GET /v1/models.
 */
export interface ElevenLabsModel {
  model_id: string;
  name: string;
  can_do_text_to_speech: boolean;
  can_do_voice_conversion: boolean;
  requires_alpha_access: boolean;
  description: string;
  token_cost_factor: number;
  languages: ElevenLabsModelLanguage[];
}
