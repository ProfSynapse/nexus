# OpenAI-compatible provider — issue #400

> Updated: October 7, 2026
> Status: Generic connection implemented and verified locally. Hermes-specific progress, remote jobs and subagent schema changes are excluded from this pass.
> Visual contract: [OpenAI-compatible provider](../mockups/openai-compatible-provider.html), simplified revision accepted October 7, 2026 with the instruction to start with JUST the generic connection.

## Product contract

Treat the endpoint as an ordinary inference provider. Nexus sends the conversation and the tools available under the chat's existing policy. The endpoint returns assistant text, standard tool calls, or both. Nexus displays text, executes valid tool calls through its existing executor, appends tool results, and requests the next response. This is the same agent loop used by other providers.

The server may host a plain model or an agent that does additional work before returning. Nexus does not classify it or orchestrate its internal tools. Its internals are irrelevant to the client as long as the endpoint implements the expected Chat Completions contract. Returning a standard client tool call lets Nexus execute that tool; server-owned tool events are not executable Nexus calls. A separate MCP/CLI connection is unnecessary for this client tool loop and is not automatically configured for the server's own environment.

Compatibility is partial in practice. The Hermes Chat Completions implementation reviewed below runs its own agent and returns the answer, but does not pass supplied client tools into that run or preserve incoming tool messages. Treat chatting with Hermes as distinct from verified Nexus tool calling. No connection-type setting can create missing server support.

User setup contains only:

- Multiple named endpoints, each independently enabled or disabled.
- Endpoint name, API base URL, optional API key.
- Connect to discover models; enable models for the usual picker.
- Manual model ID entry when discovery is unavailable or incomplete.

Use normal provider defaults. There is no connection type, tools permission switch, advanced connection section, or per-model capability, reasoning, streaming, timeout, token, or price editor. Existing chat settings continue to apply through the normal provider path. Do not replace removed controls with a new configuration questionnaire.

The same endpoint/model pair can power direct chat, prompt execution, or a subagent. No Hermes-specific protocol, proxy, MCP bridge, remote model management, OAuth, or new agent runtime is part of this feature.

## Existing code and integration seams

| Verified source | Required change |
|---|---|
| `src/services/llm/providers/ProviderDriver.ts`, `ProviderDriverRegistry.ts` | Reuse the driver/instance separation for several instances of one driver. |
| `src/services/llm/core/AdapterRegistry.ts:158` | Bootstrap configured instances instead of assuming one instance per builtin driver. |
| `src/types/llm/ProviderTypes.ts` | Add driver kind and minimal endpoint configuration; retain existing selection fields. |
| `src/services/secrets/SettingsSecrets.ts:67` | Reuse credentials keyed by provider instance; verify explicit key clearing survives hydration. |
| `src/services/llm/adapters/BaseAdapter.ts:545,861` | Avoid shared response caching and preserve instance identity in response attribution. |
| `src/services/llm/providers/ProviderManager.ts`, `src/ui/chat/utils/ModelSelectionUtility.ts`, `src/components/shared/ChatSettingsRenderer.ts` | Include configured instances and their models, including no-key endpoints; avoid fixed provider lists/static catalogs excluding them. |
| `src/services/llm/core/StreamingOrchestrator.ts`, `ToolContinuationService.ts` | Use the existing tool loop, with normal validation, cancellation, iteration limits and execution receipts. |
| `src/services/llm/adapters/shared/ProviderHttpClient.ts:71,272` | Preserve HTTPS policy and account for buffered mobile transport and current cancellation gaps. |
| `src/agents/promptManager/tools/subagent.ts:181,214` | Public tool inherits parent provider/model; optional targeting is deferred. |

These observations describe the researched checkout; verify symbols before implementation. Follow the repository's adapter, mobile, tools/schema, testing, and UI skills for the corresponding changes. No new SDK is required.

## Identity, configuration, and persistence

Use `openai-compatible` as the driver kind. Each saved endpoint gets a generated stable ID such as `openai-compatible-<uuid>`, stored as an entry in `settings.providers`. Keep top-level API key and enabled state in the existing provider configuration. Add a small typed subtree:

