# Apps Architecture: Downloadable Tool Domains

## Overview

Apps are installable tool modules that extend Nexus with external service integrations (e.g., ElevenLabs, GitHub, Notion). Each app is a self-contained agent with credentials, tools, and a manifest — that plugs directly into the existing `getTools`/`useTools` two-tool architecture.

**Key principle:** An installed app is just another agent in the registry. No changes to `getTools` or `useTools` are needed — apps automatically become discoverable and executable through the existing infrastructure.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    getTools / useTools               │
│              (unchanged — apps are just agents)      │
└────────────────────────┬────────────────────────────┘
                         │
          ┌──────────────┼──────────────────┐
          │              │                  │
   ┌──────┴──────┐ ┌────┴─────┐  ┌─────────┴────────┐
   │ Core Agents │ │ToolMgr   │  │   App Agents     │
   │ contentMgr  │ │ getTools │  │  elevenLabs      │
   │ storageMgr  │ │ useTools │  │  github          │
   │ searchMgr   │ │          │  │  notion          │
   │ memoryMgr   │ │          │  │  (any installed) │
   │ promptMgr   │ │          │  │                  │
   │ canvasMgr   │ │          │  │                  │
   └─────────────┘ └──────────┘  └──────────────────┘
                                        │
                                 ┌──────┴──────┐
                                 │ AppManager  │
                                 │ - install   │
                                 │ - uninstall │
                                 │ - configure │
                                 │ - registry  │
                                 └─────────────┘
```

---

## App Manifest

Every app ships a `manifest.json` that declares its identity, credentials requirements, and tools:

```typescript
// src/types/apps/AppTypes.ts

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

  /** Tools this app provides (declared for validation, actual tools come from the agent class) */
  tools: AppToolDeclaration[];

  /** Optional: minimum Nexus version required */
  minNexusVersion?: string;

  /** Optional: URL for documentation/help */
  docsUrl?: string;
}

export interface AppCredentialField {
  /** Key used to store this credential, e.g. "apiKey", "webhookUrl" */
  key: string;

  /** Human-readable label for settings UI */
  label: string;

  /** Input type for the settings UI */
  type: 'password' | 'text' | 'oauth';

  /** Whether this credential is required to use the app */
  required: boolean;

  /** Help text shown below the input */
  description?: string;

  /** Placeholder text */
  placeholder?: string;

  /** For OAuth: the OAuth provider config */
  oauth?: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
  };
}

export interface AppToolDeclaration {
  /** Tool slug as used in getTools/useTools */
  slug: string;

  /** Short description */
  description: string;

  /** Whether this tool requires specific credentials to function */
  requiresCredentials?: string[];
}
```

### Example: ElevenLabs Manifest

```json
{
  "id": "elevenlabs",
  "name": "ElevenLabs",
  "description": "AI voice generation — text-to-speech, voice cloning, and sound effects",
  "version": "1.0.0",
  "author": "Nexus",
  "credentials": [
    {
      "key": "apiKey",
      "label": "API Key",
      "type": "password",
      "required": true,
      "description": "Get your API key from elevenlabs.io/settings",
      "placeholder": "sk_..."
    }
  ],
  "tools": [
    {
      "slug": "textToSpeech",
      "description": "Convert text to speech audio using ElevenLabs voices",
      "requiresCredentials": ["apiKey"]
    },
    {
      "slug": "listVoices",
      "description": "List available voices"
    },
    {
      "slug": "soundEffects",
      "description": "Generate sound effects from text descriptions",
      "requiresCredentials": ["apiKey"]
    }
  ]
}
```

---

## BaseAppAgent

Apps extend a new `BaseAppAgent` that adds credential management on top of `BaseAgent`:

```typescript
// src/agents/apps/BaseAppAgent.ts

import { BaseAgent } from '../baseAgent';
import { AppManifest, AppCredentialField } from '../../types/apps/AppTypes';
import { CommonResult } from '../../types';

/**
 * Base class for all app agents.
 * Extends BaseAgent with credential management and app lifecycle.
 *
 * Subclasses implement:
 *   - registerAppTools(): Register tools in constructor
 *   - validateCredentials(): Optional deeper validation (API ping, etc.)
 */
export abstract class BaseAppAgent extends BaseAgent {
  readonly manifest: AppManifest;
  protected credentials: Record<string, string> = {};

  constructor(manifest: AppManifest) {
    super(
      manifest.agentName || manifest.id,
      manifest.description,
      manifest.version
    );
    this.manifest = manifest;
  }

