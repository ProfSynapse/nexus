import type { IAgent } from '../../interfaces/IAgent';
import type { CliToolSchema, ToolRequestItem } from '../types';
import type { ServiceResult, ToolCatalogPort } from '../../../services/instructions/types';
import { getErrorMessage } from '../../../utils/errorUtils';
import { ToolCliNormalizer } from './ToolCliNormalizer';

export type AgentRegistryGetter = () => ReadonlyMap<string, IAgent>;
export interface ToolCatalogOptions {
  /** `broad` matches discovery: compact agents, full explicitly named tools. */
  compact?: boolean | 'broad';
}

/**
 * Reads the current internal registry without executing tools or granting access.
 * Workflow dependencies request full schemas; discovery can use compact entries.
 * Alias resolution and CLI formatting remain owned by ToolCliNormalizer.
 */
export class ToolCatalogService implements ToolCatalogPort {
  constructor(private readonly getRegistry: AgentRegistryGetter) {}

  resolve(selectors: readonly string[], options: ToolCatalogOptions = {}): ServiceResult<CliToolSchema[]> {
    if (!Array.isArray(selectors)) {
      return this.invalid('Tool dependencies must be an array of agent or agent/tool selectors.');
    }
    for (const selector of selectors) {
      // Dependencies are references, never CLI programs, argument values, or
      // discovery batches. Validate before the normalizer can strip/parse flags.
      if (typeof selector !== 'string' || /[\r\n]/.test(selector) || !/^[A-Za-z][A-Za-z0-9_-]*(?:[ \t]+[A-Za-z][A-Za-z0-9_-]*)?$/.test(selector.trim())) {
        return this.invalid(`Invalid tool dependency ${JSON.stringify(selector)}. Use "agent" or "agent tool" without arguments.`);
      }
    }
    return this.resolveWith(selectors, options);
  }

  /** Preserves the existing discovery grammar, including --help and batches. */
  resolveDiscovery(selector: string): ServiceResult<CliToolSchema[]> {
    return this.resolveWith([selector], { compact: 'broad' });
  }

  private resolveWith(selectors: readonly string[], options: ToolCatalogOptions): ServiceResult<CliToolSchema[]> {
    try {
      const registry = new Map(this.getRegistry());
      const normalizer = new ToolCliNormalizer(registry);
      const requests = selectors.flatMap(selector => normalizer.normalizeDiscoveryRequests({ tool: selector }));
      return this.buildSchemas(requests, registry, normalizer, options);
    } catch (error) {
      return { ok: false, error: { code: 'unavailable', message: getErrorMessage(error) } };
    }
  }

  private buildSchemas(
    requests: readonly ToolRequestItem[],
    registry: ReadonlyMap<string, IAgent>,
    normalizer: ToolCliNormalizer,
    options: ToolCatalogOptions
  ): ServiceResult<CliToolSchema[]> {
    const schemas = new Map<string, CliToolSchema>();
    for (const request of requests) {
      const agent = registry.get(request.agent);
      if (!agent || request.agent === 'toolManager') {
        return { ok: false, error: { code: 'unavailable', message: `Agent "${request.agent}" is unavailable.` } };
      }
      const broad = !request.tools?.length;
      const tools = broad ? agent.getTools() : request.tools?.map(slug => agent.getTool(slug)) ?? [];
      for (const tool of tools) {
        if (!tool) {
          return { ok: false, error: { code: 'unavailable', message: `A requested tool is unavailable in agent "${request.agent}".` } };
        }
        const compact = options.compact === true || (options.compact === 'broad' && broad);
        const schema = normalizer.buildCliSchema(request.agent, tool, { compact });
        const key = `${request.agent}\u0000${tool.slug}`;
        const previous = schemas.get(key);
        // If both broad and explicit references select a tool, retain the full
        // signature independent of which selector appeared first.
        if (!previous || (!compact && !previous.arguments)) schemas.set(key, schema);
      }
    }
    return { ok: true, value: [...schemas.values()] };
  }

  private invalid(message: string): ServiceResult<never> {
    return { ok: false, error: { code: 'invalid', message } };
  }
}
