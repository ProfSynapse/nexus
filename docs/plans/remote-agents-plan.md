# Remote agents through subagents

Date: 2026-10-07
Status: Implemented; contract-fixture and real Hermes/Ollama app tests pass; ready for review

## Agreed behavior

Keep OpenAI-compatible inference as shipped. Add multiple named remote agent
connections, beginning with Hermes and leaving a connector interface for OpenClaw.
These are general-purpose agents with their own tools and environment. Nexus sends
a self-contained task, stores a durable job, and puts the eventual answer into the
originating chat. It does not mirror the remote agent's internal tool calls.

The existing subagent command gains an optional target. Omission keeps local
subagent behavior. Connected remote agents appear in the system prompt with their
name, stable target ID, optional description, and delegation instructions. No URL,
credential, or unavailable agent is advertised. Remote tasks receive only explicit
task/context; they do not inherit Nexus tools, system instructions, or vault access.

## File-by-file implementation

| File | Change |
| --- | --- |
| `src/services/remoteAgents/types.ts` | Connection, connector, request, health and remote run contracts. |
| `src/services/remoteAgents/HermesConnector.ts` | Authenticated, bounded Runs API submit/status/stop/probe; idempotent submission; safe URL validation and sanitized errors. |
| `src/services/remoteAgents/RemoteAgentConnectionRegistry.ts` | Settings-backed connections and current capability/health discovery; invalidation after settings changes. |
| `src/database/repositories/RemoteAgentJobRepository.ts`, `src/database/interfaces/IStorageAdapter.ts`, `src/database/adapters/HybridStorageAdapter.ts` | Durable jobs in branch conversation metadata through the existing JSONL-first repository path; paginated recovery; deterministic result message IDs. |
| `src/services/remoteAgents/RemoteAgentJobService.ts` | Plugin-owned dispatch, polling, cancellation intent, recovery and durable result delivery. Persist before submission and before delivery. |
| `src/core/services/ServiceDefinitions.ts` | Register the registry and job service with storage/agent dependencies. |
| `src/core/background/BackgroundProcessor.ts` | Start recovery after startup; cancel deferred startup and fence/drain in-flight work on unload. |
| `src/core/PluginLifecycleManager.ts`, `src/core/ServiceManager.ts`, `src/core/services/ServiceRegistrar.ts` | Stop remote timers immediately on unload, clean lazy services before storage closes, and prevent deferred initialization after shutdown. |
| `tests/unit/BackgroundProcessor.shutdown.test.ts`, `ServiceManager.shutdown.test.ts`, `PluginLifecycleManager.shutdown.test.ts` | Exercise deferred-start races, lazy cleanup, dependency order, slow embedding shutdown and a failed state save. |
| `src/types/plugin/PluginTypes.ts`, `src/types.ts`, `src/types/index.ts` | Optional remote connection settings and defaults. |
| `src/services/secrets/SettingsSecrets.ts`, `SecretStore.ts` | Store remote credentials through the existing secret handling mechanism, including explicit removal. |
| `src/settings/SettingsRouter.ts`, `src/settings/SettingsView.ts` | Mount Remote agents settings separately from inference providers. |
| `src/settings/tabs/RemoteAgentsTab.ts` | Multiple connections, availability, edit/add actions. |
| `src/settings/remoteAgents/RemoteAgentModal.ts`, `RemoteAgentEditSession.ts` | Name, Hermes connector, base URL, optional key and description; connection check, serialized autosave and save-error recovery. |
| `docs/mockups/remote-agents.html`, `.css`, `.js` | Standalone mockup of the existing settings idiom, including mobile, empty and error states, before production UI changes. |
| `styles.css` | Theme-aware settings styles using Obsidian variables. |
| `src/agents/promptManager/tools/subagent.ts` | Optional target/context arguments, runtime validation, dispatch to remote jobs, accurate asynchronous result guidance. |
| `src/agents/promptManager/promptManager.ts` | Wire the remote dispatcher independently of the local executor. |
| `src/types/branch/BranchTypes.ts` | Remote target/status information where required without changing local branch semantics. |
| `src/ui/chat/services/SystemPromptBuilder.ts`, `ModelAgentManager.ts`, `ModelAgentPromptContextAssembler.ts` | Add the connected-agent section from the live registry at prompt composition time. |
| `src/ui/chat/controllers/SubagentController.ts`, `src/ui/chat/services/ChatSubagentIntegration.ts`, `src/ui/chat/ChatView.ts` | Subscribe to job updates; attach remote status/cancellation to existing subagent UI; detach subscriptions when the view closes and defer refresh until active streaming finishes. |
| `src/ui/chat/components/AgentStatusMenu.ts`, `AgentStatusModal.ts` | Support combined local/remote status through a small structural interface. |
| `src/agents/toolManager/services/ToolBatchExecutionService.ts` | Pass trusted execution identity to delegation so switching chats cannot redirect a job. |
| `tests/unit/remoteAgents/*.test.ts` | Connector contract, health gating, persist-before-submit, restart recovery, ambiguous submission, cancellation, endpoint changes, duplicate prevention and delivery failures. |
| `tests/unit/RemoteAgent*.test.ts`, prompt/subagent tests | Settings save/secret behavior, conditional prompt discovery, tool dispatch and unchanged local behavior. |
| `src/services/ConversationService.ts`, `src/utils/remoteAgentMessages.ts`, `src/ui/chat/services/MessageAlternativeService.ts` | Preserve independently delivered remote answers across stale chat snapshot saves and local-response retries. |
| `tests/unit/dual-backend-characterization.test.ts`, `tests/unit/MessageAlternativeService.test.ts` | Regression barriers for late remote delivery and retry continuation movement. |
| `src/database/repositories/MessageRepository.ts`, `src/database/interfaces/StorageEvents.ts`, `src/database/sync/ConversationEventApplier.ts` | Persist message metadata on creation, notify observers with it, and restore it during replay. |
| `tests/unit/MessageRepository.test.ts`, `tests/unit/ConversationEventApplier.test.ts` | Verify metadata event/cache/observer/replay behavior and older events without metadata. |
| `src/database/schema/schema.ts`, `src/database/schema/SchemaMigrator.ts`, `tests/unit/SchemaMigrator.test.ts` | Add nullable message metadata in schema v18 on upgrade and fresh installs. |
| Generated tool catalogs | Regenerate from source after adding target/context arguments. |

