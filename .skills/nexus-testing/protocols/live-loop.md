# Protocol: the in-app loop (Obsidian CLI)

Context: this is the only procedure in the repo that answers "does this actually
work in Obsidian?" Jest cannot: it runs the plugin's code against
`tests/mocks/obsidian/`, never against a loaded plugin in a real vault. Whole
classes of defect live only past that line — a plugin that fails to initialise
on an installed build, a value that flowed through every layer and never
painted, a view that read its data source before hydration finished.

**Status: documented, never run.** These commands were written from the Obsidian
CLI's published developer commands and the design plan at
docs/plans/obsidian-cli-verification-plan.md, on a machine with no Obsidian
installed. No step below has been executed end to end. The first person to run
it MUST correct what is wrong here and log the correction in
`../refinement-log.md`.

## Preconditions

- Obsidian **≥ 1.12.4** (the CLI is generally available from that version) with
  `obsidian` on PATH. Desktop only.
- The `nexus` command, if you intend to drive tools from the shell. It is
  installed from the plugin's own settings: Get started → External agents →
  Local CLI.
- The plugin id is `nexus` — confirm against manifest.json rather than trusting
  this line.
- A test vault. **Do not hardcode a vault name anywhere.** One is available; ask
  for its name at run time or use the default described in step 1.

## Steps

1. **Target a vault, and know which default you are getting.** The two CLIs
   resolve vaults differently and mixing them up is the first thing that will
   bite you:

   | CLI | Syntax | Default when omitted |
   |---|---|---|
   | `obsidian` | `vault=<name>` | the most recently focused vault |
   | `nexus` | `--vault <name>` | `$NEXUS_VAULT`, else the single open vault |

   Because `obsidian`'s default follows window focus, an unattended run MUST
   pass `vault=<name>` explicitly. Confine every write to one scratch folder in
   that vault and touch nothing else.

2. **Build before you reload.** Reload only after a build that succeeded in the
   same run, or you will spend the loop diagnosing the previous bundle.

   ```bash
   npm run dev      # fast esbuild pass, for iterating
   npm run build    # lint → CLI → tsc → esbuild → connector; what actually ships
   ```

   Use `npm run build` for the run you intend to trust.

3. **Reload the plugin.**

   ```bash
   obsidian plugin:reload id=nexus vault=<name>
   ```

   The app must be running; this command launches it if it is not.

4. **Escalate when a reload is not enough.** `plugin:reload` re-runs the
   plugin's load path. It does not reset anything that outlives the plugin
   instance — persisted state on disk, the SQLite cache, leaf views Obsidian
   already has open, or a stale bundle Electron is still holding. Climb only as
   far as the symptom requires:

   1. `obsidian plugin:reload id=nexus` — code changes.
   2. Disable then enable the plugin, which runs the full unload path:
      `obsidian eval vault=<name> code="await app.plugins.disablePlugin('nexus'); await app.plugins.enablePlugin('nexus')"`
   3. Quit and relaunch Obsidian — for anything involving startup ordering,
      workspace layout, or a view that is wrong from the first paint.
   4. Reset Nexus's persisted state — cache rebuild, event-store recovery. That
      procedure belongs to the `nexus-storage` skill; follow it there rather
      than deleting files by hand.

   A defect that survives level 1 but not level 3 is a lifecycle bug, and that
   is information — record which level cleared it.

5. **Drive Nexus to exercise the change.** Two handles, and the choice matters:

   - **The `nexus` CLI** for anything reachable through the tool surface.
     Context flags go before `--`, the agent command after it. This is the shape
     `tests/debug/search-ranking-live-smoke.test.ts` builds, so copy it rather
     than inventing one:

     ```bash
     nexus --vault <name> use \
       --memory "Verifying <the change> in a live vault." \
       --goal "<what this run must show>" \
       -- <agent> <command> --<flag> <value>
     ```

     It prints JSON on stdout; `success` must be `true`. The payload contract is
     the `nexus-agents` skill's territory.

   - **`obsidian eval`** for what has no tool surface — rendered state, view
     internals, plugin singletons:

     ```bash
     obsidian eval vault=<name> code="app.plugins.plugins.nexus.<...>"
     ```

     `eval` runs arbitrary JS against a live vault. Never point it at a vault
     whose contents matter, and confine writes to the scratch folder from
     step 1.

6. **Observe. Assert on logs and DOM; screenshots are for humans.**

   ```bash
   obsidian dev:errors vault=<name>                        # errors since load
   obsidian dev:console level=error vault=<name>           # console output
   obsidian dev:dom selector="<css>" text vault=<name>     # rendered state
   obsidian dev:screenshot path=test-artifacts/<name>.png vault=<name>
   ```

   Treat unparseable CLI output as **unknown**, never as pass. A screenshot is
   an artifact to show someone, not an assertion — diffing them buys flakiness.

7. **Loop.** While *any* exit condition in step 8 is unmet:

   diagnose from `dev:errors` and `dev:console` → fix the source → rebuild
   (step 2) → reload at the lowest level that reproduces (step 4) → re-drive
   (step 5) → re-observe (step 6).

   Change one thing per pass. If two passes in a row produce the same error
   text, the fix is not landing — suspect a stale bundle and go up one
   escalation level before continuing to edit.

8. **Exit condition — all four, or you are not done:**
   - `dev:errors` is empty after a reload.
   - `dev:console level=error` shows nothing attributable to the change.
   - The driving command from step 5 returned the result the change promises
     (`success: true`, or the `dev:dom` text you expected).
   - The result survives one clean re-run from step 3 — proving you fixed the
     defect, not the process state.

9. **Bank it.** A manual loop is worth running once and worth encoding forever.
   Turn whatever you just proved into a gated live lane via
   `run-gated-lanes.md`, and record in `../refinement-log.md` which command
   shapes above turned out to be wrong.

## What this loop does NOT cover

Mobile crashes. `dev:mobile on` emulates the mobile *environment* —
`Platform.isMobile`, touch, layout — but does not remove Node built-ins from
Electron. The failure CLAUDE.md warns about, a top-level `import … from 'fs'`
killing plugin init on a phone, still resolves fine under emulation and will not
reproduce. A clean `dev:mobile` run is not evidence of mobile safety; that is
the `nexus-mobile-compat` skill's job.

## Next

Encode the result at `run-gated-lanes.md`. When the loop is finished and banked,
end the session at `self-refine.md`.
