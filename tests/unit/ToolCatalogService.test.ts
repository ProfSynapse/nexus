/**
 * Real CLI normalization must remain shared with discovery. These tests fail if
 * the catalog caches an old registry, loads partial dependencies, accepts a CLI
 * command as a reference, or treats two aliases as separate tools. The fixtures
 * supply tool metadata; the production normalizer decides aliases and signatures.
 */
import { BaseAgent } from '../../src/agents/baseAgent';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import { CONSERVATIVE_TOOL_EXECUTION_POLICY } from '../../src/agents/policy/ToolExecutionPolicy';
import { ToolCatalogService } from '../../src/agents/toolManager/services/ToolCatalogService';
import { ToolCliNormalizer } from '../../src/agents/toolManager/services/ToolCliNormalizer';

function tool(slug: string): ITool {
  return {
    slug, name: slug, version: '1.0.0', description: `Describe ${slug}`,
    execute: jest.fn(async () => ({ success: true })),
    getExecutionPolicy: () => CONSERVATIVE_TOOL_EXECUTION_POLICY,
    getParameterSchema: () => ({ type: 'object', properties: { path: { type: 'string', description: 'Vault path' }, startLine: { type: 'number' }, workspaceId: { type: 'string' } }, required: ['path'] }),
    getResultSchema: () => ({ type: 'object' })
  };
}
class CatalogAgent extends BaseAgent {
  constructor(name: string, tools: ITool[]) { super(name, 'Catalog fixture', '1.0.0'); tools.forEach(item => this.registerTool(item)); }
}
function setup() {
  const read = tool('readNote');
  const write = tool('writeNote');
  const registry = new Map<string, IAgent>([['contentManager', new CatalogAgent('contentManager', [read, write])]]);
  const catalog = new ToolCatalogService(() => registry);
  return { read, write, registry, catalog };
}

describe('ToolCatalogService', () => {
  it('returns the exact CLI schema used by discovery, without executing tools', () => {
    const { catalog, read, registry } = setup();
    const result = catalog.resolve(['content read-note']);
    expect(result).toEqual({ ok: true, value: [new ToolCliNormalizer(registry).buildCliSchema('contentManager', read)] });
    if (result.ok) expect(result.value[0]).toMatchObject({ command: 'content read-note', arguments: [expect.objectContaining({ name: 'path', positional: true }), expect.objectContaining({ name: 'startLine', flag: '--start-line' })] });
    expect(read.execute).not.toHaveBeenCalled();
  });

  it('deduplicates canonical targets across aliases and agent-wide selectors', () => {
    const { catalog } = setup();
    const result = catalog.resolve(['content read-note', 'contentManager readNote', 'content']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map(schema => schema.tool)).toEqual(['readNote', 'writeNote']);
      expect(result.value.every(schema => schema.arguments !== undefined)).toBe(true);
    }
  });

  it('expands an agent selector to every currently registered tool', () => {
    const { catalog, registry } = setup();
    expect(catalog.resolve(['content'])).toMatchObject({ ok: true, value: [{ tool: 'readNote' }, { tool: 'writeNote' }] });
    registry.set('contentManager', new CatalogAgent('contentManager', [tool('readNote'), tool('replace')]));
    expect(catalog.resolve(['content'])).toMatchObject({ ok: true, value: [{ tool: 'readNote' }, { tool: 'replace' }] });
  });

  it('uses current capabilities when an app is registered and then removed', () => {
    const { catalog, registry } = setup();
    expect(catalog.resolve(['web open'])).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    registry.set('webTools', new CatalogAgent('webTools', [tool('open')]));
    expect(catalog.resolve(['web open'])).toMatchObject({ ok: true, value: [{ agent: 'webTools', command: 'web open' }] });
    registry.delete('webTools');
    expect(catalog.resolve(['web open'])).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it.each(['unknown', 'content nonexistent', 'toolManager getTools'])('fails atomically for unavailable dependency %s', selector => {
    const { catalog, read } = setup();
    const result = catalog.resolve(['content read-note', selector]);
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(result).not.toHaveProperty('value');
    expect(read.execute).not.toHaveBeenCalled();
  });

  it.each(['', ' ', '--help', 'content --read-note', 'content read-note --path x', 'content read-note x', 'content read-note, content write-note', 'content read-note; rm -rf x', 'content\nread-note', 'content read-note\n', '"content" read-note', 'content $(command)', 'content read-note | command'])('rejects executable or malformed dependency %j', selector => {
    const { catalog } = setup();
    expect(catalog.resolve([selector])).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('retains full schemas for explicit discovery regardless of selector order', () => {
    const { catalog } = setup();
    for (const selectors of ['content, content read-note', 'content read-note, content']) {
      const result = catalog.resolveDiscovery(selectors);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value.find(schema => schema.tool === 'readNote')).toHaveProperty('arguments');
      }
    }
  });

  it('reports a failing registry getter as unavailable', () => {
    const catalog = new ToolCatalogService(() => { throw new Error('Registry initializing'); });
    expect(catalog.resolve(['content'])).toEqual({ ok: false, error: { code: 'unavailable', message: 'Registry initializing' } });
  });

  it('returns an empty union for no dependencies', () => {
    expect(setup().catalog.resolve([])).toEqual({ ok: true, value: [] });
  });

  it('can return compact schemas when explicitly requested', () => {
    const { catalog } = setup();
    const result = catalog.resolve(['content'], { compact: true });
    expect(result.ok).toBe(true);
    if (result.ok) for (const schema of result.value) expect(schema).not.toHaveProperty('arguments');
  });

  it('preserves discovery --help and mixed compact/full behavior', () => {
    const { catalog } = setup();
    expect(catalog.resolveDiscovery('--help')).toMatchObject({ ok: true, value: [{ command: 'content read-note' }, { command: 'content write-note' }] });
    const result = catalog.resolveDiscovery('content, content read-note');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value.find(schema => schema.tool === 'readNote')).toHaveProperty('arguments');
      expect(result.value.find(schema => schema.tool === 'writeNote')).not.toHaveProperty('arguments');
    }
  });
});
