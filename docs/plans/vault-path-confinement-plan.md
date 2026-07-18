# Vault Path Confinement — Design Plan

**Status:** Design (red-team confirmed the vuln; implementation pending)
**Date:** 2026-07-18
**Author:** red-team finding + design discussion (ProfSynapse + Claude)
**Branch:** `fix/vault-path-confinement` (off `main`)
**Severity:** High — arbitrary file write/mkdir outside the vault, reachable by any caller of `toolManager_useTools` (the local CLI **and** the existing Claude Desktop MCP connector).

> **How it was found:** red-teaming the local CLI bridge (`docs/plans/local-cli-agent-bridge-plan.md`).
> `nexus use "content write --path ../../../../../../tmp/x.md --content PWNED"` created a real file
> in `/tmp`, and again in `~`. `storage createFolder --path ../../..` created a directory outside the
> vault. The CLI only *surfaced* a pre-existing core bug — the same `useTools` entry point is what
> Claude Desktop drives over MCP.

## 1. The vulnerability

`content write`, `storage createFolder` (and, by shared code path, `insert` / `replace` / `setProperty` /
`storage move` / `copy` / `archive`) accept a caller-supplied `--path` and hand it, essentially raw, to
the Obsidian vault API. On desktop, `vault.create()` / `vault.adapter.write()` resolve the path against the
vault base directory with Node's `path.join`, which **follows `..`** and escapes the vault.

| Op | Path goes to | `../…` behavior |
|----|--------------|-----------------|
| `content read`, `storage list` | `vault.getAbstractFileByPath()` → in-memory **index lookup** | not in index → `null` → "not found." Never touches disk. **Confined (by accident).** |
| `content write`, `storage createFolder` | `vault.create()` / `adapter.write()` → desktop `FileSystemAdapter` → `path.join(vaultBase, p)` | Node resolves `..` → **writes outside the vault.** |

Absolute paths (`/tmp/x.md`) are neutralized only incidentally — the leading `/` is stripped, making them
vault-relative. `..` is never touched.

## 2. Root cause (not "we forgot to check `..`")

The traversal guard **already exists** and is correct:

```ts
// src/core/ObsidianPathManager.ts:51
validatePath(path): PathValidationResult {
  if (path.includes('..') || path.includes('~')) {              // line 56 — the guard
    errors.push('Path traversal sequences are not allowed for security');
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {        // absolute rejection
    errors.push('Path should be relative to vault root, not absolute');
  }
  ...
}

// same class, line 43 — what the write path ACTUALLY calls:
normalizePath(path): string { return normalizePath(path); }     // Obsidian's; does NOT collapse '..'
```

Every mutation (`VaultOperations.writeFile/ensureDirectory/moveFile`, and the tools that bypass even that)
calls **`normalizePath()`**, never **`validatePath()`**. The guard sits one method away from the code it is
meant to protect, permanently un-called on the dangerous path. `validatePath` is invoked only in a couple of
batch spots (ObsidianPathManager.ts:361/381), never inline before a `vault.create`.

The **7 copy-pasted leading-slash-only normalizers** are all symptoms of the same split — normalization got
copied everywhere; validation didn't:

```
src/utils/pathUtils.ts:11                              (the "shared" one — also inert)
src/core/ObsidianPathManager.ts:43                     (facade's normalize)
src/agents/contentManager/tools/write.ts:139
src/agents/contentManager/tools/insert.ts:61
src/agents/contentManager/tools/replace.ts:235
src/agents/contentManager/tools/setProperty.ts:121
src/agents/contentManager/utils/ContentOperations.ts:15
src/agents/storageManager/tools/baseDirectory.ts:29
```

> **This is the same disease as the pinned project learning** *"tool-schema `required`/`oneOf`/`enum` is NOT
> runtime-validated — validation guards MUST live in the service/normalizer layer, not the schema."* A guard
> that exists but is off the enforced path. A per-tool `reject('..')` bandaid would be the third instance of
> the same mistake: an opt-in guard callers can skip.

