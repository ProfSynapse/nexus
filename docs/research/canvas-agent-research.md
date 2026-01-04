# Canvas Agent Research

## Overview

This document outlines how to implement a Canvas Agent for Nexus that can programmatically create and edit Obsidian canvas documents.

## JSON Canvas Specification (v1.0)

JSON Canvas is an open file format for infinite canvas data, created by Obsidian and released under MIT license. Canvas files use the `.canvas` extension and store data as JSON.

### Core Structure

```json
{
  "nodes": [],
  "edges": []
}
```

Both arrays are optional. The format supports arbitrary additional keys for forward compatibility.

### Node Types

All nodes share common properties:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | Yes | Unique identifier |
| `type` | string | Yes | Node type (text, file, link, group) |
| `x` | number | Yes | X position |
| `y` | number | Yes | Y position |
| `width` | number | Yes | Width in pixels |
| `height` | number | Yes | Height in pixels |
| `color` | canvasColor | No | Node color |

#### 1. Text Nodes

```typescript
interface CanvasTextNode {
  id: string;
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  text: string;  // Plain text with Markdown support
}
```

#### 2. File Nodes

```typescript
interface CanvasFileNode {
  id: string;
  type: 'file';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  file: string;      // Path to file in vault
  subpath?: string;  // Optional heading/block reference (e.g., "#heading")
}
```

#### 3. Link Nodes

```typescript
interface CanvasLinkNode {
  id: string;
  type: 'link';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  url: string;  // External URL
}
```

#### 4. Group Nodes

```typescript
interface CanvasGroupNode {
  id: string;
  type: 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  label?: string;              // Group label
  background?: string;         // Path to background image
  backgroundStyle?: 'cover' | 'ratio' | 'repeat';
}
```

### Edge Properties

```typescript
interface CanvasEdge {
  id: string;           // Unique identifier
  fromNode: string;     // Source node ID
  toNode: string;       // Target node ID
  fromSide?: NodeSide;  // Connection side on source ('top' | 'right' | 'bottom' | 'left')
  toSide?: NodeSide;    // Connection side on target
  fromEnd?: EdgeEnd;    // Source endpoint ('none' | 'arrow'), default: 'none'
  toEnd?: EdgeEnd;      // Target endpoint, default: 'arrow'
  color?: CanvasColor;  // Edge color
  label?: string;       // Edge label
}
```

### Color System

Colors use the `CanvasColor` type (string):
- **Preset colors**: `"1"` (red), `"2"` (orange), `"3"` (yellow), `"4"` (green), `"5"` (cyan), `"6"` (purple)
- **Custom colors**: Hex format like `"#FF0000"`

---

## Current Canvas Integration in Nexus

Canvas files are already recognized by the system:

### VaultFileIndex (`src/database/services/cache/VaultFileIndex.ts`)

```typescript
// Canvas files are treated as key files
private keyFilePatterns = [
  /readme\.md$/i,
  /index\.md$/i,
  /\.canvas$/,  // Canvas files marked as key
  // ...
];

// Both MD and canvas files are indexed
const markdownFiles = files.filter(file =>
  file.extension === 'md' || file.extension === 'canvas'
);
```

### CacheManager

```typescript
if (file.extension === 'md' || file.extension === 'canvas') {
  await this.vaultFileIndex!.updateFile(file);
}
```

### Current Limitations

- Canvas files are indexed but not parsed
- No dedicated canvas-specific tools
- No node/edge manipulation capabilities
- No canvas visualization reading/writing

---

## Proposed Canvas Agent Architecture

### Design Philosophy

**Simplified 4-Tool Design**: Instead of separate tools for add/update/remove operations on nodes and edges, we use a lean approach where the LLM:
1. Reads the canvas with `read`
2. Modifies the data in context (add nodes, remove edges, etc.)
3. Writes back with `write` (new) or `update` (existing)

This matches the existing Nexus patterns and reduces tool count while maintaining full functionality.

