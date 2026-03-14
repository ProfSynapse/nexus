# Claude Code Context Document
Last Updated: 2026-03-13

## Project Overview
- **Name**: Claudesidian MCP
- **Version**: 5.3.0
- **Type**: Obsidian Community Plugin
- **Purpose**: MCP integration for Obsidian with AI-powered vault operations
- **Architecture**: Agent-Tool pattern with domain-driven design
- **Stack**: TypeScript, Node.js, Obsidian Plugin API, MCP SDK

## Obsidian Plugin Development Guidelines

This is an **Obsidian community plugin** that must follow official [Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines). All code changes must adhere to these best practices.

### Plugin Lifecycle

```typescript
// Plugins extend the Plugin base class
export default class MyPlugin extends Plugin {
    async onload() {
        // Initialize UI, register commands, set up events
        // Use registration methods for auto-cleanup
    }

    async onunload() {
        // Clean up resources (most handled automatically)
    }
}
```

**Key lifecycle rules:**
- All registration methods (`registerEvent`, `addCommand`, `registerView`, `registerInterval`) auto-cleanup on unload
- Never store view references in the plugin instance (causes memory leaks)
- Use `this.app.workspace.onLayoutReady()` to defer startup operations

### Styling - ALL STYLES IN styles.css

**CRITICAL**: All styles must be defined in `styles.css`, never inline in TypeScript/JavaScript.

```typescript
// ❌ NEVER do this
element.style.color = 'white';
element.style.backgroundColor = 'red';
element.style.display = 'flex';

// ✅ ALWAYS do this
element.addClass('my-plugin-element');
```

```css
/* In styles.css - use CSS variables for theme compatibility */
.my-plugin-element {
    color: var(--text-normal);
    background-color: var(--background-primary);
    display: flex;
}
```

**Required CSS Variables** (never hardcode colors):
| Variable | Purpose |
|----------|---------|
| `--text-normal`, `--text-muted`, `--text-faint` | Text colors |
| `--text-accent` | Interactive/link text |
| `--background-primary`, `--background-secondary` | Background colors |
| `--background-modifier-border` | Borders |
| `--background-modifier-error` | Error states |
| `--interactive-accent`, `--interactive-accent-hover` | Buttons/interactive |
| `--radius-s`, `--radius-m`, `--radius-l` | Border radius |

### Security Requirements

**innerHTML is FORBIDDEN** with dynamic content:
```typescript
// ❌ NEVER - XSS vulnerability
element.innerHTML = userProvidedContent;
element.innerHTML = `<div>${dynamicData}</div>`;

// ✅ Safe patterns
element.textContent = userProvidedContent;  // For text
element.createEl('div', { text: dynamicData });  // Obsidian API

// ✅ Safe innerHTML patterns (only these are acceptable)
element.innerHTML = '';  // Clearing
const escaped = div.innerHTML;  // Reading already-escaped content
```

**Safe DOM creation with Obsidian API:**
```typescript
// Use createEl, createDiv, createSpan
const container = contentEl.createDiv({ cls: 'my-container' });
const heading = container.createEl('h2', { text: 'Title' });
const button = container.createEl('button', {
    text: 'Click me',
    cls: 'my-button'
});

// For icons, use setIcon
import { setIcon } from 'obsidian';
setIcon(button, 'chevron-right');
```

### Event Registration

**Always use `registerDomEvent` for DOM events:**
```typescript
// ❌ NEVER - causes memory leaks on unload
element.addEventListener('click', handler);
document.addEventListener('keydown', handler);
window.addEventListener('resize', handler);

// ✅ ALWAYS - auto-cleanup on unload
this.registerDomEvent(element, 'click', handler);
this.registerDomEvent(document, 'keydown', handler);
this.registerDomEvent(window, 'resize', handler);

// ✅ For Obsidian workspace events
this.registerEvent(this.app.vault.on('modify', handler));
this.registerEvent(this.app.workspace.on('active-leaf-change', handler));
```

### File Operations

```typescript
// ❌ NEVER use vault.adapter directly (mobile incompatible)
await this.app.vault.adapter.read(path);
await this.app.vault.adapter.write(path, content);

// ✅ Use Vault API
await this.app.vault.read(file);
await this.app.vault.cachedRead(file);  // Faster, uses cache

// ✅ For modifying files, use Vault.process() (atomic, prevents conflicts)
await this.app.vault.process(file, (content) => {
    return content.replace('old', 'new');
});

// ✅ Use Editor API for active file (preserves cursor)
const editor = this.app.workspace.activeEditor?.editor;
if (editor) {
    editor.replaceRange('new text', from, to);
}
```

