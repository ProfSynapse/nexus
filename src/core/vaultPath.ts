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
 * Windows reserved device names. A file named after any of these (with or without
 * an extension, in any folder) maps to a device, not a file — writes silently
 * vanish (data loss) or block on a device (hang). Matched case-insensitively
 * against the segment's basename (portion before the first dot).
 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Vault-internal directories that are inside the vault (so traversal confinement
 * passes) but must never receive an UNTRUSTED write, because their contents are
 * executed: the Obsidian config folder holds plugin code and config
 * (`plugins/<x>/main.js`, `data.json`) that Obsidian runs on load, and `.git`
 * holds hooks that run on the next git operation — both are remote-code-execution
 * vectors. Trusted, code-controlled writes go through {@link vaultPathFromTrusted},
 * which is exempt.
 *
 * `.git` is fixed. The Obsidian config folder is user-configurable (defaults to
 * `.obsidian` but can be renamed via `Vault#configDir`), so it is injected once
 * at startup through {@link setConfinementConfigDir} rather than hardcoded — this
 * keeps the module dependency-free/mobile-safe and correct for custom config dirs.
 * Matched case-insensitively on the first segment (macOS/Windows are case-insensitive).
 */
const FIXED_DENY_ROOTS = new Set(['.git']);
let configDirDeny: string | null = null;

/**
 * Register the vault's Obsidian config directory (from `app.vault.configDir`) so
 * untrusted writes into it are rejected. Call once during plugin startup, before
 * any agent-facing server accepts tool calls. Idempotent.
 */
export function setConfinementConfigDir(configDir: string | null | undefined): void {
  const trimmed = (configDir ?? '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  configDirDeny = trimmed === '' ? null : trimmed;
}

/** True when the first path segment targets a deny-listed, executable-content root. */
function isDeniedRoot(firstSegment: string): boolean {
  const seg = firstSegment.toLowerCase();
  return FIXED_DENY_ROOTS.has(seg) || (configDirDeny !== null && seg === configDirDeny);
}

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

  // Control characters (incl. NUL) are never legitimate in a vault path and can
  // defeat downstream string handling; Obsidian's normalizePath does not strip them.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) {
    return { ok: false, error: 'Path cannot contain control characters.' };
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
    // Windows silently strips trailing dots and spaces at the syscall layer, so
    // a segment like ".. " or "..." reaches the filesystem as ".." — a traversal
    // the literal comparison below would miss. Compare the stripped form, and
    // reject segments that strip to nothing (all dots/spaces). Legit names like
    // "a..b.md" or "notes." are unaffected: they strip to a non-dot name.
    const winCollapsed = segment.replace(/[. ]+$/, '');
    if (segment === '..' || winCollapsed === '..') {
      return {
        ok: false,
        error: 'Path cannot contain ".." segments. Directory traversal outside the vault is not allowed.',
      };
    }
    if (segment === '.' || winCollapsed === '.' || winCollapsed === '') {
      return { ok: false, error: 'Path cannot contain "." segments or segments of only dots/spaces.' };
    }
    // NTFS alternate data streams: a ':' outside a leading drive letter (already
    // rejected as absolute) writes a hidden stream on Windows. ':' is also an
    // invalid filename char there, so reject it everywhere for a portable vault.
    if (segment.includes(':')) {
      return { ok: false, error: 'Path cannot contain ":" — it is not a valid file name character.' };
    }
    // Windows reserved device names (CON, NUL, COM1, …) — check the Windows-collapsed
    // basename so "NUL. " / "NUL.md" are caught too.
    if (WIN_RESERVED.test(winCollapsed.split('.')[0])) {
      return { ok: false, error: `"${segment}" is a reserved device name and cannot be used as a file or folder name.` };
    }
    out.push(segment);
  }

  if (out.length > 0 && isDeniedRoot(out[0])) {
    return {
      ok: false,
      error: `Writes to "${out[0]}/" are not allowed — it holds executable plugin/config or git internals.`,
    };
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
    // A ".." (incl. the Windows "dot-dot + trailing spaces" form that collapses
    // to ".." at the syscall layer) pops the prior segment. Check this BEFORE the
    // empty/current-dir skip, since ".." would otherwise strip to empty.
    if (segment === '..' || /^\.\. *$/.test(segment)) {
      out.pop();
      continue;
    }
    // Empty, current-dir ".", or an all-dots/spaces component (Windows strips
    // trailing dots/spaces to nothing) → no-op segment, skip.
    if (segment === '' || segment.replace(/[. ]+$/, '') === '') {
      continue;
    }
    out.push(segment);
  }
  return brand(out.join('/'));
}
