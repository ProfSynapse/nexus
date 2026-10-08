/** Remote results belong to their originating chat, independently of a local turn. */
export function isRemoteAgentReply(message: { metadata?: Record<string, unknown> }): boolean {
  return message.metadata?.type === 'subagent_result'
    && typeof message.metadata.remoteJobId === 'string'
    && message.metadata.remoteJobId.length > 0;
}
