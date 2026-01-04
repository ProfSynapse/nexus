import { App, TFile, TFolder } from 'obsidian';
import { CanvasData, CanvasNode, CanvasEdge } from '../types';

/**
 * Utility class for canvas file operations
 */
export class CanvasOperations {
  /**
   * Generate a unique ID for nodes/edges (matches Obsidian's format)
   */
  static generateId(): string {
    return Math.random().toString(36).substring(2, 18);
  }

  /**
   * Normalize path to ensure .canvas extension
   */
  static normalizePath(path: string): string {
    return path.endsWith('.canvas') ? path : `${path}.canvas`;
  }

  /**
   * Read canvas data from a file
   */
  static async readCanvas(app: App, path: string): Promise<CanvasData> {
    const normalizedPath = this.normalizePath(path);
    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Canvas not found: ${normalizedPath}. Use canvasManager.list to find canvases.`);
    }
    const content = await app.vault.read(file);
    return JSON.parse(content);
  }

  /**
   * Write canvas data to a NEW file (fails if exists)
   */
  static async writeCanvas(app: App, path: string, data: CanvasData): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    const existingFile = app.vault.getAbstractFileByPath(normalizedPath);

    if (existingFile instanceof TFile) {
      throw new Error(`Canvas already exists: ${normalizedPath}. Use canvasManager.update to modify.`);
    }

    // Ensure IDs on all nodes and edges
    const processedData = this.ensureIds(data);
    const content = JSON.stringify(processedData, null, 2);

    // Create parent folders if needed
    const folderPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
    if (folderPath) {
      await this.ensureFolder(app, folderPath);
    }

    await app.vault.create(normalizedPath, content);
  }

  /**
   * Update an EXISTING canvas (fails if doesn't exist)
   */
  static async updateCanvas(app: App, path: string, data: CanvasData): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    const file = app.vault.getAbstractFileByPath(normalizedPath);

    if (!file || !(file instanceof TFile)) {
      throw new Error(`Canvas not found: ${normalizedPath}. Use canvasManager.write to create.`);
    }

    // Ensure IDs on all nodes and edges
    const processedData = this.ensureIds(data);
    const content = JSON.stringify(processedData, null, 2);

    await app.vault.modify(file, content);
  }

  /**
   * Ensure a folder exists (creates recursively if needed)
   */
  static async ensureFolder(app: App, path: string): Promise<void> {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;

    // Check if any parent folder exists
    const parts = path.split('/');
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folder = app.vault.getAbstractFileByPath(currentPath);
      if (!folder) {
        await app.vault.createFolder(currentPath);
      }
    }
  }

  /**
   * Ensure all nodes and edges have IDs
   */
  static ensureIds(data: CanvasData): CanvasData {
    const nodes = (data.nodes || []).map(node => ({
      ...node,
      id: node.id || this.generateId()
    }));

    const edges = (data.edges || []).map(edge => ({
      ...edge,
      id: edge.id || this.generateId()
    }));

    return { ...data, nodes, edges };
  }

  /**
   * Validate edge references (all fromNode/toNode must exist)
   */
  static validateEdges(data: CanvasData): { valid: boolean; errors: string[] } {
    const nodeIds = new Set((data.nodes || []).map(n => n.id));
    const errors: string[] = [];

    for (const edge of data.edges || []) {
      if (!nodeIds.has(edge.fromNode)) {
        errors.push(`Edge "${edge.id}" references missing source node: ${edge.fromNode}`);
      }
      if (!nodeIds.has(edge.toNode)) {
        errors.push(`Edge "${edge.id}" references missing target node: ${edge.toNode}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get all canvas files in the vault
   */
  static getCanvasFiles(app: App, folder?: string, recursive = true): TFile[] {
    const allFiles = app.vault.getFiles();
    const canvasFiles = allFiles.filter(f => f.extension === 'canvas');

    if (!folder) {
      return canvasFiles;
    }

    const normalizedFolder = folder.replace(/^\/+|\/+$/g, '');

    return canvasFiles.filter(f => {
      if (recursive) {
        return f.path.startsWith(normalizedFolder + '/') || f.parent?.path === normalizedFolder;
      } else {
        return f.parent?.path === normalizedFolder;
      }
    });
  }

  /**
   * Parse canvas file and get node/edge counts
   */
  static async getCanvasSummary(app: App, file: TFile): Promise<{ nodeCount: number; edgeCount: number }> {
    try {
      const content = await app.vault.read(file);
      const data: CanvasData = JSON.parse(content);
      return {
        nodeCount: (data.nodes || []).length,
        edgeCount: (data.edges || []).length
      };
    } catch {
      return { nodeCount: 0, edgeCount: 0 };
    }
  }
}
