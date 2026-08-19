/** Eval tool surfaces backed by the versioned release schema catalog. */

import type { Tool } from '../../../src/services/llm/adapters/types';
import { loadEvalSchemaCatalog } from '../SchemaCatalog';
import { DEFAULT_TOOL_CATALOG } from './system-prompt';

export function loadEvalToolFixtures(version = 'latest'): {
  version: string;
  nexusTools: Tool[];
  metaTools: Tool[];
} {
  const catalog = loadEvalSchemaCatalog(version, DEFAULT_TOOL_CATALOG);
  return {
    version: catalog.version,
    nexusTools: catalog.domainTools,
    metaTools: catalog.metaTools,
  };
}

const releaseCatalog = loadEvalToolFixtures(process.env.EVAL_SCHEMA_VERSION ?? 'latest');

export const EVAL_SCHEMA_VERSION = releaseCatalog.version;
export const NEXUS_TOOLS: Tool[] = releaseCatalog.nexusTools;
export const META_TOOLS: Tool[] = releaseCatalog.metaTools;

/** Simple provider-agnostic tools retained for focused adapter smoke tests. */
export const SIMPLE_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a given city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'Get the current time in a given timezone.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone (e.g., America/New_York)' },
        },
        required: ['timezone'],
      },
    },
  },
];