  /**
   * Set credentials from settings. Called by AppManager on load/configure.
   * Credentials are NOT stored by the agent — they live in plugin settings.
   * This just injects them for runtime use.
   */
  setCredentials(credentials: Record<string, string>): void {
    this.credentials = { ...credentials };
    this.onCredentialsUpdated();
  }

  /**
   * Get a specific credential value.
   * Tools call this to get API keys, tokens, etc.
   */
  getCredential(key: string): string | undefined {
    return this.credentials[key];
  }

  /**
   * Check if all required credentials are configured.
   */
  hasRequiredCredentials(): boolean {
    return this.manifest.credentials
      .filter(c => c.required)
      .every(c => !!this.credentials[c.key]?.trim());
  }

  /**
   * Get missing required credentials (for error messages).
   */
  getMissingCredentials(): AppCredentialField[] {
    return this.manifest.credentials
      .filter(c => c.required && !this.credentials[c.key]?.trim());
  }

  /**
   * Hook called when credentials change. Override to reinitialize clients, etc.
   */
  protected onCredentialsUpdated(): void {
    // Default: no-op. Apps can override to rebuild HTTP clients, etc.
  }

  /**
   * Optional: Validate credentials by making a test API call.
   * Returns a result indicating success or specific error.
   */
  async validateCredentials(): Promise<CommonResult> {
    if (!this.hasRequiredCredentials()) {
      const missing = this.getMissingCredentials().map(c => c.label);
      return {
        success: false,
        error: `Missing required credentials: ${missing.join(', ')}`
      };
    }
    return { success: true };
  }

  /**
   * Override description to show credential status.
   * When credentials are missing, the description tells the LLM
   * that the app needs configuration before use.
   */
  get description(): string {
    if (!this.hasRequiredCredentials()) {
      const missing = this.getMissingCredentials().map(c => c.label);
      return `${this._description} [SETUP REQUIRED: configure ${missing.join(', ')} in Nexus settings]`;
    }
    return this._description;
  }
}
```

### Example: ElevenLabs Agent

```typescript
// src/agents/apps/elevenlabs/ElevenLabsAgent.ts

import { BaseAppAgent } from '../BaseAppAgent';
import { TextToSpeechTool } from './tools/textToSpeech';
import { ListVoicesTool } from './tools/listVoices';
import { SoundEffectsTool } from './tools/soundEffects';

const manifest = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  description: 'AI voice generation — text-to-speech, voice cloning, and sound effects',
  version: '1.0.0',
  author: 'Nexus',
  credentials: [
    { key: 'apiKey', label: 'API Key', type: 'password' as const, required: true,
      description: 'Get your API key from elevenlabs.io/settings' }
  ],
  tools: [
    { slug: 'textToSpeech', description: 'Convert text to speech audio' },
    { slug: 'listVoices', description: 'List available voices' },
    { slug: 'soundEffects', description: 'Generate sound effects from text' }
  ]
};

export class ElevenLabsAgent extends BaseAppAgent {
  constructor() {
    super(manifest);
    // Register tools — each tool gets a reference to this agent for credentials
    this.registerTool(new TextToSpeechTool(this));
    this.registerTool(new ListVoicesTool(this));
    this.registerTool(new SoundEffectsTool(this));
  }

  protected onCredentialsUpdated(): void {
    // Could reinitialize an HTTP client here if needed
  }
}
```

### Example: App Tool

```typescript
// src/agents/apps/elevenlabs/tools/textToSpeech.ts

import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { BaseAppAgent } from '../../BaseAppAgent';
import { requestUrl } from 'obsidian';

interface TextToSpeechParams extends CommonParameters {
  text: string;
  voiceId?: string;
  modelId?: string;
  outputPath?: string;
}

export class TextToSpeechTool extends BaseTool<TextToSpeechParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super('textToSpeech', 'Text to Speech', 'Convert text to speech audio using ElevenLabs', '1.0.0');
    this.agent = agent;
  }

  async execute(params: TextToSpeechParams): Promise<CommonResult> {
    // Check credentials before execution
    if (!this.agent.hasRequiredCredentials()) {
      const missing = this.agent.getMissingCredentials().map(c => c.label);
      return this.prepareResult(false, undefined,
        `ElevenLabs requires configuration. Missing: ${missing.join(', ')}. Set up in Nexus settings.`);
    }

    const apiKey = this.agent.getCredential('apiKey');
    const voiceId = params.voiceId || 'EXAVITQu4vr4xnSDxMaL'; // Default: Bella

    try {
      const response = await requestUrl({
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        method: 'POST',
        headers: {
          'xi-api-key': apiKey!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: params.text,
          model_id: params.modelId || 'eleven_multilingual_v2'
        })
      });

      // Save audio to vault
      const outputPath = params.outputPath || `audio/tts-${Date.now()}.mp3`;
      // ... save response.arrayBuffer to vault ...

      return this.prepareResult(true, { path: outputPath, voiceId });
    } catch (error) {
      return this.prepareResult(false, undefined, `TTS failed: ${error}`);
    }
  }

  getParameterSchema() {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to convert to speech' },
        voiceId: { type: 'string', description: 'Voice ID (optional, defaults to Bella)' },
        modelId: { type: 'string', description: 'Model ID (optional, defaults to eleven_multilingual_v2)' },
        outputPath: { type: 'string', description: 'Output path in vault (optional)' }
      },
      required: ['text']
    });
  }
}
```

---

## AppManager

Manages the lifecycle of all apps — install, configure, enable/disable, uninstall:

```typescript
// src/services/apps/AppManager.ts

