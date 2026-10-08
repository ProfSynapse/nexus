# Real Hermes integration verification

Date: 2026-10-07

Nexus was tested against the official Hermes gateway and actual local Ollama
inference. Neither the gateway nor the model response was mocked. No production
Nexus code changes were needed for this test.

## Setup on this machine

- Official source: `https://github.com/NousResearch/hermes-agent`, commit
  `e675225af2b651ad447d918b090bb554df55a420`.
- Checkout: `/tmp/nexus-hermes-live`.
- Isolated config/state/runtime: `/tmp/nexus-hermes-live-data`.
- API base: `http://127.0.0.1:18642/v1`, authenticated with a generated local
  test key stored in a private file. No cloud API credentials were needed.
- Inference: Ollama, using `nexus-hermes-test`, an alias of the already installed
  `qwen3.5:4b` weights. The alias sets `num_ctx=65536` and temperature `0.2`.
  `ollama ps` confirmed an actual 65,536-token context, not merely a Hermes hint.
- Hermes was installed through its own package manager with `web` and `messaging`
  extras. Optional browser/computer-control packages were excluded. The bootstrap
  used `/etc/ssl/cert.pem` to resolve this machine's Python CA-store issue.
- The API toolset was limited to `todo`; the authenticated toolset endpoint
  confirmed that only `todo_list` was enabled. MCP was excluded. Hermes tool
  search was disabled for this small-model test, exposing that one tool directly.

The isolated home separates configuration and state; it is not an OS sandbox.
No terminal or filesystem tools were enabled for these runs.

## Evidence

A complete successful run had:

- Nexus job: `remote_e76bcf68-a4b6-4faa-a689-b578c5bb929d`.
- Hermes run: `run_77791341fbe74cb5b052268f84277c31`.
- Nexus recovered that same run ID after a real plugin reload.
- Hermes emitted a successful `tool.completed` event for `todo_list`.
- Hermes completed, and Nexus delivered exactly one labeled response to the
  synthetic originating chat.
- Repeating the identical request with its idempotency key returned the same
  server run. A separate completed run also retained its key across actual
  Hermes gateway restarts.
- Both Nexus error diagnostics were empty. Temporary Nexus connections,
  credentials and conversations were removed and their removal was verified.

Early attempts identified test-setup/model limits: current Hermes rejects a
16K context; the small model sometimes loops through deferred tool discovery or
copies a random marker incorrectly. The saved transport test compares the Nexus
reply exactly to Hermes's actual final output and checks the run identity, rather
than treating perfect marker transcription as a transport requirement. It still
requires a real successful task-list tool event.

A clean repeat using the saved script also passed: Nexus job
`remote_0bb9ddbb-85c4-4aa1-b9cf-7d801cede712`, Hermes run
`run_58c6c3c5483c44249c29b4342b27475e`, one successful `todo_list` execution,
one matching final reply, reload recovery and idempotent replay. Both Nexus error
logs were empty after the repeat.

After verification, the original installed Code plugin files were restored and
SHA-256 verified. The isolated Hermes process was stopped and the dedicated
Ollama model unloaded from GPU memory. Its checkout, runtime, configuration and
model alias remain available for reruns; no background service was installed.

## Repeat the test

The machine-local server launcher reads the generated key from its private file:

```bash
python3 /tmp/nexus-hermes-launch.py
```

With this feature build installed in an explicitly chosen test vault and the
server running, the opt-in script exercises real delegation and cleanup:

```bash
RUN_NEXUS_HERMES_LIVE=1 \
NEXUS_HERMES_TEST_VAULT=Code \
NEXUS_HERMES_BASE_URL=http://127.0.0.1:18642/v1 \
NEXUS_HERMES_KEY_FILE=/tmp/nexus-hermes-live-data/api-key \
python3 scripts/verify-hermes-in-obsidian.py
```

The script uses unique in-app operation markers to recover missing CLI
acknowledgements; it never repeats a mutating expression blindly. Its default
proof output is `/tmp/nexus-hermes-live-proof.json` and includes no API key.
This verification covers local desktop execution; physical phones, remote
network interruption and simultaneous synced-device execution remain untested.

## PR integration verification

The feature was rebased onto main's instruction-library change before PR #407.
Both instruction/workflow preparation and conditional remote-agent discovery were
preserved. The rebased production build and full active Jest suite passed; two
additional lifecycle regressions then verified simultaneous skill/remote cleanup
and continued teardown after rejected skill cleanup.

The final rebased build also passed the opt-in actual Code-vault fixture test:
submission, reload recovery, stopped old poller, single result delivery, stale
snapshot preservation, JSONL replay, cancellation, and verified fixture removal.
Both `dev:errors` and `dev:console level=error` were empty. Original Code plugin
files were restored and SHA-256 verified after the test.
