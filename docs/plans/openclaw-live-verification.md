# OpenClaw live verification

Status: **Passed twice against the real gateway; cleanup and original-build restoration verified.**

Nexus passed a real lifecycle run against the official OpenClaw Gateway and local
Ollama inference. Neither the gateway nor its model/tool responses were mocked.

## Explicit test setup

- Test vault: Code, explicitly selected and checked inside every app operation.
- Branch: `codex/openclaw-remote-agent`, based on `f48a4eab944c62fd453d54f24a6db59d165a4a96`.
  Tested feature `main.js` SHA-256:
  `190d87b32ff7b64853f568e7f0b369d9f2ade9c7a352b5f07ec791f2d97a3526`.
- OpenClaw: official npm package 2026.9.8. Machine-local entry point:
  `/tmp/nexus-openclaw-live/node_modules/openclaw/openclaw.mjs`.
- Isolated config: `/tmp/nexus-openclaw-state/openclaw.json`, private mode 0600.
  The script reads `gateway.auth.token` without printing it.
- Gateway: `ws://127.0.0.1:18791`, owned foreground process; no daemon installed.
- Model: `ollama/nexus-hermes-test`, existing qwen3.5:4b alias, actual 32,768-token context. Only `session_status` is enabled.
- Origin: explicit `app://obsidian.md` allowlist. Signed Ed25519 device pairing
  with operator read/write access passed in the native Obsidian browser runtime.
  Authentication remained enabled; each test device was approved individually.
- Original plugin files restored and SHA-256 verified:
  `main.js`: `23b4ab0b65d8301e81d6dbcfd1815be36b2ce1496d7f55e6a2eec3906454fb29`;
  `styles.css`: `f6c1862643714be3ad08b8fbeae481dfe148913275a2eaf42b105f5763edbf00`.

The script does not download models, edit configuration, install services, or
modify an existing gateway daemon. Use an already configured isolated runtime
with `tools.allow: ["session_status"]` and no additional `alsoAllow` entries;
the script verifies this restriction before connecting. The synthetic cancellation task asks for many
status calls; it does not ask the agent to edit files or contact anyone.

## Run only after coordinating the live test

Install the feature build in the explicitly chosen vault, prepare the isolated
runtime, and obtain approval for that destination before invoking this command.
Substitute the chosen vault and unused port; the example is not a completed run.

```bash
RUN_NEXUS_OPENCLAW_LIVE=1 \
NEXUS_OPENCLAW_TEST_VAULT='<chosen test vault>' \
NEXUS_OPENCLAW_BASE_URL='ws://127.0.0.1:<unused port>' \
NEXUS_OPENCLAW_CONFIG_FILE='/tmp/nexus-openclaw-state/openclaw.json' \
NEXUS_OPENCLAW_CLI='/tmp/nexus-openclaw-live/node_modules/openclaw/openclaw.mjs' \
NEXUS_OPENCLAW_OWN_GATEWAY=1 \
NEXUS_OPENCLAW_APPROVE_TEST_DEVICE=1 \
python3 scripts/verify-openclaw-in-obsidian.py
```

`NEXUS_OPENCLAW_OWN_GATEWAY=1` allows the script to start a foreground gateway on
an unused loopback port and stop/restart that exact subprocess for recovery
testing. It refuses an occupied port and never invokes `gateway stop`,
`gateway restart`, or `--force`. Omit this option to use a preexisting gateway;
then the gateway-restart case is explicitly recorded as **not requested**.

Optional `NEXUS_OPENCLAW_APPROVE_TEST_DEVICE=1` requires the owned isolated
gateway. It reads only `id` from the exact test connection's IndexedDB identity
record, finds the matching pending device, verifies that its only requested
role/scopes are operator read/write, approves that exact request once, and checks
the resulting pairing. It never approves all pending devices or scope upgrades.
Without this option, setup waits up to two minutes for normal manual pairing.
Owned config and workspace paths must be under the system temporary directory
or `/tmp` (resolved to `/private/tmp` on macOS).
Gateway/CLI subprocesses inherit only PATH, LANG, and TMPDIR plus explicit
isolated OpenClaw state/config/home, destination, and bearer variables. Cloud
credentials from the caller's environment are not inherited.
Cleanup deletes only this connection's local IndexedDB identity. When automatic
pairing was requested, it also removes only that exact known test-device pairing
and checks the paired-device list. Synthetic remote session histories remain in
the isolated OpenClaw profile for audit.

Optional `NEXUS_OPENCLAW_PROOF_PATH` changes the default report path,
`/tmp/nexus-openclaw-live-proof.json`. Reports include job/run/session IDs and
counts, not credentials. OpenClaw's official CLI performs read-only diagnostic
RPCs using the isolated config and an exact destination assertion.

## Assertions and evidence to record