import { App } from 'obsidian';
import { BaseAppAgent } from '../../agents/apps/BaseAppAgent';
import { AppManifest } from '../../types/apps/AppTypes';
import { IAgent } from '../../agents/interfaces/IAgent';
import { logger } from '../../utils/logger';

export interface AppConfig {
  /** Whether the app is enabled */
  enabled: boolean;
  /** Stored credentials (encrypted at rest in settings) */
  credentials: Record<string, string>;
  /** When the app was installed */
  installedAt: string;
  /** App version at install time */
  installedVersion: string;
}

export interface AppsSettings {
  /** Map of app ID to its configuration */
  apps: Record<string, AppConfig>;
}

export class AppManager {
  private apps: Map<string, BaseAppAgent> = new Map();
  private appConfigs: Record<string, AppConfig>;
  private agentRegistryCallback: (agent: IAgent) => void;
  private agentUnregistryCallback: (agentName: string) => void;

  constructor(
    private app: App,
    appsSettings: AppsSettings,
    onRegister: (agent: IAgent) => void,
    onUnregister: (agentName: string) => void
  ) {
    this.appConfigs = appsSettings.apps || {};
    this.agentRegistryCallback = onRegister;
    this.agentUnregistryCallback = onUnregister;
  }

  /**
   * Load all installed and enabled apps.
   * Called during plugin initialization after core agents are registered.
   */
  async loadInstalledApps(): Promise<void> {
    const registry = this.getBuiltInAppRegistry();

    for (const [appId, config] of Object.entries(this.appConfigs)) {
      if (!config.enabled) continue;

      const factory = registry.get(appId);
      if (!factory) {
        logger.systemWarn(`App "${appId}" is installed but no factory found — skipping`);
        continue;
      }

      try {
        const agent = factory();
        agent.setCredentials(config.credentials);
        this.apps.set(appId, agent);
        this.agentRegistryCallback(agent);
        logger.systemLog(`App loaded: ${appId}`);
      } catch (error) {
        logger.systemError(error as Error, `App Load: ${appId}`);
      }
    }
  }

  /**
   * Install an app by ID. Creates config entry and registers the agent.
   */
  async installApp(appId: string): Promise<{ success: boolean; error?: string }> {
    if (this.apps.has(appId)) {
      return { success: false, error: `App "${appId}" is already installed` };
    }

    const registry = this.getBuiltInAppRegistry();
    const factory = registry.get(appId);
    if (!factory) {
      return { success: false, error: `Unknown app: "${appId}"` };
    }

    const agent = factory();

    // Create config entry
    this.appConfigs[appId] = {
      enabled: true,
      credentials: {},
      installedAt: new Date().toISOString(),
      installedVersion: agent.manifest.version
    };

    this.apps.set(appId, agent);
    this.agentRegistryCallback(agent);

    return { success: true };
  }

  /**
   * Uninstall an app. Removes from registry and clears config.
   */
  async uninstallApp(appId: string): Promise<{ success: boolean; error?: string }> {
    const agent = this.apps.get(appId);
    if (!agent) {
      return { success: false, error: `App "${appId}" is not installed` };
    }

    agent.onunload();
    this.agentUnregistryCallback(agent.name);
    this.apps.delete(appId);
    delete this.appConfigs[appId];

    return { success: true };
  }

  /**
   * Update credentials for an installed app.
   */
  setAppCredentials(appId: string, credentials: Record<string, string>): boolean {
    const agent = this.apps.get(appId);
    if (!agent) return false;

    agent.setCredentials(credentials);

    // Persist to config
    if (this.appConfigs[appId]) {
      this.appConfigs[appId].credentials = { ...credentials };
    }
    return true;
  }

