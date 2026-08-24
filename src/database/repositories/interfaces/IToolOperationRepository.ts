import type {
  StartToolOperationData,
  ToolOperationReceipt,
} from '../../../types/tools/ToolOperationTypes';

export interface CompleteToolOperationData {
  operationId: string;
  workspaceId: string;
  signature: string;
  resultJson: string;
  resultTruncated: boolean;
  completedAt?: number;
}

export interface FinishToolOperationData {
  operationId: string;
  workspaceId: string;
  signature: string;
  error: string;
  completedAt?: number;
}

export interface IToolOperationRepository {
  getById(operationId: string, workspaceId: string): Promise<ToolOperationReceipt | null>;
  /** Returns true only when this caller acquired the operation claim. */
  start(data: StartToolOperationData): Promise<boolean>;
  complete(data: CompleteToolOperationData): Promise<void>;
  fail(data: FinishToolOperationData): Promise<void>;
  markIndeterminate(data: FinishToolOperationData): Promise<void>;
}
