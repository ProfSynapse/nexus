import { IAgent } from '../../interfaces/IAgent';
import {
  CliArgumentSchema,
  CliToolSchema,
  GetToolsParams,
  ToolCallParams,
  ToolContext,
  ToolRequestItem,
  UseToolParams
} from '../types';

type ToolLike = {
  slug: string;
  description: string;
  getParameterSchema(): unknown;
};

interface ResolvedToolTarget {
  agentName: string;
  toolSlug?: string;
}

const TOP_LEVEL_CONTEXT_KEYS = new Set([
  'workspaceId',
  'sessionId',
  'memory',
  'goal',
  'constraints',
  'imageProvider',
  'imageModel',
  'transcriptionProvider',
  'transcriptionModel'
]);

const CONTEXT_FLAG_NAMES = new Set([
  'workspace-id',
  'session-id',
  'memory',
  'goal',
  'constraints',
  'image-provider',
  'image-model',
  'transcription-provider',
  'transcription-model'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toKebabCase(value: string): string {
  return value
    .replace(/Manager$/i, '')
    .replace(/Agent$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/--+/g, '-')
    .toLowerCase();
}

function getSchemaType(schema: Record<string, unknown>): string {
  if (schema.type === 'array') {
    const items = isRecord(schema.items) ? schema.items : {};
    return `array<${typeof items.type === 'string' ? items.type : 'unknown'}>`;
  }
  if (typeof schema.type === 'string') {
    return schema.type;
  }
  return 'unknown';
}

export function splitTopLevelSegments(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if ((char === '"' || char === '\'') && (!quote || quote === char)) {
      quote = quote === char ? null : char;
      current += char;
      continue;
    }

    if (char === ',' && !quote) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    segments.push(trimmed);
  }

  return segments;
}

function unescapeQuotedContent(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, '\'')
    .replace(/\\\\/g, '\\');
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      current += char;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(unescapeQuotedContent(current));
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(unescapeQuotedContent(current));
  }

  return tokens;
}

function coerceValue(raw: string, type: string): unknown {
  if (type === 'number' || type === 'integer') {
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? raw : parsed;
  }

  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }

  if (type.startsWith('array<')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
          return parsed;
        }
      } catch {
        // Fall through to CSV split for malformed JSON.
      }
    }
    return raw.split(',').map(part => part.trim()).filter(Boolean);
  }

  if (type === 'object') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

/**
 * Descriptor of a single CLI segment parsed for display.
 * Registry-free: agent and tool are the CLI aliases as written by the LLM,
 * not the canonical slugs the executor resolves them to. Use only for
 * streaming-phase UI previews; live execution events emit canonical names.
 */
export interface CliDisplaySegment {
  agent: string;
  tool: string;
  parameters: Record<string, unknown>;
}

/**
 * Parse a `useTools` `tool:` CLI string for display purposes (accordion
 * bubbles, status bar) without touching the agent registry. Returns one
 * entry per comma-separated segment. Tokens inside a segment are: the
 * agent alias, the tool slug, then `--flag value` pairs or positional
 * values. Flags not followed by a value are treated as boolean-true.
 */
export function parseCliForDisplay(toolString: string): CliDisplaySegment[] {
  return splitTopLevelSegments(toolString).flatMap(segment => {
    const tokens = tokenize(segment);
    if (tokens.length < 2) {
      return [];
    }
    const [agent, tool, ...rest] = tokens;
    const parameters: Record<string, unknown> = {};
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token.startsWith('--')) {
        const key = token.slice(2);
        const next = rest[i + 1];
        if (next === undefined || next.startsWith('--')) {
          parameters[key] = true;
        } else {
          parameters[key] = next;
          i += 1;
        }
      }
    }
    return [{ agent, tool, parameters }];
  });
}

export class ToolCliNormalizer {
  constructor(private agentRegistry: Map<string, IAgent>) {}

  normalizeContext(params: GetToolsParams | UseToolParams): ToolContext {
    const legacy = params.context || {};

    return {
      workspaceId: params.workspaceId || legacy.workspaceId || 'default',
      sessionId: params.sessionId || legacy.sessionId || `session_${Date.now()}`,
      memory: params.memory || legacy.memory || '',
      goal: params.goal || legacy.goal || '',
      ...(params.constraints || legacy.constraints ? { constraints: params.constraints || legacy.constraints } : {}),
      ...(params.imageProvider || legacy.imageProvider ? { imageProvider: params.imageProvider || legacy.imageProvider } : {}),
      ...(params.imageModel || legacy.imageModel ? { imageModel: params.imageModel || legacy.imageModel } : {}),
      ...(params.transcriptionProvider || legacy.transcriptionProvider ? { transcriptionProvider: params.transcriptionProvider || legacy.transcriptionProvider } : {}),
      ...(params.transcriptionModel || legacy.transcriptionModel ? { transcriptionModel: params.transcriptionModel || legacy.transcriptionModel } : {})
    };
  }

