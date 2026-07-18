/**
 * vaultPath — the single containment boundary for caller-supplied vault paths.
 *
 * Location: src/core/vaultPath.ts
 *
 * ## Why this exists
 *
 * Obsidian's `normalizePath` collapses separators but does NOT resolve or strip
 * `..` segments. On desktop, a `..`-bearing path handed to `vault.create()` /
 * `adapter.write()` resolves against the vault base directory with Node's
 * `path.join`, which follows `..` and escapes the vault entirely. A pre-existing
 * traversal guard (`ObsidianPathManager.validatePath`) existed but was never
 * called on the write path — every mutation used the inert leading-slash-only
 * normalizer instead. See `docs/plans/vault-path-confinement-plan.md`.
 *
 * ## Design principle
 *
 * Make an unvalidated path un-writable by construction. The only way to obtain a
 * {@link VaultPath} is to pass through this module. Untrusted, caller-supplied
 * paths go through {@link resolveVaultPath} / {@link tryResolveVaultPath}, which
 * REJECT traversal, absolute, and home-expansion paths. Trusted, code-controlled
 * paths (event store, cache, migration internals) go through
 * {@link vaultPathFromTrusted}, which canonicalizes but never rejects.
 *
 * ## Traversal check is SEGMENT-BASED, not substring-based
 *
 * We split on `/` and reject a segment equal to `..`. We deliberately do NOT use
 * `includes('..')`, which would false-positive on legitimate names like
 * `notes/a..b.md` or `foo..bar/x.md` — those MUST pass.
 *
 * ## Mobile-safe
 *
 * No Node built-ins, no heavy imports — only Obsidian's `normalizePath`. Safe to
 * load during module init on Obsidian mobile.
 */

import { normalizePath } from 'obsidian';

/**
 * A vault-relative path that has been validated/canonicalized by this module.
 * Branded so a raw `string` cannot be substituted for it in Phase 2 typing.
 * Constructable ONLY via {@link resolveVaultPath}, {@link tryResolveVaultPath},
 * or {@link vaultPathFromTrusted}.
 */
export type VaultPath = string & { readonly __brand: 'VaultPath' };

/** Thrown by {@link resolveVaultPath} when a caller-supplied path is rejected. */
export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

const brand = (path: string): VaultPath => path as VaultPath;

/**
 * True when the raw path is filesystem-absolute in a way that is NOT vault-root
 * relative: a Windows drive (`C:\x` / `C:/x`) or a UNC / leading backslash
 * (`\\server` / `\x`). These are genuinely off-vault and rejected.
 *
 * A POSIX leading slash (`/notes/x.md`) is deliberately NOT treated as absolute:
 * it is stripped and interpreted as vault-root-relative (the leading empty
 * segment is dropped during the segment scan below), matching the long-standing
 * lenient behavior and the File-Picker "strip leading slash" convention. This is
 * safe because the real escape vector is `..`, which the segment scan still
 * rejects (`/../x` → `..` segment → rejected).
 */
function isAbsolute(raw: string): boolean {
  return /^[A-Za-z]:/.test(raw) || raw.startsWith('\\');
}

/**
 * Non-throwing resolver for UNTRUSTED, caller-supplied paths. Returns a branded
 * {@link VaultPath} on success or a clear, user-facing error message on failure.
 *
 * Rejection rules (in order):
 *   1. Non-string or empty/whitespace-only input.
 *   2. Windows-drive / UNC / backslash-absolute paths. (A POSIX leading `/` is
 *      NOT rejected — it is stripped to vault-root-relative; see {@link isAbsolute}.)
 *   3. A leading `~` (home directory expansion).
 *   4. Any `..` path segment (directory traversal) — segment-based, so a name
 *      like `a..b.md` is NOT affected.
 *   5. Any `.` path segment (except a lone `.`/`` which means the vault root,
 *      preserved so tools that special-case root keep working).
 *
 * The returned path is canonicalized (separators collapsed, empty segments and a
 * trailing slash dropped). A lone `.`/`` resolves to `''` (vault root).
 */
export function tryResolveVaultPath(
  raw: string
): { ok: true; path: VaultPath } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Path must be a string.' };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'Path cannot be empty.' };
  }

  if (isAbsolute(trimmed)) {
    return { ok: false, error: 'Path must be relative to the vault, not absolute.' };
  }

  if (trimmed.startsWith('~')) {
    return {
      ok: false,
      error: 'Path cannot start with "~". Home directory expansion is not allowed; use a vault-relative path.',
    };
  }

  const normalized = normalizePath(trimmed);

  // A lone '.' or '' means the vault root. Tools that accept a root target
  // special-case this before calling here, but preserve it for safety.
  if (normalized === '' || normalized === '.') {
    return { ok: true, path: brand('') };
  }

  const out: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '') {
      continue; // collapse leading/trailing/duplicate separators
    }
    if (segment === '..') {
      return {
        ok: false,
        error: 'Path cannot contain ".." segments. Directory traversal outside the vault is not allowed.',
      };
    }
    if (segment === '.') {
      return { ok: false, error: 'Path cannot contain "." segments.' };
    }
    out.push(segment);
  }

  return { ok: true, path: brand(out.join('/')) };
}

/**
 * Throwing resolver for UNTRUSTED, caller-supplied paths. Wraps
 * {@link tryResolveVaultPath} and throws {@link VaultPathError} on rejection.
 * Use at boundaries where a thrown error is caught and surfaced; prefer
 * {@link tryResolveVaultPath} where the caller returns a `{ success, error }`
 * result shape.
 */
export function resolveVaultPath(raw: string): VaultPath {
  const result = tryResolveVaultPath(raw);
  if (!result.ok) {
    throw new VaultPathError(result.error);
  }
  return result.path;
}

/**
 * Canonicalize a TRUSTED, code-controlled path into a {@link VaultPath} WITHOUT
 * rejection. `.`/empty segments are dropped and `..` segments pop the prior
 * segment (they can never climb above the root, so the result never begins with
 * `..`). Introduced for Phase 2 typing of `VaultOperations` internals.
 *
 * ⚠️ Trusted callers ONLY — pass code-supplied paths (event store, cache,
 * migration, hidden `.obsidian/...` writes), never raw LLM/agent input. Untrusted
 * input must go through {@link tryResolveVaultPath} / {@link resolveVaultPath}.
 */
export function vaultPathFromTrusted(codeControlledPath: string): VaultPath {
  const out: string[] = [];
  for (const segment of normalizePath(codeControlledPath ?? '').split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return brand(out.join('/'));
}
