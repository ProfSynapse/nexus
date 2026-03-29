# Building Apps for Nexus

This is an agentic prompt — feed it to your AI coding assistant along with the repo to build a new Nexus app.

---

## Prompt

You are building a new **App** for [Nexus MCP for Obsidian](https://github.com/ProfSynapse/claudesidian-mcp), an Obsidian plugin that exposes vault operations via MCP tools. Apps are downloadable tool domains that extend Nexus with third-party API integrations (e.g., ElevenLabs for audio, a weather API, a translation service).

### What Is an App?

An app is a self-contained agent that:
- Declares its identity, credentials, and tools via a **manifest**
- Extends `BaseAppAgent` for credential management, vault access, and optional full `App` access
- Registers tools that extend `BaseTool` for execution
- Gets auto-discovered via `getTools` and executed via `useTools` (the two-tool architecture)
- Has its own settings modal for API key entry and validation

### Step-by-Step Process

#### 1. Read These Files First

Understand the patterns before writing any code:

| File | What You'll Learn |
|------|-------------------|
| `src/types/apps/AppTypes.ts` | Type definitions: `AppManifest`, `AppCredentialField`, `AppConfig` |
| `src/agents/apps/BaseAppAgent.ts` | Base class: credential management, vault access, validation |
| `src/agents/baseTool.ts` | Tool base class: `execute()`, `getParameterSchema()`, `prepareResult()` |
| `src/agents/apps/elevenlabs/ElevenLabsAgent.ts` | **Reference app**: manifest, constructor, `validateCredentials()` |
| `src/agents/apps/elevenlabs/tools/listVoices.ts` | **Reference tool**: simple GET request, parameter schema, error handling |
| `src/agents/apps/elevenlabs/tools/textToSpeech.ts` | **Reference tool**: POST with binary response, vault file saving |
| `src/agents/apps/webTools/WebToolsAgent.ts` | **Reference app**: desktop-only app with no credentials |
| `src/agents/apps/webTools/tools/captureToMarkdown.ts` | **Reference tool**: command-driven Obsidian integration using `App`, `WorkspaceLeaf`, and required `outputPath` |
| `src/agents/apps/webTools/tools/extractLinks.ts` | **Reference tool**: Web Viewer DOM extraction using `executeJavaScript()` |
| `src/services/apps/AppManager.ts` | App lifecycle: registry, install, credential injection |
| `src/components/AppConfigModal.ts` | Settings UI: auto-generated from manifest credentials |

#### 2. Create Your App Directory

```
src/agents/apps/{your-app-id}/
├── {YourApp}Agent.ts        # Main agent class
└── tools/
    ├── {toolOne}.ts         # Each tool in its own file
    └── {toolTwo}.ts
```

#### 3. Define Your Manifest

In your agent file, declare a manifest constant:

```typescript
import { AppManifest } from '../../../types/apps/AppTypes';

const MY_APP_MANIFEST: AppManifest = {
  id: 'my-app',                    // Unique ID (lowercase, hyphenated)
  name: 'My App',                  // Display name in settings
  description: 'What this app does in one line',
  version: '1.0.0',
  author: 'Your Name',
  docsUrl: 'https://docs.example.com',  // Optional: link shown in settings modal
  credentials: [
    {
      key: 'apiKey',               // Storage key
      label: 'API Key',           // Shown in settings UI
      type: 'password',           // 'password' masks input, 'text' shows it
      required: true,
      description: 'Get your key from example.com. Required permissions: read, write.',
      placeholder: 'sk_...',
    },
    // Add more credentials as needed (webhook URLs, tokens, etc.)
  ],
  tools: [
    { slug: 'myTool', description: 'What this tool does' },
    // List all tools — these show up in getTools discovery
  ],
};
```

#### 4. Create Your Agent Class

```typescript
import { BaseAppAgent } from '../BaseAppAgent';
import { CommonResult } from '../../../types';
import { requestUrl } from 'obsidian';
import { MyTool } from './tools/myTool';

export class MyAppAgent extends BaseAppAgent {
  constructor() {
    super(MY_APP_MANIFEST);

    // Register all tools
    this.registerTool(new MyTool(this));
  }

  /**
   * Validate credentials by hitting a lightweight API endpoint.
   * Override this to test the API key works.
   */
  async validateCredentials(): Promise<CommonResult> {
    const baseValidation = await super.validateCredentials();
    if (!baseValidation.success) return baseValidation;

    const apiKey = this.getCredential('apiKey')!;

    try {
      const response = await requestUrl({
        url: 'https://api.example.com/v1/ping',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      return {
        success: true,
        data: { message: 'API key validated successfully' },
      };
    } catch (error: unknown) {
      const status = (error as Record<string, unknown>)?.status;
      return {
        success: false,
        error: `API validation failed${status ? ` (${status})` : ''}: ${error}`,
      };
    }
  }
}
```

#### 5. Create Your Tools

Each tool extends `BaseTool<Params, Result>`:

```typescript
import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseAppAgent } from '../../BaseAppAgent';
import { requestUrl, normalizePath } from 'obsidian';

interface MyToolParams extends CommonParameters {
  query: string;
  outputPath?: string;  // Use for generated artifacts written into the vault
}

export class MyTool extends BaseTool<MyToolParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'myTool',           // slug (must match manifest)
      'My Tool',          // display name
      'What this tool does.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: MyToolParams): Promise<CommonResult> {
    // 1. Check credentials
    if (!this.agent.hasRequiredCredentials()) {
      const missing = this.agent.getMissingCredentials().map(c => c.label);
      return this.prepareResult(false, undefined,
        `App not configured. Missing: ${missing.join(', ')}. Set up in Nexus Settings → Apps.`);
    }

    const apiKey = this.agent.getCredential('apiKey')!;

    try {
      // 2. Call external API (always use requestUrl, never fetch)
      const response = await requestUrl({
        url: 'https://api.example.com/v1/action',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: params.query }),
      });

      // 3. Check status (requestUrl may throw on non-200, but be defensive)
      if (response.status !== 200) {
        return this.prepareResult(false, undefined,
          `API error (${response.status}): ${response.text || 'Unknown error'}`);
      }

      // 4. Return result
      return this.prepareResult(true, {
        result: response.json,
      });
    } catch (error: unknown) {
      const status = (error as Record<string, unknown>)?.status;
      const body = (error as Record<string, unknown>)?.text
        ?? (error as Record<string, unknown>)?.message
        ?? String(error);
      return this.prepareResult(false, undefined,
        `Failed${status ? ` (${status})` : ''}: ${body}`);
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The input query',
        },
      },
      required: ['query'],
    });
  }
}
```

##### Saving Files to the Vault

If your tool produces binary output (audio, images, PDFs, etc.):

```typescript
// Get vault from agent
const vault = this.agent.getVault();
if (!vault) {
  return this.prepareResult(false, undefined, 'Vault not available');
}

// Determine output path
const outputPath = normalizePath(params.outputPath || `output/file-${Date.now()}.ext`);

// Ensure parent directory exists
const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
if (dir) {
  try {
    const existing = vault.getAbstractFileByPath(dir);
    if (!existing) await vault.createFolder(dir);
  } catch { /* directory may already exist */ }
}

// Save binary data
await vault.createBinary(outputPath, response.arrayBuffer);

// Return the path
return this.prepareResult(true, {
  path: outputPath,
  fileSize: response.arrayBuffer.byteLength,
});
```

For text files, use `vault.create(path, content)` instead of `vault.createBinary()`.

If your tool must let the LLM choose exactly where to save the result, make `outputPath` required in the schema. The new Web Tools app uses this pattern for Markdown, PNG, and PDF capture tools so callers must decide the destination explicitly.

##### Desktop-only apps that need the full Obsidian app

Some apps need workspace, command, or Web Viewer access rather than just raw vault writes. In those cases:

- call `this.agent.getApp()` inside the tool
- guard with desktop/Electron checks when the feature depends on Web Viewer or Electron APIs
- keep `outputPath` for file-producing tools so the save destination remains explicit

The `webTools` app is the reference example for this pattern:
- `openWebpage` opens Obsidian Web Viewer tabs
- `captureToMarkdown` uses the built-in `webviewer:save-to-vault` command, then moves the note to the required `outputPath`
- `capturePagePng`, `capturePagePdf`, and `extractLinks` operate on the warmed-up embedded webview directly

#### 6. Register Your App

In `src/services/apps/AppManager.ts`, add your app to the registry:

```typescript
import { MyAppAgent } from '../../agents/apps/my-app/MyAppAgent';

// Inside getBuiltInAppRegistry():
registry.set('my-app', () => new MyAppAgent());
```

That's it. The app system handles everything else automatically:
- Settings UI generates from your manifest
- Credentials are stored in plugin settings
- Tools are discoverable via `getTools` and executable via `useTools`
- Vault access is injected automatically
- Full `App` access is injected automatically for apps that need workspace or command APIs

#### 7. Build and Test

```bash
npm run build     # Must pass clean (TypeScript + esbuild)
npm run test      # Run existing tests (don't break anything)
```

Test in Obsidian:
1. Reload plugin
2. Go to Settings → Nexus → Apps
3. Install your app
4. Enter credentials and validate
5. Test tools via chat or MCP client

### Rules to Follow

| Rule | Details |
|------|---------|
| **Use `requestUrl()`** | Never use `fetch()` — Obsidian's `requestUrl()` handles CORS |
| **Use `normalizePath()`** | Always normalize vault paths |
| **No `console.log`** | Use `console.error` only for actual errors |
| **No inline styles** | All CSS goes in `styles.css` using CSS variables |
| **No `innerHTML`** | Use `createEl()`, `createDiv()`, `textContent` |
| **Check HTTP status** | Always check `response.status` before accessing body |
| **Handle errors** | Extract status and body from caught errors |
| **Credential safety** | Never log API key values — only log `'present'` or `'missing'` |
| **File saving** | Use `vault.createBinary()` / `vault.create()` — never `vault.adapter` |
| **Artifact paths** | Prefer `outputPath` for generated files. Make it required when the caller must choose the save location explicitly |
| **Desktop-only features** | Guard Electron/Web Viewer behavior with desktop checks and keep mobile-safe fallbacks or clear errors |
| **Validate credentials** | Override `validateCredentials()` to test the API key works |

### Submitting Your App

1. Fork [ProfSynapse/claudesidian-mcp](https://github.com/ProfSynapse/claudesidian-mcp)
2. Create your app following this guide
3. Ensure `npm run build` and `npm run test` pass
4. Open a PR with:
   - Your app directory (`src/agents/apps/{your-app}/`)
   - The one-line registry addition in `AppManager.ts`
   - A brief description of what your app does and which API it integrates