## Reliability boundaries

- Store the job, originating conversation/message, exact request, target identity
  and idempotency key before contacting Hermes. Never store credentials in jobs.
- Keep remote run identity after submission. A timeout or disconnect is not proof
  that the server rejected the task. Retry only with the same key within the
  server's documented retention; otherwise require attention instead of creating
  a second task.
- Record result before delivery. Use stable branch and parent message IDs and
  check persistence before adding, so restart recovery cannot duplicate answers.
- Closing a view detaches UI only. Plugin restart resumes polling; phone suspension
  delays collection until Nexus runs again. Remote server execution durability is
  limited by the server's own guarantees.
- Connection failure hides an agent from new delegation but retains existing
  jobs. A changed endpoint must not redirect an existing job to another server.
- Remote approval requests appear as attention states; Nexus does not approve
  them automatically. Stop is explicit, persisted and retried safely.
- Result delivery is durable. A follow-up parent inference is a separate action;
  it must not cause duplicate answers or switch silently to a global default.
- Do not claim cross-device exactly-once execution from a local database lock.
  Hermes idempotency and stable delivery identity handle retries; synced-device
  behavior needs explicit verification before advertising stronger guarantees.

## Validation and ownership

1. Connector owner: Hermes API/source research, connector/registry and contract tests.
2. Storage owner: repository/job service and recovery tests.
3. UI owner: validated mockup, settings and settings tests.
4. Root: plan, prompt/tool/lifecycle/status integration, credential storage, audits
   and end-to-end validation.

Run focused tests with demonstrated failure cases, schema generation, TypeScript,
lint/mobile gates and build. Exercise the actual plugin using a controlled local
Runs API fixture: submit, close/reload Nexus, retrieve the completion exactly once
in the correct chat, verify prompt availability and cancellation. Verify stored
job metadata through the real replay path using a disposable test store rather
than rebuilding the user's full embedding cache unnecessarily. A fixture test is
not a live Hermes deployment test; report that distinction explicitly.

## Implementation decision: direct results

Remote results are delivered as labeled agent replies directly into the parent
chat; they do not automatically launch another parent inference. This follows the
requested simple send-task/receive-answer interaction and avoids turning durable
message delivery into an extra autonomous tool run. Local subagent wake behavior
is unchanged. Persist parent settings for future continuation support, but no
ChatService scheduling refactor is required for this first version.

## Follow-up

OpenClaw implements the same connector contract after its native gateway auth,
reconnection and result retention are verified. It is not represented as a working
connection option in this first Hermes implementation.

## Protocol evidence

