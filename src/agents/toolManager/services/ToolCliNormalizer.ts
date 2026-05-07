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

function hasOwn(value: unknown, key: string): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

export function toKebabCase(value: string): string {
  return value
    .replace(/Manager$/i, '')
    .replace(/Agent$/i, '')
    .replace(/Tools$/i, '')
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
  // `oneOf` with an array option (e.g. `setProperty.value`) previously fell
  // through to `unknown`, which meant `coerceValue` had no branch to hit and
  // returned the raw string verbatim. A CSV multi-item input like `"a,b,c"`
  // therefore reached the tool as the literal string `"a,b,c"` instead of the
  // array the caller intended. Flag oneOf-with-array here so coerceValue can
  // branch on whether the raw looks like a JSON array literal or a CSV.
  if (Array.isArray(schema.oneOf)) {
    const hasArrayOption = schema.oneOf.some(
      (opt: unknown) => isRecord(opt) && opt.type === 'array'
    );
    if (hasArrayOption) {
      return 'oneOfArray';
    }
  }
  return 'unknown';
}

export function splitTopLevelSegments(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
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
      // A comma is a top-level command separator only when followed by
      // whitespace (or end of input) — the canonical `cmd1, cmd2` form.
      // A comma glued to a non-whitespace character is textual (typically
      // a CSV array flag value like `--paths a,b,c`) and stays in the
      // current segment; the schema-layer `splitCsvRespectingQuotes`
      // then does the per-item split at coercion time. See issue #181.
      const next = input[i + 1];
      const isCommandSeparator = next === undefined || /\s/.test(next);
      if (isCommandSeparator) {
        const trimmed = current.trim();
        if (trimmed.length > 0) {
          segments.push(trimmed);
        }
        current = '';
        continue;
      }
      current += char;
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
  // Single-pass scan so `\\` consumes the backslash first. A sequential
  // .replace() chain would let `\\n` collide with `\n` when the double
  // backslash ran last.
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '\\' || i + 1 >= value.length) {
      out += value[i];
      continue;
    }
    const next = value[i + 1];
    if (next === 'u') {
      const hex = value.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 5;
        continue;
      }
    }
    switch (next) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case '"': out += '"'; break;
      case '\'': out += '\''; break;
      case '\\': out += '\\'; break;
      // POSIX-style: `\X` for any X outside the canonical set drops the
      // backslash (aligns with shell double-quoted behavior, where `\"`
      // already drops the backslash above). A literal `\X` is expressible
      // via `\\X`, which collapses through the `\\` case. Without this,
      // backticks / `$` / `#` etc. carry a phantom backslash into the
      // content payload (see issue #179).
      default: out += next;
    }
    i += 1;
  }
  return out;
}

export interface QuotedToken {
  value: string;
  wasQuoted: boolean;
}