```typescript
interface OpenAICompatibleEndpointConfig {
  schemaVersion: 1;
  displayName: string;
  baseUrl: string;
  models: Record<string, {
    source: 'discovered' | 'manual';
  }>;
}
```

Use the existing per-model enabled configuration rather than introducing a second enabled flag. Discovery currently persists model IDs and provenance only; richer metadata is deferred. Do not persist behavior toggles removed from the UI.

Resolve `driverKind ?? instanceId` at bootstrap so existing builtin entries retain their identities. Selections remain `{ provider: instanceId, model: modelId }`; mutable display names and driver kinds are not routing keys. Responses, costs, events, saved selections and subagent branches must retain the selected instance ID. Two endpoints offering the same model ID must remain independent.

Use existing secret storage per instance. Renaming preserves the key; clearing the API key must clear its stored secret so hydration cannot restore it. Disable/re-enable preserves configuration and historical selections. An unavailable explicit endpoint must fail visibly, never fall back to another server with the same model ID. Permanent removal UI is outside this draft.

Persist discovered/manual model IDs so restart or temporary server failure does not empty the picker. Preserve model enable choices on refresh. Save valid edits through an awaited persistence path; close flushes pending edits, and failed saves retain visible feedback. Discovery and active requests capture configuration revisions so stale results cannot overwrite newer URL/key edits or mix an old request with new credentials.

## URL, discovery, and transport

The user enters an exact API base prefix. Preserve its path and append `/models` or `/chat/completions`; never insert `/v1` implicitly. For example, `https://host.example/proxy/v1` becomes `https://host.example/proxy/v1/chat/completions`.

Validate absolute HTTP(S), reject embedded credentials, query strings, fragments, and suffixes `/models`, `/completions`, or `/chat/completions`. Preserve the shared transport policy: HTTPS for remote hosts; HTTP only for localhost/127.0.0.1/::1. A phone's localhost is the phone. Do not forward authorization across origins on redirects or weaken certificate validation.

Send a Bearer header only when a key is present. Use no fabricated placeholder credential. Connect performs model discovery only, with a fixed internal 30-second deadline. A received model list is not proof of generation compatibility. Save/Connect must not trigger hidden generation requests. Manual IDs remain usable when `/models` is missing; the first actual chat exercises the route and model.

The portable discovery shape is `{ object: 'list', data: [{ id: string, ... }] }`. Validate the data array and nonempty IDs; treat IDs as opaque strings, including slashes, colons and case. Deduplicate exact IDs without rewriting them or filtering by familiar model prefixes. Extra fields are optional metadata, not a universal capability contract. Retain saved/manual entries and enable choices across refreshes. Distinguish invalid credentials (401/403), an unavailable discovery route (404/405), an empty list, and an unreachable server; manual entry must not turn an authentication failure into a successful connection claim. Use the same current endpoint credentials for discovery and inference.

Implement a small `OpenAICompatibleAdapter` using the existing shared HTTP/message/SSE helpers. Do not subclass the Responses-specific OpenAI adapter or import LM Studio's model-loading behavior. The baseline body is `{ model, messages, stream }`, plus normal applicable generation settings and tool schemas from the caller. Preserve standard assistant/tool history and avoid duplicating the latest user message.

Use standard function calling by default when the normal Nexus caller supplies tools. Route returned calls through the same validation/executor/continuation path as other providers. No new provider-specific permission boundary or forced text-only prompt. Respect existing tool restrictions, selected toolsets, stop behavior and iteration limits.

Parse text, standard `tool_calls`, usage and returned reasoning through the existing response/display channels. Do not interpret server-internal tool events or ordinary prose as tool calls. Do not send vendor-specific thinking flags merely because returned reasoning is supported.

