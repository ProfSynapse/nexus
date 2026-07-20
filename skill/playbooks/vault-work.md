---
name: vault-work
intent: Search the vault, read what you find, then create or edit notes — the typical loop
tools: [search content, search directory, content read, content write, content replace, content insert, content set-property, storage list, memory list-workspaces, memory create-state]
---

# Playbook: vault-work

The 80% loop: **find → read → change.** Use it for "find the note about X and
update it," "answer a question from my notes," "add a section to Y," etc.

## Protocol

1. **Load a workspace** (see the spine above), thread `--workspace`/`--session`.
2. **Find the note(s).** Pick the search that fits:
   - `search content --query "<terms>"` — semantic/keyword over note bodies.
   - `search directory --query "<name>" --paths "<folder>"` — by filename/path.
   - `storage list --path "<folder>"` — browse a known folder.
   Each returns **locations** (`path` + score), not contents.
3. **Read before you act.** `content read --path <path> --start-line 1` on the
   hit(s) — `content read` **requires a start line** (use `1` to read from the
   top). Never quote, summarize, or edit from a search result alone — it has no body.
4. **Make the change** with the narrowest tool:
   - `content set-property` — a frontmatter field.
   - `content insert` — add a section (append/prepend/at an anchor).
   - `content replace` — a surgical edit. It is **pattern-anchored**:
     `{path, start, end, content}` where `start`/`end` are exact **anchor text**
     from the note (not line numbers). Read first to copy the anchors.
   - `content write` — a new note, or a full overwrite.
5. **Checkpoint** with `memory create-state` when the edit is done.

## Worked example — add a summary under a heading

```
# 1. load the workspace you picked from the list above (--workspace = name or id)
nexus use \
  --memory "starting: summarize the auth notes" --goal "load the research workspace" \
  --session auth-summary \
  -- memory load-workspace --workspace research

# 2. find
nexus use \
  --workspace research --session auth-summary \
  --memory "looking for the main auth note" --goal "locate the auth flow note" \
  -- search content --query "authentication flow" --limit 5

# 3. read the top hit (search gave a path, not the text)
nexus use \
  --workspace research --session auth-summary \
  --memory "found Projects/Auth/flow.md; reading it" --goal "read the auth flow note" \
  -- content read --path Projects/Auth/flow.md --start-line 1

# 4. edit — anchor on exact text pulled from the read
nexus use \
  --workspace research --session auth-summary \
  --memory "have the body; inserting a summary" --goal "replace the Summary section" \
  -- content replace --path Projects/Auth/flow.md \
  --start "## Summary" --end "## Details" \
  --content "## Summary\n\nOAuth2 + PKCE; tokens rotate hourly.\n\n"

# 5. checkpoint (create-state needs name + context + task + file/step arrays)
nexus use \
  --workspace research --session auth-summary \
  --memory "summary written to flow.md" --goal "checkpoint the finished edit" \
  -- memory create-state --name auth-summary-done \
  --conversation-context "summarized the auth flow note into a Summary section" \
  --active-task "add a summary to flow.md" \
  --active-files "[Projects/Auth/flow.md]" \
  --next-steps "[review the summary with the team]"
```

## Pitfalls

- **Editing from a search hit without reading** — the hit is a location; you'll
  guess the body wrong. Always `content read` first.
- **`content replace` with line numbers** — it wants anchor *text* in
  `start`/`end`. Copy the anchors verbatim from the read.
- **Answering a question from `{path, score}`** — read the note; don't fabricate
  from the ranking.
- **Losing trace scope** — pass `--workspace` on every call, not just the load.
- **Writing outside the vault** — `..`/`~`/absolute paths are rejected; keep
  paths vault-relative.
