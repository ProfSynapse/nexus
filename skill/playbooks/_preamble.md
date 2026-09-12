# Nexus playbook

This is a task primer. Below, in order, you get: **this spine**, **your
workspaces**, the **recipe**, and the **tools it needs (already discovered)** —
so you can go straight to `nexus use` without a separate `nexus tools` call.

**Every playbook starts the same way:**

1. **Name the session and load a workspace — once.** Choose from *Your
   workspaces* below and run
   `nexus use --session <task-name> --memory … --goal … -- memory load-workspace "<name>"`.
   If none fits, create one with `memory create-workspace`, then load it. Loading
   scopes your traces, auto-loads that workspace's task summary, and **binds the
   session to it**. (This playbook only *lists* workspaces — loading is your
   call, since only you know which one.)
2. **Then omit `--session` and `--workspace`.** The vault remembers both: every
   later call continues that session and inherits its workspace. Pass a
   different value once to switch; `nexus context` shows what is remembered. A
   session that never chose fails with "This session has no workspace yet" —
   never pass `default` as a placeholder.
3. **Always pass real `--memory` and `--goal`** — a running summary and the
   current objective. Placeholders are rejected.
4. **Checkpoint at milestones** with `memory create-state` so the work is
   restorable (archive is reversible; there is no destructive delete). It needs a
   few flags — `--name`, `--conversation-context`, `--active-task`, `--active-files`
   (array), `--next-steps` (array); run `nexus tools memory create-state` for the
   full schema.

Paths are vault-relative and confined — no `..`, `~`, or absolute escapes. **All
flags are kebab-case** — camelCase (e.g. `--activeTask`) is rejected as an unknown
flag; use `--active-task`.

For multiline Markdown/YAML or embedded quotes, keep content out of shell argv:
after `--`, swap any value flag for its transport form — pipe with
`--<flag>-stdin` or pass `--<flag>-file <local-path>` (e.g. `--content-stdin`,
`--conversation-context-file ctx.md`). Never flatten multiline content to one
line to dodge quoting.