Hermes source verified at commit `134e08ca6d272c9b9610ce5889e2ecff9c73adf0`:
[Runs API](https://github.com/NousResearch/hermes-agent/blob/134e08ca6d272c9b9610ce5889e2ecff9c73adf0/gateway/platforms/api_server_runs.py)
and [idempotency store](https://github.com/NousResearch/hermes-agent/blob/134e08ca6d272c9b9610ce5889e2ecff9c73adf0/gateway/platforms/api_server_run_idempotency.py).
The capabilities response explicitly advertises durable replay and retention.
Retention is measured conservatively from the first local submission attempt;
status polling does not extend the client's permission to replay a lost submission.
Jobs also retain a SHA-256 credential fingerprint, so replacing credentials cannot
silently move an ambiguous request into a different Hermes authentication scope.

## Validation results

- Production build, TypeScript, lint, mobile import reachability, current tool
  catalogs and mockup validator pass. Jobs use existing conversation metadata;
  schema v18 adds nullable message metadata storage for durable reply identity.
- Full host-permitted Jest run: 433 suites / 5,493 tests passed; 12 gated suites
  were skipped. Jest reported open handles from existing image-adapter timeout promises after
  completion; the runner was stopped after all assertions passed. Unit coverage includes capability gating, request shape, credentials,
  persist-before-submit, ambiguous outcomes, reload recovery, delivery deduplication,
  cancellation, changed connection identity, conditional prompt composition and
  trusted originating-chat routing. Targeted mutation checks demonstrated failures
  when routing, deduplication and capability guards were removed.
- The real Code-vault app test uses an authenticated loopback Hermes contract
  fixture. It dispatches through the actual subagent tool, reloads the plugin,
  collects exactly one result in the originating chat, rebuilds only its synthetic
  cache rows through the real JSONL applier, verifies no duplicate delivery, and
  cancels a second task. Fixtures and their credentials are removed afterward.
- Native Obsidian settings inspection verified the empty state, add modal,
  scrollable actions, masked key field and missing-name validation. The standalone
  mockup could not be inspected in the browser available to this session; the
  actual implemented UI was inspected instead.
- A real local Hermes server with Ollama was subsequently verified; see
  [live verification](hermes-live-verification.md). Physical phone
  behavior, remote network interruption and simultaneous synced-device execution
  remain unverified. OpenClaw is a follow-up connector.
- Skill refinement logs record the tested workflow. The storage skill validator
  still reports pre-existing missing SQLite spike-document links; its schema
  consistency check passes (with an existing v5 DROP warning).

### Issues found during app verification

An early repeat encountered a native renderer SIGTRAP. The crash report does not
identify a TypeScript cause. Code was reopened and later app runs completed.

A separate audit found that whole-conversation snapshot saves could delete a
remote result appended after the snapshot was read. Snapshot reconciliation now
preserves independently delivered remote replies; explicit message/conversation
deletion still owns removal. Retrying a local response also keeps these replies
in the parent instead of moving them with ordinary continuation messages. Both
regression tests failed before their fixes and pass afterward.

The strengthened app regression exposed a lower-level omission: initial message
inserts discarded metadata in both JSONL and SQLite, and replay did not restore
it. Remote-result identity must therefore be carried by the message writer and
replay applier as well as supplied by the job repository. The live check also exposed a missing message metadata column, requiring an
additive schema v18 migration and matching fresh-install DDL. The app lane now checks this
identity after replay, in addition to the result text.

Job recovery also removes deleted branches from its cached status list without
losing jobs accepted during a scan. A Stop persisted while initial submission is
waiting for readiness is rechecked before POST; it cancels without dispatch when
there has been no previous attempt.

Repeated app runs exposed a separate shutdown leak: lazy services were skipped by
`ServiceManager.stop()`, leaving old pollers querying closed storage. Remote
workers now stop synchronously on unload, service cleanup drains before storage
closes, and delayed startup is cancelled/fenced. Regression tests cover both
pending startup and slow/failed shutdown prerequisites. The live lane retains the
old job runner across plugin reload and checks its stopped flag, cleared timer
and aborted signal before asserting recovery in the replacement instance.

### Final app verification and restoration

The final lifecycle build passed two complete Code-vault app runs (55 and 57
seconds), each including a real plugin reload, old-runner shutdown assertion,
conditional prompt composition, SQLite schema checks, job recovery, direct reply
delivery, stale-snapshot preservation, actual JSONL replay and cancellation.
`dev:errors` and `dev:console level=error` were empty after both runs. Each run
verified that its synthetic conversations and saved connection were removed.

The installed original `main.js` and `styles.css` were restored from the preserved
backup and verified by SHA-256. Code remains open with its editor/chat rendered,
and a guarded runtime check confirmed zero temporary fixture connections.
The feature remains in this worktree for review;
it has not been opened as a PR or merged.
