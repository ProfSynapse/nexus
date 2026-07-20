---
name: prompt
intent: Run a prompt (text or image) over your notes — inline or from your saved library — and optionally write the result back
tools: [prompt execute, prompt list, prompt get, prompt create, prompt list-models, prompt check-generated-artifact, content read, content write, memory list-workspaces, memory create-state]
---

# Playbook: prompt

Run an LLM (or image model) over vault content with `prompt execute`. Use it to
summarize/rewrite/extract across notes, draft new notes, or generate an image —
driving the prompt **inline** (one you write) or from a **saved prompt** in the
vault's prompt library, with **notes attached as context**, and optionally
**writing the result straight back** into a note.

## The `prompt execute` shape

`prompt execute` takes **`--prompts`, a JSON array** of one or more request
objects (it's a batch tool). The fields that matter:

| Field | Purpose |
|-------|---------|
| `type` | `"text"` (LLM) or `"image"` (image model). **Required.** |
| `prompt` | the prompt text — **an inline prompt you write.** Required. (For a saved prompt, still give a `prompt`, or a short instruction; `customPrompt` supplies the template.) |
| `customPrompt` | **name or ID of a saved prompt** (from `prompt list`) to use as the template. |
| `contextFiles` | array of **vault-relative note paths to attach as context** (text requests). |
| `workspace` | workspace name — gather its context automatically (text requests). |
| `provider` / `model` | pick the model (see `prompt list-models`); defaults to your configured agent model. |
| `action` | write the result back: `{type: create\|append\|prepend\|replace\|findReplace, targetPath, start, end, …}`. |
| `savePath` / `aspectRatio` / `referenceImages` | image requests only. |
| `sequence` / `parallelGroup` / `includePreviousResults` / `contextFromSteps` | chain multiple requests. |

Full live schema: `nexus tools prompt execute`. Saved prompts: `prompt list`
(names/IDs) → `prompt get --id <name>` to inspect one; `prompt create` to add one.

## Protocol

1. **Load a workspace** (see the spine above); thread `--workspace`/`--session`.
2. **Pick the driver**: write an **inline** `prompt`, or find a **saved** one with
   `prompt list` and pass its name as `customPrompt`.
3. **Attach the notes** the prompt should see via `contextFiles` (read them first
   if you need to confirm paths).
4. **Choose where the result goes**: omit `action` to get it on stdout (use
   `--json`), or set `action` to write it into a note.
5. **Run** `prompt execute --prompts '[ … ]'`. For images/audio/video it returns a
   job — poll `prompt check-generated-artifact`.
6. **Checkpoint** with `memory create-state`.

## Quoting the JSON

The `--prompts` value is JSON, so it carries literal double-quotes. Put it after
the structured `--` delimiter as one argument:

- Bash/zsh: single-quote the compact JSON normally: `'[{"type":"text",…}]'`.
- Windows PowerShell: native argument marshalling needs each literal JSON quote
  tripled inside the single-quoted value: `'[{"""type""":"""text""",…}]'`.

Use top-level `--dry-run` to inspect the reconstructed `tool` string without
connecting or executing. If quoting fights you, use a saved `customPrompt` so
the inline JSON stays small.

## Worked examples

**A — inline prompt, one note as context, result to stdout:**

```
nexus use \
  --json --workspace research --session prompt-run \
  --memory "summarizing the auth flow note" --goal "get a 3-bullet summary" \
  -- prompt execute --prompts '[{"type":"text","prompt":"Summarize this note in 3 bullets","contextFiles":["Projects/Auth/flow.md"]}]'
```

**B — saved prompt + note context, write the result back into a note:**

```
# find the saved prompt's name
nexus use --workspace research --session prompt-run \
  --memory "looking for my weekly-review prompt" --goal "list saved prompts" \
  -- prompt list

# run it over this week's notes and append the output to the review note
nexus use \
  --workspace research --session prompt-run \
  --memory "have the daily notes; running weekly-review" --goal "append a weekly review" \
  -- prompt execute --prompts '[{"type":"text","customPrompt":"weekly-review","contextFiles":["Daily/2026-07-14.md","Daily/2026-07-15.md"],"action":{"type":"append","targetPath":"Reviews/2026-W29.md"}}]'
```

**C — image, saved to the vault:**

```
nexus use \
  --workspace research --session prompt-run \
  --memory "need a logo asset" --goal "generate a logo image" \
  -- prompt execute --prompts '[{"type":"image","prompt":"a minimalist logo, teal on white","savePath":"Assets/logo.png","aspectRatio":"1:1"}]'
# then poll:
nexus use --workspace research --session prompt-run \
  --memory "waiting on the logo" --goal "check image generation status" \
  -- prompt check-generated-artifact --id <job-id>
```

## Pitfalls

- **Forgetting `type`/`prompt`** — both are required on every item.
- **JSON quoting** — use ordinary compact JSON in Bash/zsh; triple each literal
  `"` for Windows PowerShell as shown above. Confirm with `--dry-run`; prefer
  `customPrompt` for anything reusable.
- **`contextFiles` are vault-relative** — the same confinement as everywhere;
  no `..`/absolute.
- **A bad `model`/`provider`** — check `prompt list-models` first.
- **Media is async** — `type: image`/`generate-*` returns a job; poll
  `prompt check-generated-artifact`, don't expect the bytes inline.
- **`action` overwrites** — `replace` needs anchor text (`start`/`end`); `create`
  refuses to clobber; append/prepend are safe additive writes.