**Exception**: Hidden files (like `.nexus/`) aren't indexed by Obsidian, so `vault.adapter` is acceptable for those paths. Use `isHiddenPath()` helper.

### API Best Practices

| Task | Do This | Not This |
|------|---------|----------|
| HTTP requests | `requestUrl()` | `fetch()` |
| Path handling | `normalizePath(userPath)` | Direct string concat |
| OS detection | `Platform.isMobile`, `Platform.isDesktop` | User agent sniffing |
| File lookup | `vault.getFileByPath(path)` | Iterating vault.getFiles() |
| View access | `workspace.getActiveViewOfType(MarkdownView)` | `workspace.activeLeaf.view` |

### Commands

```typescript
this.addCommand({
    id: 'my-action',  // Don't duplicate plugin ID
    name: 'My action',  // Sentence case, no "command" word
    // NO default hotkey - users set their own
    checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
            if (!checking) {
                // Execute command
            }
            return true;
        }
        return false;
    }
});
```

### Mobile Compatibility

```typescript
import { Platform } from 'obsidian';

if (Platform.isMobile) {
    // Mobile-specific code
}

// ❌ These APIs are NOT available on mobile
import { fs, path, crypto } from 'node:*';  // Node.js modules
require('electron');  // Electron APIs

// ✅ Mobile alternatives
// Use SubtleCrypto instead of crypto
// Use navigator.clipboard instead of electron clipboard
// Set isDesktopOnly: true in manifest if Node.js required
```

### Accessibility Requirements

```typescript
// ✅ Interactive elements need aria-labels
const iconButton = container.createEl('button', { cls: 'icon-button' });
iconButton.setAttribute('aria-label', 'Open settings');
setIcon(iconButton, 'settings');

// ✅ Keyboard navigation (Tab, Enter, Space)
// ✅ Focus indicators with :focus-visible
// ✅ Touch targets minimum 44×44px on mobile
```

### Code Quality Rules

| Rule | Requirement |
|------|-------------|
| Type safety | No `as any` casts, use `instanceof` checks |
| Variables | Use `const`/`let`, never `var` |
| Console logging | No `console.log` in production, only `console.error` for actual errors |
| UI text | Sentence case everywhere |
| Cleanup | Remove all template/sample code before submission |

### Manifest Requirements

```json
{
    "id": "my-plugin-id",      // Lowercase, no "obsidian", doesn't end with "plugin"
    "name": "My Plugin Name",  // No "Obsidian" or "Plugin" suffix
    "version": "1.0.0",
    "minAppVersion": "1.0.0",
    "description": "Does something useful.",  // <250 chars, ends with punctuation
    "author": "Author Name",
    "isDesktopOnly": false     // true only if Node.js APIs required
}
```

### Performance Guidelines

```typescript
// ❌ Vault 'create' fires for ALL files on startup
this.registerEvent(this.app.vault.on('create', handler));

// ✅ Wait for layout ready
this.app.workspace.onLayoutReady(() => {
    this.registerEvent(this.app.vault.on('create', handler));
});

// OR check inside handler
onCreate(file: TFile) {
    if (!this.app.workspace.layoutReady) return;
    // Process event
}
```

### References