| Check | Required evidence | Result |
|---|---|---|
| Connection | Actual Nexus registry probe advertises a usable remote agent | Passed |
| Dispatch | Actual `SubagentTool` with trusted synthetic parent/message identity | Passed |
| Plugin reload | Same persisted job, native run ID, and exact session key after a new job service starts | Passed |
| Tool execution | Matching `openclaw.nested-tool.v1` result for successful `session_status` | Passed |
| Delivery | Exactly one task input in native history and one Nexus reply exactly matching the final assistant row with the native run ID | Passed |
| JSONL recovery | Replay only the tagged parent/branch cache rows; preserve run, session and result delivery | Passed |
| Gateway restart | Pause Nexus polling after acceptance, await native completion, restart only the owned process, observe native wait timeout, recover final history after plugin reload | Passed |
| Cancellation | Stop a third long synthetic task and receive one cancelled result | Passed |
| Cleanup | Best-effort stop of tagged active jobs; tagged conversations, temporary connection and secret removed and checked; owned process stopped | Passed |
| Diagnostics | Nexus error logs checked after the run | Passed |
| Restoration | Original plugin files restored and hashes verified | Passed |

The job service is temporarily paused for the history-recovery and fixture-cache
replay cases. Use a vault with no other active remote jobs. The script never
rebuilds the whole vault cache; cache deletion is restricted to verified tagged
fixture IDs, and their JSONL remains the replay source.

Every Obsidian eval checks the selected vault name. Mutating expressions run
once under unique in-app operation markers. If a CLI acknowledgement is lost,
the script polls that marker rather than repeating submission or deletion.
Reload also waits for a different job-service instance, not merely a truthy
service reference, and waits separately for storage query readiness. A timeout or model/tool failure is a failed verification,
not permission to manufacture a passing response.

## Completed-run record

- Date: 2026-10-07, 20:57–21:07 America/New_York.
- Proof artifact: `/tmp/nexus-openclaw-app-proof-pass2.json`.
- First task/run: `remote_db2a8a15-5684-492b-adcd-662f53d56e64`.
- Gateway-recovery task/run: `remote_b509e849-a199-4139-acb6-fb38d89f1c37`.
- Cancellation run: `remote_8f1da28d-2dd2-4746-8e13-a9c7d2423410`.
- Each native session key is `agent:main:explicit:nexus-<runId>`.
- Each completed task had one input, one successful actual `session_status`
  result, and exactly one Nexus reply matching the native final assistant row.
- Synthetic event replay preserved the native identities and delivery marker.
- Gateway restart lost the completed run's in-memory wait result; Nexus recovered
  its exact final reply from session history without another input.
- Cancellation produced one cancelled result in the requesting chat.
- All six tagged conversations, the temporary connection, its secret, local
  device identity and exact gateway pairing were removed. The owned gateway
  stopped. Both Obsidian error diagnostics were checked separately through the CLI and
  were empty; they are not assertions in the lifecycle proof JSON.
- Clean repeat passed with the same build: `/tmp/nexus-openclaw-app-proof-repeat.json`.
  Reload run `remote_f764f9f0-ac79-4523-9f0e-cd89c1bc8232`;
  history-recovery run `remote_17b8ab08-63b1-4e1b-b45b-a1c1433c7b5e`;
  cancellation run `remote_a8291200-e33d-474c-818f-450b8785be4d`.
  It again verified one actual tool result and exactly one matching reply per
  completed task, JSONL replay, restart recovery, cancellation and scoped cleanup.
- Original installed files restored; storage became query-ready and both
  restored-build error diagnostics were empty.
- Separate diagnostic/cleanup evidence: `/tmp/nexus-openclaw-final-cleanup.json`.
  Feature checks returned `No errors captured.` and `No console messages captured.`
- The isolated gateway port is closed, the dedicated Ollama model is unloaded,
  and the temporary repository dependency symlink is removed. Runtime/config and
  synthetic remote histories remain under `/tmp` for reproducibility.

## Corrections and limits

Review caught malformed acknowledgements being treated as definitive rejection.
Transport regressions now require uncertain submission recovery for malformed
frames and operational server errors; no automatic replay is allowed. An isolated
mutation removing the run-ID history filter made its regression fail.

Earlier live attempts exposed lost CLI acknowledgements and service construction
preceding storage query readiness. The harness now polls unique operation markers
without replaying mutations, and waits separately for `isQueryReady()` after each
reload. In the complete run these two storage waits took about 151 and 143 seconds;
those startup waits are not remote task execution time. An earlier timed-out
operation eventually recovered the correct reply, but that attempt is not counted
as a passing full run. The native UI also displayed that recovered reply.

Production build, TypeScript, ESLint and mobile import reachability passed.
The full host Jest run passed 459 suites / 5,726 tests (13 suites / 74 tests
skipped). Sandbox-only socket tests initially failed with EPERM; the host run
passed them. Jest retained background handles after its passing summary and the
owned completed test process was stopped. Existing storage-skill link validation
reports three pre-existing missing historical-plan links; schema consistency and
all tool-catalog/gated-lane checks passed.

Physical phones, reverse-proxy deployments and simultaneous synced-device
execution were not tested. Native Gateway protocol 4 was verified against the
pinned OpenClaw version above. Device pairing and a valid TLS gateway remain
normal deployment prerequisites. There is no cross-device exactly-once claim,
and missing retained history requires attention instead of resubmitting work.
