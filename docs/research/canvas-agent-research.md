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

### Directory Structure

```
src/agents/canvasManager/
├── canvasManager.ts           # Agent class
├── types.ts                   # TypeScript interfaces
├── tools/
│   ├── index.ts               # Tool exports
│   ├── read.ts                # Read canvas structure
│   ├── write.ts               # Create/overwrite canvas
│   ├── addNode.ts             # Add node to canvas
│   ├── updateNode.ts          # Update node properties
│   ├── removeNode.ts          # Remove node from canvas
│   ├── addEdge.ts             # Add edge between nodes
│   ├── updateEdge.ts          # Update edge properties
│   ├── removeEdge.ts          # Remove edge from canvas
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
// TOOL PARAMETERS & RESULTS
// ============================================================================

// Read Canvas
export interface ReadCanvasParams extends CommonParameters {
  path: string;
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

// Write Canvas
export interface WriteCanvasParams extends CommonParameters {
  path: string;
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
  overwrite?: boolean;
}

export interface WriteCanvasResult extends CommonResult {
  data?: {
    path: string;
    created: boolean;
  };
}

// Add Node
export interface AddNodeParams extends CommonParameters {
  path: string;
  node: Omit<CanvasNode, 'id'> & { id?: string };
}

export interface AddNodeResult extends CommonResult {
  data?: {
    nodeId: string;
    path: string;
  };
}

// Update Node
export interface UpdateNodeParams extends CommonParameters {
  path: string;
  nodeId: string;
  updates: Partial<Omit<CanvasNode, 'id' | 'type'>>;
}

export interface UpdateNodeResult extends CommonResult {
  data?: {
    nodeId: string;
    path: string;
  };
}

// Remove Node
export interface RemoveNodeParams extends CommonParameters {
  path: string;
  nodeId: string;
  removeConnectedEdges?: boolean; // default: true
}

export interface RemoveNodeResult extends CommonResult {
  data?: {
    removedNodeId: string;
    removedEdgeIds: string[];
    path: string;
  };
}

// Add Edge
export interface AddEdgeParams extends CommonParameters {
  path: string;
  edge: Omit<CanvasEdge, 'id'> & { id?: string };
}

export interface AddEdgeResult extends CommonResult {
  data?: {
    edgeId: string;
    path: string;
  };
}

// Update Edge
export interface UpdateEdgeParams extends CommonParameters {
  path: string;
  edgeId: string;
  updates: Partial<Omit<CanvasEdge, 'id'>>;
}

export interface UpdateEdgeResult extends CommonResult {
  data?: {
    edgeId: string;
    path: string;
  };
}

// Remove Edge
export interface RemoveEdgeParams extends CommonParameters {
  path: string;
  edgeId: string;
}

export interface RemoveEdgeResult extends CommonResult {
  data?: {
    removedEdgeId: string;
    path: string;
  };
}

// List Canvases
export interface ListCanvasParams extends CommonParameters {
  folder?: string;
  recursive?: boolean;
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
  AddNodeTool,
  UpdateNodeTool,
  RemoveNodeTool,
  AddEdgeTool,
  UpdateEdgeTool,
  RemoveEdgeTool,
  ListCanvasTool
} from './tools';
import NexusPlugin from '../../main';

/**
 * Agent for canvas operations in the vault
 *
 * Tools:
 * - read: Read canvas structure (nodes and edges)
 * - write: Create or overwrite a canvas file
 * - addNode: Add a new node to a canvas
 * - updateNode: Update node properties
 * - removeNode: Remove a node (and optionally connected edges)
 * - addEdge: Add an edge between nodes
 * - updateEdge: Update edge properties
 * - removeEdge: Remove an edge
 * - list: List canvas files in the vault
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

    // Register tools
    this.registerTool(new ReadCanvasTool(app));
    this.registerTool(new WriteCanvasTool(app));
    this.registerTool(new AddNodeTool(app));
    this.registerTool(new UpdateNodeTool(app));
    this.registerTool(new RemoveNodeTool(app));
    this.registerTool(new AddEdgeTool(app));
    this.registerTool(new UpdateEdgeTool(app));
    this.registerTool(new RemoveEdgeTool(app));
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
   * Generate a unique ID for nodes/edges
   */
  static generateId(): string {
    return Math.random().toString(36).substring(2, 18);
  }

  /**
   * Read canvas data from a file
   */
  static async readCanvas(app: App, path: string): Promise<CanvasData> {
    const file = app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Canvas not found: ${path}`);
    }
    const content = await app.vault.read(file);
    return JSON.parse(content);
  }

  /**
   * Write canvas data to a file
   */
  static async writeCanvas(app: App, path: string, data: CanvasData, overwrite = false): Promise<boolean> {
    const existingFile = app.vault.getAbstractFileByPath(path);
    const content = JSON.stringify(data, null, 2);

    if (existingFile instanceof TFile) {
      if (!overwrite) {
        throw new Error(`Canvas already exists: ${path}`);
      }
      await app.vault.modify(existingFile, content);
      return false; // not created, modified
    }

    // Create parent folders if needed
    const folderPath = path.substring(0, path.lastIndexOf('/'));
    if (folderPath) {
      await this.ensureFolder(app, folderPath);
    }

    await app.vault.create(path, content);
    return true; // created
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
   * Add a node to canvas data
   */
  static addNode(data: CanvasData, node: CanvasNode): CanvasData {
    const nodes = [...(data.nodes || [])];

    // Generate ID if not provided
    if (!node.id) {
      node.id = this.generateId();
    }

    // Check for duplicate ID
    if (nodes.some(n => n.id === node.id)) {
      throw new Error(`Node with ID "${node.id}" already exists`);
    }

    nodes.push(node);
    return { ...data, nodes };
  }

  /**
   * Update a node in canvas data
   */
  static updateNode(data: CanvasData, nodeId: string, updates: Partial<CanvasNode>): CanvasData {
    const nodes = (data.nodes || []).map(node => {
      if (node.id === nodeId) {
        return { ...node, ...updates, id: nodeId }; // Preserve ID
      }
      return node;
    });

    if (!nodes.some(n => n.id === nodeId)) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    return { ...data, nodes };
  }

  /**
   * Remove a node from canvas data
   */
  static removeNode(data: CanvasData, nodeId: string, removeConnectedEdges = true): {
    data: CanvasData;
    removedEdgeIds: string[]
  } {
    const nodes = (data.nodes || []).filter(n => n.id !== nodeId);
    let edges = data.edges || [];
    let removedEdgeIds: string[] = [];

    if (removeConnectedEdges) {
      removedEdgeIds = edges
        .filter(e => e.fromNode === nodeId || e.toNode === nodeId)
        .map(e => e.id);
      edges = edges.filter(e => e.fromNode !== nodeId && e.toNode !== nodeId);
    }

    return {
      data: { ...data, nodes, edges },
      removedEdgeIds
    };
  }

  /**
   * Add an edge to canvas data
   */
  static addEdge(data: CanvasData, edge: CanvasEdge): CanvasData {
    const edges = [...(data.edges || [])];
    const nodes = data.nodes || [];

    // Generate ID if not provided
    if (!edge.id) {
      edge.id = this.generateId();
    }

    // Validate nodes exist
    if (!nodes.some(n => n.id === edge.fromNode)) {
      throw new Error(`Source node not found: ${edge.fromNode}`);
    }
    if (!nodes.some(n => n.id === edge.toNode)) {
      throw new Error(`Target node not found: ${edge.toNode}`);
    }

    // Check for duplicate ID
    if (edges.some(e => e.id === edge.id)) {
      throw new Error(`Edge with ID "${edge.id}" already exists`);
    }

    edges.push(edge);
    return { ...data, edges };
  }

  /**
   * Update an edge in canvas data
   */
  static updateEdge(data: CanvasData, edgeId: string, updates: Partial<CanvasEdge>): CanvasData {
    const edges = (data.edges || []).map(edge => {
      if (edge.id === edgeId) {
        return { ...edge, ...updates, id: edgeId }; // Preserve ID
      }
      return edge;
    });

    if (!edges.some(e => e.id === edgeId)) {
      throw new Error(`Edge not found: ${edgeId}`);
    }

    return { ...data, edges };
  }

  /**
   * Remove an edge from canvas data
   */
  static removeEdge(data: CanvasData, edgeId: string): CanvasData {
    const edges = (data.edges || []).filter(e => e.id !== edgeId);
    return { ...data, edges };
  }

  /**
   * Calculate auto-layout positions for nodes
   */
  static autoLayout(nodes: CanvasNode[], options?: {
    startX?: number;
    startY?: number;
    gapX?: number;
    gapY?: number;
    columns?: number;
  }): CanvasNode[] {
    const {
      startX = 0,
      startY = 0,
      gapX = 50,
      gapY = 50,
      columns = 3
    } = options || {};

    return nodes.map((node, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const width = node.width || 250;
      const height = node.height || 150;

      return {
        ...node,
        x: startX + col * (width + gapX),
        y: startY + row * (height + gapY)
      };
    });
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

### 1. Create a Project Structure Canvas

```typescript
// Create canvas with project folders as nodes
{
  "nodes": [
    {
      "id": "src",
      "type": "file",
      "x": 0,
      "y": 0,
      "width": 200,
      "height": 100,
      "file": "src/index.ts",
      "color": "4"
    },
    {
      "id": "components",
      "type": "group",
      "x": 300,
      "y": 0,
      "width": 400,
      "height": 300,
      "label": "Components"
    }
  ],
  "edges": [
    {
      "id": "e1",
      "fromNode": "src",
      "toNode": "components",
      "toEnd": "arrow"
    }
  ]
}
```

### 2. Visualize Note Relationships

```typescript
// Add file nodes for each note
await canvasManager.addNode({
  path: "relationships.canvas",
  node: {
    type: "file",
    x: 100,
    y: 100,
    width: 250,
    height: 150,
    file: "notes/Topic A.md"
  }
});

// Connect related notes
await canvasManager.addEdge({
  path: "relationships.canvas",
  edge: {
    fromNode: "topicA",
    toNode: "topicB",
    label: "relates to"
  }
});
```

### 3. Create a Mind Map

```typescript
// Central topic
const centerNode = {
  type: "text",
  x: 500,
  y: 300,
  width: 200,
  height: 100,
  text: "# Main Topic\n\nCentral idea",
  color: "1"
};

// Branch topics positioned around center
const branches = [
  { angle: 0, text: "Branch 1" },
  { angle: 72, text: "Branch 2" },
  // ...
].map((b, i) => ({
  type: "text",
  x: 500 + Math.cos(b.angle * Math.PI / 180) * 300,
  y: 300 + Math.sin(b.angle * Math.PI / 180) * 200,
  width: 150,
  height: 80,
  text: b.text
}));
```

---

## Implementation Priority

### Phase 1: Core Operations (MVP)
1. `read` - Read canvas structure
2. `write` - Create/overwrite canvas
3. `addNode` - Add single node
4. `addEdge` - Add single edge
5. `list` - List canvas files

### Phase 2: Modification Operations
6. `updateNode` - Update node properties
7. `removeNode` - Remove node with edge cleanup
8. `updateEdge` - Update edge properties
9. `removeEdge` - Remove edge

### Phase 3: Advanced Features
10. Batch operations (add multiple nodes/edges)
11. Auto-layout algorithms
12. Canvas templates
13. Import from other formats (Mermaid, DOT, etc.)

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

The proposed architecture follows existing Nexus patterns (BaseAgent, BaseTool) and provides a comprehensive set of tools for canvas manipulation while maintaining forward compatibility with future JSON Canvas spec versions.
