# Refinement log

- 2026-10-07 | A live OpenAI-compatible protocol spike used actual Ollama responses and a fresh random tool result to verify the round trip. SSE deltas prove framing, not temporal delivery or in-app rendering. | No procedure change; existing mock-honesty guidance applies. | Files: refinement-log.md.

- 2026-09-30 | Focused adapter, banner, and pricing tests plus the production build verified the new model and reconnect state. | No skill procedure change. | Files: none.

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-09-18 | Ran `headless-obsidian.md` and `live-loop.md` end to end against
Obsidian 1.13.7 on Linux (Electron 43.3.0, Chrome 150), driving a real
measurement harness. Five findings: (1) `vault=` is not validated on Linux at
all, `obsidian-cli eval vault=nope-not-a-vault code="1+1"` ran against the open
vault and returned `=> 2`, so the only safe check is asserting
`app.vault.getName()` in-band, and that name is the directory basename, not the
`obsidian.json` key; (2) `eval` stdout interleaves console output with its own
`=> ` line, so a naive strip of the whole output breaks on a stray console
warning, take the last `^=> ` line instead; (3) the CLI reinstalls its own
console hook on every `eval` connection and silently displaces an earlier
wrapper, a plain `console.error = wrapper` caught 1 line out of about 50,000
and looked exactly like the plugin logging nothing, an accessor-based
save-and-restore hook (the same shape as `SQLiteCacheManager.initialize` and
`SQLitePersistenceService.saveDatabase`) is what held; (4) `enablePluginAndSave`
persists to `community-plugins.json`, so the next launch auto-loads the plugin
and starts background indexing before any harness attaches, the fix is
resetting `community-plugins.json` to `[]` before each launch and polling at
about 10 ms after an explicit enable, `plugin.embeddingManager` appeared at
about 3.3 s; (5) `xvfb-run` leaves its X server running after a SIGKILL, so the
existing `pkill` patterns need `pkill -9 -f Xvfb` too, or servers accumulate
across runs. Also confirmed the `loadManifests()` plus `enablePluginAndSave()`
rescan added earlier the same day was required in this run and worked exactly
as documented. | Added the Linux vault-targeting warning and the
`app.vault.getName()` check to `live-loop.md` step 1, the `eval` output-parsing
and console-hook notes to `live-loop.md` step 5, the persisted-enable and
instrumentation timing to `headless-obsidian.md` step 5 with the rescan
confirmation, the `Xvfb` pkill target and an IndexedDB-wiping warning to
`headless-obsidian.md`'s guidelines. | `protocols/live-loop.md`,
`protocols/headless-obsidian.md`, `refinement-log.md`.

2026-09-18 | Ran `headless-obsidian.md` end to end against Obsidian 1.13.7 on
2026-09-18 while measuring the SQLite save path. The protocol worked as written
(xvfb-run present, obsidian.md still 403 and github.com reachable, the full GPU flag
set still required, `"cli": true` written while not running still took effect), but
step 5 has a silent failure: Obsidian reads `.obsidian/plugins/` once at vault load,
so a plugin folder created after launch is invisible. `enablePlugin()` then resolves
without error and without loading anything, `app.plugins.manifests` lacks the entry,
and `dev:errors` stays empty, so it presents exactly like a plugin that failed to
load. Also, when walking plugin internals with `eval`, a harness plugin parked on
`window` is reachable via `plugin.app.workspace...` and via `secretStore.host.plugins`
and gets mistaken for the plugin under test. | Added the `loadManifests()` +
`enablePluginAndSave()` rescan to step 5 with the symptom described, so the next
reader does not diagnose a working plugin as broken. | `protocols/headless-obsidian.md`,
`refinement-log.md`.
2026-09-18 | `references/lanes.md` told readers that adding a file to the coverage
allowlist without a per-file `coverageThreshold` reds the run, and prescribed "add
both or neither". The prescribed remedy does nothing: `npm run test:coverage` passes
`--coverageThreshold` on the command line, which *replaces* the config object rather
than merging, so none of the ~35 per-file entries in jest.config.js are read by that
command. Verified by running it: only `"global"` threshold failures are reported,
while the four per-file failures a bare `jest --coverage` reports are absent. Also
found that command already red on main at 76.44% statements, so it gates nothing. |
Replaced the Coverage section with a table separating what each command reads, kept
the advice to add the per-file entry (a bare `jest --coverage` does read it) while
removing the false claim that it protects `test:coverage`, and added the two
discovery commands. | `references/lanes.md`, `refinement-log.md`.
2026-08-24 | A 2026-08-21 entry below repointed this skill's validator command at
`.codex/skills` on the premise that the `.claude/skills` mirror had been removed.
The premise was false: `scripts/sync-agent-context.mjs` copies `.skills/` into all
three mirrors byte-for-byte with no path rewriting, so both mirrors exist and a
mirror-local path cannot survive a sync — the edit only produced drift. | Restored
the canonical `.claude/skills` path used by the rest of the skills (63 references
to 0). Edit `.skills/` and run `npm run sync:skills`; never edit a mirror. |
`protocols/self-refine.md`, `refinement-log.md`.