Audit shared helpers before reuse: decode UTF-8 across transport chunk boundaries; accumulate interleaved tool argument fragments; recognize error frames even with HTTP 200; preserve trailing usage after finish reasons; and reject incomplete streams instead of synthesizing success at EOF. Preserve assistant text alongside its tool calls when replaying history. Returned reasoning may be displayed without blindly replaying vendor-specific fields. Request only the standard fields needed by the caller; do not assume support for Responses API fields, strict schemas, parallel-tool controls, or stream-usage options.

Desktop requests stream normally. If a streaming request receives a complete JSON response, normalize that same response without issuing another POST. Mobile uses the available buffered transport. Use a fixed internal overall generation deadline of 600 seconds, propagate stop signals, and release listeners/timers. Where `requestUrl` cannot abort the network operation, settle local cancellation promptly and ignore late results; the server may continue work.

No automatic POST retries, dialect rewrites or provider fallback. A server that rejects the expected standard request gets an actionable error. Do not silently remove tools and replay a request. Disable response caching for this adapter so agent-backed requests are neither skipped nor shared between endpoints. Discovery snapshots may still be persisted.

## Internal model defaults

Model discovery commonly gives IDs without reliable limits or prices. Keep this uncertainty in the implementation rather than exposing a capability setup panel.

Use one internal metadata resolver keyed by endpoint and model. Accept only validated, documented server metadata with the correct meaning: for example, vLLM's `max_model_len` describes its configured limit, whereas llama.cpp's `meta.n_ctx_train` describes training context, not necessarily the allocated runtime context. Otherwise use an internal budget assumption of 4096 context tokens and 1024 maximum output tokens. These are heuristics, not guaranteed server limits; the tested Ollama process itself reported a 4096-token runtime context. Keep fallback budgeting consistent across dropdowns, pre-send budgeting and compaction rather than inheriting an unrelated static 128K fallback. Output budgeting does not require sending a token-limit field unless normal generation settings request one.

The generic contract supports standard text and tool calling and prefers streaming. Optional image/structured-output capabilities use reliable metadata or existing established capability rules; do not invent support from model names. Unsupported requests fail visibly. Reasoning display follows the normal chat path, with no endpoint-specific control.

Unknown pricing remains unknown, not zero. Preserve token usage and adapt touched cost consumers to tolerate missing prices without inventing a custom pricing editor. Keep this change narrow; existing known-price providers retain their behavior.

## Direct chat and delegation

All routes resolve the same stable endpoint/model pair:

- Direct chat uses the usual model picker and `LLMService`.
- `prompt execute` already supports provider/model for request/reply delegation.
- Existing subagent inheritance continues to work. Exposing optional provider/model on `prompt sub` is deferred; it is not part of this generic-connection pass.

Deferred subagent proposal: for `prompt sub`, omission inherits the parent's pair; both supplied validates that exact pair; model-only uses the parent provider. Provider-only can use an existing saved default belonging to that provider or its sole enabled model; when ambiguous, return a request for the model ID. Never combine a supplied provider with another provider's model. Validate before branch creation and persist the resolved pair. Add friendly endpoint names to `prompt list-models` alongside stable execution IDs, preserving its existing result fields, and regenerate public tool schemas/catalogs.

A separate pre-existing continuation issue was found: `SubagentExecutor.executeSubagent` currently creates a new branch without consuming `continueBranchId`. Repairing actual same-branch continuation is an adjacent follow-up, not a prerequisite for generic endpoint inference. Do not claim continuation is fixed by exposing provider/model. Until repaired, reject continuation requests carrying a selection override instead of silently retargeting them. A future repair must use persisted branch selection/history and prevent a changed parent model from switching the resumed target.

## Implementation and verification

A [live Ollama protocol spike](../../scripts/smoke-openai-compatible.mjs)
passed all six checks on October 7: discovery, buffered/SSE text, buffered/SSE
tool-result round trips, and invalid-model HTTP errors. Standard requests with
an installed model worked without vendor-specific generation fields. This initially established the endpoint contract; the implementation verification below also exercises Nexus integration.