### Directory Structure

```
src/agents/canvasManager/
├── canvasManager.ts           # Agent class
├── types.ts                   # TypeScript interfaces
├── tools/
│   ├── index.ts               # Tool exports
│   ├── read.ts                # Read canvas structure
│   ├── write.ts               # Create NEW canvas
│   ├── update.ts              # Modify EXISTING canvas
│   └── list.ts                # List canvas files
└── utils/
    └── CanvasOperations.ts    # Shared canvas utilities
```

### TypeScript Interfaces

```typescript
// types.ts

import { CommonParameters, CommonResult } from '../../types';

// ============================================================================
// CANVAS DATA STRUCTURES (JSON Canvas 1.0 Spec)
// ============================================================================

export type CanvasColor = string; // "1"-"6" or "#RRGGBB"
export type NodeSide = 'top' | 'right' | 'bottom' | 'left';
export type EdgeEnd = 'none' | 'arrow';
export type BackgroundStyle = 'cover' | 'ratio' | 'repeat';
export type NodeType = 'text' | 'file' | 'link' | 'group';

export interface CanvasNodeBase {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  text: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: 'file';
  file: string;
  subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: 'link';
  url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: 'group';
  label?: string;
  background?: string;
  backgroundStyle?: BackgroundStyle;
}

export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: NodeSide;
  toSide?: NodeSide;
  fromEnd?: EdgeEnd;
  toEnd?: EdgeEnd;
  color?: CanvasColor;
  label?: string;
}

export interface CanvasData {
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
  [key: string]: unknown; // Forward compatibility
}

// ============================================================================
// TOOL PARAMETERS & RESULTS (4 Tools)
// ============================================================================

// 1. Read Canvas - Get canvas structure
export interface ReadCanvasParams extends CommonParameters {
  path: string;  // Path to canvas file
}

export interface ReadCanvasResult extends CommonResult {
  data?: {
    path: string;
    nodes: CanvasNode[];
    edges: CanvasEdge[];
    nodeCount: number;
    edgeCount: number;
  };
}

// 2. Write Canvas - Create NEW canvas (fails if exists)
export interface WriteCanvasParams extends CommonParameters {
  path: string;           // Path for new canvas
  nodes?: CanvasNode[];   // Initial nodes (IDs auto-generated if missing)
  edges?: CanvasEdge[];   // Initial edges (IDs auto-generated if missing)
}

export interface WriteCanvasResult extends CommonResult {
  // Lean result - just success: true
}

// 3. Update Canvas - Modify EXISTING canvas (fails if doesn't exist)
export interface UpdateCanvasParams extends CommonParameters {
  path: string;           // Path to existing canvas
  nodes?: CanvasNode[];   // Full nodes array (replaces existing)
  edges?: CanvasEdge[];   // Full edges array (replaces existing)
}

export interface UpdateCanvasResult extends CommonResult {
  // Lean result - just success: true
}

// 4. List Canvases - Find canvas files in vault
export interface ListCanvasParams extends CommonParameters {
  folder?: string;        // Folder to search (default: vault root)
  recursive?: boolean;    // Search subfolders (default: true)
}

export interface ListCanvasResult extends CommonResult {
  data?: {
    canvases: Array<{
      path: string;
      name: string;
      modified: number;
      nodeCount: number;
      edgeCount: number;
    }>;
    total: number;
  };
}
```

### Agent Implementation