  normalizeDiscoveryRequests(params: GetToolsParams): ToolRequestItem[] {
    if (Array.isArray(params.request) && params.request.length > 0) {
      return params.request;
    }

    const selector = typeof params.tool === 'string' ? params.tool.trim() : '';
    if (!selector) {
      throw new Error('tool is required. Use "--help", "storage", "storage move", or a comma-separated list of selectors.');
    }

    if (selector === '--help') {
      return Array.from(this.agentRegistry.keys())
        .filter(agentName => agentName !== 'toolManager')
        .map(agentName => ({ agent: agentName }));
    }

    return splitTopLevelSegments(selector).map(segment => {
      const tokens = tokenize(segment);
      if (tokens.length === 0) {
        throw new Error(`Invalid empty selector in "${selector}"`);
      }
      if (tokens.length > 2) {
        throw new Error(`Invalid selector "${segment}". Use "--help", "agent", or "agent tool".`);
      }

      const resolved = this.resolveTarget(tokens[0], tokens[1]);
      return {
        agent: resolved.agentName,
        ...(resolved.toolSlug ? { tools: [resolved.toolSlug] } : {})
      };
    });
  }

  normalizeExecutionCalls(params: UseToolParams): ToolCallParams[] {
    if (Array.isArray(params.calls) && params.calls.length > 0) {
      return params.calls;
    }

    const command = typeof params.tool === 'string' ? params.tool.trim() : '';
    if (!command) {
      throw new Error('tool is required. Use a CLI command string such as "content read --path notes/today.md".');
    }

    return splitTopLevelSegments(command).map(segment => this.parseCommandSegment(segment));
  }

  buildCliSchema(agentName: string, tool: ToolLike): CliToolSchema {
    const baseCommand = `${this.getAgentAlias(agentName)} ${toKebabCase(tool.slug)}`;
    const inputSchema = this.stripCommonParams(tool.getParameterSchema() as Record<string, unknown>);
    const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
    const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required.filter((value): value is string => typeof value === 'string') : []);

    const argumentsSchema: CliArgumentSchema[] = Object.entries(properties).map(([name, rawSchema]) => {
      const schema = isRecord(rawSchema) ? rawSchema : {};
      const type = getSchemaType(schema);
      const requiredArg = required.has(name);
      const positional = requiredArg && type !== 'boolean' && type !== 'object' && !type.startsWith('array<');
      return {
        name,
        flag: `--${toKebabCase(name)}`,
        type,
        required: requiredArg,
        positional,
        description: typeof schema.description === 'string' ? schema.description : undefined
      };
    });

    const usageParts = [baseCommand];
    for (const arg of argumentsSchema) {
      if (arg.positional) {
        usageParts.push(`<${arg.name}>`);
      } else if (arg.type === 'boolean') {
        usageParts.push(arg.required ? arg.flag : `[${arg.flag}]`);
      } else {
        usageParts.push(arg.required ? `${arg.flag} <${arg.name}>` : `[${arg.flag} <${arg.name}>]`);
      }
    }

    const exampleParts = [baseCommand];
    for (const arg of argumentsSchema) {
      if (arg.type === 'boolean') {
        if (!arg.required) {
          continue;
        }
        exampleParts.push(arg.flag);
        continue;
      }

      const exampleValue = arg.type === 'number' || arg.type === 'integer'
        ? '1'
        : arg.type.startsWith('array<')
          ? '"value-1,value-2"'
          : arg.type === 'object'
            ? '\'{"key":"value"}\''
            : `"${arg.name}-value"`;

      if (arg.positional) {
        exampleParts.push(exampleValue);
      } else {
        exampleParts.push(arg.flag, exampleValue);
      }
    }

