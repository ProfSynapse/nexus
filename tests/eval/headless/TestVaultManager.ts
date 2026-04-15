/**
 * tests/eval/headless/TestVaultManager.ts — Reset, seed, snapshot, and
 * restore a test vault directory for scenario isolation.
 *
 * Each eval scenario starts from a known state. TestVaultManager provides
 * the primitives to clear the vault, seed it with fixture files, and
 * snapshot/restore for sub-scenario isolation.
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';

export class TestVaultManager {
  private basePath: string;
  private snapshotPath: string | null = null;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Remove all files and folders from the test vault directory.
   * Recreates the empty directory afterward.
   */
  reset(): void {
    if (fs.existsSync(this.basePath)) {
      fs.rmSync(this.basePath, { recursive: true, force: true });
    }
    fs.mkdirSync(this.basePath, { recursive: true });
  }

  /**
   * Write fixture files into the test vault.
   * Keys are vault-relative paths, values are file content strings.
   *
   * @param files - Map of relative path to content
   */
  seed(files: Record<string, string>): void {
    for (const [relativePath, content] of Object.entries(files)) {
      const absPath = nodePath.join(this.basePath, relativePath);
      const dir = nodePath.dirname(absPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, content, 'utf-8');
    }
  }

  /**
   * Take a snapshot of the current vault state by copying all files to
   * a temporary sibling directory.
   */
  snapshot(): void {
    this.snapshotPath = this.basePath + '__snapshot';
    if (fs.existsSync(this.snapshotPath)) {
      fs.rmSync(this.snapshotPath, { recursive: true, force: true });
    }
    this.copyDir(this.basePath, this.snapshotPath);
  }

  /**
   * Restore the vault to the last snapshot. Clears the current vault
   * and copies the snapshot back.
   */
  restore(): void {
    if (!this.snapshotPath || !fs.existsSync(this.snapshotPath)) {
      throw new Error('No snapshot to restore — call snapshot() first');
    }

    // Clear current vault
    if (fs.existsSync(this.basePath)) {
      fs.rmSync(this.basePath, { recursive: true, force: true });
    }

    // Copy snapshot back
    this.copyDir(this.snapshotPath, this.basePath);
  }

  /**
   * Clean up the snapshot directory if it exists.
   */
  cleanup(): void {
    if (this.snapshotPath && fs.existsSync(this.snapshotPath)) {
      fs.rmSync(this.snapshotPath, { recursive: true, force: true });
      this.snapshotPath = null;
    }
  }

  /**
   * Recursively copy a directory.
   */
  private copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = nodePath.join(src, entry.name);
      const destPath = nodePath.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