```typescript
// canvasManager.ts

import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import {
  ReadCanvasTool,
  WriteCanvasTool,
  UpdateCanvasTool,
  ListCanvasTool
} from './tools';
import NexusPlugin from '../../main';

/**
 * Agent for canvas operations in the vault
 *
 * Tools (4 total):
 * - read: Read canvas structure (nodes and edges)
 * - write: Create a NEW canvas file
 * - update: Modify an EXISTING canvas file
 * - list: List canvas files in the vault
 *
 * Workflow: LLM reads → modifies in context → writes/updates back
 */
export class CanvasManagerAgent extends BaseAgent {
  protected app: App;
  protected plugin: NexusPlugin | null = null;

  constructor(app: App, plugin?: NexusPlugin) {
    super(
      'canvasManager',
      'Canvas operations for Obsidian infinite canvas files',
      '1.0.0'
    );

    this.app = app;
    this.plugin = plugin || null;

    // Register 4 tools
    this.registerTool(new ReadCanvasTool(app));
    this.registerTool(new WriteCanvasTool(app));
    this.registerTool(new UpdateCanvasTool(app));
    this.registerTool(new ListCanvasTool(app));
  }
}
```

### Example Tool Implementation (ReadCanvasTool)

```typescript
// tools/read.ts

import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { ReadCanvasParams, ReadCanvasResult, CanvasData } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';

export class ReadCanvasTool extends BaseTool<ReadCanvasParams, ReadCanvasResult> {
  private app: App;

  constructor(app: App) {
    super(
      'read',
      'Read Canvas',
      'Read the structure of a canvas file (nodes and edges)',
      '1.0.0'
    );
    this.app = app;
  }

  async execute(params: ReadCanvasParams): Promise<ReadCanvasResult> {
    try {
      const { path } = params;

      // Ensure .canvas extension
      const canvasPath = path.endsWith('.canvas') ? path : `${path}.canvas`;

      // Get the file
      const file = this.app.vault.getAbstractFileByPath(canvasPath);
      if (!file || !(file instanceof TFile)) {
        return this.prepareResult(false, undefined, `Canvas not found: ${canvasPath}`);
      }

      // Read and parse the canvas
      const content = await this.app.vault.read(file);
      const canvasData: CanvasData = JSON.parse(content);

      const nodes = canvasData.nodes || [];
      const edges = canvasData.edges || [];

      return this.prepareResult(true, {
        path: canvasPath,
        nodes,
        edges,
        nodeCount: nodes.length,
        edgeCount: edges.length
      });
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error reading canvas: ', error));
    }
  }

  getParameterSchema(): Record<string, unknown> {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the canvas file (with or without .canvas extension)'
        }
      },
      required: ['path']
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): JSONSchema {
    const baseSchema = super.getResultSchema() as { properties: Record<string, unknown> };

    baseSchema.properties.data = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the canvas file' },
        nodes: { type: 'array', description: 'Array of canvas nodes' },
        edges: { type: 'array', description: 'Array of canvas edges' },
        nodeCount: { type: 'number', description: 'Number of nodes' },
        edgeCount: { type: 'number', description: 'Number of edges' }
      },
      required: ['path', 'nodes', 'edges', 'nodeCount', 'edgeCount']
    };

    return baseSchema;
  }
}
```

### Canvas Operations Utility

```typescript
// utils/CanvasOperations.ts

import { App, TFile, TFolder } from 'obsidian';
import { CanvasData, CanvasNode, CanvasEdge } from '../types';

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
   * Ensure a folder exists
   */
  static async ensureFolder(app: App, path: string): Promise<void> {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;

    await app.vault.createFolder(path);
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
}
```

---

## Registration & Configuration

### Update Agent Registry

```typescript
// src/config/agentConfigs.ts

export const AGENTS: AgentDescriptor[] = [
  // ... existing agents
  {
    name: "canvasManager",
    description: "Canvas operations for Obsidian infinite canvas files. Supports reading, creating, and modifying canvas files with nodes (text, file, link, group) and edges."
  }
];
```

### Register in AgentRegistry

```typescript
// src/server/services/AgentRegistry.ts

import { CanvasManagerAgent } from '../../agents/canvasManager/canvasManager';

// In initialization:
this.agents.set('canvasManager', new CanvasManagerAgent(app, plugin));
```

---

## Example Use Cases

### 1. Create a New Canvas

