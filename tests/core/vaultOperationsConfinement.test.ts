/**
 * Phase 2 confinement tests for the typed VaultOperations facade.
 *
 * The mutators (writeFile / ensureDirectory / deleteFile / deleteFolder /
 * moveFile / copyFile / batchWrite) accept a branded {@link VaultPath}, not a
 * raw string. This makes "an unvalidated path reaches vault.create" a COMPILE
 * error: the only way to obtain a VaultPath is through the vaultPath resolver,
 * which rejects `..`/absolute/home paths at the untrusted boundary and
 * canonicalizes trusted-internal paths.
 *
 * See docs/plans/vault-path-confinement-plan.md (Phase 2).
 */

import { VaultOperations } from '@/core/VaultOperations';
import {
  resolveVaultPath,
  tryResolveVaultPath,
  vaultPathFromTrusted,
  VaultPathError,
} from '@/core/vaultPath';

function makeVaultOperations() {
  const create = jest.fn().mockResolvedValue(undefined);
  const modify = jest.fn().mockResolvedValue(undefined);
  const createFolder = jest.fn().mockResolvedValue(undefined);
  const getFileByPath = jest.fn().mockReturnValue(null);
  const getFolderByPath = jest.fn().mockReturnValue(null);
  const adapter = {
    exists: jest.fn().mockResolvedValue(false),
    write: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
  };
  const vault = { create, modify, createFolder, getFileByPath, getFolderByPath, adapter };

  const pathManager = {
    normalizePath: jest.fn((p: string) => (p.startsWith('/') ? p.slice(1) : p)),
    getParentPath: jest.fn((p: string) => p.split('/').slice(0, -1).join('/')),
    ensureParentExists: jest.fn().mockResolvedValue(undefined),
  };
  const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  };
  const app = { fileManager: { trashFile: jest.fn(), renameFile: jest.fn() } };

  // The mocks are structurally compatible with what the mutators exercise; the
  // facade's constructor types are widened via `unknown` for the test doubles.
  const ops = new VaultOperations(
    app as never,
    vault as never,
    pathManager as never,
    logger as never
  );
  return { ops, vault, create };
}

describe('VaultOperations — branded-path boundary (compile-time)', () => {
  // Type-only assertions. Never executed at runtime; ts-jest still type-checks
  // the body, so a missing compile error on a raw-string call FAILS the build.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function _typeOnlyAssertions(ops: VaultOperations) {
    const good = resolveVaultPath('notes/a.md');

    // A raw string must NOT be accepted by any mutator — this is the whole point.
    // @ts-expect-error — a raw string is not a VaultPath
    await ops.writeFile('notes/a.md', 'body');
    // @ts-expect-error — a raw string is not a VaultPath
    await ops.ensureDirectory('notes');
    // @ts-expect-error — a raw string is not a VaultPath
    await ops.deleteFile('notes/a.md');
    // @ts-expect-error — a raw string is not a VaultPath
    await ops.deleteFolder('notes');
    // @ts-expect-error — a raw string is not a VaultPath
    await ops.moveFile('a.md', good);
    // @ts-expect-error — a raw string is not a VaultPath
    await ops.copyFile(good, 'b.md');
    // @ts-expect-error — a raw string is not a VaultPath in BatchWriteOperation
    await ops.batchWrite([{ path: 'a.md', content: 'x' }]);

    // A resolved / trusted VaultPath IS accepted (no error expected here).
    await ops.writeFile(good, 'body');
    await ops.ensureDirectory(vaultPathFromTrusted('.workspaces'));
  }

  it('keeps the type-only assertions referenced', () => {
    expect(typeof _typeOnlyAssertions).toBe('function');
  });
});

describe('VaultOperations — an escaping path can never be branded', () => {
  const escaping = ['../../../../tmp/ESCAPE.md', '~/ESCAPE.md', 'notes/../../etc/x'];

  it.each(escaping)('resolveVaultPath throws for %s (never reaches the facade)', (p) => {
    expect(() => resolveVaultPath(p)).toThrow(VaultPathError);
    expect(tryResolveVaultPath(p).ok).toBe(false);
  });

  it('writes a legitimate resolved path through to vault.create', async () => {
    const { ops, create } = makeVaultOperations();
    const ok = await ops.writeFile(resolveVaultPath('notes/a..b.md'), 'body');
    expect(ok).toBe(true);
    // `a..b.md` is a legit name (segment-based check), so it is NOT rejected and
    // the write reaches the vault at the canonical, confined path.
    expect(create).toHaveBeenCalledWith('notes/a..b.md', 'body');
  });
});
