import { generateSessionId, isStandardSessionId } from './sessionUtils';
import { parseWorkspaceContext } from './contextUtils';

export interface SessionContextManagerLike {
  validateSessionId(sessionId: string, sessionDescription?: string): Promise<{ id: string; created: boolean }>;
  getWorkspaceContext(sessionId: string): { workspaceId: string; workspacePath?: string[]; activeWorkspace?: boolean } | null;
}

export interface FallbackSessionIdProcessorResult {
  sessionId: string;
  isNewSession: boolean;
  isNonStandardId: boolean;
  originalSessionId?: string;
}

export interface NormalizeToolContextOptions {
  sessionContextManager?: SessionContextManagerLike;
  fallbackSessionIdProcessor?: (sessionId: string) => Promise<FallbackSessionIdProcessorResult>;
  defaultWorkspaceId?: string;
  markSessionFlags?: boolean;
}

export interface NormalizedSessionInfo {
  sessionId: string;
  isNewSession: boolean;
  isNonStandardId: boolean;
  originalSessionId?: string;
  usedSessionContextManager: boolean;
}

export interface NormalizedWorkspaceInfo {
  workspaceId: string;
  source: 'workspaceContext' | 'context' | 'session' | 'default';
}

export interface NormalizedToolContextResult {
  params: any;
  session: NormalizedSessionInfo;
  workspace: NormalizedWorkspaceInfo;
}

function ensureObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, any>;
}

function getString(value: any): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Normalize a tool params object so that:
 * - `context` always exists as an object
 * - `context.sessionId` is populated (validated/standardized when possible)
 * - `context.workspaceId` and `workspaceContext.workspaceId` are populated and aligned
 *
 * This utility is intended to be used at tool-call boundaries (MCP + Chat View) to keep
 * session/workspace continuity consistent across the codebase.
 */
export async function normalizeToolContext(
  params: any,
  options: NormalizeToolContextOptions = {}
): Promise<NormalizedToolContextResult> {
  const normalizedParams = ensureObject(params);
  normalizedParams.context = ensureObject(normalizedParams.context);

  const defaultWorkspaceId = options.defaultWorkspaceId ?? 'default';

  const sessionIdFromContext = getString(normalizedParams.context.sessionId);
  const sessionIdFromLegacy = getString(normalizedParams.sessionId);
  const providedSessionId = sessionIdFromContext ?? sessionIdFromLegacy ?? '';

  const providedSessionDescription = getString(normalizedParams.context.sessionDescription);
  const hasProvidedSessionId = providedSessionId.length > 0;

  let sessionId = providedSessionId;
  let isNewSession = false;
  let usedSessionContextManager = false;

  const isNonStandardInput = hasProvidedSessionId && !isStandardSessionId(providedSessionId);

  if (options.sessionContextManager?.validateSessionId) {
    try {
      const validated = await options.sessionContextManager.validateSessionId(
        providedSessionId,
        providedSessionDescription
      );
      sessionId = validated.id;
      isNewSession = validated.created;
      usedSessionContextManager = true;
    } catch {
      if (options.fallbackSessionIdProcessor) {
        const fallback = await options.fallbackSessionIdProcessor(providedSessionId);
        sessionId = fallback.sessionId;
        isNewSession = fallback.isNewSession;
      } else if (!hasProvidedSessionId || isNonStandardInput) {
        sessionId = generateSessionId();
        isNewSession = true;
      } else {
        sessionId = providedSessionId;
        isNewSession = false;
      }
    }
  } else if (options.fallbackSessionIdProcessor) {
    const fallback = await options.fallbackSessionIdProcessor(providedSessionId);
    sessionId = fallback.sessionId;
    isNewSession = fallback.isNewSession;
  } else if (!hasProvidedSessionId || isNonStandardInput) {
    sessionId = generateSessionId();
    isNewSession = true;
  }

  normalizedParams.context.sessionId = sessionId;
  if ('sessionId' in normalizedParams) {
    delete normalizedParams.sessionId;
  }

  const isNonStandardId =
    hasProvidedSessionId && typeof sessionId === 'string' && sessionId !== providedSessionId;

  const originalSessionId = isNonStandardId ? providedSessionId : undefined;

  // Workspace normalization
  // 1) Prefer workspaceContext if already provided (or parseable).
  const parsedWorkspace = parseWorkspaceContext(
    normalizedParams.workspaceContext,
    defaultWorkspaceId,
    normalizedParams.context
  );

  let workspaceId: string | undefined;
  let workspaceSource: NormalizedWorkspaceInfo['source'] = 'default';

  if (parsedWorkspace?.workspaceId) {
    workspaceId = parsedWorkspace.workspaceId;
    workspaceSource = normalizedParams.workspaceContext ? 'workspaceContext' : 'context';
    normalizedParams.workspaceContext = parsedWorkspace;
  }

  // 2) Fall back to session-bound workspace context.
  if (!workspaceId && options.sessionContextManager?.getWorkspaceContext) {
    const sessionWorkspace = options.sessionContextManager.getWorkspaceContext(sessionId);
    if (sessionWorkspace?.workspaceId) {
      workspaceId = sessionWorkspace.workspaceId;
      workspaceSource = 'session';
      normalizedParams.workspaceContext = sessionWorkspace;
    }
  }

  // 3) Default.
  if (!workspaceId) {
    workspaceId = defaultWorkspaceId;
    workspaceSource = 'default';
    normalizedParams.workspaceContext = ensureObject(normalizedParams.workspaceContext);
    if (!getString((normalizedParams.workspaceContext as any).workspaceId)) {
      (normalizedParams.workspaceContext as any).workspaceId = workspaceId;
    }
  }

  normalizedParams.context.workspaceId = workspaceId;

  // Mark as normalized so deeper layers can skip duplicate normalization/validation.
  normalizedParams._normalizedContext = true;

  if (options.markSessionFlags) {
    normalizedParams._isNewSession = isNewSession;
    normalizedParams._isNonStandardId = isNonStandardId;
    normalizedParams._originalSessionId = originalSessionId;
  }

  return {
    params: normalizedParams,
    session: {
      sessionId,
      isNewSession,
      isNonStandardId,
      originalSessionId,
      usedSessionContextManager
    },
    workspace: {
      workspaceId,
      source: workspaceSource
    }
  };
}
