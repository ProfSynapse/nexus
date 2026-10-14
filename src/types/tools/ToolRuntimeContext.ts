/**
 * Runtime identity of a tool call, supplied by the tool batch executor.
 *
 * Most tools only see their parameters. A tool that needs to know which
 * conversation called it, and whether the call came from internal chat or an
 * external MCP client, opts in with `acceptsToolRuntimeContext` and receives
 * this object as the second argument to `execute`.
 */
export interface ToolRuntimeContext {
  conversationId: string;
  messageId: string;
  workspaceId?: string;
  sessionId?: string;
  source: 'internal' | 'mcp';
  isSubagentBranch: boolean;
}

export interface ToolRuntimeContextConsumer {
  readonly acceptsToolRuntimeContext: true;
}

export function acceptsToolRuntimeContext(tool: unknown): tool is ToolRuntimeContextConsumer {
  return typeof tool === 'object'
    && tool !== null
    && (tool as { acceptsToolRuntimeContext?: unknown }).acceptsToolRuntimeContext === true;
}