  /**
   * Enable/disable an app without uninstalling.
   */
  async setAppEnabled(appId: string, enabled: boolean): Promise<boolean> {
    if (!this.appConfigs[appId]) return false;
    this.appConfigs[appId].enabled = enabled;

    if (enabled && !this.apps.has(appId)) {
      // Re-register
      await this.installApp(appId);
    } else if (!enabled && this.apps.has(appId)) {
      // Unregister but keep config
      const agent = this.apps.get(appId)!;
      agent.onunload();
      this.agentUnregistryCallback(agent.name);
      this.apps.delete(appId);
    }

    return true;
  }

  /**
   * List all available apps (installed or not).
   */
  getAvailableApps(): Array<{
    id: string;
    manifest: AppManifest;
    installed: boolean;
    enabled: boolean;
    configured: boolean;
  }> {
    const registry = this.getBuiltInAppRegistry();
    const results = [];

    for (const [appId, factory] of registry) {
      const agent = this.apps.get(appId);
      const config = this.appConfigs[appId];
      const tempAgent = agent || factory();

      results.push({
        id: appId,
        manifest: tempAgent.manifest,
        installed: !!config,
        enabled: config?.enabled ?? false,
        configured: agent ? agent.hasRequiredCredentials() : false,
      });
    }

    return results;
  }

  /**
   * Get current configs for persistence.
   */
  getAppsSettings(): AppsSettings {
    return { apps: { ...this.appConfigs } };
  }

  /**
   * Registry of built-in apps.
   * This is where new apps are added — just add a factory function.
   *
   * Future: This could also load from a remote registry or local directory
   * for community apps.
   */
  private getBuiltInAppRegistry(): Map<string, () => BaseAppAgent> {
    const registry = new Map<string, () => BaseAppAgent>();

    // === ADD NEW APPS HERE ===
    // registry.set('elevenlabs', () => new ElevenLabsAgent());
    // registry.set('github', () => new GitHubAgent());
    // registry.set('notion', () => new NotionAgent());
    // registry.set('slack', () => new SlackAgent());
    // registry.set('todoist', () => new TodoistAgent());

    return registry;
  }
}
```

---

## Integration Points

### 1. Settings Storage

App credentials are stored alongside existing settings:

```typescript
// Addition to MCPSettings in src/types/plugin/PluginTypes.ts

export interface MCPSettings {
  // ... existing fields ...

  /** Installed apps and their credentials */
  apps?: AppsSettings;
}
```

### 2. Agent Registration (in AgentRegistrationService)

Apps load AFTER core agents but BEFORE toolManager:

```
PHASE 1: Core independent agents (content, storage, canvas)
PHASE 2: Core dependent agents (prompt, search, memory)
PHASE 3: App agents ← NEW
PHASE 4: ToolManager (needs all agents including apps)
```

```typescript
// In AgentRegistrationService.doInitializeAllAgents():

// PHASE 3: Load app agents
await this.safeInitialize('apps', async () => {
  const appsSettings = this.getAppsSettings();
  this.appManager = new AppManager(
    this.app,
    appsSettings,
    (agent) => this.agentManager.registerAgent(agent),
    (name) => this.agentManager.unregisterAgent(name)
  );
  await this.appManager.loadInstalledApps();
});

// PHASE 4: ToolManager MUST be last
await this.safeInitialize('toolManager', () =>
  this.initializationService.initializeToolManager()
);
```

### 3. getTools Discovery (zero changes needed)

Since apps are registered as standard agents, `GetToolsTool` already iterates `agentRegistry` and will include app agents automatically:

```
LLM calls getTools → sees all agents including:
  contentManager: [read, write, update]
  elevenlabs: [textToSpeech, listVoices, soundEffects]   ← app!
  github: [createIssue, listPRs, searchCode]              ← app!
```

### 4. useTools Execution (zero changes needed)

```
LLM calls useTools({
  context: { ... },
  calls: [{
    agent: "elevenlabs",          ← routes to ElevenLabsAgent
    tool: "textToSpeech",
    arguments: { text: "Hello world" }
  }]
})
```

### 5. getTools Description Update

The only change to `GetToolsTool` is that app agents naturally appear in the description since it already iterates all registered agents. No code changes needed — they just show up.

### 6. findToolInOtherAgents (minor update)

`BaseAgent.findToolInOtherAgents` has a hardcoded list of agent names. This should be updated to use the agent manager dynamically:

```typescript
// Instead of hardcoded:
const agentNames = ['storageManager', 'contentManager', ...];