```typescript
// Use write to create a new canvas with initial structure
await canvasManager.write({
  path: "project-overview.canvas",
  nodes: [
    {
      id: "src",
      type: "file",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      file: "src/index.ts",
      color: "4"
    },
    {
      id: "components",
      type: "group",
      x: 300,
      y: 0,
      width: 400,
      height: 300,
      label: "Components"
    }
  ],
  edges: [
    {
      id: "e1",
      fromNode: "src",
      toNode: "components",
      toEnd: "arrow"
    }
  ]
});
```

### 2. Modify an Existing Canvas

```typescript
// Step 1: Read current canvas
const { nodes, edges } = await canvasManager.read({
  path: "relationships.canvas"
});

// Step 2: Modify in context (add new node)
const newNodes = [...nodes, {
  id: "newTopic",
  type: "file",
  x: 400,
  y: 200,
  width: 250,
  height: 150,
  file: "notes/New Topic.md"
}];

// Step 3: Add edge to new node
const newEdges = [...edges, {
  id: "e-new",
  fromNode: "existingTopic",
  toNode: "newTopic",
  label: "relates to"
}];

// Step 4: Update canvas with modified data
await canvasManager.update({
  path: "relationships.canvas",
  nodes: newNodes,
  edges: newEdges
});
```

### 3. Create a Mind Map

```typescript
// Build node structure in memory
const centerNode = {
  id: "center",
  type: "text",
  x: 500,
  y: 300,
  width: 200,
  height: 100,
  text: "# Main Topic\n\nCentral idea",
  color: "1"
};

const branches = [
  { angle: 0, text: "Branch 1" },
  { angle: 72, text: "Branch 2" },
  { angle: 144, text: "Branch 3" },
  { angle: 216, text: "Branch 4" },
  { angle: 288, text: "Branch 5" }
].map((b, i) => ({
  id: `branch-${i}`,
  type: "text",
  x: 500 + Math.cos(b.angle * Math.PI / 180) * 300,
  y: 300 + Math.sin(b.angle * Math.PI / 180) * 200,
  width: 150,
  height: 80,
  text: b.text
}));

// Create edges from center to all branches
const edges = branches.map((_, i) => ({
  id: `edge-${i}`,
  fromNode: "center",
  toNode: `branch-${i}`,
  toEnd: "arrow"
}));

// Write complete canvas in one call
await canvasManager.write({
  path: "mindmap.canvas",
  nodes: [centerNode, ...branches],
  edges
});
```

---

## Implementation Priority

### Phase 1: Core Operations (Complete Implementation)
All 4 tools implemented together:
1. `read` - Read canvas structure
2. `write` - Create NEW canvas
3. `update` - Modify EXISTING canvas
4. `list` - List canvas files

### Phase 2: Advanced Features (Future)
- Auto-layout algorithms (grid, radial, tree)
- Canvas templates
- Import from other formats (Mermaid, DOT, etc.)
- Batch operations with validation

---

## References

- **JSON Canvas Spec**: https://jsoncanvas.org/
- **GitHub Repository**: https://github.com/obsidianmd/jsoncanvas
- **Obsidian Canvas API**: https://github.com/obsidianmd/obsidian-api/blob/master/canvas.d.ts
- **Canvas Help**: https://help.obsidian.md/plugins/canvas

---

## Conclusion

Implementing a Canvas Agent for Nexus is straightforward given:
1. The well-defined JSON Canvas 1.0 specification
2. Existing patterns in Nexus for agents/tools
3. Canvas files already being indexed as key files

**Simplified 4-Tool Design Benefits**:
- **Fewer tools** (4 vs 9) = simpler for LLMs to understand
- **Read-modify-write pattern** matches how LLMs naturally work
- **Full array replacement** avoids complex partial update logic
- **Matches existing patterns** in contentManager (read → modify → replace)

The architecture follows Nexus patterns (BaseAgent, BaseTool) and maintains forward compatibility with future JSON Canvas spec versions.
