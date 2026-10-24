import type { ConversationMessage } from '../../types/chat/ChatTypes';
import type { CliToolSchema } from '../../agents/toolManager/types';
import type { ToolCatalogPort } from '../instructions/types';
import { parseCliForDisplay } from '../../agents/toolManager/services/ToolCliNormalizer';

/** Most-recent first, including the real commands inside useTools batches. */
export function previouslyUsedTools(messages: ConversationMessage[], previous: readonly string[] = []): string[] {
  const selectors: string[] = [];
  for (const message of [...messages].reverse()) {
    for (const call of [...(message.toolCalls ?? [])].reverse()) {
      const name = ('technicalName' in call && typeof call.technicalName === 'string' ? call.technicalName : undefined)
        ?? call.function?.name ?? call.name ?? '';
      if (/use[-_]?tools$/i.test(name)) {
        let args: Record<string, unknown> = call.parameters ?? {};
        try {
          const parsed: unknown = JSON.parse(call.function?.arguments ?? '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = { ...args, ...parsed };
        } catch { /* Stored malformed arguments are not executable commands. */ }
        if (typeof args.tool === 'string') {
          try {
            selectors.push(...parseCliForDisplay(args.tool).reverse().map(segment => `${segment.agent} ${segment.tool}`));
          } catch { /* The remaining valid history is still useful. */ }
        }
      } else if (!/get[-_]?tools$/i.test(name)) {
        const match = name.match(/^([A-Za-z][A-Za-z0-9-]*)[_\s]([A-Za-z][A-Za-z0-9_-]*)$/);
        if (match && match[1] !== 'toolManager') selectors.push(`${match[1]} ${match[2]}`);
      }
    }
  }
  return [...new Set([...selectors, ...previous])];
}

/** Resolve fresh schemas; never persist schema bodies or override tool access. */
export function selectPreviousToolSchemas(
  selectors: readonly string[],
  catalog: ToolCatalogPort,
  maxTokens: number,
  alreadyLoaded: readonly CliToolSchema[] = []
): { tools: CliToolSchema[]; deferred: string[] } {
  const tools: CliToolSchema[] = [];
  const deferred: string[] = [];
  const seen = new Set(alreadyLoaded.map(tool => `${tool.agent}/${tool.tool}`));
  for (const selector of [...new Set(selectors)]) {
    const result = catalog.resolve([selector]);
    if (!result.ok || result.value.length !== 1) { deferred.push(selector); continue; }
    const schema = result.value[0];
    const key = `${schema.agent}/${schema.tool}`;
    if (seen.has(key)) continue;
    // Match the prompt's pretty JSON and leave room for XML/framing overhead.
    const cost = Math.ceil(JSON.stringify([...tools, schema], null, 2).length / 4 * 1.2) + 64;
    if (cost > maxTokens) { deferred.push(selector); continue; }
    tools.push(schema);
    seen.add(key);
  }
  return { tools, deferred };
}
