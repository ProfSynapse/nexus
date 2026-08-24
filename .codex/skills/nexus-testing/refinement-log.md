# Refinement log

2026-08-21 | A green receipt concurrency test sent both calls through one
`ToolOperationService`, so its local in-flight map prevented the cross-instance
race before persistence was exercised. | Added a two-owner/barrier rule for
tests whose production risk crosses service, reload, cache, or device ownership
boundaries. | `references/mock-honesty.md`, `refinement-log.md`.

2026-08-21 | The packaged verifier, explicit vault targeting, Promise-chain eval,
and Nexus CLI drive loop all worked as documented for the durable-receipt live
gate; the only correction belonged to the storage skill's modal-driven rebuild
procedure. | No change. | `refinement-log.md` only.

2026-08-21 | A PR 5 live check needed an asynchronous service lookup: top-level `await` failed as documented, but returning a Promise chain worked and the macOS CLI waited for its result. | Corrected the eval guidance and added a known-good Promise-chain example. | `protocols/live-loop.md`, `refinement-log.md`.

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

2026-08-21 | The terminal validation recipe still targeted the removed
`.claude/skills` mirror, so the prescribed gate paths did not resolve in the
current repository. | Repointed validation and both mechanical gates at
`.codex/skills`, with explicit installed skill-crafter resolution. |
`protocols/self-refine.md`, `refinement-log.md`.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-23 | On a multi-window macOS install, `obsidian eval vault="Rose N
Thorn" ...` and `obsidian vault vault="Rose N Thorn" info=name` both returned
the focused `Code` vault without an error. The live-loop treated an explicit
vault argument as sufficient proof of targeting. | Added a mandatory harmless
vault-name probe and a stop condition when the CLI silently falls back to the
focused renderer. | `protocols/live-loop.md`, `refinement-log.md`.
2026-08-21 | A live macOS run confirmed vault-targeted `plugin:reload`,
`dev:errors`, `dev:debug`, `dev:console clear`, error filtering, and synchronous
`eval`; top-level `await` in `eval code=` failed with `await is not defined`, and
an uncleared console mixed earlier startup errors into a later clean reload. |
Recorded the macOS exercise, replaced the async-eval disable/enable example with
native plugin commands, and required clearing console capture before the reload
under judgment. | `SKILL.md`, `protocols/live-loop.md`, `refinement-log.md`.

2026-08-21 | The contract-test, deliberate red/green, socket-capable full-suite,
and packaged verifier procedures covered the provider lifecycle refactor; the
only initial full-suite failure was the host sandbox denying local listeners,
not a stale repository command, and no user correction was available. | No
skill change. | `refinement-log.md` only.

2026-08-21 | The write-test, deliberate red/green, full-suite, and packaged
verifier procedures matched the repository; the verifier honestly skipped when
no running Obsidian answered, and no user correction was available. | No skill
change. | `refinement-log.md` only.

2026-08-21 | On macOS, the packaged verifier put `vault=<name>` before the CLI
subcommand, while the installed CLI accepted `obsidian eval vault=<name> ...`.
The existing stubs accepted arguments in any order and hid the defect. | Moved
the subcommand first for eval, reload, errors, and screenshot calls; added a
strict argument-order regression case. | `scripts/verify-in-obsidian.mjs`,
`tests/unit/verifyInObsidianScript.test.ts`, `refinement-log.md`.

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