2026-08-19 | The catalog-target guard falsely failed because it compared an intentional scratch subset to the new release alias. | Changed it to validate manifest-selected CLI/MCP artifacts against their root aliases and ignore scratch exports. | `scripts/check_catalog_target.py`, `refinement-log.md`.

2026-08-14 | Restructured from a single prose file via the skill-crafter
improve-skill protocol. Every factual claim re-verified against the tree; the
lane table, gate names and env-var lists were replaced with discovery commands
because they had no way to stay true. The in-app Obsidian CLI loop was added and
is **unrun** — no Obsidian in the authoring container. | Split the router into
protocols/, references/ and scripts/; added `check_live_lane_gates.py` and
`check_catalog_target.py`; installed this log and the self-refine protocol. |
SKILL.md, the protocols, references and scripts folders, and this log.

## 2026-08-14 — the in-app loop was run for the first time

Stood up Obsidian 1.13.7 headless in a Linux container and exercised the loop.
Added `protocols/headless-obsidian.md` so the setup is not rediscovered.

Learned the hard way, each after a failed attempt:

- `obsidian.md` is blocked by the egress proxy (403 CONNECT); `github.com` is
  not, so the AppImage comes from the releases repo's assets.
- Electron needs the full flag set — without `--in-process-gpu` and friends it
  dies with `GPU process isn't usable. Goodbye.`
- `"cli": true` in `~/.config/obsidian/obsidian.json` is the CLI toggle, and it
  must be written while the app is stopped.
- `pkill -f obsidian.asar` matches only helper processes. The main process
  survives and keeps answering with the old config, which reads exactly like the
  setting being ignored.
- A fresh vault opens in Restricted Mode; `community-plugins.json` alone does
  not load a plugin. `app.plugins.setEnable(true)` does.
- `dev:console` is silent until `dev:debug on`.

Payoff on the first run: `dev:errors` surfaced `Database not initialized` from
`NotesIndexBuilder.startInBackground` — a cold-start ordering bug that leaves the
notes index silently empty for the whole session. Reproduced on a normal cold
start, so it was not an artifact of enabling plugins mid-session. No Jest lane
could see it.

## 2026-08-24 — the loop on macOS, and why `eval` looked broken

Ran the loop against Obsidian on macOS to prove a Gemini reasoning fix
(`thinkingConfig.includeThoughts`). Two things cost most of the run, neither of
them the plugin:

- **A shell wrapper can eat the CLI's output.** This machine rewrites bare
  commands through `rtk`, which returned nothing at all for `obsidian eval`.
  Every probe looked like a silent no-op while the app was in fact executing the
  code. Invoke the binary by absolute path
  (`/Applications/Obsidian.app/Contents/MacOS/obsidian`) before concluding a
  command does nothing.
