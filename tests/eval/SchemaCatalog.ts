import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '../../src/services/llm/adapters/types';
import type { ToolCatalogEntry } from '../../src/ui/chat/services/SystemPromptBuilder';

interface CliArgument {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface CliToolSchema {
  agent: string;
  tool: string;
  description: string;
  command: string;
  usage: string;
  arguments: CliArgument[];
  examples: string[];
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface SchemaManifest {
  latest: string;
  versions: Record<string, { cli: string; mcp: string }>;
}

interface CliCatalogFile {
  nexusVersion: string;
  tools: CliToolSchema[];
}

interface McpCatalogFile {
  nexusVersion: string;
  tools: McpToolSchema[];
}

export interface EvalSchemaCatalog {
  version: string;
  cliTools: CliToolSchema[];
  mcpTools: McpToolSchema[];
  domainTools: Tool[];
  metaTools: Tool[];
}

function readJson<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Schema artifact is missing: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function argumentSchema(argument: CliArgument): Record<string, unknown> {
  const common = argument.description ? { description: argument.description } : {};
  const arrayMatch = /^array<(.+)>$/.exec(argument.type);
  if (arrayMatch) {
    const items = arrayMatch[1] === 'unknown' ? {} : { type: arrayMatch[1] };
    return { type: 'array', items, ...common };
  }
  if (argument.type === 'oneOfArray') {
    return { type: 'array', items: {}, ...common };
  }
  if (['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(argument.type)) {
    return { type: argument.type, ...common };
  }
  return { ...common };
}

function toDomainTool(schema: CliToolSchema): Tool {
  const properties = Object.fromEntries(
    schema.arguments.map((argument) => [argument.name, argumentSchema(argument)]),
  );
  const required = schema.arguments
    .filter((argument) => argument.required)
    .map((argument) => argument.name);

  return {
    type: 'function',
    function: {
      name: `${schema.agent}_${schema.tool}`,
      description: schema.description,
      parameters: { type: 'object', properties, required },
    },
  };
}

function toMetaTool(schema: McpToolSchema): Tool {
  if (!schema.name.startsWith('toolManager_')) {
    throw new Error(`Unexpected MCP tool name in schema catalog: ${schema.name}`);
  }
  return {
    type: 'function',
    function: {
      name: schema.name.slice('toolManager_'.length),
      description: schema.description,
      parameters: schema.inputSchema,
    },
  };
}

function selectAdvertisedTools(
  schemas: CliToolSchema[],
  advertisedCatalog?: ToolCatalogEntry[],
): CliToolSchema[] {
  if (!advertisedCatalog) return schemas;

  const selected = new Set(
    advertisedCatalog.flatMap((entry) =>
      entry.tools.map((tool) => `${entry.agent}_${tool}`),
    ),
  );
  const tools = schemas.filter((schema) => selected.has(`${schema.agent}_${schema.tool}`));
  const found = new Set(tools.map((schema) => `${schema.agent}_${schema.tool}`));
  const missing = [...selected].filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(`Advertised eval tools are absent from the generated CLI catalog: ${missing.join(', ')}`);
  }
  return tools;
}

export function loadEvalSchemaCatalog(
  requestedVersion = 'latest',
  advertisedCatalog?: ToolCatalogEntry[],
  schemasRoot = path.resolve(process.cwd(), 'schemas'),
): EvalSchemaCatalog {
  const manifest = readJson<SchemaManifest>(path.join(schemasRoot, 'manifest.json'));
  const version = requestedVersion === 'latest' ? manifest.latest : requestedVersion;
  const entry = manifest.versions[version];
  if (!entry) {
    throw new Error(
      `Schema version "${version}" is unavailable. Available versions: ${Object.keys(manifest.versions).join(', ')}`,
    );
  }

  const cli = readJson<CliCatalogFile>(path.resolve(schemasRoot, entry.cli));
  const mcp = readJson<McpCatalogFile>(path.resolve(schemasRoot, entry.mcp));
  if (cli.nexusVersion !== version || mcp.nexusVersion !== version) {
    throw new Error(`Schema artifact version mismatch for ${version}`);
  }
  const cliTools = selectAdvertisedTools(cli.tools, advertisedCatalog);

  return {
    version,
    cliTools,
    mcpTools: mcp.tools,
    domainTools: cliTools.map(toDomainTool),
    metaTools: mcp.tools.map(toMetaTool),
  };
}