export function tokenizeWithMeta(input: string): QuotedToken[] {
  const tokens: QuotedToken[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;
  // `hasToken` tracks whether we have started a token during the current run
  // so a bare `""` emits an empty-string token rather than being silently
  // dropped (which would let downstream flag/positional parsing consume the
  // wrong next token). `wasQuoted` tracks whether any quote opened in the
  // current token — used downstream to distinguish a positional value whose
  // text happens to start with `--` from a real flag.
  let hasToken = false;
  let wasQuoted = false;

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
      hasToken = true;
      wasQuoted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken || current.length > 0) {
        tokens.push({ value: unescapeQuotedContent(current), wasQuoted });
        current = '';
        hasToken = false;
        wasQuoted = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  // EC-2: an unclosed quote that swallows everything to end-of-input is
  // silent data corruption — in a multi-segment call it would absorb later
  // commands. Throw loud so the caller sees the malformed input.
  if (quote !== null) {
    const quoteName = quote === '"' ? 'double' : 'single';
    throw new Error(`Unclosed ${quoteName} quote in segment "${input}".`);
  }

  if (hasToken || current.length > 0) {
    tokens.push({ value: unescapeQuotedContent(current), wasQuoted });
  }

  return tokens;
}

export function tokenize(input: string): string[] {
  return tokenizeWithMeta(input).map(token => token.value);
}

function coerceValue(raw: string, type: string): unknown {
  if (type === 'number' || type === 'integer') {
    // EC-4: `Number("")` is 0 in JS, which silently turns an empty-string flag
    // value into a valid 0 instead of letting schema validation reject it.
    // Same for whitespace-only. Keep the raw string so the schema layer sees
    // a type mismatch (or "missing required" for required slots).
    if (raw.trim() === '') return raw;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? raw : parsed;
  }

  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    // Previously fell through to `return raw`, silently stringifying bool
    // inputs. `--foo "maybe"` for a boolean slot would reach schema validation
    // as the string "maybe" — schema type-check catches it, but the error
    // message is generic. Throw a canonical-literal error at the parser layer
    // so the LLM sees the exact shape it needs to emit.
    throw new Error(`Boolean value accepts only "true" or "false", got "${raw}".`);
  }

  if (type.startsWith('array<')) {
    // EC-3: `array<X>` must produce `X[]`, not `string[]`. Per-item coerce
    // every element so `array<number>` of "1,2,3" yields [1,2,3] etc. The
    // previous JSON-path early-return only honored the all-strings case;
    // dropped here so JSON-typed items (numbers, objects) flow through.
    const itemType = type.slice('array<'.length, -1);
    const trimmed = raw.trim();
    let jsonItems: unknown[] | null = null;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          jsonItems = parsed;
        }
      } catch {
        // Malformed JSON → fall through to CSV split.
      }
    }
    // Coerce items OUTSIDE the try/catch so per-item canonical-literal errors
    // (e.g., `array<boolean>` with "maybe") propagate instead of being caught
    // by the JSON-parse catch and silently re-routed to CSV split.
    if (jsonItems !== null) {
      return jsonItems.map((item: unknown) => coerceArrayItem(item, itemType));
    }
    return splitCsvRespectingQuotes(stripOuterArrayBrackets(raw)).map(item => coerceValue(item, itemType));
  }

  if (type === 'object') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  if (type === 'oneOfArray') {
    // `oneOf: [string|number|boolean, array<string>]` slot. JSON array literal
    // wins first; otherwise split on top-level commas. A single-item result
    // collapses to a scalar (the outer quotes were already stripped by the
    // tokenizer / CSV splitter) so the caller sees a string, not `["x"]`.
    // Multi-item results become `string[]` for the array branch of oneOf.
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Malformed JSON → fall through to CSV split.
      }
    }
    const items = splitCsvRespectingQuotes(stripOuterArrayBrackets(raw));
    if (items.length >= 2) return items;
    if (items.length === 1) return items[0];
    return raw;
  }

  return raw;
}

/**
 * If `raw` is wrapped by a single outer `[...]` pair (depth returns to zero
 * exactly at the final char), return the unwrapped inner content. Otherwise
 * return `raw` unchanged. Quote-aware: brackets inside `"..."` or `'...'`
 * don't affect depth.
 *
 * Bug this guards: `set-property --value "[[[A]],[[B]],[[C]]]"` where the
 * caller intends an array of three Obsidian wikilinks. JSON.parse fails
 * (wikilinks aren't valid JSON), and the previous CSV fallback split the
 * raw string verbatim — the outer `[` stayed glued to the first item and
 * the outer `]` stayed glued to the last, writing `[[[A]]` and `[[C]]]` to
 * the frontmatter. Stripping the outer pair first leaves `[[A]],[[B]],[[C]]`,
 * which CSV-splits cleanly into `["[[A]]", "[[B]]", "[[C]]"]`.
 *
 * Bare CSV like `[[A]],[[B]]` (no outer wrapper) is preserved: depth zeroes
 * out mid-string at the close of the first wikilink, so the function bails
 * and returns `raw` unchanged.
 *
 * Issue: ProfSynapse/nexus#TBD.
 */
export function stripOuterArrayBrackets(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return raw;

  let depth = 0;
  let quote: '"' | '\'' | null = null;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') { quote = ch; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      // Outer pair only matches if depth zeroes out exactly at the final char.
      // An earlier zero-depth (e.g. `[[A]],[[B]]`) means there's no single
      // outer pair — leave `raw` alone so the CSV splitter sees it as-is.
      if (depth === 0 && i < trimmed.length - 1) return raw;
    }
  }
  if (depth !== 0) return raw; // unbalanced — don't touch
  return trimmed.slice(1, -1);
}

function coerceArrayItem(item: unknown, itemType: string): unknown {
  // JSON-parsed items already have their target type (number, boolean, object).
  // Only string items need to be passed through coerceValue for parsing.
  if (typeof item === 'string') return coerceValue(item, itemType);
  return item;
}

/**
 * Split a CSV-style string into items, respecting quote pairs as item-internal
 * literals. A `,` inside a `"..."` or `'...'` region is preserved; a `,` outside
 * any quote acts as the separator. Outer quotes wrapping an item are stripped.
 *
 * Backward compatible with bare CSV: `"a,b,c"` (no internal quoting) still
 * yields `["a", "b", "c"]`. Issue: ProfSynapse/nexus#163.
 *
 * Examples:
 *   `a,b,c`           → ["a", "b", "c"]
 *   `"a, b",c`        → ["a, b", "c"]
 *   `"a,b","c,d"`     → ["a,b", "c,d"]
 *   `'one, two',three`→ ["one, two", "three"]
 */