- **`eval`'s stdout is unreliable; its side effects are not.** The same
  `code=` payload printed `=> 12` on one run out of three and nothing on the
  others, which reads exactly like a syntax problem and is not one. Do not
  assert on what `eval` prints. Have the code write its result into a scratch
  folder in the vault and read that file from the shell — and poll for it, since
  the command returns before an async body finishes.

Shape that worked, once the driver was too long to quote inline: write the
driver to `<vault>/_scratch/driver.js` from the shell, then

```
obsidian eval vault=<name> code="app.vault.adapter.read('_scratch/driver.js').then(function(t){return new Function('app',t)(app)}).catch(function(e){return app.vault.adapter.write('_scratch/error.txt',String(e.stack))})"
```

The catch clause matters: without it a failing driver is indistinguishable from
one that never ran.

Also worth the minute it costs: A/B the bundle. Reinstalling the pre-fix
`main.js`, reloading and re-driving turned "reasoning appears" into "reasoning
appears only with the fix" — 0 events before, thought summaries after, same
prompt and same session.

Worktree gotcha: `npm run build` resolves `node_modules/typescript/bin/tsc`
relative to the worktree, so a worktree without its own `node_modules` fails
there while `npx jest` still works (node resolution walks up). Symlink it, or
`npm ci`.

- 2026-09-08 | Request-body assertions caught unsupported sampling parameters; removing the production guards made all new regression cases fail. Skill validation also treated optional machine-private hook paths as broken references. | Clarified the optional local hook without repository links and added the missing Next section in protocols/merge-a-pr.md.

- 2026-09-08 | Quality and dimension guards were tested at the outgoing request boundary; disabling them made the regression cases fail. | No procedure change.

- 2026-09-18 | headless-obsidian step 5 copies only `main.js manifest.json styles.css`, but the build also emits `sqlite3.wasm`. Without it SQLite never initialises and ConversationService silently falls back to the legacy `.conversations/*.json` backend — the plugin loads, `dev:errors` is clean, conversations save and reload, and a storage round-trip test passes against a backend the change never touched. Cost a full round of "proven" results that proved nothing about the hybrid path. | Added `sqlite3.wasm` to the copy list, pointed at `npm run build | grep -i copied` to derive it instead, and added a storage-backend stop condition to step 6 that asserts the schema version. | protocols/headless-obsidian.md

- 2026-10-07 | Generic provider verification in macOS Obsidian 1.14.4: synchronous `eval`, `dev:errors`, and in-band vault checks worked; returned async expressions sometimes printed nothing, and main-window screenshots could not see the separate Settings window. Native app automation exercised discovery/save, and synchronous status polling captured the real LLMService/getTools roundtrip. | Added async polling and separate-window guidance to `protocols/live-loop.md`. No missing commands observed.
- 2026-10-03: Real protocol integration caught context injection and flattened-result binding defects missed by service-only fixtures. Added context-through-real-boundary guidance to references/mock-honesty.md; regression tests use the actual strategy/normalizer/batch/agent path.

### 2026-10-03 — Instruction workflow live verification

- `obsidian-cli eval vault=Code code=<async IIFE>` returned awaited JSON when the last `=> ` line was parsed. In-band vault assertions remained necessary after Code was opened. `plugin:reload id=nexus vault=Code`, `dev:debug on`, `dev:console clear`, `dev:errors`, `dev:console level=error`, and `dev:screenshot path=<absolute>` all resolved. Screenshots captured the main workspace while the settings DOM was in a separate window; assert connected elements and nonzero bounds when judging settings rendering.
- `nexus --vault code use ... -- memory load-workspace <id> --workflow <id>` loaded instructions and full tool signatures. A shared skill-reference object in discovery was replaced with `[Circular Reference]` by the boundary serializer; cloning summary references plus a real serialized-result regression fixed it. CLI tool failures may use stderr with empty stdout: do not classify an empty JSON parse as the feature failure.
- Repeated reload exposed runtime teardown errors that `dev:errors` did not capture but `dev:console level=error` did. Preserve both exit checks from the live-loop protocol.

