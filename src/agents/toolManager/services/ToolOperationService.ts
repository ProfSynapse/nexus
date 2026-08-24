import type { IToolOperationRepository } from '../../../database/repositories/interfaces/IToolOperationRepository';
import type { ToolReplayPolicy } from '../../policy/ToolExecutionPolicy';
import type {
  ToolExecutionOrigin,
  ToolOperationIdentity,
} from '../../../types/tools/ToolOperationTypes';
import type { ToolCallResult } from '../types';

const MAX_RESULT_BYTES = 32 * 1024;
const MAX_ERROR_CHARS = 4096;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passphrase|private.?key|api.?key|access.?token|refresh.?token|secret)/i;
const VOLATILE_SIGNATURE_KEY = /^(?:workspaceId|sessionId|conversationId|messageId|turnId|context|memory|goal|constraints)$/;

export interface ToolOperationPersistence {
  waitForQueryReady?(): Promise<boolean>;
  isReady(): boolean;
  operations?: IToolOperationRepository;
}

export type ToolOperationPersistenceProvider = () => Promise<ToolOperationPersistence | null>;

export interface ToolOperationExecutionInput {
  operationId: string;
  origin: ToolExecutionOrigin;
  replayable: boolean;
  workspaceId: string;
  sessionId: string;
  conversationId?: string;
  messageId?: string;
  turnId?: string;
  agent: string;
  tool: string;
  params: Record<string, unknown>;
  replayPolicy: ToolReplayPolicy;
}

/** Coordinates durable receipt lookup, dispatch, and terminal persistence. */
export class ToolOperationService {
  private readonly inFlight: Map<string, { signature: string; result: Promise<ToolCallResult> }>;

  constructor(
    private readonly persistenceProvider?: ToolOperationPersistenceProvider,
    coordinator: Map<string, { signature: string; result: Promise<ToolCallResult> }> = getSharedCoordinator()
  ) {
    this.inFlight = coordinator;
  }

  async execute(
    input: ToolOperationExecutionInput,
    dispatch: () => Promise<ToolCallResult>
  ): Promise<ToolCallResult> {
    // Headless/eval stacks may intentionally omit storage. Production passes a
    // provider and therefore fails closed if durable receipt storage is absent.
    if (!this.persistenceProvider) {
      return dispatch();
    }

    const signature = await createToolOperationSignature(input);
    const identity: ToolOperationIdentity = {
      operationId: input.operationId,
      signature,
      origin: input.origin,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      turnId: input.turnId,
    };

    const coordinatorKey = `${input.workspaceId}:${input.operationId}`;
    const active = this.inFlight.get(coordinatorKey);
    if (active) {
      return active.signature === signature
        ? active.result
        : this.failure(input, `Operation ID conflict: "${input.operationId}" is already running with a different command.`);
    }

    const result = this.executePersisted(input, identity, dispatch);
    this.inFlight.set(coordinatorKey, { signature, result });
    try {
      return await result;
    } finally {
      if (this.inFlight.get(coordinatorKey)?.result === result) {
        this.inFlight.delete(coordinatorKey);
      }
    }
  }

  private async executePersisted(
    input: ToolOperationExecutionInput,
    identity: ToolOperationIdentity,
    dispatch: () => Promise<ToolCallResult>
  ): Promise<ToolCallResult> {
    const persistence = await this.persistenceProvider!();
    const queryReady = persistence
      ? (persistence.waitForQueryReady ? await persistence.waitForQueryReady() : persistence.isReady())
      : false;
    const repository = persistence?.operations;
    if (!queryReady || !repository) {
      return this.failure(input, 'Durable operation receipt storage is not query-ready; the tool was not executed.');
    }

    const existing = await repository.getById(input.operationId, input.workspaceId);
    if (existing) {
      if (existing.signature !== identity.signature) {
        return this.failure(
          input,
          `Operation ID conflict: "${input.operationId}" was already used for a different command. Use a new operationId.`
        );
      }
      if (existing.status === 'completed') {
        return parseRecordedResult(existing.resultJson, input);
      }
      if (existing.status === 'failed') {
        return this.failure(input, existing.error || 'The recorded operation failed.');
      }
      if (existing.status === 'indeterminate') {
        return this.failure(input, existing.error || 'The recorded operation has an indeterminate outcome and cannot be replayed automatically.');
      }
      if (!existing.replayable || input.replayPolicy !== 'safe') {
        const reason = input.replayPolicy === 'deduplicate'
          ? 'A prior attempt started but no tool-specific reconciliation is available; outcome is indeterminate and automatic replay was refused.'
          : 'A prior attempt started and this tool is unsafe to replay; outcome is indeterminate and automatic replay was refused.';
        await repository.markIndeterminate({
          operationId: identity.operationId,
          workspaceId: identity.workspaceId,
          signature: identity.signature,
          error: reason,
        });
        return this.failure(input, reason);
      }
      // Safe reads may be re-dispatched after an interrupted attempt.
      return this.dispatchAndFinish(repository, identity, input, dispatch);
    }

    const claimed = await repository.start({
      ...identity,
      replayPolicy: input.replayPolicy,
      replayable: input.replayable,
      commandSummary: `${input.agent} ${input.tool}`,
    });
    if (!claimed) {
      const winner = await repository.getById(input.operationId, input.workspaceId);
      if (winner?.signature !== identity.signature) {
        return this.failure(input, `Operation ID conflict: "${input.operationId}" was claimed by a different command.`);
      }
      if (winner?.status === 'completed') return parseRecordedResult(winner.resultJson, input);
      if (winner?.status === 'failed') return this.failure(input, winner.error || 'The recorded operation failed.');
      if (winner?.status === 'indeterminate') {
        return this.failure(input, winner.error || 'The recorded operation has an indeterminate outcome.');
      }
      return this.failure(input, `Operation "${input.operationId}" is already running.`);
    }
    return this.dispatchAndFinish(repository, identity, input, dispatch);
  }

