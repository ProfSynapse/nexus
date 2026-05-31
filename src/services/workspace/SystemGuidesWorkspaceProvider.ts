import { type App, requestUrl } from 'obsidian';
import type { VaultOperations } from '../../core/VaultOperations';
import { resolveVaultRoot } from '../../database/storage/VaultRootResolver';
import type { LoadWorkspaceResult } from '../../database/types/workspace/ParameterTypes';
import type { WorkspaceContext } from '../../database/types/workspace/WorkspaceTypes';
import {
  type ManagedGuideDefinition,
  MANAGED_GUIDES,
  MANAGED_GUIDES_MANIFEST_PATH,
  MANAGED_GUIDES_VERSION
} from '../../guides/ManagedGuidesCatalog';
import type { MCPSettings } from '../../types/plugin/PluginTypes';
import type { IndividualWorkspace } from '../../types/storage/StorageTypes';

export const SYSTEM_GUIDES_WORKSPACE_ID = '__system_guides__';
export const SYSTEM_GUIDES_WORKSPACE_NAME = 'Assistant guides';

/**
 * URL for the bundled guides manifest hosted on GitHub.
 * Contains all guide content and a version string. Fetched on startup
 * so that guide content can be updated without a plugin release.
 */
const REMOTE_GUIDES_URL =
  'https://raw.githubusercontent.com/ProfSynapse/nexus/main/src/guides/guides-manifest.json';

interface RemoteGuidesManifest {
  version: string;
  guides: ManagedGuideDefinition[];
}

interface ManagedGuideManifestFile {
  path: string;
  hash: string;
}

interface ManagedGuideManifest {
  version: string;
  pluginVersion: string;
  updatedAt: string;
  files: ManagedGuideManifestFile[];
}

export interface SystemGuidesWorkspaceSummary {
  id: string;
  name: string;
  description: string;
  rootFolder: string;
  entrypoint: string;
  isSystemManaged: true;
}

export interface SystemGuidesLoadResult {
  workspace: IndividualWorkspace;
  data: LoadWorkspaceResult['data'];
  workspacePromptContext: WorkspaceContext;
  workspaceContext: NonNullable<LoadWorkspaceResult['workspaceContext']>;
}

interface GuideInventoryItem {
  path: string;
  modified: number;
  size: number;
}

export class SystemGuidesWorkspaceProvider {
  constructor(
    private readonly app: App,
    private readonly pluginVersion: string,
    private readonly vaultOperations: VaultOperations,
    private readonly getSettings: () => Pick<MCPSettings, 'storage'> | undefined
  ) {}

  matchesWorkspaceId(identifier: string): boolean {
    return identifier === SYSTEM_GUIDES_WORKSPACE_ID;
  }

  async ensureGuidesInstalled(): Promise<void> {
    const { guidesPath } = resolveVaultRoot(this.getSettings(), {
      configDir: this.app.vault.configDir
    });

    await this.vaultOperations.ensureDirectory(guidesPath);
    await this.vaultOperations.ensureDirectory(`${guidesPath}/_meta`);

    const manifestPath = `${guidesPath}/${MANAGED_GUIDES_MANIFEST_PATH}`;
    const previousManifest = await this.readManifest(manifestPath);

    // Use remote guides if available and newer, otherwise fall back to hardcoded defaults
    const guides = await this.resolveGuideSource(previousManifest);

    for (const guide of guides) {
      const filePath = `${guidesPath}/${guide.path}`;
      const previousHash = previousManifest?.files.find(file => file.path === guide.path)?.hash;
      const existingContent = await this.vaultOperations.readFile(filePath, false);

      const shouldWrite =
        existingContent === null ||
        existingContent === guide.content ||
        (previousHash !== undefined && this.hashContent(existingContent) === previousHash);

      if (shouldWrite) {
        await this.vaultOperations.writeFile(filePath, guide.content);
      }
    }

    const effectiveVersion = guides === MANAGED_GUIDES
      ? MANAGED_GUIDES_VERSION
      : (this.lastRemoteVersion ?? MANAGED_GUIDES_VERSION);

    const manifest: ManagedGuideManifest = {
      version: effectiveVersion,
      pluginVersion: this.pluginVersion,
      updatedAt: new Date().toISOString(),
      files: guides.map(guide => ({
        path: guide.path,
        hash: this.hashContent(guide.content)
      }))
    };

    await this.vaultOperations.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }

  /**
   * Track the version from the last successful remote fetch so it can be
   * written into the local manifest.
   */
  private lastRemoteVersion: string | null = null;

  /**
   * Determine which guide source to use: remote (GitHub) or hardcoded fallback.
   * Fetches remote manifest and compares its version against the local manifest.
   * Returns the hardcoded defaults on any failure (offline, rate limited, parse error).
   */
  private async resolveGuideSource(
    localManifest: ManagedGuideManifest | null
  ): Promise<readonly ManagedGuideDefinition[]> {
    try {
      const remote = await this.fetchRemoteGuides();
      if (!remote) {
        return MANAGED_GUIDES;
      }

      const localVersion = localManifest?.version ?? MANAGED_GUIDES_VERSION;
      if (this.compareVersionStrings(remote.version, localVersion) > 0) {
        this.lastRemoteVersion = remote.version;
        return remote.guides;
      }

      // Remote is not newer — use hardcoded defaults (which match the bundled version)
      return MANAGED_GUIDES;
    } catch {
      return MANAGED_GUIDES;
    }
  }

