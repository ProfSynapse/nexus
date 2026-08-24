import type { VaultPath } from '../../core/vaultPath';

export type ToolEffect =
  | 'read'
  | 'vault-write'
  | 'external-write'
  | 'destructive'
  | 'unknown';

export type ToolReplayPolicy = 'safe' | 'deduplicate' | 'unsafe';
export type ToolUndoPolicy = 'none' | 'vault-preimage';

export interface ToolExecutionPolicy {
  effect: ToolEffect;
  parallelSafe: boolean;
  replay: ToolReplayPolicy;
  undo: ToolUndoPolicy;
}

export type ToolMutationIntent =
  | { kind: 'create'; path: VaultPath }
  | { kind: 'modify'; path: VaultPath }
  | { kind: 'move'; from: VaultPath; to: VaultPath }
  | { kind: 'archive'; from: VaultPath; to: VaultPath }
  | { kind: 'copy'; from: VaultPath; to: VaultPath }
  | { kind: 'multi'; operations: ToolMutationIntent[] };

export const CONSERVATIVE_TOOL_EXECUTION_POLICY: Readonly<ToolExecutionPolicy> = Object.freeze({
  effect: 'unknown',
  parallelSafe: false,
  replay: 'unsafe',
  undo: 'none',
});