    return {
      agent: agentName,
      tool: tool.slug,
      description: tool.description,
      command: baseCommand,
      usage: usageParts.join(' '),
      arguments: argumentsSchema,
      examples: [exampleParts.join(' ')]
    };
  }

  stripCommonParams(schema: Record<string, unknown>): Record<string, unknown> {
    const result = { ...schema };

    if (isRecord(result.properties)) {
      const properties = { ...result.properties };
      for (const key of Object.keys(properties)) {
        if (TOP_LEVEL_CONTEXT_KEYS.has(key) || key === 'context' || key === 'workspaceContext') {
          delete properties[key];
        }
      }
      result.properties = properties;
    }

    if (Array.isArray(result.required)) {
      result.required = result.required.filter(
        (value): value is string => typeof value === 'string' && !TOP_LEVEL_CONTEXT_KEYS.has(value) && value !== 'context' && value !== 'workspaceContext'
      );
    }

    return result;
  }

  private parseCommandSegment(segment: string): ToolCallParams {
    const tokens = tokenize(segment);
    if (tokens.length < 2) {
      throw new Error(`Invalid command "${segment}". Expected "agent tool-name [flags...]"`);
    }

    const resolved = this.resolveTarget(tokens[0], tokens[1]);
    if (!resolved.toolSlug) {
      throw new Error(`Command "${segment}" is missing a tool name after "${tokens[0]}".`);
    }

    const agent = this.agentRegistry.get(resolved.agentName);
    const tool = agent?.getTool(resolved.toolSlug);
    if (!agent || !tool) {
      throw new Error(`Unknown command "${segment}". Call getTools first to inspect available commands.`);
    }

    const cliSchema = this.buildCliSchema(resolved.agentName, {
      slug: tool.slug,
      description: tool.description,
      getParameterSchema: () => tool.getParameterSchema()
    });

    const params: Record<string, unknown> = {};
    const positionalArgs = cliSchema.arguments.filter(arg => arg.positional);
    let positionalIndex = 0;

    for (let index = 2; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.startsWith('--')) {
        const normalizedFlag = token.slice(2);
        if (CONTEXT_FLAG_NAMES.has(normalizedFlag)) {
          throw new Error(`Do not include --${normalizedFlag} inside "tool". Keep context fields at the top level of useTools/getTools.`);
        }

        if (normalizedFlag.startsWith('no-')) {
          const boolArg = cliSchema.arguments.find(arg => arg.flag === `--${normalizedFlag.slice(3)}` && arg.type === 'boolean');
          if (!boolArg) {
            throw new Error(`Unknown flag "${token}" for ${resolved.agentName}.${resolved.toolSlug}. Call getTools first to inspect supported flags.`);
          }
          params[boolArg.name] = false;
          continue;
        }

        const arg = cliSchema.arguments.find(item => item.flag === token);
        if (!arg) {
          throw new Error(`Unknown flag "${token}" for ${resolved.agentName}.${resolved.toolSlug}. Call getTools first to inspect supported flags.`);
        }

        if (arg.type === 'boolean') {
          params[arg.name] = true;
          continue;
        }

        const next = tokens[index + 1];
        if (next === undefined) {
          throw new Error(`Flag "${token}" requires a value.`);
        }

        params[arg.name] = coerceValue(next, arg.type);
        index += 1;
        continue;
      }

      const positional = positionalArgs[positionalIndex];
      if (!positional) {
        throw new Error(`Too many positional arguments for ${resolved.agentName}.${resolved.toolSlug}. Call getTools first to inspect supported flags.`);
      }

      params[positional.name] = coerceValue(token, positional.type);
      positionalIndex += 1;
    }

    for (const arg of cliSchema.arguments) {
      if (arg.required && params[arg.name] === undefined) {
        throw new Error(`Missing required argument "${arg.name}" for ${resolved.agentName}.${resolved.toolSlug}.`);
      }
    }

    return {
      agent: resolved.agentName,
      tool: resolved.toolSlug,
      params
    };
  }

  private resolveTarget(agentToken: string, toolToken?: string): ResolvedToolTarget {
    const normalizedAgent = toKebabCase(agentToken);
    const agentEntry = Array.from(this.agentRegistry.keys())
      .filter(agentName => agentName !== 'toolManager')
      .find(agentName => {
        const alias = this.getAgentAlias(agentName);
        return normalizedAgent === alias || normalizedAgent === toKebabCase(agentName);
      });

    if (!agentEntry) {
      throw new Error(`Unknown agent "${agentToken}". Call getTools("--help") to list available agents.`);
    }

    if (!toolToken) {
      return { agentName: agentEntry };
    }

    const normalizedTool = toKebabCase(toolToken.replace(/^--/, ''));
    const tool = this.agentRegistry.get(agentEntry)?.getTools().find(candidate => toKebabCase(candidate.slug) === normalizedTool);
    if (!tool) {
      throw new Error(`Unknown tool "${toolToken}" for agent "${agentToken}". Call getTools("${this.getAgentAlias(agentEntry)}") to inspect available commands.`);
    }

    return {
      agentName: agentEntry,
      toolSlug: tool.slug
    };
  }

  private getAgentAlias(agentName: string): string {
    return toKebabCase(agentName);
  }
}