  /**
   * Fetch the bundled guides manifest from GitHub using Obsidian's requestUrl.
   * Returns null on any network or parse failure — callers fall back to hardcoded content.
   */
  private async fetchRemoteGuides(): Promise<RemoteGuidesManifest | null> {
    try {
      const response = await requestUrl({
        url: REMOTE_GUIDES_URL,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (response.status !== 200) {
        return null;
      }

      const data = response.json as RemoteGuidesManifest;
      if (!data?.version || !Array.isArray(data?.guides) || data.guides.length === 0) {
        return null;
      }

      // Basic structural validation — each guide needs path and content
      const valid = data.guides.every(
        (g: ManagedGuideDefinition) => typeof g.path === 'string' && typeof g.content === 'string'
      );
      if (!valid) {
        return null;
      }

      return data;
    } catch {
      // Network failure, rate limit, timeout — silent fallback
      return null;
    }
  }

  /**
   * Simple lexicographic version comparison for dot-separated version strings.
   * Returns positive if a > b, negative if a < b, zero if equal.
   */
  private compareVersionStrings(a: string, b: string): number {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    const length = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < length; i++) {
      const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }

  getWorkspaceSummary(): SystemGuidesWorkspaceSummary {
    const { guidesPath } = resolveVaultRoot(this.getSettings(), {
      configDir: this.app.vault.configDir
    });

    return {
      id: SYSTEM_GUIDES_WORKSPACE_ID,
      name: SYSTEM_GUIDES_WORKSPACE_NAME,
      description: 'System-managed documentation for built-in capabilities and workflows.',
      rootFolder: guidesPath,
      entrypoint: `${guidesPath}/index.md`,
      isSystemManaged: true
    };
  }

  getWorkspace(): IndividualWorkspace {
    const summary = this.getWorkspaceSummary();
    const context = this.buildWorkspaceContext(summary.entrypoint);

    return {
      id: summary.id,
      name: summary.name,
      description: summary.description,
      rootFolder: summary.rootFolder,
      created: 0,
      lastAccessed: 0,
      isActive: false,
      isArchived: false,
      context,
      sessions: {}
    };
  }

  async loadWorkspaceData(limit = 5): Promise<SystemGuidesLoadResult> {
    await this.ensureGuidesInstalled();
    const workspace = this.getWorkspace();
    const inventory = await this.collectGuideInventory(workspace.rootFolder);
    const entrypoint = `${workspace.rootFolder}/index.md`;
    const entrypointContent = await this.vaultOperations.readFile(entrypoint, false);
    const workspacePromptContext = workspace.context ?? this.buildWorkspaceContext(entrypoint);

    const boundedInventory = inventory.slice(0, Math.max(limit * 5, 10));
    const recentFiles = inventory
      .slice()
      .sort((left, right) => right.modified - left.modified)
      .slice(0, limit)
      .map(item => ({
        path: item.path,
        modified: item.modified
      }));

    return {
      workspace,
      workspacePromptContext,
      workspaceContext: {
        workspaceId: workspace.id,
        workspacePath: boundedInventory.map(item => item.path)
      },
      data: {
        context: {
          name: workspace.name,
          description: workspace.description,
          purpose: workspacePromptContext.purpose,
          rootFolder: workspace.rootFolder,
          recentActivity: [
            `Start with ${entrypoint}.`,
            'Load additional guide files selectively when they are relevant.',
            'Treat the sibling data folder as storage, not documentation.'
          ]
        },
        workflows: [],
        workflowDefinitions: [],
        workspaceStructure: boundedInventory.map(item => item.path),
        recentFiles,
        keyFiles: entrypointContent ? { [entrypoint]: entrypointContent } : {},
        preferences: 'Use this workspace for built-in capability and workflow guidance only.',
        sessions: [],
        states: []
      }
    };
  }

  private buildWorkspaceContext(entrypoint: string): WorkspaceContext {
    return {
      purpose: 'Reference built-in assistant guidance and product capability documentation.',
      keyFiles: [entrypoint],
      preferences: 'Start with the guide index and load deeper guide files selectively.'
    };
  }

  private async readManifest(path: string): Promise<ManagedGuideManifest | null> {
    const content = await this.vaultOperations.readFile(path, false);
    if (!content) {
      return null;
    }

    try {
      return JSON.parse(content) as ManagedGuideManifest;
    } catch {
      return null;
    }
  }

  private async collectGuideInventory(rootPath: string): Promise<GuideInventoryItem[]> {
    const results: GuideInventoryItem[] = [];
    await this.walkGuideTree(rootPath, results);
    return results
      .filter(item => item.path.endsWith('.md'))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private async walkGuideTree(path: string, results: GuideInventoryItem[]): Promise<void> {
    const listing = await this.vaultOperations.listDirectory(path);

    for (const filePath of listing.files) {
      if (filePath.includes('/_meta/')) {
        continue;
      }

      const stats = await this.vaultOperations.getStats(filePath);
      results.push({
        path: filePath,
        modified: stats?.mtime ?? 0,
        size: stats?.size ?? 0
      });
    }

    for (const folderPath of listing.folders) {
      if (folderPath.endsWith('/_meta') || folderPath.includes('/_meta/')) {
        continue;
      }
      await this.walkGuideTree(folderPath, results);
    }
  }

  private hashContent(content: string): string {
    let hash = 2166136261;
    for (let index = 0; index < content.length; index += 1) {
      hash ^= content.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
  }
}
