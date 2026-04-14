import type { App } from 'obsidian';
import type { VaultOperations } from '../../core/VaultOperations';
import { resolveVaultRoot } from '../../database/storage/VaultRootResolver';
import type { LoadWorkspaceResult } from '../../database/types/workspace/ParameterTypes';
import type { WorkspaceContext } from '../../database/types/workspace/WorkspaceTypes';
import {
  MANAGED_GUIDES,
  MANAGED_GUIDES_MANIFEST_PATH,
  MANAGED_GUIDES_VERSION
} from '../../guides/ManagedGuidesCatalog';
import type { MCPSettings } from '../../types/plugin/PluginTypes';
import type { IndividualWorkspace } from '../../types/storage/StorageTypes';

export const SYSTEM_GUIDES_WORKSPACE_ID = '__system_guides__';
export const SYSTEM_GUIDES_WORKSPACE_NAME = 'Assistant guides';

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

    for (const guide of MANAGED_GUIDES) {
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

    const manifest: ManagedGuideManifest = {
      version: MANAGED_GUIDES_VERSION,
      pluginVersion: this.pluginVersion,
      updatedAt: new Date().toISOString(),
      files: MANAGED_GUIDES.map(guide => ({
        path: guide.path,
        hash: this.hashContent(guide.content)
      }))
    };

    await this.vaultOperations.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
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
