# OpenClaw remote-agent connector

Date: 2026-10-07
Status: implemented and verified. Production build, full tests and two real gateway lifecycle runs passed; test cleanup and original-build restoration are complete.

## Behavior

Add OpenClaw to the existing Remote agents type selector. Keep name, server URL,
credential and optional description; no protocol or recovery switches. This is a
small addition within the existing settings layout, not a new UI surface.

Nexus sends a task through OpenClaw's native authenticated Gateway WebSocket RPC.
The remote agent runs its own tools. Nexus persists the Nexus-generated run ID
and exact session key before submission, then delivers one labeled final reply
into the originating chat using the existing remote job machinery.

OpenClaw's in-memory replay/status caches are not durable. After an uncertain
submission, recover only through run status and matching persisted session
history. Never infer rejection from a timeout or automatically submit again.
Missing history requires attention. A completed response must match both the
saved session and run ID. Cancellation is scoped to that run and session.

## File ownership

- Connector/transport: new `OpenClawConnector.ts` and WebSocket implementation,
  protocol fixtures, real gateway handshake and lifecycle verification.
- Recovery: `RemoteAgentJobService.ts`, `RemoteAgentJobRepository.ts`, tests for
  prepare-before-persist, lost acknowledgements, history recovery and cancellation.
- Settings: existing remote agent modal/edit session/tab and their tests.
- Integration: shared contracts, protocol-aware URL validation, registry and
  availability, live app test script, final build/replay/UI verification.

## Verification

Use the existing isolated OpenClaw install with local Ollama, a generated private
bearer token and status-only tools. Test actual Nexus delegation, actual remote
tool use, plugin reload, one final reply, gateway restart/history recovery and
cancellation. Preserve and restore Code's original installed plugin files, remove
only tagged synthetic Nexus records, stop test processes and unload the test model.

Run connector, job, settings and existing Hermes suites; then production build,
mobile reachability and the full Jest suite. Validate recovery against actual
JSONL replay of only synthetic records, avoiding a destructive whole-vault cache
rebuild that would recompute unrelated embeddings. Physical phones and concurrent
synced devices require separate verification and are not claimed by these tests.

## Connecting an existing OpenClaw gateway

In Nexus settings, open **Remote agents**, add a connection, choose **OpenClaw**,
and enter its name, gateway URL and gateway token. Use the WebSocket gateway
address (`wss://...`); `https://...` is normalized to WSS. Local testing accepts
`ws://localhost:<port>`. The HTTP `/v1` inference route is a different endpoint.
Add an optional description of when to delegate to this agent. Nexus includes
available agents in the system prompt automatically.

OpenClaw must explicitly allow Obsidian's `app://obsidian.md` origin through
`gateway.controlUi.allowedOrigins`. Keep authentication enabled. The first
connection creates a local device identity and may require normal OpenClaw
pairing: review the pending Nexus device with `openclaw devices list`, then
approve that request with `openclaw devices approve <requestId>`. Nexus requests
operator read/write access. Check the connection again after approval. Every
Obsidian installation has its own local private key and needs its own pairing.

Tasks use the gateway's default agent and its configured model/tools. Nexus
shows job status and delivers the final answer into the requesting chat; the
remote agent's internal tool calls stay on its server. Closing Nexus does not
cancel the remote task. Reopening Nexus resumes result checks. If a server has
lost the relevant history, Nexus asks for attention instead of replaying work.

Verification evidence and repeat instructions: [OpenClaw live verification](openclaw-live-verification.md).