1. Implement minimal config, stable instance bootstrap, credentials, persisted discovery/manual models, and internal metadata defaults.
2. Add the Chat Completions adapter and integrate existing request/response/tool execution paths. Wire instance IDs through selection and attribution.
3. Implement the reviewed setup UI. Leave subagent tool schemas unchanged.
4. Run focused tests, build, adapter stream-error checks, and mobile reachability checks. Verify real endpoints separately from mockup behavior.

Meaningful checks cover:

- Two endpoints with identical model IDs and different URLs/keys; rename/restart/disable retain identity.
- Exact path joining, optional auth, explicit secret clearing, discovery failure/manual models and stale discovery results.
- Normal text and function-call responses; tool results reach the correct endpoint, with existing permissions/receipts/stop behavior intact.
- SSE fragments, streamed error frames, JSON returned to a stream request, empty/malformed/truncated responses, and no duplicate POST.
- Cancellation/deadline/disposal, mobile late response suppression, and no response cache reuse.
- Internal context fallback and unknown cost handling without new setup controls.
- Existing direct-chat and prompt execution paths retain endpoint identity; subagents inherit through their existing path.
- Save failure and close-flush behavior; desktop/mobile layout and normal theme/accessibility rules.

Live acceptance should include an unauthenticated compatible server, an authenticated HTTPS endpoint with a custom prefix, a tool-calling endpoint, discovery-unavailable/manual models, and actual mobile buffered chat. Report untested compatibility honestly. The standalone mock simulates connections and saves; it proves the setup flow, not endpoint interoperability.

## Endpoint research — October 7, 2026

The practical shared surface is `GET /models` and `POST /chat/completions`, relative to the configured API base (commonly ending in `/v1`). OpenAI's model-list schema supplies identifiers and basic ownership/creation metadata, not a portable description of context limits, pricing or tool support. There is no capability endpoint shared by all the servers reviewed. Start with Chat Completions; broader support for Responses or server-native management routes is outside this feature. [OpenAI model-list reference](https://developers.openai.com/api/reference/resources/models/methods/list)

