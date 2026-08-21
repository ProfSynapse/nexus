# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

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