## 3. Design principle

> **Make an unvalidated path un-writable by construction.** The only way to obtain a path the mutation layer
> will accept is to pass through one function that *both* validates and normalizes. Confinement stops being a
> check each caller may or may not run and becomes a property of the type system.

This mirrors the fix the Skills App already shipped locally (`src/agents/apps/skills/services/skillPaths.ts`:
`resolveVaultPath` / `assertInside` / `isSafePathSegment`) — generalize that idea to the whole plugin.

### Trusted vs untrusted paths (the nuance that keeps this from breaking internals)

Not every path is caller-supplied. Internal, trusted callers legitimately write to plugin-config locations
that a strict untrusted check would (wrongly) reject or that simply must not be blocked:

- Event store / cache / migration writing under `<configDir>/plugins/<id>/…` and `<rootPath>/data/…`
- Hidden-file writes via `adapter.write` (`.obsidian/...`) — `VaultOperations.isHiddenPath` path

So the confinement (`..`/`~`/absolute **rejection**) applies at the **untrusted tool boundary**
(contentManager / storageManager / canvasManager tools that take an LLM/agent-supplied `--path`). Internal
writes still route through the typed facade for canonicalization, but are constructed from code-controlled
paths, not rejected. The branded type carries "this path was resolved"; the *rejection policy* lives in the
resolver used at the untrusted boundary.

## 4. The fix, in three phases

Phase 1 closes the hole and is shippable on its own. Phases 2–3 make regression structurally impossible.

### Phase 1 — Fused resolver + wire the untrusted write boundary (closes the hole)

1. **New module `src/core/vaultPath.ts`** (or generalize `skillPaths.ts` up to core):
   - `resolveVaultPath(raw: string): VaultPath` — the single chokepoint. Steps:
     1. Reject non-string / empty.
     2. Reject absolute (`startsWith('/')`, `^[A-Za-z]:`, `startsWith('\\')`).
     3. Reject `~` as the first segment.
     4. Normalize (Obsidian `normalizePath`), then **segment-based** traversal check: `split('/')` and
        reject if any segment `=== '..'`. **Do NOT use `includes('..')`** — it false-positives on legit
        names like `notes/a..b.md`. (Reject `.` segments too, except a bare `.` meaning root where the tool
        already special-cases it.)
     5. Return a **branded** `VaultPath` (`type VaultPath = string & { readonly __brand: 'VaultPath' }`)
        constructable *only* here.
   - `tryResolveVaultPath(raw): { ok: true; path: VaultPath } | { ok: false; error: string }` — non-throwing
     variant so tools return the existing `{ success:false, error }` shape with a clean message.
2. **Wire it at the untrusted boundary** — replace the leading-slash-only normalize in each write-side tool
   with `tryResolveVaultPath` and early-return the error on failure:
   - `contentManager/tools/write.ts`, `insert.ts`, `replace.ts`, `setProperty.ts`
   - `contentManager/utils/ContentOperations.ts` (createContent/append/prepend/etc. — the shared write core)
   - `storageManager/tools/createFolder.ts`, `move.ts`, `copy.ts`, `archive.ts` (validate **both** source and
     target for move/copy)
   - `canvasManager` write/update tools (same `--path` surface)
3. **Tests** — `tests/core/vaultPath.test.ts` (resolver unit tests: `..` at every position, `~`, absolute,
   backslash, mixed, false-positive names like `a..b.md` must PASS) + per-tool regression tests feeding `../`
   and absolute paths and asserting a rejection result (not a thrown/escaped write).
4. **Re-run the red-team probes** (§6) and confirm every write-escape is now blocked while normal
   vault-relative writes still succeed.

### Phase 2 — Type the boundary (make the mistake a compile error)