export function splitCsvRespectingQuotes(input: string): string[] {
  const items: string[] = [];
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
    if (char === ',') {
      const trimmed = current.trim();
      if (trimmed.length > 0) items.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) items.push(trimmed);
  return items;
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
    const tokens = tokenizeWithMeta(segment);
    if (tokens.length < 2) {
      return [];
    }
    const [agentToken, toolToken, ...rest] = tokens;
    const parameters: Record<string, unknown> = {};
    const looksLikeFlag = (token: QuotedToken): boolean =>
      !token.wasQuoted && token.value.startsWith('--');
    // Display parser is registry-free, so it can't consult a schema to know
    // which flags are booleans. Instead it applies the same SHAPE-level
    // conventions as `parseCommandSegment` and leaves type disambiguation
    // to post-resolution events that have canonical names + types.
    //
    // Conventions mirrored here (so the chat bubble matches the executor):
    //   - `--flag=value` GNU long-option: split on first `=`.
    //   - `--no-foo` (no `=value`) means `{foo: false}`, per §C.1.
    //   - `--foo true` / `--foo false` (unquoted) means `{foo: true/false}`,
    //     per §C.2/§C.3. Quoted `"true"`/`"false"` stays as a string.
    //   - `--foo` with no following value or followed by another flag means
    //     `{foo: true}` (bare boolean flag).
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (!looksLikeFlag(token)) {
        continue;
      }
      let key = token.value.slice(2);
      let inlineValue: string | undefined;
      const equalsIdx = key.indexOf('=');
      if (equalsIdx >= 0) {
        inlineValue = key.slice(equalsIdx + 1);
        key = key.slice(0, equalsIdx);
      }

      if (key.startsWith('no-') && inlineValue === undefined) {
        parameters[key.slice(3)] = false;
        continue;
      }

      if (inlineValue !== undefined) {
        if (inlineValue === 'true') parameters[key] = true;
        else if (inlineValue === 'false') parameters[key] = false;
        else parameters[key] = inlineValue;
        continue;
      }

      const next = rest[i + 1];
      if (next === undefined || looksLikeFlag(next)) {
        parameters[key] = true;
        continue;
      }

      if (!next.wasQuoted && (next.value === 'true' || next.value === 'false')) {
        parameters[key] = next.value === 'true';
      } else {
        parameters[key] = next.value;
      }
      i += 1;
    }
    return [{ agent: agentToken.value, tool: toolToken.value, parameters }];
  });
}

export class ToolCliNormalizer {
  constructor(private agentRegistry: Map<string, IAgent>) {}

  normalizeContext(params: GetToolsParams | UseToolParams): ToolContext {
    if (hasOwn(params, 'context')) {
      throw new Error('Deprecated payload shape: move workspaceId, sessionId, memory, goal, and constraints out of "context" and onto the top level.');
    }

    return {
      workspaceId: params.workspaceId || 'default',
      sessionId: params.sessionId || `session_${Date.now()}`,
      memory: params.memory || '',
      goal: params.goal || '',
      ...(params.constraints ? { constraints: params.constraints } : {}),
      ...(params.imageProvider ? { imageProvider: params.imageProvider } : {}),
      ...(params.imageModel ? { imageModel: params.imageModel } : {}),
      ...(params.transcriptionProvider ? { transcriptionProvider: params.transcriptionProvider } : {}),
      ...(params.transcriptionModel ? { transcriptionModel: params.transcriptionModel } : {})
    };
  }