- [Official Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Obsidian API Types](https://github.com/obsidianmd/obsidian-api)
- [CSS Variables Reference](https://docs.obsidian.md/Reference/CSS+variables)
- [Sample Plugin Template](https://github.com/obsidianmd/obsidian-sample-plugin)

## Recent Milestones

### March 2026

**Mar 13**: Settings UI Redesign ✅ (PR #42)
- CSS spacing token system: 7 `--space-*` tokens (4px base), replacing ~15 hardcoded values
- New `SearchableCardManager` component: composition wrapper with search/filter + group headers
- All 4 card tabs migrated (Workspaces, Providers, Apps, Prompts) + GetStartedTab
- BreadcrumbNav: chevron icon separators, CSS specificity fix for Obsidian button defaults
- Card hover: `box-shadow` → `background-color` transition (theme-aware)
- Cross-platform: removed hardcoded button sizes fighting `clickable-icon`
- BackButton: `div` → `button` element (keyboard accessibility)
- `CardManagerConfig.onAdd`/`addButtonText` now optional
- WorkspacesTab decomposed: 1,611 → 855 lines + WorkspaceListRenderer + WorkspaceDetailRenderer
- 132 new tests across 6 files (SettingsRouter, SearchableCardManager, Card, CardManager, BackButton, WorkspacesTab)
- Plan: `docs/plans/settings-ui-redesign-plan.md`

**Mar 8**: SDK→HTTP Migration ✅ (commit 103a9e73)
- Removed provider SDKs (OpenAI, Anthropic, Google, Groq, Mistral) — direct HTTP via shared ProviderHttpClient
- Real-time streaming via Node.js https + `processNodeStream()` (replaces buffered requestUrl approach)
- New: `ProviderHttpClient.ts` (shared HTTP + streaming + HTTPS enforcement + retry), `BufferedSSEStreamProcessor.ts`
- Fixed: Google finish reason mapping, MALFORMED_FUNCTION_CALL error surfacing, OpenAI SSE multi-line parser, Anthropic stale betas field, Mistral param names, error body truncation (security)
- 796 tests (+34 new across ProviderHttpClient, BufferedSSEStreamProcessor, OpenAICodexAdapter, MessageManager)
- UI: ChatInput tri-state button, MessageManager interrupt-before-send

**Mar 8**: v5.1.0 Release ✅
- SDK→HTTP migration: Removed all LLM provider SDKs, direct HTTP via `ProviderHttpClient` + Obsidian `requestUrl`
- Real streaming on desktop (Node.js https), buffered fallback on mobile
- TaskManager DI wiring fixed (was never registered in runtime init path)
- Deleted unused agent factory system (`ServiceFactory.ts`, -409 lines)
- Self-documenting TaskManager tool schemas (result objects fully defined)
- Wired TaskService into MemoryManager for loadWorkspace task summaries

**Mar 8**: TaskManager Agent ✅ (PR #37)
- New agent: workspace-scoped project/task management with DAG dependencies
- Data model: Workspace → Project → Task, with `dependsOn[]` DAG edges + `parentTaskId` subtask tree
- 10 tools: createProject, listProjects, updateProject, archiveProject, createTask, listTasks, updateTask, moveTask, queryTasks, linkNote
- Services: TaskService (facade) + DAGService (pure computation: cycle detection, topological sort, next actions, blocked tasks)
- DB: 4 new tables (projects, tasks, task_dependencies, task_note_links), schema v8→v9, JSONL+SQLite hybrid
- Integration: auto-loads task summary via loadWorkspace, CacheableEntityType extended with 'project'/'task'
- 857 tests (236 new across 5 test files)
- Plan: `docs/plans/task-manager-agent-plan.md`, Architecture: `docs/architecture/task-manager-agent-architecture.md`

**Mar 4**: New Models + Bug Fixes ✅ (v4.4.5 → v4.4.6)
- Added Claude Sonnet 4.6, Gemini 3.1 Pro/Flash Lite, GPT-5.3 Chat/Codex; removed legacy Claude 4 Opus/Sonnet
- Fixed ConversationTitleModal focus trap: replaced fragile setTimeout/rAF hack, added focus restoration in onClose()
- Fixed default temperature not loading from user settings (hardcoded 0.5 → reads `defaultTemperature`)
- Fixed prompt selector using name instead of id as dropdown key (wouldn't persist selection)
- Fixed `syncWorkspacePrompt()` saving name instead of id

### February 2026

**Feb 28**: Dynamic Image Model Defaults ✅ (v4.4.4)
- Image generation defaults now resolve from user settings instead of hardcoded values
- Priority chain: explicit param > user settings > first available provider/model > fallback
- `generateImage`: new `resolveDefaults()`, `getAvailableProviderNames()`, dynamic schema/errors
- `executePrompts`/`promptParser`/`RequestExecutor`: removed hardcoded model lists and google-only restrictions
- `ImageGenerationService`: added `getInitializedProviders()`
- `executeTypes`: provider optional + accepts openrouter, model widened to string

**Feb 26**: Dynamic Image Model Loading ✅ (v4.4.3)
- Image model dropdowns now load dynamically from adapters (removed hardcoded `IMAGE_MODELS` in ChatSettingsRenderer)
- `generateImage` tool schema builds model enum at runtime from configured providers
- Added `getModelsForProvider()` and `getSupportedModelIds()` to `ImageGenerationService`
- Adding a new image model to an adapter now auto-populates UI and tool schema

**Feb 26**: New Image Models + FLUX Validation Fix ✅ (v4.4.2)
- Added `gemini-3.1-flash-image-preview` (Nano Banana 2): Google direct + OpenRouter, 512px-4K, 14 ref images, new aspect ratios (1:4, 4:1, 1:8, 8:1)
- Added `gpt-5-image` (OpenRouter only): GPT-5 with image generation, 400K context
- Fixed FLUX models (`flux-2-pro`, `flux-2-flex`) failing validation — missing from `supportedModels` and `ImageModel` union type

**Feb 23**: Workspace Settings Display Fix ✅ (v4.4.1)
- Root cause: `renderWorkspacesTab()` passed stale `prefetchedWorkspaces` (populated before SQLite ready) → WorkspacesTab skipped async load, showed JSONL fallback data only
- Fix: pass `prefetchedWorkspaces: null` → WorkspacesTab always shows loading skeleton → awaits both `workspaceService` + `hybridStorageAdapter` → queries SQLite with full data
- Also removed temporary `[DEBUG-WS]` console.error logs from 6 files: `SettingsView.ts`, `WorkspacesTab.ts`, `ServiceManager.ts`, `WorkspaceService.ts`, `BackgroundProcessor.ts`, `PluginLifecycleManager.ts`

**Feb 22**: Tool Call History Fix ✅ (v4.4.0)
- `MessageStreamHandler.ts` — post-loop safety net: forces `state=complete` + accumulated toolCalls onto in-memory message before second save runs; prevents stale `draft/null` from overwriting good data
- `ConversationService.ts` — try-catch around `JSON.parse(tc.function.arguments)` in `convertToLegacyConversation`; malformed JSON no longer crashes entire conversation load
- `MessageRepository.ts` — defensive try-catch in `rowToMessage()` for toolCallsJson/metadataJson/alternativesJson
- **Note for existing stale conversations**: Delete `.nexus/cache.db` to force JSONL rebuild; tool calls will reappear

**Feb 22**: TypeScript Build Fix ✅ (PR #31)
- `IPCTransportManager.ts` — changed socket param from `NodeJS.ReadWriteStream` to `net.Socket`; removed 4 redundant casts
- `npm run build` (tsc + esbuild) now passes clean

**Feb 22**: OpenAI CORS Bypass + Validation Fixes ✅ (PR #29)
- `nodeFetch.ts` — Node.js `https.request()` passed as custom `fetch` to OpenAI SDK; bypasses CORS on `/v1/responses`
- Fixed 3 stale validation probes: `gpt-5-nano` needs `max_completion_tokens`; `claude-3-5-haiku-latest` deprecated → `claude-haiku-4-5-20251001`
- 619 tests (adds 55 nodeFetch unit tests)

**Feb 22**: Provider OAuth Connect ✅ (PR #26 — v4.3.4)
- OpenAI Codex OAuth via ChatGPT: connect button, token refresh, model listing with `(ChatGPT)` suffix
- **Codex Responses API gotchas (CRITICAL)**:
  - No `previous_response_id` support — must use stateless full input array continuation
  - `delta` is plain string, not object — `typeof event.delta === 'string'` check required
  - CORS from `app://obsidian.md` — must use Node.js `require('https').request()` not `fetch()`
  - `for await` unreliable in Electron — use explicit `chunkQueue`/`chunkWaiter` event-listener queue
  - `instructions` field always required — cannot be conditional on conversationHistory
  - Model won't use tools without `tool_choice: "auto"` + explicit tool-use preamble in instructions
- 547 tests passing, all console.log removed, JSON.parse in try-catch, `expires_in` validated

**Feb 21**: IPC Transport Fix ✅ (v4.3.2 — cherry-pick from PR #24, DylanLacey)
- Fixed `handleSocketConnection` never wiring socket `close`/`end` to `transport.close()`
- Crashed connectors no longer permanently wedge `Protocol._transport`; reconnects cleanly
- FD leak on failed `connect()` also fixed (socket destroyed on rejection)
- PR #24 mux part still open — pending contributor fix for hardcoded socket path

**Feb 20**: New Model Definitions ✅ (PR #22 — v4.3.1)
- Added Claude Sonnet 4.6 (`claude-sonnet-4-6`): 200K ctx, 64K out, $3/$15/M + 1M beta variant
- Added Gemini 3.1 Pro Preview (`gemini-3.1-pro-preview`): 1M ctx, 65K out, $2/$12/M
- Updated: AnthropicModels.ts, GoogleModels.ts, OpenRouterModels.ts

**Feb 9**: Conversation Memory Search ✅ (PR #19 — merged)
- Semantic search across conversation turns and tool call traces via `searchMemory` tool
- Two modes: Discovery (workspace-scoped) and Scoped (session-filtered, N-turn window)
- QA pair model + ContentChunker (500-char/100-overlap) + sqlite-vec KNN + multi-signal reranking
- Real-time indexing via ConversationEmbeddingWatcher + background backfill
- Actionable error feedback, enhanced descriptions, optional workspaceId
- EmbeddingService refactored: facade pattern (1034→199 lines) + 3 domain services
- MemorySearchProcessor (824→553) and IndexingQueue (822→497) split into extracted modules
- 351 tests pass (205 new), all coverage thresholds met, 19 commits
- Plan: `docs/plans/conversation-memory-search-plan.md`
- Review: `docs/review/pr19-conversation-memory-search.md`

**Feb 5**: Startup Performance Fix ✅ (PR #15)
- Non-blocking startup ~200ms (75x improvement from ~15s)
- Root cause: deadlock between ChatView.onOpen() and onLayoutReady
- Solution: setTimeout(0) services, registerViewEarly(), non-blocking onOpen()

**Feb 5**: Chat Stop/Retry/Branch Bug Fixes ✅ (PR #16)
- 12 bugs fixed across stop, retry, and branch navigation
- Key patterns: clear-and-restream, incremental reconciliation, dual abort controllers
- 142 unit tests across 7 new test files

**Feb 5**: Inline AI Editing Feature ✅ (PR #14)
- Right-click or hotkey to edit selected text via LLM
- State machine pattern, streaming preview, Jest test infrastructure (41 tests)

### January 2026

**Jan 24**: ExecutePrompts improvements (optional provider/model, reference images, CommandManager cleanup)
**Jan 12**: MCP integration settings fix (invalid config handling)
**Jan 4**: CanvasManager agent (4 tools), SQLite transaction fix, memory leak fixes (7), embeddings toggle

### December 2025

**Dec 22**: Subagent UI + architecture
**Dec 20**: Auto-compaction + dual models + WebLLM
**Dec 17**: Two-Tool Architecture (95% token reduction)
**Dec 16**: Local embeddings + dead code cleanup (~4,000 lines removed)
**Dec 9**: Mobile + branching persistence
**Dec 3**: SQLite + JSONL hybrid storage

## Quick Navigation

### Core Directories
- `/src/agents/` - Agent implementations (PromptManager, ContentManager, etc.)
- `/src/services/` - Shared services (LLM providers, memory, conversations)
- `/src/components/` - UI components (chat view, settings, modals)
- `/src/types/` - TypeScript type definitions
- `/src/utils/` - Utility functions and helpers

### Key Files
- `main.ts` - Plugin entry point and lifecycle management
- `connector.ts` - MCP server connector for Claude Desktop
- `src/agents/index.ts` - Agent registry and initialization
- `src/services/conversationService.ts` - Chat conversation management
- `src/services/llmService.ts` - LLM provider abstraction layer

## Agent Architecture

### Available Agents

**ToolManager** (`src/agents/toolManager/`) - **MCP Entry Point** (Two-Tool Architecture)
   - `getTools`: Discovery - returns tool schemas for requested agents/tools
   - `useTools`: Execution - unified context-first tool execution
   - *Only these 2 tools are exposed to Claude Desktop. All other agents work internally.*

1. **PromptManager** (`src/agents/promptManager/`) - Custom prompts and LLM integration
   - Tools: listModels, executePrompts, createPrompt, updatePrompt, deletePrompt, listPrompts, getPrompt, generateImage

2. **ContentManager** (`src/agents/contentManager/`) - Note reading/editing operations
   - Tools: read, write, update, setProperty

3. **StorageManager** (`src/agents/storageManager/`) - File/folder management
   - Tools: list, createFolder, move, copy, archive, open

4. **SearchManager** (`src/agents/searchManager/`) - Advanced search operations
   - Tools: searchContent, searchDirectory, searchMemory

5. **MemoryManager** (`src/agents/memoryManager/`) - Session/workspace/state management
   - Tools: createSession, loadSession, createWorkspace, createState, etc.

6. **CanvasManager** (`src/agents/canvasManager/`) - Obsidian canvas operations
   - Tools: read, write, update, list

7. **TaskManager** (`src/agents/taskManager/`) - Workspace-scoped project/task management with DAG dependencies
   - Tools: createProject, listProjects, updateProject, archiveProject, createTask, listTasks, updateTask, moveTask, queryTasks, linkNote
   - Services: TaskService (business facade), DAGService (pure computation)
   - Auto-loads task summary when workspace loads

### Agent Structure Pattern
```
agents/
  [agentName]/
    [agentName].ts          # Main agent class extending BaseAgent
    tools/                   # Operation tools
      [toolName].ts         # File: read.ts, Class: ReadTool
      services/             # Tool-specific services
    services/               # Agent-level shared services
    types.ts                # Agent-specific types
    utils/                  # Agent-specific utilities
```

### Base Classes
- **BaseAgent** (`src/agents/baseAgent.ts`) - Common agent functionality
- **BaseTool** (`src/agents/baseTool.ts`) - Common tool functionality with generic types
- **IAgent** (`src/agents/interfaces/IAgent.ts`) - Agent interface contract
- **ITool** (`src/agents/interfaces/ITool.ts`) - Tool interface contract

## Current Context

### Active Branch
`main` (current) — active worktrees:
- `.worktrees/feat/elevenlabs-dynamic-models` (branch: `feat/elevenlabs-dynamic-models`)
- `.worktrees/feat/large-file-refactoring` (branch: `feat/large-file-refactoring`)

### Open PRs
| # | Title | Status |
|---|-------|--------|
| **#43** | Plugin store compliance fixes | **Merged** ✅ |
| **#24** | Socket lifecycle fix (DylanLacey) | Transport fix in main (v4.3.2); mux awaiting contributor socket path fix |

### Current Work
**Large File Refactoring + DRY Consolidation** — Branch `feat/large-file-refactoring`, PR pending. Plan: `docs/plans/large-file-refactoring-plan.md`. Waves 0-3 complete:
- DualBackendExecutor helper (eliminates dual-backend if/else across 3 services)
- ModelDropdownRenderer shared component (ChatSettingsRenderer 798→552 lines)
- OAuthBannerComponent + OAuthFlowManager (GenericProviderModal 650→466 lines)
- ProjectsManagerView extraction (WorkspacesTab 855→589 lines)
- Service decomposition: type converters + normalizers extracted (WorkspaceService 1206→965, ConversationService 1108→813)
- 30 characterization tests + 980/1016 passing

**File Picker Bug** — `FilePickerRenderer.getRootFolder()` fails when workspace rootFolder has leading `/` (e.g., `/blog-test` → Obsidian expects `blog-test`). Separate fix needed.

### Branch Architecture

A branch IS a conversation with parent metadata:
- `metadata.parentConversationId`: parent conversation
- `metadata.parentMessageId`: message the branch is attached to
- `metadata.branchType`: 'alternative' | 'subagent'

**Key Files**:
- `src/services/chat/BranchService.ts` - Facade over ConversationService
- `src/ui/chat/controllers/SubagentController.ts` - Subagent infrastructure
- `src/ui/chat/controllers/NexusLoadingController.ts` - Loading overlays
- `src/ui/chat/services/ContextTracker.ts` - Token/cost tracking

### Known Issues

**File Picker rootFolder Leading Slash** (Mar 13):
- `FilePickerRenderer.getRootFolder()` passes workspace rootFolder (e.g., `/blog-test`) directly to `getAbstractFileByPath()`, which expects no leading slash (`blog-test`)
- Shows "Folder not found" for valid folders. Also "Destination file already exists" error when adding context files.
- Fix: `normalizePath(this.rootPath)` or strip leading slash before lookup

**Workspace Delete Persistence** (Feb 2):
- Deleted workspaces may reappear on page reload
- Backend delete logic looks correct, may be UI cache issue

**Subagent Flow** (Dec 22, fixed Feb 20 in `fix/subagent-bugs` — awaiting manual test):
- 29 bugs fixed: icon race, retry-stuck, abort race, O(N) scan, Continue feature, EventBus instance-scoping, maxIterations enforcement, and more
- Full fix list: `docs/review/pr23-subagent-functionality-review.md`

**WebLLM/Nexus** (Dec 20):
- Multi-turn tool continuations may crash on Apple Silicon (WebGPU issue)
- If startup hangs on "loading cache", clear site data

### Backlog
1. **Obsidian Secrets API Adoption** (target: March 2026): Migrate API key storage to `SecretStorage` API (v1.11.4+). Research: `docs/preparation/obsidian-secrets-api-research.md`
2. **Port 3000 conflict**: ~~Fixed~~ OpenRouter OAuth port changed to 3456 (commit 15576fb2). MCPServer.ts HttpTransportManager still on 3000; long-term: make configurable.
3. **SOLID Audit**: `SystemPromptBuilder.ts` and `ModelAgentManager.ts` are large files
4. **SQLiteCacheManager.ts** (849 lines): Above 600-line threshold
5. **v5.0.0 Deprecation Cleanup**: Remove backward compatibility for old dedicated agent structures (TODO(v5.0.0) in WorkspacePromptResolver)
6. **Obsidian CLI Integration** (blocked: Catalyst-only): Research: `docs/preparation/obsidian-cli-research.md`
7. **Missing `version-bump.mjs`**: `package.json` `version` lifecycle script references `node version-bump.mjs` but file doesn't exist — `npm version` will error. Either create it or remove the script reference.

## Obsidian Plugin Guidelines Compliance

**Status**: Audit 2026-03-13 found regressions. `isDesktopOnly: false` is correct (chat works on mobile, MCP requires desktop).
**Full audit report**: `docs/review/plugin-store-audit-2026-03-13.md`

| Issue | Status | Count |
|-------|--------|-------|
| innerHTML security | 1 unsafe (MessageEditController restore); 6 safe patterns | 1 to fix |
| registerDomEvent | ~27 raw addEventListener (modals + view components) | ~27 to fix |
| console.log cleanup | 398 → 37 (WebLLM: 25, others: 12) | 37 to fix |
| Inline styles | 85 → 10 (all dynamic/justified — progress bars, positioning) | 0 blocking |
| Type safety (`as any`) | Regressed from 0 → 16 | 16 to fix |
| `@ts-ignore` | Regressed from 1 → 5 | 5 to fix |
| SQL injection | sortBy column interpolation in 2 repositories | 2 to fix |
| Timer leak | ContentCache.ts unmanaged setInterval | 1 to fix |
| Node.js imports | 4 ungated imports (path, fs, child_process) — mobile crash risk | 4 to fix |
| Accessibility | ~5 icon buttons missing aria-label | ~5 to fix |

## Development Notes

### Build Commands
- `npm run dev` - Development build with watch mode
- `npm run build` - Production build (TypeScript + esbuild)
- `npm run test` - Run Jest test suite
- `npm run lint` - Run ESLint
- `npm run deploy` - Build and deploy via PowerShell script
- **Release**: Use `/nexus-release` skill for version bumping and GitHub release creation

### Testing Approach
- **Unit Tests**: Jest for core logic and services (980 tests — 796 baseline + 132 settings UI + 4 WorkspacesTab + 30 characterization + 18 refactoring)
- **Integration Tests**: Manual testing in Obsidian environment
- **MCP Testing**: Via Claude Desktop connection

### Code Patterns

- **Agents**: Extend `BaseAgent`, register tools in constructor
- **Tools**: Extend `BaseTool<Params, Result>`, implement `execute()`, `getParameterSchema()`, `getResultSchema()`
- **Results**: Return `{ success: boolean, ...data }` or `{ success: false, error: string }`
- **Services**: Singletons with dependency injection via constructor
- **Adding a new agent**: (1) Add `initializeYourAgent()` to `AgentInitializationService.ts`, (2) Add `safeInitialize('yourAgent', ...)` to a phase in `AgentRegistrationService.doInitializeAllAgents()`. That's it — no factory classes, no ServiceDefinitions entry.

### Dependencies
See `package.json`. Key: MCP SDK, express, winston, uuid. LLM provider SDKs removed — direct HTTP via ProviderHttpClient.

## Code Quality

### SOLID Refactoring Progress (17/22 large files completed or assessed)
Key reductions: HybridStorageAdapter (-72%), LLMService (-75%), ChatService (-60%), LLMProviderModal (-82%), MessageBubble (-45%), EmbeddingService (-81% facade), MemorySearchProcessor (-33%), IndexingQueue (-40%), ChatSettingsRenderer (-31%), GenericProviderModal (-28%), WorkspacesTab (-31%), WorkspaceService (-20%), ConversationService (-27%)

### Remaining Large Files (600+ lines)
WorkspaceService (965), ConversationService (813), connector (731), ModelAgentManager (895), SQLiteCacheManager (856), ChatSettingsModal (702), ChatView (659, well-decomposed), OpenRouterAdapter (640), ValidationService (625), BatchExecutePromptTool (618), GoogleAdapter (612)

### New Shared Modules (from DRY refactoring)
- `src/services/helpers/DualBackendExecutor.ts` — shared dual-backend routing for 3 services
- `src/services/helpers/findByNameOrId.ts` — generic ID/name lookup
- `src/services/helpers/WorkspaceTypeConverters.ts` — workspace type conversion
- `src/services/helpers/WorkspaceNormalizer.ts` — workspace normalization + search indexing
- `src/services/helpers/ConversationTypeConverters.ts` — conversation type conversion
- `src/components/shared/ModelDropdownRenderer.ts` — shared provider+model dropdown
- `src/components/shared/OAuthBannerComponent.ts` — shared OAuth banner rendering
- `src/services/oauth/OAuthFlowManager.ts` — shared OAuth connect/disconnect flow
- `src/components/workspace/ProjectsManagerView.ts` — projects CRUD extracted from WorkspacesTab

## MCP Integration

### Server Configuration
- Server runs locally via `connector.js`
- Configured in Claude Desktop's `claude_desktop_config.json`
- Server identifier: `claudesidian-mcp-[vault-name]`
- Supports multiple vault instances simultaneously

### Two-Tool Architecture

Instead of 50+ tools, MCP exposes just 2: `getTools` (discovery) and `useTools` (execution).

**Context Schema**: `{ workspaceId, sessionId, memory, goal, constraints? }` - all required except constraints.

**Flow**: `getTools` → get schemas → `useTools` with context + calls array

**Benefits**: 95% token reduction (~15,000 → ~500), works with small context models.

**Key Files**: `src/agents/toolManager/` (agent + tools), `src/services/trace/ToolCallTraceService.ts`

**Tool Count**: 54 tools across 8 agents (not counting ToolManager meta-tools)

## Memory & Workspace System

### Storage Location
`.nexus/` - All storage in single hidden folder:
- `conversations/*.jsonl` - OpenAI fine-tuning format (syncs across devices)
- `workspaces/*.jsonl` - Event-sourced workspace data
- `tasks/tasks_[workspaceId].jsonl` - Task/project events per workspace
- `cache.db` - SQLite local cache (auto-rebuilt, not synced)

### Architecture
- Hybrid JSONL + SQLite: JSONL = source of truth, SQLite = fast queries
- True database pagination with OFFSET/LIMIT
- Workspace-scoped sessions and traces
- Searchable via MemoryManager and SearchManager agents

## UI Components

- **Chat View**: `src/components/ChatView.ts` - conversations, branching, streaming, tool accordion
- **Settings**: `src/components/ConfigModal.ts` - tabbed LLM/agent configuration

### Chat Suggesters
| Trigger | Purpose |
|---------|---------|
| `/` | Tool hints |
| `@` | Custom agents |
| `[[` | Note links |
| `#` | Workspace data |

Key files: `src/ui/chat/components/suggesters/`, `MessageEnhancer.ts`, `SystemPromptBuilder.ts`

## Architectural Notes

- **Subagents**: Branch → stream via LLMService → save result. `chunk.toolCalls` are display-only.
- **WebLLM/Nexus**: Nexus Quark (4B, 4K context), `<tool_call>` format. May crash on Apple Silicon.
- **Storage**: Branches as JSONL events, SQLite v9 schema (4 task tables added in v9), tool names use `agent_tool` format.
- **Apps & Vault Access**: App agents that produce files (binary or text) must have vault access wired through `BaseAppAgent`. Use `vault.createBinary()` for binary outputs (audio, images) and `vault.create()` for text files. Always ensure parent directories exist before writing. Follow the pattern established by ElevenLabs audio tools and `ImageFileManager`. Future apps will likely need the same vault integration for saving their outputs.

## Working Memory
<!-- Auto-managed by pact-memory skill. Last 5 memories shown. Full history searchable via pact-memory skill. -->

<!-- SESSION_START -->
## Current Session
<!-- Auto-managed by session_init hook. Overwritten each session. -->
- Resume: `claude --resume 0cd83a1b-6a4c-48db-a427-f78adf03ca45`
- Team: `pact-0cd83a1b`
- Started: 2026-03-14 13:31:34 UTC
<!-- SESSION_END -->