1. Change `VaultOperations` mutators (`writeFile`, `ensureDirectory`, `moveFile`, `copyFile`, `deleteFile`,
   `deleteFolder`, `batchWrite`) to accept **`VaultPath`**, not `string`.
2. Callers construct a `VaultPath` at their trust boundary: untrusted tools via `resolveVaultPath` (rejecting
   on bad input); internal callers via an explicit `vaultPathFromTrusted(codeControlledString)` constructor
   that canonicalizes but does not reject (documented, greppable, code-supplied args only).
3. **Delete** the 7 scattered normalizers and the inert `src/utils/pathUtils.normalizePath` (or reduce it to a
   re-export of the resolver). Now a raw `string` literally cannot reach `vault.create` — picking the cheap
   path is a type error.

### Phase 3 — Arch guard (stop regression across the 35 call sites)

1. **eslint `no-restricted-syntax`** (or a CI grep gate) forbidding direct
   `vault.create` / `vault.modify` / `vault.createBinary` / `vault.createFolder` / `adapter.write` /
   `adapter.writeBinary` outside `src/core/VaultOperations.ts`. ~35 files call these directly today
   (inventory produced in Phase 0 recon); each must either route through `VaultOperations` or land on a
   documented allowlist (event store / cache / migration internals).
2. Config-level rule (matching the existing `no-nodejs-modules` / `no-deprecated` override style in
   `eslint.config.mjs`) so the obsidian-releases bot's inline-disable rejection doesn't bite.

## 5. Work breakdown (for parallel agents)

| Track | Scope | Depends on | Conflicts with |
|-------|-------|------------|----------------|
| **A — Phase 1** | `vaultPath.ts` + wire content/storage/canvas write tools + unit/regression tests + red-team re-probe | — | owns the tool files |
| **B — Phase 0 recon** | Authoritative inventory of all `vault.*`/`adapter.*` mutation call sites, classify **trusted-internal vs untrusted-boundary**, draft the Phase 3 eslint rule + allowlist (as a doc/patch, **not applied**) | — | read-only + doc; no code conflict with A |

A is the critical path and self-contained. B is read-only prep that unblocks Phases 2–3; it must not edit the
tool files A owns. Phase 2 (typed facade migration) follows A landing and consumes B's inventory — sequenced
after review, not run concurrently on the same files.

## 6. Red-team acceptance probes (must all be BLOCKED after Phase 1)

Run against a live vault via the CLI (`nexus use "<cmd>" --vault code --memory .. --goal ..`); each must
return a clean rejection and leave **no file on disk outside the vault**:

- `content write --path ../../../../../../tmp/ESCAPE.md --content x`
- `content write --path ../../../../../../../Users/<user>/ESCAPE.md --content x`
- `storage createFolder --path ../../../../../../tmp/ESCAPE-dir`
- `content insert` / `content replace` / `content setProperty` with a `../` path
- `storage move --path notes/a.md --new-path ../../../../tmp/ESCAPE.md`

Must still **SUCCEED** (no false positives):

- `content write --path notes/a..b.md --content x` (legit name containing `..`)
- `content write --path Nexus/data/legit.md --content x`
- normal vault-relative reads/writes/lists as before

## 7. Non-goals

- Socket authentication / capability-scoping of the CLI (separate threat-model discussion; the socket is
  already `0600` owner-only). This plan is strictly about vault-path confinement.
- Sandboxing `data runPython` or the web tools' network reach.
- Blocking writes into `.obsidian/` config from the untrusted boundary — worth considering as a follow-up
  policy layer, but out of scope here (the traversal escape is the acute issue).

## 8. Rollout

Ship Phase 1 as the security fix (fast, closes the hole, fully tested + red-teamed). Land Phase 2 + the
Phase 3 arch guard as a follow-up hardening PR once B's inventory is reviewed. Because the bug is reachable
over the existing MCP connector, Phase 1 hardens Claude Desktop too, not just the new CLI.