  normalizeDiscoveryRequests(params: GetToolsParams): ToolRequestItem[] {
    if (hasOwn(params, 'request')) {
      throw new Error('Deprecated payload shape: getTools no longer accepts "request". Use the top-level "tool" selector string instead.');
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
    if (hasOwn(params, 'calls')) {
      throw new Error('Deprecated payload shape: useTools no longer accepts "calls". Put one or more CLI commands in the top-level "tool" string.');
    }

    const command = typeof params.tool === 'string' ? params.tool.trim() : '';
    if (!command) {
      throw new Error('tool is required. Use a top-level CLI command string such as "content read --path notes/today.md".');
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
    const tokens = tokenizeWithMeta(segment);
    if (tokens.length < 2) {
      throw new Error(`Invalid command "${segment}". Expected "agent tool-name [flags...]"`);
    }

    const resolved = this.resolveTarget(tokens[0].value, tokens[1].value);
    if (!resolved.toolSlug) {
      throw new Error(`Command "${segment}" is missing a tool name after "${tokens[0].value}".`);
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
      const isFlag = !token.wasQuoted && token.value.startsWith('--');
      if (isFlag) {
        // EC-5: GNU long-option syntax `--flag=value`. Split before the
        // context/no-/lookup checks so they all see the bare flag name.
        // Multiple `=` characters keep the first as the separator so
        // `--label=foo=bar` yields flag="label", value="foo=bar".
        let normalizedFlag = token.value.slice(2);
        let inlineValue: string | undefined;
        const equalsIdx = normalizedFlag.indexOf('=');
        if (equalsIdx >= 0) {
          inlineValue = normalizedFlag.slice(equalsIdx + 1);
          normalizedFlag = normalizedFlag.slice(0, equalsIdx);
        }

        if (CONTEXT_FLAG_NAMES.has(normalizedFlag)) {
          throw new Error(`Do not include --${normalizedFlag} inside "tool". Keep context fields at the top level of useTools/getTools.`);
        }

        if (normalizedFlag.startsWith('no-')) {
          if (inlineValue !== undefined) {
            throw new Error(`Negation flag "--${normalizedFlag}" cannot be combined with =value.`);
          }
          const boolArg = cliSchema.arguments.find(arg => arg.flag === `--${normalizedFlag.slice(3)}` && arg.type === 'boolean');
          if (!boolArg) {
            throw new Error(`Unknown flag "${token.value}" for ${resolved.agentName}.${resolved.toolSlug}. Call getTools first to inspect supported flags.`);
          }
          params[boolArg.name] = false;
          continue;
        }

        const flagSpec = `--${normalizedFlag}`;
        const arg = cliSchema.arguments.find(item => item.flag === flagSpec);
        if (!arg) {
          throw new Error(`Unknown flag "${token.value}" for ${resolved.agentName}.${resolved.toolSlug}. Call getTools first to inspect supported flags.`);
        }

        if (arg.type === 'boolean') {
          if (inlineValue !== undefined) {
            // EC-5: inline value for boolean must be the canonical literal.
            if (inlineValue !== 'true' && inlineValue !== 'false') {
              throw new Error(`Boolean flag "${flagSpec}" only accepts =true or =false, got "${inlineValue}".`);
            }
            params[arg.name] = inlineValue === 'true';
            continue;
          }
          // §C.2/§C.3: accept an unquoted `true`/`false` literal as the flag
          // value if it follows the flag. Quoted literals stay as positional
          // values (so `--bool "true"` means bool=true + positional "true",
          // matching typical shell semantics).
          const peek = tokens[index + 1];
          if (peek && !peek.wasQuoted && (peek.value === 'true' || peek.value === 'false')) {
            params[arg.name] = peek.value === 'true';
            index += 1;
          } else {
            params[arg.name] = true;
          }
          continue;
        }

        let value: string;
        if (inlineValue !== undefined) {
          // Reject `--flag=` with empty RHS for non-bool slots. Previously the
          // empty string passed the schema-required check (not `undefined`)
          // and validators that accept any string silently accepted "". The
          // space-separated form `--flag ""` is still legal and goes through
          // the `next.value` branch below — that one is an explicit empty
          // string, not a dropped value. (Bool slots are already guarded
          // above: `=` with no RHS on a bool throws earlier because "" is
          // neither "true" nor "false".)
          if (inlineValue === '') {
            throw new Error(`Flag "${flagSpec}" requires a non-empty value after "=". Use '${flagSpec} ""' if an empty string is intended.`);
          }
          value = inlineValue;
        } else {
          const next = tokens[index + 1];
          if (next === undefined) {
            throw new Error(`Flag "${flagSpec}" requires a value.`);
          }
          // EC-1: reject a flag value that is itself a flag. Quoted positional
          // flag-likes (e.g., `--label "--important"`) stay legal because
          // wasQuoted=true is the explicit "this is data, not a flag" signal.
          if (!next.wasQuoted && next.value.startsWith('--')) {
            throw new Error(`Flag "${flagSpec}" requires a value, got flag "${next.value}".`);
          }
          value = next.value;
          index += 1;
        }

        params[arg.name] = coerceValue(value, arg.type);
        continue;
      }

      // §G.1/§G.2: skip positional slots already filled by named flags, so a
      // mixed call like `content write --path "x.md" "body"` fills `content`
      // with "body" instead of overwriting `path`. If every slot is filled,
      // the fall-through below raises "Too many positional arguments" (which
      // replaces the previous silent overwrite bug).
      while (
        positionalIndex < positionalArgs.length &&
        params[positionalArgs[positionalIndex].name] !== undefined
      ) {
        positionalIndex += 1;
      }

      const positional = positionalArgs[positionalIndex];
      if (!positional) {
        throw new Error(`Too many positional arguments for ${resolved.agentName}.${resolved.toolSlug}. Call getTools first to inspect supported flags.`);
      }

      params[positional.name] = coerceValue(token.value, positional.type);
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

  public getAgentAlias(agentName: string): string {
    return toKebabCase(agentName);
  }
}
