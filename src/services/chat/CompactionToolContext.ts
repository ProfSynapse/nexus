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

/** Prefer the complete search schema; a small window can carry the exact
 * catalog-backed recovery arguments without unrelated advanced options. */
export function selectConversationRecoverySchema(catalog: ToolCatalogPort, maxTokens: number, alreadyLoaded: readonly CliToolSchema[] = []): { tools: CliToolSchema[]; deferred: string[] } {
  const full = selectPreviousToolSchemas(['search memory'], catalog, maxTokens, alreadyLoaded);
  if (!full.deferred.length) return full;
  const resolved = catalog.resolve(['search memory']);
  if (!resolved.ok || resolved.value.length !== 1) return full;
  const schema = resolved.value[0];
  if (!schema.arguments?.length) return full;
  const recoveryArguments = new Set(['query', 'memoryTypes', 'sessionName', 'windowSize', 'limit']);
  const subset: CliToolSchema = {
    agent: schema.agent, tool: schema.tool, command: schema.command, usage: schema.usage,
    description: `${schema.description.split('\n')[0]} Recovery argument subset; discover the full schema before using additional options.`,
    arguments: schema.arguments.filter(argument => argument.required || recoveryArguments.has(argument.name))
  };
  const cost = Math.ceil(JSON.stringify([subset], null, 2).length / 4 * 1.2) + 64;
  return cost <= maxTokens ? { tools: [subset], deferred: [] } : full;
}
