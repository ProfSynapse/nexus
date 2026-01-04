import { CommonParameters, CommonResult } from '../../types';

// ============================================================================
// CANVAS DATA STRUCTURES (JSON Canvas 1.0 Spec)
// ============================================================================

/**
 * Color for nodes and edges
 * - Preset: "1" (red), "2" (orange), "3" (yellow), "4" (green), "5" (cyan), "6" (purple)
 * - Custom: Hex format like "#FF0000"
 */
export type CanvasColor = string;

/** Side of a node for edge connections */
export type NodeSide = 'top' | 'right' | 'bottom' | 'left';

/** Edge endpoint style */
export type EdgeEnd = 'none' | 'arrow';

/** Background image rendering style for groups */
export type BackgroundStyle = 'cover' | 'ratio' | 'repeat';

/** Node types */
export type NodeType = 'text' | 'file' | 'link' | 'group';

/** Base properties shared by all nodes */
export interface CanvasNodeBase {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
}

/** Text node - contains markdown content */
export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  text: string;
}

/** File node - links to a vault file */
export interface CanvasFileNode extends CanvasNodeBase {
  type: 'file';
  file: string;
  subpath?: string; // Heading/block reference, starts with #
}

/** Link node - external URL */
export interface CanvasLinkNode extends CanvasNodeBase {
  type: 'link';
  url: string;
}

/** Group node - visual container for other nodes */
export interface CanvasGroupNode extends CanvasNodeBase {
  type: 'group';
  label?: string;
  background?: string;
  backgroundStyle?: BackgroundStyle;
}

/** Union of all node types */
export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode;

/** Edge connecting two nodes */
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

/** Complete canvas data structure */
export interface CanvasData {
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
  [key: string]: unknown; // Forward compatibility
}

// ============================================================================
// TOOL PARAMETERS & RESULTS
// ============================================================================

// 1. Read Canvas
export interface ReadCanvasParams extends CommonParameters {
  /** Path to the canvas file (with or without .canvas extension) */
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

// 2. Write Canvas (create NEW)
export interface WriteCanvasParams extends CommonParameters {
  /** Path for the new canvas file */
  path: string;
  /** Initial nodes (IDs auto-generated if missing) */
  nodes?: CanvasNode[];
  /** Initial edges (IDs auto-generated if missing) */
  edges?: CanvasEdge[];
}

export interface WriteCanvasResult extends CommonResult {
  // Lean result - just success: true
}

// 3. Update Canvas (modify EXISTING)
export interface UpdateCanvasParams extends CommonParameters {
  /** Path to the existing canvas file */
  path: string;
  /** Full nodes array (replaces existing) */
  nodes?: CanvasNode[];
  /** Full edges array (replaces existing) */
  edges?: CanvasEdge[];
}

export interface UpdateCanvasResult extends CommonResult {
  // Lean result - just success: true
}

// 4. List Canvases
export interface ListCanvasParams extends CommonParameters {
  /** Folder to search (default: vault root) */
  folder?: string;
  /** Search subfolders (default: true) */
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