- 2026-10-07: The gated instruction/workflow lane passed on Obsidian 1.14.4 after `obsidian-cli reload vault=Code` cleared callbacks from previously installed plugin instances. Eval output should be JSON-parsed once even when the result is a string; Nexus `--json` exposes the raw MCP wrapper, while normal output decodes the tool result on the tested CLI. One CLI subprocess ignored its timeout termination signal; `killSignal: 'SIGKILL'` bounds the harness, and fixture existence was checked before retry. Another build later replaced the shared Code runtime, detected by comparing installed hashes; do not overwrite a concurrent build to preserve a verification claim.

- 2026-10-07: PR validation after rebasing preserved concurrent provider changes. Saved live-runtime backups under ignored test-artifacts were still scanned by ESLint; excluded that generated evidence directory in eslint.config.mjs. Real socket suites require execution outside the filesystem sandbox. Merge remains gated on parsed GitHub check buckets.

- 2026-10-07 | Remote-agent app verification used `obsidian eval vault=Code code=<synchronous status expression>`, `obsidian plugin:reload id=nexus vault=Code`, and `obsidian dev:errors vault=Code`; all worked with host access. Async status polling followed existing guidance. The gated app fixture replays only its synthetic conversation cache rows through the actual JSONL applier. A later repeat returned empty CLI output and the Code renderer became blank; the original build was restored, and the repeat is not claimed as passing. | No procedure change; reproducible recipe is tests/debug/remote-agents-app-live.test.ts.

- 2026-10-07 | Follow-up remote-agent app checks caught missing message metadata in both writer/replay and actual schema despite passing mocks. Synchronous eval also briefly returned empty immediately after plugin reload while a later probe succeeded. | Added bounded read-only reload readiness guidance to protocols/live-loop.md; the app lane now asserts real schema, identity replay, stale-snapshot preservation and verified cleanup.

- 2026-10-07 | Remote job/replay assertions passed while `dev:console level=error` exposed old pollers querying closed databases after plugin reload. `dev:errors` alone was clean. | Retained the existing two-log exit gate; added a real-app assertion that the old job runner is stopped, its timer cleared and its abort signal fired across reload. Lifecycle regressions cover lazy service cleanup and deferred startup cancellation.

- 2026-10-07 | Real Hermes/Ollama tests confirmed occasional lost CLI acknowledgements even when an async operation ran. A random output marker also confused transport correctness with small-model transcription accuracy. | Saved scripts/verify-hermes-in-obsidian.py: recover only the unique operation status, never replay a mutating eval; compare the delivered reply to the actual server output and require a real successful tool event.

- 2026-10-07 | Rebased remote-agent app verification preserved concurrent instruction-library work. `obsidian eval vault=Code code=<guarded expression>`, `plugin:reload`, `dev:errors`, and `dev:console level=error` all worked; fixture dispatch/reload/replay/cancellation and cleanup passed. | No protocol change; existing live and merge gates covered this integration.

- 2026-10-07 | Native OpenClaw testing confirmed signed pairing in actual Obsidian; the first lifecycle run passed task delivery and JSONL replay, then lost the acknowledgement while capturing a reload marker. | The gated scripts/verify-openclaw-in-obsidian.py now captures that marker through the same one-shot operation/status recovery as other mutations. Exact test-device approval is scoped to its public identity and read/write roles; no auth bypass. Guarded eval, plugin:reload, dev:errors and dev:console retain their documented syntax. A later recovery completed after the harness deadline because service construction preceded storage hydration; live-loop.md now requires query readiness before persisted-state checks.

- 2026-10-08 | Stop-reason tests exercised real SSE parsing, runtime mapping, reduction and both message-save paths, with mock storage serialization. Removing response-stop recording made the history assertion fail; the production source was restored before broad checks. No Obsidian CLI was available on PATH, so those tests do not establish an in-app storage round-trip. | No protocol change; existing mutation-proof and live-loop guidance covered the verification limits.