  private async dispatchAndFinish(
    repository: IToolOperationRepository,
    identity: ToolOperationIdentity,
    input: ToolOperationExecutionInput,
    dispatch: () => Promise<ToolCallResult>
  ): Promise<ToolCallResult> {
    const result = await dispatch();
    try {
      if (result.success) {
        const recorded = serializeRecordedResult(result);
        await repository.complete({
          operationId: identity.operationId,
          workspaceId: identity.workspaceId,
          signature: identity.signature,
          resultJson: recorded.json,
          resultTruncated: recorded.truncated,
        });
      } else {
        await repository.fail({
          operationId: identity.operationId,
          workspaceId: identity.workspaceId,
          signature: identity.signature,
          error: sanitizeError(result.error || 'Tool execution failed'),
        });
      }
      return result;
    } catch {
      return this.failure(
        input,
        'The tool executed, but its terminal receipt could not be persisted. The outcome is indeterminate; do not retry with a new operationId.'
      );
    }
  }

  private failure(input: ToolOperationExecutionInput, error: string): ToolCallResult {
    return { agent: input.agent, tool: input.tool, success: false, error: sanitizeError(error) };
  }
}

interface ToolOperationCoordinatorGlobal {
  __nexusToolOperationInFlight?: Map<string, { signature: string; result: Promise<ToolCallResult> }>;
}

const headlessCoordinator = new Map<string, { signature: string; result: Promise<ToolCallResult> }>();

function getSharedCoordinator(): Map<string, { signature: string; result: Promise<ToolCallResult> }> {
  // This service is also constructed by headless/eval stacks where `window`
  // does not exist. The coordinator is runtime-global by design so it survives
  // same-realm browser plugin reload overlap; headless callers share the module
  // coordinator for their process lifetime.
  if (typeof window === 'undefined') return headlessCoordinator;
  const shared = window as typeof window & ToolOperationCoordinatorGlobal;
  shared.__nexusToolOperationInFlight ??= new Map();
  return shared.__nexusToolOperationInFlight;
}

export async function createToolOperationSignature(input: Pick<
  ToolOperationExecutionInput,
  'workspaceId' | 'agent' | 'tool' | 'params'
>): Promise<string> {
  const canonical = stableStringify({
    workspaceId: input.workspaceId,
    agent: input.agent,
    tool: input.tool,
    params: stripVolatileContext(input.params),
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function stripVolatileContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatileContext);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (!VOLATILE_SIGNATURE_KEY.test(key)) {
      output[key] = stripVolatileContext((value as Record<string, unknown>)[key]);
    }
  }
  return output;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key =>
      `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[depth limit]';
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeValue(child, depth + 1);
  }
  return output;
}

function serializeRecordedResult(result: ToolCallResult): { json: string; truncated: boolean } {
  const safe = sanitizeValue({
    agent: result.agent,
    tool: result.tool,
    success: result.success,
    data: result.data,
  });
  const json = JSON.stringify(safe);
  if (new TextEncoder().encode(json).byteLength <= MAX_RESULT_BYTES) {
    return { json, truncated: false };
  }
  let low = 0;
  let high = json.length;
  let bounded = '';
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const preview = safeUtf16Prefix(json, midpoint);
    const candidate = JSON.stringify({
      agent: result.agent,
      tool: result.tool,
      success: true,
      data: { receiptTruncated: true, preview },
    });
    if (new TextEncoder().encode(candidate).byteLength <= MAX_RESULT_BYTES) {
      bounded = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return {
    json: bounded,
    truncated: true,
  };
}

function safeUtf16Prefix(value: string, end: number): string {
  let boundary = Math.min(end, value.length);
  if (boundary > 0) {
    const finalUnit = value.charCodeAt(boundary - 1);
    if (finalUnit >= 0xD800 && finalUnit <= 0xDBFF) boundary--;
  }
  return value.slice(0, boundary);
}

function parseRecordedResult(resultJson: string | undefined, input: ToolOperationExecutionInput): ToolCallResult {
  if (!resultJson) {
    return { agent: input.agent, tool: input.tool, success: false, error: 'Completed operation receipt has no recorded result.' };
  }
  try {
    const parsed = JSON.parse(resultJson) as ToolCallResult;
    return {
      agent: typeof parsed.agent === 'string' ? parsed.agent : input.agent,
      tool: typeof parsed.tool === 'string' ? parsed.tool : input.tool,
      success: parsed.success === true,
      data: parsed.data,
      error: parsed.error,
    };
  } catch {
    return { agent: input.agent, tool: input.tool, success: false, error: 'Completed operation receipt contains an invalid recorded result.' };
  }
}

function sanitizeError(error: string): string {
  return error
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .slice(0, MAX_ERROR_CHARS);
}
