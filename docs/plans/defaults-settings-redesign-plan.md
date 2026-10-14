# Implementation Plan: Defaults, Chat Settings and Get Started Redesign

> Analysis date: 2026-10-14
> Source baseline: `daa9abd5` (Nexus 5.20.4)
> Status: proposed. Nothing under `src/`, `styles.css` or `tests/` has changed. Only this document was written.
> Visual contract: `docs/mockups/defaults-settings-essentials.html` and its same-stem CSS/JS, accepted by the owner on 2026-10-14 against plugin version 5.20.4 ("Essentials + folds", option 2, round 3). `docs/mockups/defaults-settings-options.html` (+ CSS/JS) is the 10-option exploration and is reference only.

Cite the mockup by file, never by line number. Copy strings that matter are lifted into the [copy appendix](#appendix-a--copy-lifted-from-the-mockup) so tests can hold them as constants without pointing at the mockup.

## Outcome

Three surfaces change: the Settings → Nexus → **Defaults** tab, the in-chat **Chat settings** modal and the **Get started** entry above the tab strip. Semantic search gets real settings behaviour as well. The other settings tabs keep their current behaviour.

- **Defaults and Chat settings** keep their shared renderer and show the "Essentials + folds" layout. There is no intro line and no heading above the top block. The top block is always open and holds Provider, Model and Thinking. Below it are icon folds, collapsed by default, each showing a one-line summary: Chat options, Context, Subagents, Images, Video, Voice, File conversion and Semantic search. The selected model's capabilities decide which controls appear and whether they are enabled.
- **Get started** becomes one navigable row above the tab strip. It opens in-tab pages (Get started → Chat inside Obsidian / Connect an external agent) that use the existing `BackButton` and `SettingsRouter`. The external-agent page checks for Node.js first, adds Antigravity next to Claude Desktop and Codex, and replaces the "Other agents" manual flow with four numbered steps.
- **Semantic search** stays on by default. It shows its index status. Turning it off asks for confirmation and takes effect immediately, with no restart. The index is kept, and a separate **Delete index** button appears only while search is off. Stale vectors are pruned. When search is off, agents are not offered semantic search.
- Bug fixes, the high-priority one first: five call sites ask the service registry for an `embeddingService` that nothing registers.

## What the code actually does

Line numbers are from the baseline above and come from reading the code for this plan.

**Rendering**

- `ChatSettingsRenderer.render()` empties its container (`src/components/shared/ChatSettingsRenderer.ts:210`) and rebuilds the whole form whenever any of these changes:
  - LLM settings (`:194`)
  - chat or subagent provider/model (`ModelDropdownRenderer.ts:188`, `:287` via `reRender`)
  - image provider (`:682`)
  - workspace when workflows are shown (`:1270`)
  - prompt sync (`:1327`)

  Fold state and scroll position are lost on every redraw.
- The section order today is chat model (with Reasoning, Effort, Context window, Web search), Subagent model, Image model, the Defaults-only `renderAfterImageSection` hook (Video, Voice), Voice/Transcription, Temperature, Context (`:206-219`). Thinking is a Reasoning toggle plus an Effort slider (`:344-418`). Both readouts are hand-made spans (`csr-effort-value`, `csr-context-window-value`). The second span has **no CSS rule** (`styles.css` only defines `.csr-effort-value` at 4473 and `.csr-temp-value` at 4482).
- Context window is a 1-token-step slider from 1,024 to the model maximum (`:452-479`). Keys are `getContextWindowOverrideKey(provider, model)` and values are clamped by `resolveContextWindowLimit` (`src/ui/chat/utils/ContextWindowSettings.ts`).
- Creativity is always shown, range 0–1 (`:600-623`). `StaticModelsService.ModelWithProvider.capabilities` does not carry `supportsSamplingParams` (`src/services/StaticModelsService.ts:23-40`, `:210-222`), so the renderer cannot know that Claude Opus/Sonnet/Haiku 5.5, Fable 5/5.1 and others reject temperature (`AnthropicModels.ts`, 10 `supportsSamplingParams: false` entries). The adapters already drop the parameter (`adapters/shared/SamplingParams.ts`).
- Voice is implemented twice:
  - `DefaultsTab.renderVoiceSection` / `renderSpeechSettings` / `renderRealtimeVoiceSettings` (`src/settings/tabs/DefaultsTab.ts:473-982`) writes straight to `llmProviderSettings` and calls `saveSettings()` outside the tab's save queue.
  - `ChatSettingsRenderer.renderVoiceSection` (`:777-1240`) writes to the pending settings object.

  The labels differ ("Voice input" vs "Transcription", "Speech provider", "Live voice provider").
- Context notes use raw `onclick` assignments (`:1310`, `:1346`), which breaks the `registerDomEvent` rule.
- `Accordion` (`src/components/Accordion.ts`) is used only by `SettingsView` for Get started. `getContentEl()` creates a **new** child div every time it is called (`:91-94`).

**Subagent settings mostly have no effect**

- `LLMService.getAgentModel()` returns the chat default model unless that model is local (`src/services/llm/core/LLMService.ts:126-151`). The saved subagent model therefore only matters for `executePrompt` when the chat model is WebLLM, Ollama or LM Studio.
- The `subagent` tool inherits the parent chat's provider, model and thinking (`src/agents/promptManager/tools/subagent.ts:232-243`, built by `SubagentController.buildSubagentContext` at `src/ui/chat/controllers/SubagentController.ts:455-483`). It never reads `agentModel` or `agentThinking`.
- `SubagentExecutor` receives `thinkingEnabled`/`thinkingEffort` but does not forward them to its streaming generator (`src/services/chat/SubagentExecutor.ts:367-375`). The generator's options type has no thinking or temperature fields (`SubagentController.ts:315-358`).
- `PromptExecutor` sends no temperature and no thinking (`src/agents/promptManager/tools/executePrompts/services/PromptExecutor.ts:89-97`).
- `agentThinking` is saved and restored (`ModelAgentDefaultsResolver.ts:89-92`, `ModelAgentManager.ts:309-313`) but no execution path reads it.

**Thinking state**

`renderReasoningControls` returns early for models without `supportsThinking` (`CSR:352`). `thinking.enabled` stays `true` but hidden, and `ModelAgentPromptContextAssembler.buildMessageOptions` still sends `enableThinking: true` (`:120`, `:126`). Some adapters gate on capability (e.g. `AnthropicAdapter.ts:185`, `:428`). Not every adapter was checked.

**Context window ownership**

- Each conversation already has its own budget: `committedContextWindow`, `getEffectiveContextWindow()` and `effectiveContextWindow` in the conversation metadata (`ModelAgentManager.ts:687-698`, `:1234`).
- The Chat settings modal *additionally* merges the edited value into the global `contextWindowOverrides` and saves it (`src/ui/chat/components/ChatSettingsModal.ts:234-258`). PR #410 did this on purpose, and `tests/unit/ChatSettingsModalContextHandoff.test.ts` locks it in.
- In the other direction, a Defaults edit is pushed to the active chat when its model matches (`DefaultsTab.ts:154-161` → `ChatView.applyContextWindowDefault`, `src/ui/chat/ChatView.ts:1145-1155`). This is also deliberate and tested (`tests/unit/DefaultsTabContextHandoff.test.ts`).

**Embeddings**

- `enableEmbeddings` is read once, after storage is ready (`src/core/PluginLifecycleManager.ts:362-371`). `EmbeddingManager.initialize()` returns early when disabled (`src/services/embeddings/EmbeddingManager.ts:91`). Nothing listens for later changes.
- The dream cycle uses `registerInterval` plus `addCommand` (`:301-336`). Neither can be undone today.
- `getStats()` (`:265-294`) and the `IndexingQueue` `progress` events (`IndexingQueue.ts:39-46`, `:587`, with pause/resume at `:288-325`) exist, but only the status bar reads them.
- Re-enabling is incremental. `filterUnindexedNotes` compares `contentHash` (`IndexingQueue.ts:392-414`).
- Stale vectors are never pruned. That pass walks only existing files, and `NoteEmbeddingService.embedNote` removes a vector only when it is asked to embed a path that has gone (`NoteEmbeddingService.ts:127-133`).
- **"Rebuild cache" does not delete note or trace vectors.** `SQLiteMaintenanceService.clearAllData()` drops and recreates only `conversation_embeddings` and clears `conversation_embedding_metadata` and `embedding_backfill_state` (`src/database/storage/SQLiteMaintenanceService.ts:93-118`). `note_embeddings`, `embedding_metadata`, `trace_embeddings` and `trace_embedding_metadata` survive. Nothing deletes them.

**Settings sync**

`Settings.reconcileExternalSettings` treats a synced change to any non-`llmProviders` key as "needs reload" (`src/settings.ts:182-201`). Two consequences:
- `enableEmbeddings` is synced, and a change made on another device currently forces a reload.
- Any UI state stored in `data.json`, for example the old `getStartedOpen`, has the same effect.

**Ingestion**

`enableIngestion` gates audio conversion as well as PDF (`src/core/ingest/VaultIngestionManager.ts:189-195`, `:261`) and decides whether ingestion models are listed (`GenericProviderModal.ts:445-446`).

## Bug verification

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Nothing registers `'embeddingService'`, so `getServiceIfReady('embeddingService')` always returns null | **CONFIRMED** | Five callers: `src/agents/searchManager/services/ServiceAccessors.ts:77`, `src/agents/searchManager/searchManager.ts:114` (the result is cached and passed to the tool at `:140-141`), `src/ui/chat/components/suggesters/initializeSuggesters.ts:47`, `src/ui/tasks/TaskBoardView.ts:61`, `src/components/workspace/ProjectsManagerView.ts:146`. The registry is `CORE_SERVICE_DEFINITIONS` (no entry with that name; `grep "name: '"` over `src/core/services/ServiceDefinitions.ts`) plus `ADDITIONAL_SERVICE_FACTORIES`, which is empty (`:730-733`). `ServiceContainer.getIfReady` reads only already-created instances (`src/core/ServiceContainer.ts:298-300`). There are no string aliases, and the only other `register` calls are logger/pathManager/dataManager/vaultOperations in `src/core/index.ts:111-114`. `EmbeddingManager` is never in the container; it is attached as `plugin.embeddingManager` (`PluginLifecycleManager.ts:371`). Only `SearchContentTool` reads it there (`searchContent.ts:257-279`). The registration was dropped in commit `e1eada3a` ("removing embeddings"). Effects: `ConversationSearchStrategy.search` returns `[]` (`ConversationSearchStrategy.ts:69-71`), so **semantic search of past chats never runs**; `[[` note suggestions are always fuzzy (`noteSearch.ts:24`); task and project note linking never uses embeddings. `ChatTraceService` gets its service by direct injection (`PluginLifecycleManager.ts:390-397`) and works. Every existing test mocks around the gap (`tests/unit/SearchManagerAgent.test.ts:19-21` answers only `hybridStorageAdapter`). |
| 2 | Ingestion and Embeddings vanish after a redraw on the Defaults tab | **CONFIRMED** | They are appended to `rendererContainer` after `renderer.render()` (`DefaultsTab.ts:259`, `:281`). `render()` empties that container (`CSR:210`) on every redraw trigger listed above. Video and Voice survive only because they run inside `renderAfterImageSection`. |
| 3 | Ingestion rows sit above their toggle; Auto-convert is visible while off; the copy says "the defaults below" | **CONFIRMED** | `ingestionSettingsContainer = content.createDiv()` is created at `DefaultsTab.ts:1075`, before the "Enable ingestion" `Setting` at `:1078-1079`, so the PDF mode and OCR rows render first. "Auto-convert new files" is added to `content`, not the hidden container (`:1095-1106`). The copy at `:1097` says "using the defaults below". |
| 4 | Chat welcome "Open settings" opens Chat settings even with no provider | **CONFIRMED** | The button appears only in the "no providers" branch (`src/ui/chat/controllers/UIStateController.ts:93-114`). Its callback calls `openChatSettingsModal()` (`ChatView.ts:647-649`). |
| 5 | The header has a stray `;` and no title; `StatusBadge.ts` is unused | **CONFIRMED** | `SettingsView.ts:251-252` (comment "Title and description" followed by a bare `;`). `StatusBadge` has no importer in `src/` or `tests/`; its CSS is at `styles.css:4736-4754`. |
| 6 | `WorkspaceFormRenderer` saves top-level `dedicatedAgentId` while `syncWorkspacePrompt` reads `context.dedicatedAgent.agentId` | **CONFIRMED** | Writer: `src/components/workspace/WorkspaceFormRenderer.ts:165-175`. Reader: `CSR:1316-1330`. The canonical resolver prefers the top-level field and treats `context.dedicatedAgent` as deprecated (`src/agents/memoryManager/services/WorkspacePromptResolver.ts:83-97`). It is worse on Defaults: `DefaultsTab.loadWorkspaces` passes only `{id, name}` (`:91-99`), so the sync never fires there. |
| 7 | The modal does not persist without an open conversation; web search cannot be a default | **CONFIRMED (note only)** | `ChatSettingsModal.ts:326-328` saves only when `conversationId` is set. The values stay in `ModelAgentManager` memory. `initializeDefaults` resets `webSearch = false` (`ModelAgentManager.ts:394`), and it is restored per conversation (`:351`). |
| 8 | Temperature range is 0–1 | **CONFIRMED (note only)** | `CSR:613` `setLimits(0, 1, 0.1)`, clamped at `ModelAgentManager.ts:355`, `:993`. |
| — | "High 2" and "1,000,000 tokens 1000000" duplicate readouts | **NOT CONFIRMED (cause)** | The renderer adds its own value span next to each slider (`CSR:400`, `:462`). The second number is most likely a value label Obsidian 1.13 draws itself; the mockup header says its slider markup was "captured from the running app" with a `.slider-value`. I could not confirm this from `obsidian.d.ts` 1.12.3, which has no value-label API. Phase 1 starts by checking it in the app. |
| — | The CLI copy claims a Ctrl/Cmd+Shift+C hotkey | **CONFIRMED** | `GetStartedTab.ts:233`. The `open-chat` command has no `hotkeys` (`src/core/ui/ChatUIManager.ts:106-112`). |
| — | Bare `'node'` fallback in the copyable config | **CONFIRMED** | `GetStartedTab.ts:979`, `:992`. |
| — | "MCP setup guide" link uses `href: '#'` | **CONFIRMED** | `GetStartedTab.ts:518`. It opens the guide only when a `component` is supplied. The target `guide/mcp-setup.md` exists. |
| — | "Gemini CLI" in user-facing copy | **CONFIRMED** | `GetStartedTab.ts:500` (Other agents heading), `BuiltinProviderDrivers.ts:278` (`displayName`), `src/utils/platform.ts:159` (mobile-unavailable list), `GoogleGeminiCliAdapter.ts:244` (error text), `README.md:16`. Elsewhere the UI already says "Antigravity CLI" (`ProvidersTab.ts:115`, `ModelDropdownRenderer.ts:24`). |

## Decisions

| Topic | Decision | Why |
|---|---|---|
| `SettingGroup` (API 1.11) vs `minAppVersion` 1.10.0 | **Raise `minAppVersion` to `1.11.0`** in `manifest.json` and add the `versions.json` entry through the `nexus-release` machinery. No fallback shim. | `SettingGroup`, `Setting.addComponent` and the core `.setting-group .setting-items` CSS that the accordion content reuses all arrived in 1.11. A shim would need a second, unstyled code path that nobody tests. The owner's machines run 1.12.7–1.14.4. Users on 1.10 remain on 5.20.x. |
| Fold open/closed memory | **Device-local**: `app.saveLocalStorage('nexus-settings-folds', { v: 1, defaults: string[], chat: string[] })`, kept separately for each surface. | A synced `data.json` key would mark every other device "needs reload" (`settings.ts:182-201`) whenever a fold is toggled. `loadLocalStorage` is already scoped to the vault and is used for device IDs (`JSONLWriter.ts:174-180`). |
| Chat modal context window | **Applies to this conversation only.** Remove the global merge-and-save (`ChatSettingsModal.ts:234-258`). | This reverses part of PR #410 (see open question 2). Defaults stay the source for *new* chats. The modal already commits through `requestContextChange`. |
| Defaults → active chat context push | **Keep** (`applyContextWindowDefault`). | It is deliberate and tested. Changing it is out of scope (open question 3). |
| Web search default | **Stays per chat.** It is shown only in the Chat settings modal, as in the mockup. | Matches the mockup. A default is a new feature. |
| No conversation open | **Keep the in-memory behaviour.** The values carry into the next chat. Phase 0 adds a test proving that the first conversation created afterwards persists them. | No copy for this case exists in the mockup. |
| Thinking on non-reasoning models | **Keep the stored preference and gate it at the request boundary.** A new `resolveThinkingForModel(provider, model, thinking)` returns `{enabled: false}` when the model lacks `supportsThinking`. It is used by `ModelAgentPromptContextAssembler`, the subagent path and the prompt-execution path. | Switching to a non-reasoning model and back keeps the user's level. The hidden value can no longer be sent. |
| Thinking control | One `DropdownComponent`: Off, Low, Medium, High, Extra high, Max. Off is `{enabled:false, effort: <unchanged>}`; any other value is `{enabled:true, effort}`. | Uses the existing `DefaultThinkingSettings` storage, so nothing needs migrating. |
| Context window control | `SliderComponent` over indices `0..n-1` of `contextWindowStops(max)` = presets 32K, 64K, 128K, 200K, 350K, 750K, 1M that are **strictly below** `max`, followed by `max` itself. A single stop disables the slider. The readout shows `formatContextWindow` ("200K", "1M"). Changing provider or model clears the pending override for the newly selected key, so the readout shows that model's maximum. | Matches the mockup's `ctxChoices`. Storage stays `contextWindowOverrides[provider::model]`, and the maximum is still stored as "no override". A legacy value that is not a preset (e.g. 150,000) is shown as-is in the readout, with the thumb at the nearest lower stop, until the user moves it. No migration. |
| Creativity | Shown when `supportsSamplingParams !== false`. Otherwise the row is disabled with the readout "—" and the description `<Model display name> sets its own temperature.`. | Matches the mockup. It reads the registry flag through `StaticModelsService`. |
| Subagent settings take effect | Precedence for subagents and `executePrompt`: an explicit tool parameter, then the conversation's `agentProvider`/`agentModel`, then the default `agentModel`, then the chat model if it is a cloud model (today's behaviour), then the first cloud provider (today's local fallback). The new subagent Creativity and Context window settings travel with the agent model. | The mockup says "Used for: Subagents, saved prompts and automations". Today almost none of it applies (see findings). Users who never set a subagent model see no change. |
| Get started auto-open | Replace `getStartedOpen` and `shouldOpenGetStarted` with this rule: on the **first** `display()` in a plugin session, if `!hasConfiguredProviders && !hasExternalAgentSetup`, open the Get started page instead of the tab list. Back goes to Settings. Nothing is persisted. | First-run users still land on guidance. Saving a preference would cause the sync-reload problem. The old key is left inert in `data.json` and is no longer read. Deleting it would itself create a synced change. |
| Get started on mobile | Show the row and the "Chat inside Obsidian" path on every platform. Hide "Connect an external agent" (desktop only). | Today mobile has no Get started at all (`SettingsView.ts:535`). The chat path does not depend on Node. |
| `embeddingService` fix | Add one accessor, `resolveEmbeddingService(plugin)`, that reads `plugin.embeddingManager` and returns its service only while the manager is enabled and initialized. Replace all five string lookups with it. Callers resolve it on every use and never cache it. | Registering a container entry would need a factory for an optional, late, toggleable service. Hot-apply also means the instance changes during a session, so caching it (`searchManager.ts:113`, `searchContent.ts:269`, `initializeSuggesters.ts:47`) becomes a bug of its own. |
| Semantic toggle when off | `searchContent` keeps the `semantic` property, with a description saying it is unavailable, and drops the semantic pitch from the tool description. `semantic=true` falls back to keyword search and the result carries a `note` saying semantic search is turned off in Nexus settings. | The mockup copy says "agents stop being offered semantic search". The property stays because CLI flag parsing is driven by the schema (check this in the nexus-agents verify step). Removing `--semantic` could turn a harmless request into a parse error. |
| Delete index | Shown only while search is off. It runs right away (mod-warning), with no second confirmation, exactly as in the mockup. | Vectors are derived cache data, so deleting them is legal under the storage invariants. Turning search back on rebuilds them. |
| `enableEmbeddings` scope | Stays synced. Synced changes are hot-applied instead of forcing a reload. | Lowest-change option. Device-local is open question 5. |

## Settings keys

All new keys are optional. **No migration**: an absent key falls back as listed.

| Key | Type | Default when absent | Phase | Notes |
|---|---|---|---|---|
| `llmProviders.agentTemperature` | `number` (0–1) | `llmProviders.defaultTemperature ?? 0.5` | 2 | Subagent Creativity. Ignored when the agent model has `supportsSamplingParams === false`. |
| `llmProviders.agentContextWindowOverrides` | `Record<string, number>` keyed by `getContextWindowOverrideKey` | the agent model's advertised window | 2 | A separate map, so the chat and subagent sliders for the same model never write the same key. |
| Conversation `chatSettings.agentTemperature` | `number` | conversation absent → defaults above | 2 | Extends `ModelAgentConversationSettingsStore` and the `chatSettings` metadata (`src/types/chat/ChatTypes.ts:175-180`). The JSONL metadata event already carries `chatSettings` as an object. Check with `nexus-storage` `persist-new-data.md` that the field survives a cache rebuild. |
| Conversation `chatSettings.agentContextWindow` | `number` | resolved from defaults | 2 | Same as above. |
| `getStartedOpen` (`PluginTypes.ts:84`) | — | — | 3 | **Retired.** No longer read or written. Remove it from the type and leave it inert on disk. |
| Device-local `nexus-settings-folds` | `{ v: 1; defaults: string[]; chat: string[] }` | everything collapsed | 1 | Not in `data.json`. |

Existing keys keep their meaning: `defaultThinking`, `agentThinking`, `defaultTemperature`, `contextWindowOverrides`, `agentModel`, `enableIngestion`, `autoIngestion`, `defaultPdfMode`, `defaultOcrModel`, `enableEmbeddings`.

---

## Phase 0 — Correctness fixes (can ship alone)

**Goal:** fix the confirmed bugs that do not need the new layout.

### Files

| Path | Change | Kind |
|---|---|---|
| `src/services/embeddings/embeddingAccess.ts` | `resolveEmbeddingService(plugin: unknown): EmbeddingService \| null`. It reads `(plugin as {embeddingManager?}).embeddingManager` and returns `getService()` only when `isEmbeddingEnabled()`. No top-level Node imports; it only pulls types from `EmbeddingService`. | new |
| `src/agents/searchManager/services/ServiceAccessors.ts` | `getEmbeddingService()` uses the accessor (`:72-83`). | modified |
| `src/agents/searchManager/searchManager.ts` | Remove the cached `embeddingService` field and the lookup at `:113-115`. Stop calling `setEmbeddingService` at `:140-141`; the tool resolves on use. | modified |
| `src/agents/searchManager/tools/searchContent.ts` | `getEmbeddingService()` (`:257-279`) delegates to the accessor with no caching. Remove `setEmbeddingService` or make it test-only. | modified |
| `src/ui/chat/components/suggesters/initializeSuggesters.ts` | Pass a resolver `() => resolveEmbeddingService(plugin)` instead of a captured instance (`:44-50`). | modified |
| `src/ui/chat/components/suggesters/TextAreaNoteSuggester.ts`, `src/utils/noteSearch.ts` | Accept `EmbeddingService \| null \| (() => EmbeddingService \| null)`. Resolve per query. | modified |
| `src/ui/tasks/TaskBoardView.ts` (`:61`), `src/components/workspace/ProjectsManagerView.ts` (`:146`) | Use the accessor. | modified |
| `src/ui/chat/controllers/UIStateController.ts`, `src/ui/chat/ChatView.ts` | The welcome "Open settings" button (`UIStateController.ts:102-113`) calls a new `onOpenProviderSettings` callback. `ChatView` (`:647`) wires it to `openNexusSettings({ tab: 'providers' })`. The "Configure a provider to start chatting." hint stays. | modified |
| `src/core/settings/SettingsTabManager.ts` | Add `openNexusSettings(route: Partial<RouterState>)`. It stores the pending route on the `SettingsView`, then calls `app.setting.open()` and `app.setting.openTabById(manifest.id)`. The private `app.setting` typing follows the shape already used in `CommandDefinitions.ts:11`. | modified |
| `src/settings/SettingsView.ts` | Add `openTo(route)`, consumed by `display()`. Delete the stray `;` and the dead comment (`:251-252`). The header title is still out of scope (the mockup marks the header as unchanged), so only the noise goes. | modified |
| `src/settings/components/StatusBadge.ts` | Delete. | deleted |
| `src/components/shared/ChatSettingsRenderer.ts` | `syncWorkspacePrompt` (`:1316-1330`) uses the same precedence as `WorkspacePromptResolver`: top-level `dedicatedAgentId` first, then `context.dedicatedAgent.agentId`. The `ChatSettingsOptions.workspaces` type gains `dedicatedAgentId?: string`. Replace the `onclick` assignments (`:1310`, `:1346`) with `registerDomEvent` on the renderer's `Component`. | modified |
| `src/settings/tabs/DefaultsTab.ts` | `loadWorkspaces` (`:91-99`) passes `dedicatedAgentId` and `context` as the modal does. Move Ingestion and Embeddings into the renderer's `renderAfterImageSection` hook so a redraw cannot drop them (an interim fix; Phase 1 replaces the hook). In Ingestion: create the toggle first, put "Auto-convert" inside the gated container, and fix the copy (see Phase 1 for the final copy). | modified |
| `src/ui/chat/components/ChatSettingsModal.ts` | Remove the global context-window merge (`:234-258`). | modified |

### CSS

Delete `.nexus-status-badge*` (`styles.css:4736-4754`). Nothing else changes.

### Mobile

The accessor has no Node imports. `openNexusSettings` uses only Obsidian APIs. Run `npm run lint:mobile`.

### Tests (mocked Jest lane, `tests/unit/`, per nexus-testing `write-a-test.md`)

| Test | Asserts | Why it fails today |
|---|---|---|
| `ServiceNameRegistryContract.test.ts` | Statically collects every string literal passed to `getServiceIfReady` / `getService` under `src/`. Every name must be in `CORE_SERVICE_DEFINITIONS`, `ADDITIONAL_SERVICE_FACTORIES` or the `src/core/index.ts` registrations. | `'embeddingService'` is in none of them. Keeps the class of bug from coming back. |
| `ConversationMemorySearchEmbeddingAccess.test.ts` | Builds `MemorySearchProcessor` with a plugin stub whose `embeddingManager` is enabled and whose service's `semanticConversationSearch` is a spy, and **no** `embeddingService` registry entry. A conversation memory search must call the spy. | Today the accessor asks the registry, gets null and returns `[]`. |
| `SearchContentEmbeddingResolution.test.ts` | Manager disabled then re-enabled: the tool must use the new service instance, not a cached old one. | Today the tool caches forever (`searchContent.ts:269`). |
| `NoteSuggesterSemantic.test.ts` | `searchNotes` with a resolver that returns an enabled service calls `semanticSearch`. | The captured null means it never does. |
| `ChatWelcomeOpenSettings.test.ts` | The no-provider welcome button invokes the provider-settings callback, not the chat-settings modal. | It opens the modal today. |
| `ChatSettingsRendererWorkspacePrompt.test.ts` | Selecting a workspace whose **top-level** `dedicatedAgentId` names a prompt sets `promptId`. | It reads only the deprecated path today. |
| `DefaultsTabIngestionOrder.test.ts` | Uses a DOM-recording `Setting` mock (see the Phase 1 mock work). Asserts the order Enable → Auto-convert → mode, that Auto-convert is hidden while off, and that the rows survive `renderer.render()` being called twice. | All three fail today. |
| Update `ChatSettingsModalContextHandoff.test.ts` | Rename "saves defaults only after commit" to "never writes global defaults". Delete "merges only the edited model budget…". Keep the stale-handoff and cancel cases. | They encode the behaviour being removed. |
| `ChatSettingsWithoutConversation.test.ts` | Save with `conversationId = null`, then create a conversation. Its `chatSettings` must hold the saved temperature and thinking. | Expected to pass. It proves decision 7 rather than fixing anything; if it fails, that is a new bug. |

Make each new assertion fail once against the baseline before writing the fix (`mock-honesty.md`).

### In-app verification (nexus-testing `live-loop.md`, test vault only)

1. `npm run build`, then `obsidian plugin:reload id=nexus vault=<test>`, assert `app.vault.getName()`, then `obsidian dev:errors`.
2. Wait for indexing to finish, then: `nexus --vault <test> use --memory "Verify chat memory search" --goal "semantic conversation hits" -- search memory <phrase from an old chat>`. Expect conversation results with similarity scores.
3. `obsidian eval` on the chat view: type `[[concept` in the composer and confirm the suggestions differ from basename fuzzy matching for a conceptual query.
4. Remove all providers in the test vault, open chat, click "Open settings", and confirm the Providers tab opens.

### Acceptance

- Conversation semantic search returns results in the live vault.
- No `getServiceIfReady('embeddingService')` remains (`grep`).
- The welcome button lands on Providers.
- Ingestion survives provider and model changes on Defaults.

---

## Phase 1 — Shared accordion and the Essentials + folds layout

**Goal:** both surfaces render the mockup's structure with Obsidian components. Capability rules are partly in place here and finished in Phase 2.

### Step 1a — settle the slider readout (in-app, before any code)

In a test vault, run `obsidian eval` against a settings tab's `containerEl` and collect the markup of a plain `Setting().addSlider()`. If Obsidian renders its own value element, the readout helper writes the formatted text into that element. Otherwise it adds exactly one `span.nexus-slider-value`. Either way each value appears once. Record the finding in the testing skill's `refinement-log.md`.

### Files

| Path | Change | Kind |
|---|---|---|
| `src/components/Accordion.ts` | Rewrite to `new Accordion(containerEl, { id, title, icon?, summary?, open?, onToggle? })`. Markup:<br>• root `div.nexus-accordion` with `is-open`<br>• `button.nexus-accordion-toggle` with `aria-expanded` and `aria-controls`, holding `setIcon` icon, `.nexus-accordion-text` (title plus summary, summary hidden while open) and a chevron (`chevron-down` / `chevron-up`)<br>• `div.nexus-accordion-content.setting-group` with `id` and `hidden`, containing one stable `div.setting-items` exposed as `itemsEl`<br>API: `setSummary()`, `setOpen(open, {silent})`, `isOpen`, `itemsEl`. Events use `registerDomEvent`, and Enter/Space come from the native button. Remove `getContentEl()`, which created a new div per call. | modified |
| `src/settings/SettingsView.ts` | Interim: move the Get started accordion to the options object (`title: 'Get started'`, `icon: 'rocket'`). Phase 3 deletes this use. | modified |
| `src/components/shared/settings/FoldStateStore.ts` | Wraps `app.loadLocalStorage` / `saveLocalStorage` for `nexus-settings-folds` as `isOpen(surface, id)` and `setOpen(surface, id, open)`. Tolerates malformed stored values. | new |
| `src/components/shared/settings/settingGroup.ts` | `createSettingGroup(container, cls?)` returns `new SettingGroup(container)`. Kept in one place for the mock and for a future API change. | new |
| `src/components/shared/settings/sliderReadout.ts` | `bindSliderReadout(setting, slider, format)`: one readout per the step 1a finding, live `input` updates through the owning `Component.registerDomEvent`, and `aria-valuetext`. | new |
| `src/components/shared/ChatSettingsRenderer.ts` | Restructure (details below). | modified |
| `src/components/shared/ModelDropdownRenderer.ts` | Split into `renderProviderSetting(itemsEl, cfg)` and `renderModelSetting(itemsEl, cfg)` that add rows to a provided `setting-items` (no `csr-section` shell, no section title, no info icon). `reRender` becomes `onSelectionChanged(kind)`, so the caller redraws only the affected group. | modified |
| `src/components/shared/chatSettings/VoiceSettings.ts` | **The single voice implementation.** It merges `CSR.renderVoiceSection/renderSpeechSettings/renderRealtimeVoiceSettings/renderTranscriptionControls/getVoiceWarningMessages` with the Defaults-only bits: `renderAudioSaveSettings` and the `buildSpeechDefault` / `buildRealtimeDefault` source/auto bookkeeping (`DefaultsTab.ts:566-600`, `:984-1006`). Subheads: Transcription, Read aloud, Live voice. It writes only to the renderer's settings object, and Defaults persists it through its save queue (see DefaultsTab). Warning messages become the description of the affected Provider row. | new |
| `src/components/shared/chatSettings/sectionSummaries.ts` | Pure functions that build each fold's collapsed summary from settings plus capabilities (copy appendix). | new |
| `src/settings/tabs/defaults/VideoSettings.ts` | Moves `renderVideoSection` (`DefaultsTab.ts:288-470`) into fold rows: Provider, Model, Aspect ratio, Resolution. | new |
| `src/settings/tabs/defaults/FileConversionSettings.ts` | Rows in order: PDF import toggle (`enableIngestion`), then, only when on, Reading method (`defaultPdfMode`: Text extraction / Vision), Vision provider and Vision model (only when Vision, via `renderIngestModelDropdowns` with the new names) and Convert new PDFs automatically (`autoIngestion`). The section redraws its own rows when the toggle or mode changes. | new |
| `src/settings/tabs/defaults/SemanticSearchSettings.ts` | Phase 1: the toggle row only, keeping today's restart Notice, so the fold exists. Phase 4 completes it. Desktop only. | new |
| `src/settings/tabs/DefaultsTab.ts` | Delete the header and intro (`:221-229`), the voice, video and ingestion implementations, the Embeddings section and the `renderAfterImageSection` use. Construct the renderer with `surface: 'defaults'` and `extraFolds` = Video, File conversion and Semantic search. Extend `getCurrentSettings`/`saveSettings` to persist `speech*`, `realtimeVoice*` and the video fields through the save queue, so nothing writes `llmProviderSettings` outside it. | modified (large reduction) |
| `src/ui/chat/components/ChatSettingsModal.ts` | Use `this.setTitle('Chat settings')` and put Cancel / Save in a bottom `div.modal-button-container` (replacing the `chat-settings-header` block at `:55-72`). Keep the `role=status` save text there. `surface: 'chat'`. | modified |
| `tests/mocks/obsidian/components.ts`, `tests/mocks/obsidian/index.ts` | Add `SettingGroup`, `ExtraButtonComponent`, `ProgressBarComponent`, `Setting.addExtraButton`, `Setting.addProgressBar`, `Setting.setDisabled`, `SliderComponent.setDisabled` and `DropdownComponent.setDisabled`. Make the `Setting` mock **append** `settingEl` to the container passed in and record its name, so tests can assert order. Today it appends nothing and drops the name (`components.ts:8-28`). | modified |

**Renderer structure** (`ChatSettingsRendererConfig` gains `surface: 'defaults' | 'chat'`, `foldStore` and `extraFolds?: FoldDefinition[]`; `showWorkflowSelection`, `showVoiceSection`, `showTranscriptionSection`, `showWebSearch` and `renderAfterImageSection` are removed):

1. `render()` builds a **stable shell** once: the top `SettingGroup` (no heading) and one `Accordion` per fold, in mockup order. Order and icons:
   - Chat options — `sliders-horizontal`
   - Context — `layers`
   - Subagents — `bot`
   - Images — `image`
   - Video — `film` (Defaults only)
   - Voice — `mic`
   - File conversion — `file-input` (Defaults only)
   - Semantic search — `scan-search` (Defaults only, desktop only)
2. Each group has its own `renderX(itemsEl)` that empties and refills only its own `itemsEl`, then calls `accordion.setSummary(...)`. Redraw map:

   | Change | Redraws |
   |---|---|
   | chat provider/model | top block, Chat options, Subagents summary (inherits) |
   | subagent provider/model | Subagents |
   | image provider | Images |
   | workspace | Context |
   | `LLMSettingsNotifier` | all groups, but **not** the shell |

   Because accordions are never rebuilt, fold state and scroll position survive. For a full redraw (`destroy()` and re-render on surface switch), capture `scrollTop` of the scroll parent (modal `contentEl` or the settings `.vertical-tab-content`) and restore it after.
3. Top block: Provider and Model as separate dropdowns, then the Thinking dropdown. Thinking is present only when `supportsThinking`.
4. Chat options: Creativity (disabled rule in Phase 2; in Phase 1 always enabled, with the new description), Context window (preset slider), and Web search only on `surface === 'chat'`, using the existing provider gating (`CSR:483-501`) and the new description.
5. Context: Workspace, Workflow (chat only, new description), Prompt, then a "Context notes" `Setting` with a `ButtonComponent` "Add note" and one row per note. Each note row shows a `file-text` icon and the basename, plus an `ExtraButtonComponent` `x` with tooltip `Remove <name>`.
6. Subagents: a "Used for" note row, then the same row builders as the top block and Chat options with `variant: 'agent'`. Creativity and Context window for subagents arrive in Phase 2. Until then the fold shows Provider, Model and Thinking.
7. Images: Provider and Model (existing logic, `CSR:627-707`).
8. Voice: `VoiceSettings` with `surface`.
9. Extra folds supplied by Defaults.

`ChatSettings` gains nothing in Phase 1 apart from moving the voice and video fields that Defaults now persists through the queue.

### Settings keys

Only the device-local fold store.

### CSS (`styles.css`)

**Add** a "Settings: shared accordion" section that replaces `ORIGINAL ACCORDION STYLES` (`:1754-1866`). Port these rules from the mockup's CSS, using theme variables only:
- `.nexus-accordion` (max-width `var(--setting-group-max-width)`, margin, radius)
- `.nexus-accordion.is-open { background: var(--setting-items-background) }`, so the whole open fold, header included, is one lighter card
- `.nexus-accordion-toggle` (flex, padding `var(--setting-items-padding-x)`, hover only while closed)
- `.nexus-accordion-icon` (accent)
- `.nexus-accordion-title` (`--setting-group-heading-size`, 600)
- `.nexus-accordion-summary` (muted, single line, ellipsis)
- `.nexus-accordion-chevron`
- `.nexus-accordion-content .setting-items { background: transparent }`
- the first-row divider rule
- spacing between folds, more than between rows
- the modal variant
- `.nexus-subhead`, `.nexus-note-row`, `.nexus-note`, `.nexus-ctx-value` (or `.nexus-slider-value`)
- `is-mobile` tap targets of at least 44 px on the toggle

**Delete:**
- `.mcp-accordion*` (`:1754-1866`)
- `.csr-effort-row`, `.csr-effort-value`, `.csr-temp-value`, `.csr-provider-warning*`, `.csr-notes-*`, `.csr-note-*`, `.csr-add-btn`, `.csr-info-icon` (`:4408-4417`, `:4466-4584`)
- `.nexus-voice-*` (`:4435-4460`)
- `.thinking-settings-section`, `.thinking-effort-value` (`:4345-4361`), if `grep` shows no remaining users
- the `.chat-settings-header` / `.chat-settings-buttons` rules (`:3900-3910`, `:4255-4270`, after checking each selector)

**Keep** `.csr-section`, `.csr-section-header`, `.csr-section-content` and `.csr-section-desc`, because `DataTab.ts:76-134` still uses them. Leave a one-line comment naming DataTab as the remaining consumer. **Keep** `.nexus-ingest-confirm-hidden` (`:8555`), which `IngestConfirmModal.ts:145-157` uses. Do not reference the mockup by file or line in CSS comments; name the plan.

The text-only provider warning (`CSR:546-596`) becomes the Model row's description (`setDesc`), with its title in bold through a `DocumentFragment`. No dedicated CSS.

### Mobile

The renderer stays mobile-safe: no Node imports, and the Semantic search fold is constructed only when `Platform.isDesktop`. The Video fold follows today's provider availability. Verify `is-mobile` layout with `obsidian dev:mobile on` (layout only; it is not evidence of import safety) and run `npm run lint:mobile`.

### Tests

| Test | Lane | Asserts | Fails today because |
|---|---|---|---|
| `Accordion.test.ts` | unit | Collapsed by default. Toggle flips `aria-expanded`, `hidden` and `is-open`. The summary is hidden while open. `itemsEl` is the same node across calls. `onToggle` fires once. | `getContentEl()` returns a new node each call, and there is no summary or icon API. |
| `FoldStateStore.test.ts` | unit | Round-trip per surface. Malformed stored JSON gives all closed. Nothing touches `saveSettings`. | New. |
| `ChatSettingsRendererLayout.test.ts` | unit, DOM-recording mocks | Defaults order: top group (Provider, Model, Thinking) then folds Chat options, Context, Subagents, Images, Video, Voice, File conversion, Semantic search. Chat order omits Video, File conversion and Semantic search. Chat options includes Web search only in chat. Context includes Workflow only in chat. No element with the old intro text. | The current order and section names differ. |
| `ChatSettingsRendererRedraw.test.ts` | unit | Open Context, change the chat model: Context is still open and the Context `itemsEl` was not rebuilt. Change the workspace: only Context rebuilt. | `render()` empties everything. |
| `ThinkingDropdown.test.ts` | unit | Mapping Off↔`{enabled:false}` and level↔`{enabled:true, effort}`. Hidden for a non-thinking model. Off keeps the stored effort. | The toggle and slider exist today. |
| `ContextWindowStops.test.ts` | unit | `contextWindowStops(1_000_000)` = 7 stops ending at 1M. `(200_000)` = [32K, 64K, 128K, 200K]. `(40_000)` = [32K, 40K]. `(4096)` = [4096] and the slider is disabled. A legacy 150,000 keeps the readout "150K" and puts the thumb on 128K. A provider/model change shows the new model's maximum. | 1-token slider today. |
| `SettingsSectionSummaries.test.ts` | unit | Each summary string, using the copy constants in Appendix A. | New. |
| `VoiceSettingsSingleImplementation.test.ts` | unit | Defaults and chat produce the same row labels. The Defaults-only "Saved audio folder" row appears only on Defaults. Defaults persists `defaultSpeechModel.source = 'user'` on a manual pick. | Two implementations with different labels. |
| `FileConversionSettings.test.ts` | unit | Toggle first. Dependent rows only when on. Vision rows only in Vision mode. The copy matches Appendix A. | Bug 3. |
| Rewrite `ChatSettingsRendererEffort.test.ts`, `ChatSettingsRendererContextWindow.test.ts` | unit | Retarget them at the dropdown and the preset slider. | Old controls removed. |
| Keep `ChatSettingsRendererTextOnlyWarning.test.ts` | unit | Update it to assert the Model row description. | Location moves. |

### In-app verification

Build and reload, then use `obsidian eval` on `app.setting.activeTab.containerEl` (settings may be a separate window, per `live-loop.md`) to dump each group's title and its row names.

1. Defaults: open Context, switch the chat model, and check that Context is still open and the scroll position is unchanged.
2. Close and reopen settings: the fold state is remembered. Restart Obsidian: still remembered.
3. Chat settings modal: same checks, then Cancel discards and Save persists.
4. Light and dark themes, and narrow width with `dev:mobile on`.
5. `dev:screenshot` both surfaces for the owner, next to the mockup.

### Acceptance (against the mockup)

- No intro line and no heading above the top block.
- The top block is a `SettingGroup` with Provider, Model and Thinking.
- Folds are collapsed by default, in mockup order with mockup icons, and show a one-line summary while collapsed.
- An open fold is a single lighter card, header included.
- Every value appears once.
- No "restore default" buttons.
- The only custom component is the accordion. `grep -n "createEl('button'" src/components/shared/ChatSettingsRenderer.ts` finds nothing.

---

## Phase 2 — Capability-driven controls and subagent settings that take effect

### Files

| Path | Change | Kind |
|---|---|---|
| `src/services/StaticModelsService.ts` | `ModelWithProvider` gains `supportsSamplingParams?: boolean` (mapped at `:210-222`). | modified |
| `src/components/shared/chatSettings/modelCapabilities.ts` | `getModelCapabilities(staticModels, providerManager, provider, model)` returns `{ supportsThinking, supportsSamplingParams, contextWindow }`. Static models answer synchronously; discovered windows (Ollama, LM Studio) come from `providerManager.getModelsForProvider`, as `CSR:430-449` does today. Merged provider IDs (`openai-codex` → `openai`, `anthropic-claude-code` → `anthropic`, `google-gemini-cli` → `google`) are handled like `ModelDropdownRenderer.ts:199-206`. | new |
| `src/services/llm/utils/resolveThinkingForModel.ts` | Shared gating helper (see Decisions). | new |
| `src/components/shared/ChatSettingsRenderer.ts` | The Creativity row follows `supportsSamplingParams`: disabled `Setting` and slider, readout "—", description `<Model display name> sets its own temperature.`. The Subagents fold gets Creativity and Context window rows. On agent provider/model change, clear the pending `agentContextWindowOverrides[key]`. The "Used for" row is always present. | modified |
| `src/types/llm/ProviderTypes.ts` | Add `agentTemperature?`, `agentContextWindowOverrides?` to `LLMProviderSettings` (`:128-152`), with comments. | modified |
| `src/components/shared/ChatSettingsRenderer.ts` (`ChatSettings`) | Add `agentTemperature?: number` and `agentContextWindowOverrides?: Record<string, number>`. | modified |
| `src/settings/tabs/DefaultsTab.ts` | Load and save the two new keys. | modified |
| `src/ui/chat/services/ModelAgentDefaultsResolver.ts`, `ModelAgentConversationSettingsStore.ts`, `ModelAgentManager.ts` | Carry `agentTemperature` and `agentContextWindow` through defaults, conversation restore (`:303-313`), `buildChatSettingsMetadata` (`:1229-1255`) and new getters/setters. | modified |
| `src/types/chat/ChatTypes.ts` | `chatSettings` gains the two fields (`:175-180`). | modified |
| `src/ui/chat/components/ChatSettingsModal.ts` | Read and write the new agent fields. | modified |
| `src/ui/chat/services/ModelAgentPromptContextAssembler.ts` | `enableThinking` and `thinkingEffort` go through `resolveThinkingForModel` (`:120`, `:126`). | modified |
| `src/ui/chat/controllers/SubagentController.ts` | `buildSubagentContext` (`:455-483`) resolves provider, model, thinking, temperature and context window using the agent precedence in Decisions, via a new `SubagentModelResolver`. `createStreamingGenerator` (`:315-358`) accepts and forwards `enableThinking`, `thinkingEffort` and `temperature`. | modified |
| `src/ui/chat/services/SubagentModelResolver.ts` | Pure precedence function, with the `LOCAL_PROVIDERS` list shared with `LLMService`. | new |
| `src/agents/promptManager/tools/subagent.ts` | The context type gains `temperature` and `contextWindow`. Pass them into `executeSubagent` and to remote jobs where supported (`:200-206`). | modified |
| `src/types/branch/BranchTypes.ts`, `src/services/chat/SubagentExecutor.ts` | Params gain `temperature` and `contextWindow`. Forward `thinkingEnabled`, `thinkingEffort` and `temperature` to `streamingGenerator` (`:367-375`). Use `contextWindow` as the budget for inherited `contextFiles`/`workspaceData` assembly: drop whole files beyond the budget and add one line saying which were omitted. No mid-run compaction. | modified |
| `src/services/llm/core/LLMService.ts` | `getAgentModel()` (`:126-151`) honours a configured `agentModel` whatever the chat model is. The precedence lives in `SubagentModelResolver`, imported here. | modified |
| `src/agents/promptManager/tools/executePrompts/services/PromptExecutor.ts` | Pass the agent temperature, unless sampling is unsupported, and agent thinking through `resolveThinkingForModel` into `executeParams` (`:89-97`). `LLMExecutionOptions` already extends `GenerateOptions`, which has `temperature`, `enableThinking` and `thinkingEffort`. | modified |

### CSS

None beyond Phase 1. `.setting-item.is-disabled` comes from Obsidian.

### Mobile

No new imports. Local providers stay excluded from the Subagents provider list (`CSR` `LOCAL_PROVIDERS`).

### Tests

| Test | Asserts | Fails today because |
|---|---|---|
| `CreativityCapability.test.ts` | Claude Opus 5.5: row disabled, description `Claude Opus 5.5 sets its own temperature.`. Claude Opus 4.6: enabled. A model missing from the registry: enabled. | The flag is not mapped and the slider is always enabled. |
| `ResolveThinkingForModel.test.ts` | Non-thinking model gives `{enabled:false}`, the stored preference is untouched, and a thinking model passes through. | New. |
| `PromptContextThinkingGate.test.ts` | Stored `enabled:true` with Mistral Large Latest gives `buildMessageOptions().enableThinking === false`. | It sends `true` today. |
| `SubagentModelResolver.test.ts` | Precedence table, including "no agent model set and chat model is cloud → chat model", which is today's behaviour. | New. |
| `SubagentControllerForwardsSettings.test.ts` | With agent Haiku 5.5, thinking High and temperature 0.3, the generator calls `llmService.generateResponseStream` with the agent provider and model, `enableThinking: true`, `thinkingEffort: 'high'` and **no** temperature (Haiku rejects sampling). With Opus 4.6, temperature 0.3 is passed. | Today it inherits the chat model and drops thinking and temperature. |
| `PromptExecutorAgentSettings.test.ts` | `executePrompt` receives the agent temperature and thinking. | Not passed today. |
| `LLMServiceAgentModel.test.ts` | A configured `agentModel` wins even when the chat model is cloud. | Returns the chat default today. |
| `SubagentContextBudget.test.ts` | Context files beyond `contextWindow` are omitted, and the prompt says which. | No budget today. |

Gated live smoke (`nexus-testing` `run-gated-lanes.md`): one subagent run against a real provider, confirming the provider and model that the adapter receives. Optional and not in CI.

### In-app verification

1. In Defaults set Subagents to Claude Haiku 5.5 with Thinking Off; set the chat model to Opus 5.5.
2. Ask the chat to spawn a subagent.
3. With `obsidian eval`, read the subagent branch's message metadata (provider/model). Expect Haiku.
4. Switch the chat model to Mistral Large Latest and send a message. Its request carries no thinking, confirmed by temporary console logging in a dev build only, or by adapter tests.

### Acceptance

- Creativity and Thinking rows follow the model, exactly as the mockup's caption describes ("Opus, Sonnet and Haiku 5.5 reject temperature, Opus 4.6 accepts it, Mistral Large can't reason, and Magistral Medium has a 40K context").
- Every Subagents value demonstrably reaches the execution path.

---

## Phase 3 — Get started pages, Node.js and Antigravity

### Files

| Path | Change | Kind |
|---|---|---|
| `src/settings/SettingsRouter.ts` | `RouterState` gains `page?: 'get-started' \| 'get-started-chat' \| 'get-started-agents'`. Add `openPage(page)` and `closePage()`. `setTab()` clears `page`. `back()` from a page goes up one level: agents or chat → get-started → none. | modified |
| `src/settings/SettingsView.ts` | Above the tab strip, a `SettingGroup` (class `nexus-get-started`) with one navigable `Setting`. Its name is the `rocket` icon plus "Get started", it has the description from Appendix A and a `chevron-right` control, and the whole row is clickable (`registerDomEvent` on `settingEl`, `role=button`, `tabindex=0`, Enter/Space). While `state.page` is set, `display()`/`renderTabContent` hides the row, the tab strip and the panes, and renders the page into a page container. Apply the first-run auto-open rule. Delete `renderGetStartedAccordion` and the `getStartedAccordion` field (`:534-597`). The external-agent page still loads through `await import(...)`. | modified |
| `src/settings/getStarted/GetStartedPage.ts` | Mobile-safe. Page head: `BackButton` ("Settings") and title. Lede, the six capability bullets (Lucide icons via `setIcon`), heading "Choose your setup" with description "Pick one, or use both.", and a `SettingGroup` with two navigable rows. "Chat inside Obsidian" has value `Ready` / `Not set up` from `hasConfiguredProviders`. "Connect an external agent" (desktop only) has value `N connected`, where N counts Claude Desktop, Codex and Antigravity configs that contain a Nexus server key plus the command line when installed. | new |
| `src/settings/getStarted/ChatSetupPage.ts` | Mobile-safe. Back: "Get started". Three numbered steps (`.nexus-step` badge):<br>1. Status "Connected" (circle-check) only when a provider is configured, plus a "Open providers" button that calls `router.setTab('providers')`.<br>2. "Open chat" (mod-cta) runs `app.commands.executeCommandById('<manifest.id>:open-chat')` and closes settings.<br>3. Text only. | new |
| `src/settings/getStarted/ExternalAgentsPage.ts` | Desktop only. **Dynamically imported.** Built from the reusable parts of `GetStartedTab.ts` (config paths, `ensureConnectorFile`, `autoConfigureNexus`, `autoConfigureCodex`, `openConfigFile`, the Local CLI install, PATH fix and providers logic). Layout as in the list after this table. | new |
| `src/settings/tabs/GetStartedTab.ts` | Deleted once its logic is moved. | deleted |
| `src/utils/nodeRuntime.ts` | `resolveNodeRuntime(): { path, version, manager: 'nvm' \| 'other' } \| null`. It uses `resolveDesktopBinaryPath('node')` and then runs `execFileSync(path, ['--version'], { timeout: 3000 })` through `desktopRequire`. `manager` is `'nvm'` when the path contains `/.nvm/versions/node/` (or `\nvm\` on Windows nvm-windows). No top-level Node imports. | new |
| `src/utils/mcpClientConfigs.ts` | Path and status helpers: `getAntigravityConfigPath()` (`~/.gemini/config/mcp_config.json`, using `%USERPROFILE%` on Windows); `getAntigravityLegacyConfigPath()` (`~/.gemini/antigravity/mcp_config.json`); `getMcpJsonStatus(path, serverKeys)`. These are shared by Claude Desktop and Antigravity, since both use the `mcpServers {command,args}` shape. Also `buildMcpServerEntry(nodePath, connectorPath)`, which **requires** a node path; there is no `'node'` fallback. | new |
| `src/settings/getStartedStatus.ts` | Remove `shouldOpenGetStarted` and the `getStartedOpen` branch. `hasExternalAgentSetup` also checks Antigravity. Export a `countExternalConnections(app)`. | modified |
| `src/types/plugin/PluginTypes.ts` | Remove `getStartedOpen` (`:84`). | modified |
| `src/settings/components/BackButton.ts` | Make `component` required, removing the `addEventListener` fallback at `:28-30`. All callers already pass one or can. | modified |
| `src/services/llm/providers/BuiltinProviderDrivers.ts` (`:278`), `src/utils/platform.ts` (`:159`), `src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter.ts` (`:244`), `README.md` (`:16`) | Replace "Gemini CLI" in user-facing strings with "Antigravity CLI", or "Antigravity" for the MCP client in README. Internal IDs (`google-gemini-cli`), class names and code comments stay. Update `tests/unit/GenericProviderModalSaveBehavior.test.ts:131-149` only if the notice label source changes (it is `oauthConfig.providerLabel`, already "Antigravity CLI" at `ProvidersTab.ts:717-721`, so check before editing). | modified |

**External-agent page layout:**

- Lede: "Let apps outside Obsidian use your vault through Nexus."
- **Node.js group**
  - Found: description "Runs the connector. Found `<version>` at `<path>`." with the status "Found". If `manager === 'nvm'`, add a warning line: "This path changes when you switch Node versions with nvm. Reconnect your apps after switching, or install Node.js from nodejs.org for a stable path."
  - Missing: the Appendix A copy with "Install Node.js" (mod-cta, opens `https://nodejs.org/`) and "Check again", which re-resolves and redraws.
- **Apps group** (one `SettingGroup`, no descriptions under the names):
  - Claude Desktop: status, plus "Open config" when connected or "Connect".
  - Codex: status plus "Connect".
  - Antigravity: status plus "Connect". **New**: writes the JSON entry to `getAntigravityConfigPath()`, merging into existing `mcpServers` with the same code path as Claude Desktop.
  - Every Connect calls `ensureConnectorFile` first.
  - Stale detection: if a config's `command` path no longer exists (the nvm switch case), the status reads "Reconnect".
  - Last row, "Other agents": description from Appendix A, with a chevron `ExtraButtonComponent` ("Show steps" / "Hide steps"). It expands inline into four numbered steps:
    1. Create → "Created".
    2. A `pre.nexus-code` preview of `JSON.stringify({mcpServers:{[serverKey]:{command, args:[connector]}}}, null, 2)` and "Copy config".
    3. Prompt preview and "Copy prompt".
    4. Text only.
  - When Node is missing, every Connect, Create and Copy is disabled, the status reads "Needs Node.js", and the previews read "Install Node.js first." (step 2 uses the long form from the mockup).
- **Command line group**
  - Name `terminal` icon plus "Command line", description from Appendix A, status (the existing `installer.status()` wording, shortened to "Installed" / "Not installed" / "Not on your PATH"), and Install or Uninstall.
  - Three `ToggleComponent` child rows: "Claude Code skills" `~/.claude/skills`, "Cursor skills" `~/.cursor/skills`, "Codex AGENTS.md" `~/.codex/AGENTS.md`.
  - The toggles behave as the checkboxes do today: they pick targets before install and wire immediately after install (`GetStartedTab.ts:660-695`).
  - "Add to path" and the PATH-fix panel keep their behaviour, as extra rows when applicable.
- Fix the guide link: `createEl('a', { href: 'https://github.com/ProfSynapse/nexus/blob/main/guide/mcp-setup.md' })`, with the click going through `registerDomEvent` + `window.open`. The link sits under the Other agents steps.

### CSS

**Add** a "Settings: Get started pages" section with:
- `.nexus-page-head`, `.nexus-page-title`, `.nexus-page-lede`
- `.nexus-can` (icon list)
- `.nexus-gs-heading`
- `.setting-item.mod-navigable` (cursor, hover)
- `.nexus-step` (number badge)
- `.nexus-status` and `.nexus-status.is-ok` (circle-check)
- `.nexus-code` and `.nexus-prompt` (monospace, wrapping, max-height with scroll)
- `.nexus-other-steps`, `.nexus-child-row`, `.nexus-path-row`, `.nexus-node-missing`
- 44 px tap targets on `is-mobile`

**Delete** the old Get started CSS:
- `.nexus-intro*`, `.nexus-capabilit*`, `.nexus-cap-icon`, `.nexus-divider`, `.nexus-setup-*` (`:4773-4925`)
- `.nexus-mcp-*`, `.nexus-cli-*`, `.nexus-manual-*`, `.nexus-config-code`, `.nx-*` (`:4869-5280`)
- `.nexus-settings-accordion*` (`:2210-2216`)

Check each selector with `grep -rn` across `src/` first; some `nexus-mcp-*` names may be shared.

### Mobile

`GetStartedPage` and `ChatSetupPage` import only `obsidian` and `getStartedStatus` (already imported at init). `ExternalAgentsPage`, `nodeRuntime` and `mcpClientConfigs` are reached only through `await import()` behind `Platform.isDesktop && supportsMCPBridge()`. Run `node scripts/check-mobile-imports.mjs . --trace src/settings/getStarted/ExternalAgentsPage.ts` to confirm it is not on the init path. `src/settings/components/**` stays under the ESLint Node ban.

### Tests

| Test | Asserts | Fails today because |
|---|---|---|
| `SettingsRouterPages.test.ts` | `openPage`/`back` hierarchy; `setTab` clears the page. | No pages. |
| `GetStartedFirstRun.test.ts` | No provider and no external setup: the first `display()` shows the Get started page and the second does not. A configured provider shows the tab list. | The accordion and `getStartedOpen` exist today. |
| `GetStartedChatPage.test.ts` | Step 1 shows "Connected" only when configured and never lists provider names. "Open providers" switches to the providers tab. Copy has no "Ctrl/Cmd". | Hotkey copy today. |
| `ExternalAgentsNodeMissing.test.ts` | `resolveNodeRuntime` returns null: every Connect, Create and Copy is disabled, status "Needs Node.js", the preview says "Install Node.js first.", and no config string contains `"node"` as a bare command. | Bare `'node'` fallback. |
| `McpServerEntryWindows.test.ts` | With Windows paths the copied JSON escapes backslashes and `JSON.parse` round-trips to the exact paths. | New. |
| `AntigravityConnect.test.ts` | With a mocked `desktopRequire` fs: creates `connector.js` first, creates the file if missing, merges into existing `mcpServers` and preserves other servers. | New. |
| `NodeRuntimeNvm.test.ts` | Detects an nvm path; parses `v24.11.0`. | New. |
| `NoGeminiCliCopy.test.ts` | Scans `src/**/*.ts` string literals in UI and notice contexts for "Gemini CLI". The allowlist is limited to comments and IDs. | Five user-facing hits. |
| Update `GetStartedStatus.test.ts`, `SettingsViewDataTab.test.ts:164-199` | Remove the `getStartedOpen` cases. | The key is retired. |
| `BackButton.test.ts` | Update for the required `component`. | Signature change. |

### In-app verification (desktop test vault)

1. With providers configured, open Settings → Nexus. The row sits above the tabs and the whole row opens the page. Back returns to the tab list on the same tab.
2. "Chat inside Obsidian": "Open providers" lands on Providers; "Open chat" opens the chat view.
3. External agents: the Node row shows version and path. Temporarily point `PATH` to exclude node and use a dev build that forces `resolveNodeRuntime` to null; check the disabled state.
4. Click Antigravity Connect on a machine with Antigravity (see Not confirmed). Check that the file is written, then reload MCP servers with `/mcp` or Refresh, then ask Antigravity to list vault folders.
5. Copy config and check the clipboard content with `obsidian eval` (`navigator.clipboard.readText()`).
6. On mobile (a real device, not emulation), Get started shows only the chat path.

### Acceptance

The pages, the row, copy, order and states match the mockup: Get started intro, Chat inside Obsidian, Connect an external agent with OS-specific paths and the Node found/missing states, and the Other agents four steps. There is no emoji, no "Gemini CLI" and no `href="#"`.

---

## Phase 4 — Semantic search: status, hot-apply, delete, prune, tool schema

### Files

| Path | Change | Kind |
|---|---|---|
| `src/services/embeddings/EmbeddingManager.ts` | Separate **disable** from **unload**:<br>• `setEnabled(enabled): Promise<void>`. Enabling sets `isEnabled` and calls `initialize()`, which builds fresh components. Disabling calls `stop()`.<br>• `stop()`: cancel the timer, `queue.destroy()`, `watcher.stop()`, `conversationWatcher.shutdown()`, `statusBar.destroy()`, await `backgroundIndexingWork`, `engine.dispose()` (unloads the model), clear the dream interval (store its ID; it is currently anonymous at `:322-325`), `plugin.removeCommand('consolidate-retrieval-memory')` (API 1.7.2), null all components, `isInitialized = false`.<br>• `shutdown()` keeps its permanent `shuttingDown` fence and calls the shared teardown.<br>• Add `onStateChange(listener)` (Obsidian `Events`), emitted on start, stop and every queue `progress` event.<br>• `getStats()` adds `conversationCount` (`SELECT COUNT(DISTINCT conversationId) FROM conversation_embedding_metadata`) and returns stored counts even while disabled, so the off state can show "Paused · N notes". It reads the DB directly when `service` is null. | modified |
| `src/services/embeddings/IndexingQueue.ts` | Add `pruneMissingNotes()`: `SELECT notePath FROM embedding_metadata`, and for every path where `app.vault.getAbstractFileByPath(path)` is null, call `embeddingService.removeEmbedding`. Add `pruneMissingConversations()` for `conversation_embedding_metadata` rows whose conversation no longer exists. Expose `getProgress()` for initial paint. | modified |
| `src/services/embeddings/EmbeddingManager.ts` (`runIndexingPhases`, `:379-411`) | Run the prune passes before Phase 1. This covers startup, re-enable and rebuild. | modified |
| `src/database/storage/SQLiteMaintenanceService.ts`, `SQLiteCacheManager.ts` | Add `clearEmbeddingIndex()` in a transaction: drop and recreate `note_embeddings`, `trace_embeddings` and `conversation_embeddings` (`USING vec0(embedding float[384])`, matching `schema.ts:305-367`), `DELETE FROM` `embedding_metadata`, `trace_embedding_metadata`, `conversation_embedding_metadata` and `embedding_backfill_state`, then save. No schema change. Still run `check_schema_consistency.py`, since the DDL strings must match. | modified |
| `src/services/embeddings/EmbeddingManager.ts` | `deleteIndex()` is allowed only while disabled; it throws otherwise. | modified |
| `src/core/PluginLifecycleManager.ts` | Keep constructing `EmbeddingManager` on desktop whatever the setting (it already does, `:363-371`). Subscribe to `onStateChange`, so `chatTraceService.setEmbeddingService(service \| null)` follows the state (`:389-397`). Expose `setEmbeddingsEnabled(value)`. | modified |
| `src/services/chat/ChatTraceService.ts` | `setEmbeddingService(service: EmbeddingService \| null)` (`:56`). | modified |
| `src/settings.ts` | `reloadSettings` (`:195-201`) excludes `enableEmbeddings`. `reconcileExternalSettings` returns a flag so the plugin can hot-apply a synced change. | modified |
| `src/main.ts` | In `onExternalSettingsChange`, when `enableEmbeddings` changed, call `lifecycle.setEmbeddingsEnabled`. | modified |
| `src/settings/tabs/defaults/SemanticSearchSettings.ts` | Full fold:<br>• Toggle row.<br>• On: status row "Index" (`4,512 notes · 318 chats`).<br>• Indexing: a "Indexing" row with `ProgressBarComponent`, "1,904 / 4,512", ETA text from `estimatedTimeRemaining`, and a pause `ExtraButtonComponent` (`pause` / "Pause indexing"; `play` / "Resume indexing" while paused).<br>• Off: "Index" (`Paused · N notes`) plus a "Delete index" `ButtonComponent` (`mod-warning`). After deletion it shows "No index on this device".<br>• Turning off opens the confirmation modal; Cancel reverts the toggle and Escape cancels.<br>• Subscribes to `onStateChange` while mounted and unsubscribes on destroy.<br>• Summary: `On · N notes` / `Indexing · P%` / `Off · index kept`. | modified |
| `src/settings/tabs/defaults/SemanticSearchOffModal.ts` | An Obsidian `Modal` with the Appendix A copy, `mod-confirm` and the buttons Cancel / Turn off (`mod-warning`). | new |
| `src/agents/searchManager/tools/searchContent.ts` | Constructor takes `getSemanticState: () => 'available' \| 'off' \| 'unsupported'`, derived from `settings.enableEmbeddings`, `Platform` and the manager state. `refreshDescription()` reassigns `this.description` (BaseTool's `description` is a field, so a getter override would clash in TS). The constructor calls it, and so does an `onStateChange` subscription made in `SearchManagerAgent`. `getParameterSchema()` (`:666-709`) picks the `semantic` property description by state. In `execute()`, `semantic === true` while off runs keyword search and adds `note: 'Semantic search is turned off in Nexus settings, so this used keyword search.'`. While unsupported (mobile) it does the same with a "not available on this device" note. "Still initializing" (`:321-322`) is used only when enabled but not yet initialized. | modified |
| `src/agents/searchManager/searchManager.ts` | Wire `getSemanticState` and the refresh subscription. | modified |
| `src/agents/searchManager/types` (result type) | `ContentSearchResult` gains an optional `note?: string`. | modified |
| `cli-first-tool-schemas.json` and `docs/generated/*` | Regenerate with `npm run schemas:tools -- --output cli-first-tool-schemas.json` per `nexus-tool-schemas` `refresh-catalog.md`, then `check_catalog.py`. The headless exporter has no plugin settings, so the default state **must** be `'available'` to keep the committed description stable. | regenerated |

### CSS

Add `.nexus-semantic-progress` (progress bar width 140 px, as in the mockup) and `.nexus-semantic-value`. Nothing else is needed: the modal uses Obsidian's `.modal` and `mod-confirm`.

### Mobile

The fold is not constructed on mobile. `EmbeddingManager` already disables itself (`:83`). The tool's `'unsupported'` state reports keyword fallback. `SemanticSearchOffModal` is a plain `Modal`.

### Tests

| Test | Lane | Asserts | Fails today because |
|---|---|---|---|
| `EmbeddingManagerHotToggle.test.ts` | unit | `setEnabled(false)`: watcher stopped, queue destroyed, status bar destroyed, engine disposed, interval cleared, `removeCommand` called, `getService()` null, and a state event emitted. `setEnabled(true)`: new components and indexing scheduled. A later `shutdown()` does not throw. | No runtime toggle; `initialize` refuses after shutdown. |
| `EmbeddingPrune.test.ts` | unit | Rows for missing paths are removed; existing ones are kept. Conversations likewise. | No prune pass. |
| `ClearEmbeddingIndex.test.ts` | integration (sql.js, as other SQLite tests do) | After `clearEmbeddingIndex()` all seven embedding tables are empty, non-embedding tables are untouched, and the vec0 tables accept inserts. | No delete path. |
| `SemanticSearchSettings.test.ts` | unit | The off flow needs the modal; Cancel keeps it on; the off state shows Delete index; indexing shows the progress bar and pause; the summaries match. | New. |
| `SearchContentSemanticOff.test.ts` | unit | With state `off`: the description has no "Set semantic=true for AI-powered" pitch; `semantic=true` returns success, keyword results and the note. With state `available` and not initialized: "still initializing". | Misleading error today (`:321-322`). |
| `SettingsSyncEmbeddingsHotApply.test.ts` | unit | A synced `enableEmbeddings` change returns `requiresReload === false` and triggers hot-apply. | It requires a reload today. |
| `shippedGuidanceCommands` / `ToolManagerCliSyntax` | existing | Stay green after the catalog regenerates (`fix-shipped-docs-drift.md` if not). | — |

### In-app verification

1. In a test vault with notes, open Defaults → Semantic search. Check the status counts against `obsidian eval "app.plugins.plugins.nexus.embeddingManager.getStats().then(JSON.stringify)"`.
2. Turn it off and confirm the modal copy. After confirming: the status bar item has gone and `getService()` is null, all without a restart.
3. Run `nexus ... -- search content "x" --semantic`. Expect success, keyword results and the note.
4. Delete two notes, turn search on, and confirm their `embedding_metadata` rows are gone (eval query) and only changed notes are re-indexed (progress total).
5. Turn it off and click Delete index. Table counts read 0. Turn it on and a full re-index runs.
6. Escalate to disable/enable the plugin (`live-loop.md` step 4) to confirm no orphan intervals or commands remain (`app.commands.commands`).

### Acceptance

The semantic fold states match the mockup's "On, indexed / On, indexing / Turning off (confirm) / Off" states. Hot-apply takes effect with no restart. The tool no longer claims it is "initializing" when search is turned off.

---

## Phase 5 — Follow-ups (not core)

- One-click **"Add to"** install links in the Other agents card:
  - Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=<key>&config=<base64 JSON>`
  - VS Code / Copilot: `vscode:mcp/install?<urlencoded JSON>` or `code --add-mcp`
  - LM Studio: `lmstudio://add_mcp`. **Check the spelling against LM Studio docs**; it is unconfirmed here.
  - Windsurf: write `~/.codeium/windsurf/mcp_config.json`.

  Each needs the same Node.js gate and an absolute-path entry.
- Temperature range 0–2 for providers that accept it (Bug 8). This needs a per-provider maximum on `ModelSpec`.
- Web search as a default (Bug 7), if wanted.
- Migrate `DataTab` off `csr-section`, so the remaining `csr-*` CSS can be deleted.
- Decide whether Defaults should keep pushing context-window changes to the active chat (open question 3).

---

## Appendix A — Copy lifted from the mockup

Hold these as constants in `src/components/shared/chatSettings/copy.ts` and `src/settings/getStarted/copy.ts`. Tests import the constants and never point at the mockup.

**Defaults and Chat settings**
- Creativity: "Lower is more focused, higher is more creative." / disabled: "`<Model>` sets its own temperature." Readout "—".
- Context window: "Older messages are summarized past this size." Readout examples "32K", "200K", "1M"; `aria-valuetext` "`<n>` tokens".
- Web search (chat only): "Let the model search the web when needed."
- Workflow (chat only): "Loads its instructions and tools. Steps run only when you ask."
- Context notes: button "Add note"; remove tooltip "Remove `<name>`".
- Subagents note row: name "Used for", description "Subagents, saved prompts and automations. Must be a cloud model."
- Voice: subheads "Transcription", "Read aloud", "Live voice".
  - Transcription Provider description: "Chat microphone and audio files."
  - "Saved audio folder" (Defaults only): "Inside the Nexus data folder."
  - Live voice with none available: "None of your providers offer live voice."
- File conversion:
  - "PDF import": "Drop PDFs into chat to turn them into notes."
  - "Reading method": "Text is free. Vision reads scanned pages with a model." Options "Text extraction", "Vision".
  - "Vision provider", "Vision model".
  - "Convert new PDFs automatically": "Adds a Markdown note next to each PDF added to the vault."
- Summaries:
  - Chat options: "Creativity 0.5 · 1M context" or "Fixed temperature · 1M context"; chat adds " · Web search on|off".
  - Context: "`<workspace>`|No workspace · `<prompt>`|No prompt · N notes".
  - Subagents: "`<model>` · Thinking off|`<Level>` thinking · `<tuning>`".
  - Images: "`<model>`".
  - Video: "`<model>` · `<ratio>` · `<resolution>`".
  - Voice: "`<transcription model>` · `<read-aloud model>` (`<voice>`)".
  - File conversion: "PDF import on · `<method>`[ · auto-convert]" / "PDF import off".
  - Semantic: "On · N notes" / "Indexing · P%" / "Off · index kept".
- Semantic search:
  - Toggle: "Semantic search" — "Find notes and past chats by meaning, not just exact words. Runs on this device."
  - On: "Index" — "Kept up to date as notes and chats change." value "N notes · M chats".
  - Indexing: "Indexing" — "About N minutes left. You can keep working." value "x / y"; "Pause indexing".
  - Off: "Index" — "Kept on this device, so turning search back on only re-indexes notes that changed." value "Paused · N notes".
  - "Delete index" — "Frees the space it uses. Turning search back on re-indexes the whole vault." Button "Delete index".
- Off modal: title "Turn off semantic search?"; "Nexus will match exact words only."; bullets "Vault search falls back to keyword matching, and agents stop being offered semantic search." / "Searching past chats by meaning stops working." / "Note suggestions in chat use file names only."; muted "Your index stays on this device, so turning it back on is quick."; buttons "Cancel", "Turn off".

**Get started**
- Row: "Get started" — "Set up chat in Obsidian, or connect Claude Desktop, Codex and other agents."
- Intro lede: "Nexus is an assistant that lives in your vault. It reads and writes your notes, searches them, and remembers context between conversations. Your data stays in your vault."
- Capabilities, each with its icon:
  - pencil-line: "Read, create and edit notes"
  - search: "Search by keyword or by meaning"
  - layers: "Remember context with workspaces"
  - folder: "Organize files and folders"
  - bot: "Run saved prompts and subagents"
  - wifi-off: "Work offline with local models"
- "Choose your setup" / "Pick one, or use both."
- "Chat inside Obsidian" — "Connect a model provider and chat in a side panel." (value "Ready").
- "Connect an external agent" — "Claude Desktop, Codex, Cursor and more use your vault." (value "N connected").
- Chat page:
  1. "Connect a model provider" — "An API key, a sign-in, or a local model such as Ollama." Status "Connected", button "Open providers".
  2. "Open the chat" — "From the ribbon icon or the “Nexus: Open chat” command." Button "Open chat".
  3. "Start chatting" — "Ask about your notes. Nexus can read, search and edit them."
- Agents page:
  - Lede "Let apps outside Obsidian use your vault through Nexus."
  - Node.js found: "Runs the connector. Found `<version>` at `<path>`." status "Found".
  - Node.js missing: "Every agent connection runs through Node.js, and it isn’t installed or Nexus can’t find it. Install it, then check again." Buttons "Install Node.js", "Check again". Blocked status "Needs Node.js".
  - "Other agents" — "Cursor, Cline, Copilot, Windsurf and others. Four steps."
  - Steps:
    1. "Create the connector file" — "connector.js lets the app talk to this vault. It goes in the Nexus plugin folder." Button "Create"; status "Created".
    2. "Copy the config" — "The Nexus entry for the app’s MCP settings, with this computer’s paths." Button "Copy config". Missing Node: "Install Node.js first. The config needs its location."
    3. "Add it to your app" — "Paste it into the app’s MCP settings yourself, or paste this prompt into the agent and let it make the change." Button "Copy prompt". Prompt: "Add an MCP server to your configuration. Name: `<key>`. Command: `<node>`. Args: ["`<connector>`"]. Use these paths exactly. Merge it into the existing mcpServers and keep any servers already there. Then tell me where you saved it." Missing Node: "Install Node.js first."
    4. "Restart the app" — "Quit and reopen it so it loads Nexus. Then ask it to list your vault’s folders to check."
  - "Command line" — "Lets Claude Code, Cursor and Codex use Nexus without MCP." Status "Not installed", button "Install". Child toggles "Claude Code skills", "Cursor skills", "Codex AGENTS.md" with their paths.

In the prompt, `<connector>` must be JSON-escaped (build it with `JSON.stringify(path)`), because the mockup's template literal would not escape Windows backslashes inside `[" "]`.

## Risks

- **Fixing `embeddingService` changes live behaviour.** `[[` suggestions switch from fuzzy to semantic-first (`noteSearch.ts:24-33`). Semantic ranking can be worse for a typed filename prefix. Check this in the app. If it regresses, put exact and prefix basename matches ahead of semantic hits. Conversation memory search starts returning results, which changes agent behaviour.
- **Subagent precedence is a behaviour change** for anyone who has set a subagent model: subagents move from the chat model to that model. Call it out in the changelog.
- **Hot-apply teardown order.** Stopping must await the in-flight indexing phase before disposing the engine, the same constraint `shutdown()` documents at `:178-195`. A race leaves a write after the DB is closed. `deleteIndex()` while disabled avoids racing with the queue.
- **Settings in a separate window.** `live-loop.md` notes that `document` targets the main window. DOM assertions must go through the setting tab's `containerEl`.
- **The `Setting` mock does not render.** Order assertions need the mock change in Phase 1. Until then a green test proves nothing about order (`mock-honesty.md`).
- **The `minAppVersion` bump** strands 1.10 users on 5.20.x. This is acceptable but must be noted in the release.
- **Tool description churn.** Agents connected over MCP cache `getTools` results, so a runtime description change reaches them only on their next discovery.

## Owner decisions (2026-10-14)

These answer the former open questions. They override the Decisions table above wherever the two disagree.

1. **Subagent default.** When no subagent model is set, subagents keep using the chat model if it is a cloud model (as proposed).
2. **Chat modal context window applies to this conversation only.** This reverses PR #410's save-to-defaults. Confirmed.
3. **Changing Defaults does not change the open chat.** Remove the Defaults → active chat context push (`applyContextWindowDefault`) and update its tests. Defaults apply to new chats only. *This overrides the Decisions table's "Keep".*
4. **The toggle is labelled "File import"**, with the description "Drop PDFs or audio into chat to turn them into notes.", because `enableIngestion` gates audio as well. The fold is still called "File conversion".
5. **`enableEmbeddings` stays synced** (hot-applied). The index stays per device.
6. **Delete index asks for confirmation** in an Obsidian `Modal`: title "Delete the search index?", buttons Cancel / Delete (mod-warning). It deletes vectors only and keeps the learned retrieval adapter (`AdapterStore`). *This overrides the Decisions table's "no second confirmation".*
7. **Get started opens automatically** on the first `display()` of each session while nothing is configured (as proposed).
8. **The Thinking dropdown hides levels the model or provider does not support.** If no capability data exists, show all six.

## Could not confirm

- **Antigravity config path and reload.** Antigravity's MCP docs (fetched 2026-10-14) list the global config as `~/.gemini/config/mcp_config.json` (workspace: `.agents/mcp_config.json`) with `mcpServers {command, args, env}`. Reload is `/mcp` in the CLI or Refresh in the app. I have not confirmed this against an installed Antigravity. It remains **must-verify** on a machine that has it, along with whether older builds read `~/.gemini/antigravity/mcp_config.json` and whether the desktop app manages servers only through its own Settings UI. If both paths exist, write the one the installed build reads, and do not write both.
- **The native slider value label** in Obsidian 1.13 (the cause of "High 2" and "1,000,000 tokens 1000000"). Phase 1 step 1a settles it. I did not run `obsidian eval` against the owner's vaults.
- **Whether `ToolCliNormalizer` rejects a flag missing from the schema.** This decides whether `semantic` could ever be removed rather than re-described. Check it in the nexus-agents verify step.
- **The LM Studio deep-link spelling** (`lmstudio://add_mcp`) and the other Phase 5 link formats.
- **Whether every thinking-capable adapter ignores `enableThinking` for non-thinking models.** Only Anthropic was checked. The new gate makes this moot for requests built by Nexus.
- **Whether the conversation `chatSettings` JSONL payload keeps unknown fields** through a cache rebuild (Phase 2 keys). Check with `nexus-storage` `persist-new-data.md` before relying on it.

## Analysis completion

Analysis only. No production files, styles, tests, the running plugin or any vault were changed or exercised. The file counts below are planned, not executed.

| Phase | New | Modified | Deleted |
|---|---|---|---|
| 0 | 1 | ~15 | 1 |
| 1 | 9 | ~8 | 0 |
| 2 | 3 | ~16 | 0 |
| 3 | 6 | ~12 | 1 |
| 4 | 1 | ~14 | 0 (plus regenerated catalogs) |

Tests and `styles.css` are not counted.