// Use dynamic discovery:
// The agentManager already provides this capability
```

---

## Settings UI

The apps settings tab renders dynamically from manifests:

```
Settings → Apps
├── Available Apps
│   ├── ElevenLabs ✅ Installed
│   │   ├── [API Key: ••••••••••] [Validate]
│   │   ├── Status: Connected ✓
│   │   └── [Disable] [Uninstall]
│   ├── GitHub ○ Not installed
│   │   └── [Install]
│   ├── Notion ○ Not installed
│   │   └── [Install]
│   └── Slack ○ Not installed
│       └── [Install]
```

The UI is generated from `AppManifest.credentials` — no custom UI code per app:

```typescript
// Pseudocode for settings rendering
for (const { manifest, installed, configured } of appManager.getAvailableApps()) {
  renderAppCard(manifest.name, manifest.description);

  if (installed) {
    for (const cred of manifest.credentials) {
      renderCredentialInput(cred.label, cred.type, cred.key);
    }
    renderButton('Validate', () => agent.validateCredentials());
    renderButton('Uninstall', () => appManager.uninstallApp(manifest.id));
  } else {
    renderButton('Install', () => appManager.installApp(manifest.id));
  }
}
```

---

## Adding a New App (Developer Guide)

Adding a new app requires **3 files**:

### Step 1: Create the agent

```
src/agents/apps/myapp/
├── MyAppAgent.ts       ← extends BaseAppAgent, declares manifest
└── tools/
    ├── toolOne.ts      ← extends BaseTool
    └── toolTwo.ts      ← extends BaseTool
```

### Step 2: Register in AppManager

```typescript
// In AppManager.getBuiltInAppRegistry():
registry.set('myapp', () => new MyAppAgent());
```

### Step 3: Done

That's it. The app will:
- Appear in the settings UI (credentials form auto-generated from manifest)
- Appear in `getTools` discovery when installed & enabled
- Be executable via `useTools` with full context support
- Show "[SETUP REQUIRED]" in description if credentials are missing

---

## File Structure

```
src/
├── agents/
│   ├── apps/                          ← NEW
│   │   ├── BaseAppAgent.ts            ← Base class for all app agents
│   │   ├── elevenlabs/
│   │   │   ├── ElevenLabsAgent.ts
│   │   │   └── tools/
│   │   │       ├── textToSpeech.ts
│   │   │       ├── listVoices.ts
│   │   │       └── soundEffects.ts
│   │   ├── github/
│   │   │   ├── GitHubAgent.ts
│   │   │   └── tools/
│   │   │       └── ...
│   │   └── notion/
│   │       ├── NotionAgent.ts
│   │       └── tools/
│   │           └── ...
│   └── ... (existing agents unchanged)
├── services/
│   └── apps/                          ← NEW
│       └── AppManager.ts              ← Install/configure/lifecycle
├── types/
│   └── apps/                          ← NEW
│       └── AppTypes.ts                ← Manifest, credential, config types
└── settings/
    └── tabs/
        └── AppsSettingsTab.ts         ← NEW (auto-generated settings UI)
```

---

## Future Considerations

### Community App Registry
A remote JSON index of community-contributed apps. The `AppManager.getBuiltInAppRegistry()` could be extended to fetch from a URL:

```json
{
  "apps": [
    {
      "id": "elevenlabs",
      "manifest_url": "https://registry.nexus.so/apps/elevenlabs/manifest.json",
      "source_url": "https://github.com/nexus-apps/elevenlabs"
    }
  ]
}
```

### Hot-loading
Apps could potentially be loaded without restarting Obsidian, since `AgentRegistry` already supports `registerAgent`/`unregisterAgent` and `GetToolsTool` iterates the registry dynamically.

### App-scoped Storage
Apps may need persistent storage beyond credentials (caches, downloaded voice lists, etc.). This could use the existing `.nexus/` directory structure:

```
.nexus/
├── apps/
│   ├── elevenlabs/
│   │   └── voices-cache.json
│   └── github/
│       └── repos-cache.json
```

### Rate Limiting & Cost Tracking
Since all app tool calls flow through `useTools`, we could add middleware for:
- Per-app rate limiting
- API call cost tracking
- Usage analytics per app

---

## Summary

| Aspect | Approach |
|--------|----------|
| **App = Agent** | Apps extend `BaseAppAgent` → `BaseAgent` → `IAgent` |
| **Discovery** | Zero changes to `getTools` — apps are just agents in the registry |
| **Execution** | Zero changes to `useTools` — apps route like any agent |
| **Credentials** | Declarative in manifest, stored in plugin settings, injected at runtime |
| **Settings UI** | Auto-generated from `AppManifest.credentials` |
| **Adding apps** | 1 agent file + N tool files + 1 line in registry |
| **Extensibility** | Community registry, hot-loading, app storage all possible later |
