import { DEFAULT_TOOL_CATALOG } from './fixtures/system-prompt';
import { loadEvalSchemaCatalog } from './SchemaCatalog';

describe('loadEvalSchemaCatalog', () => {
  it('resolves latest and an explicit release to the same generated catalog', () => {
    const latest = loadEvalSchemaCatalog('latest', DEFAULT_TOOL_CATALOG);
    const explicit = loadEvalSchemaCatalog(latest.version, DEFAULT_TOOL_CATALOG);

    expect(explicit.version).toBe(latest.version);
    expect(explicit.cliTools).toEqual(latest.cliTools);
    expect(explicit.metaTools).toEqual(latest.metaTools);
  });

  it('uses the exact MCP surface while exposing internal eval names', () => {
    const catalog = loadEvalSchemaCatalog('latest', DEFAULT_TOOL_CATALOG);

    expect(catalog.mcpTools.map((tool) => tool.name)).toEqual([
      'toolManager_getTools',
      'toolManager_useTools',
    ]);
    expect(catalog.metaTools.map((tool) => tool.function?.name)).toEqual([
      'getTools',
      'useTools',
    ]);
    expect(catalog.metaTools[0].function?.parameters).toEqual(
      catalog.mcpTools[0].inputSchema,
    );
  });

  it('derives the advertised domain schemas from generated CLI arguments', () => {
    const catalog = loadEvalSchemaCatalog('latest', DEFAULT_TOOL_CATALOG);
    const replace = catalog.domainTools.find(
      (tool) => tool.function?.name === 'contentManager_replace',
    );

    expect(replace).toBeDefined();
    expect(replace?.function?.parameters.required).toEqual([
      'path',
      'start',
      'end',
      'content',
    ]);
    expect(catalog.domainTools.some(
      (tool) => tool.function?.name === 'searchManager_replace',
    )).toBe(false);
  });

  it('fails clearly when a requested schema release is unavailable', () => {
    expect(() => loadEvalSchemaCatalog('0.0.0', DEFAULT_TOOL_CATALOG)).toThrow(
      /Schema version "0\.0\.0" is unavailable/,
    );
  });
});
