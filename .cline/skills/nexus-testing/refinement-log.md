# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

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