| Server | Discovery and compatibility findings |
|---|---|
| Ollama | `/v1/models` and Chat Completions are documented. Our local spike verified text, SSE and client tool-result round trips. Discovery alone does not supply the runtime context budget. [Official compatibility documentation](https://docs.ollama.com/api/openai-compatibility) |
| LM Studio | `/v1/models` lists visible models; with just-in-time loading it can include downloaded models that are not loaded. Do not describe every listed model as running. [Official models documentation](https://lmstudio.ai/docs/developer/openai-compat/models) |
| vLLM | `/v1/models` is available; its implementation additionally emits `max_model_len`. Automatic tool calling depends on server flags, a suitable parser and sometimes the chat template. These are server responsibilities, not Nexus setup controls. [Serving documentation](https://docs.vllm.ai/en/latest/serving/online_serving/), [model-list source](https://github.com/vllm-project/vllm/blob/main/vllm/entrypoints/openai/models/serving.py), [tool-calling documentation](https://docs.vllm.ai/en/stable/features/tool_calling/) |
| llama.cpp | `/v1/models` exposes served model IDs/aliases, with extensions that vary by server mode. Training-context metadata is not proof of allocated context. Tool calling depends on the server's template support. [Official server documentation](https://github.com/ggml-org/llama.cpp/tree/master/tools/server) |
| LiteLLM | `/v1/models` can be filtered by the API key. A model configured as undiscoverable can still be callable, so keep manual entry even after successful discovery. Rich `/model/info` metadata is a native extension. [Model access](https://docs.litellm.ai/docs/proxy/model_access), [model management](https://docs.litellm.ai/docs/proxy/model_management) |
| Hermes | `/v1/models` advertises the agent/profile alias rather than every upstream model. Its native capabilities/options routes are not universal. Preserve profile URL prefixes. Its documented stream can include internal tool-progress events, which must never be executed as client calls. [API server documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/) |

Hermes source verification: at revision `6fa88c19ac1dedbecd9809873b8c2cbea9ae0522`, the chat handler keeps system/user/assistant content, discards tool-role history and assistant tool-call structure, and constructs agent run arguments without client-supplied function definitions. This supports text/agent delegation but does not establish the client function-call contract Nexus needs. This was source review, not a live Hermes test. [Pinned chat handler](https://github.com/NousResearch/hermes-agent/blob/6fa88c19ac1dedbecd9809873b8c2cbea9ae0522/gateway/platforms/api_server_openai_routes.py#L636-L740), [pinned agent override selection](https://github.com/NousResearch/hermes-agent/blob/6fa88c19ac1dedbecd9809873b8c2cbea9ae0522/gateway/platforms/api_server.py#L333-L355)

Only Ollama was exercised live. The other entries record documentation/source evidence, not blanket claims of tested compatibility. Endpoint support and actual model behavior must be verified separately.

Follow-up Hermes trace: its capabilities handler explicitly reports `runtime.mode: 'server_agent'`, `tool_execution: 'server'`, and `split_runtime: false`. Agent construction selects the configured `api_server` toolsets; `_run_agent` invokes `AIAgent.run_conversation`, whose tool executor runs calls internally. Chat SSE exposes `hermes.tool.progress` notifications, not a standard client tool-call handoff. Supporting that handoff upstream would require registering request-supplied external tool schemas, yielding those calls before local execution, and accepting their tool results on continuation; changing response serialization alone would not suffice. Prompting the agent to emit textual commands and parsing them in Nexus is a different, untested protocol, not evidence of native function calling. [Capabilities and agent construction](https://github.com/NousResearch/hermes-agent/blob/6fa88c19ac1dedbecd9809873b8c2cbea9ae0522/gateway/platforms/api_server.py#L2340-L2523), [SSE serialization](https://github.com/NousResearch/hermes-agent/blob/6fa88c19ac1dedbecd9809873b8c2cbea9ae0522/gateway/platforms/api_server_openai_routes.py#L888-L922), [internal execution](https://github.com/NousResearch/hermes-agent/blob/6fa88c19ac1dedbecd9809873b8c2cbea9ae0522/run_agent.py#L1303-L1328)

## Implementation verification — October 7, 2026

Implemented the generic provider, multiple persisted instances, discovery/manual
models, optional credentials, normal model selection, and the reviewed settings
flow. Standard returned function calls use the existing Nexus executor and tool
result continuation. Remote-agent-specific events and new subagent selection
arguments remain deferred.

- Production build passed (lint, mobile reachability, TypeScript and bundles).
- The full Jest run passed apart from three socket-binding suites blocked by
  sandbox permissions; all three passed when rerun with those permissions.
  Focused provider, selector, credential, save-race and continuation regressions
  passed. Targeted fault injections made regression tests fail before restoration.
- Live Ollama checks passed for buffered/SSE text, tool-result replay, invalid
  model errors, midstream errors and cancellation. The latter two use real HTTP
  fixture servers to make failure deterministic.
- In the user-authorized Code vault, native settings UI connected to local
  Ollama, discovered both installed models, and saved the endpoint. Reload
  preserved its stable ID, model catalog and enabled state. Default selections
  were not changed.
- Two real in-app LLMService roundtrips, separated by plugin reload, passed:
  the model requested `getTools` for `content read`, the real Nexus executor
  returned its schema, and the model answered with the required flags. The
  probe permitted discovery only; no notes were read or modified.
- Actual mobile use and an authenticated remote HTTPS endpoint with a custom
  prefix remain unverified live. Unit coverage and startup-import checks do
  not substitute for those checks. Hermes has not been run live.

The repeatable opt-in integration test is
`tests/debug/openai-compatible-app-live.test.ts`; its header documents the
explicit vault, endpoint ID and model parameters. It runs against an already
installed build and permits only `getTools` discovery. The adapter-level lane
is `tests/debug/openai-compatible-live.test.ts`.

The installed build was only temporarily replaced for verification; the source
implementation remains in this worktree. The disposable connection was removed, the previous installed files were
restored and hash-verified, and the original plugin reloaded successfully. The
temporary Ollama server was stopped. The saved in-app test also passed against
the temporary build before cleanup.
