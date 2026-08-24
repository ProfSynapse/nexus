import type { ToolReplayPolicy } from '../../agents/policy/ToolExecutionPolicy';

export type ToolExecutionOrigin =
  | 'native-chat'
  | 'subagent'
  | 'workflow'
  | 'external-mcp';

export type ToolOperationStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'indeterminate';

export interface ToolOperationIdentity {
  operationId: string;
  signature: string;
  origin: ToolExecutionOrigin;
  workspaceId: string;
  sessionId: string;
  conversationId?: string;
  messageId?: string;
  turnId?: string;
}

export interface ToolOperationReceipt extends ToolOperationIdentity {
  status: ToolOperationStatus;
  replayPolicy: ToolReplayPolicy;
  replayable: boolean;
  commandSummary: string;
  resultJson?: string;
  resultTruncated: boolean;
  error?: string;
  startedAt: number;
  completedAt?: number;
  updatedAt: number;
}

export interface StartToolOperationData extends ToolOperationIdentity {
  replayPolicy: ToolReplayPolicy;
  replayable: boolean;
  commandSummary: string;
}
