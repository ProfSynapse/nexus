/**
 * tests/unit/EnvelopeWorkspaceIdRequired.test.ts — issue #214.
 *
 * The envelope disagreed with itself about `workspaceId` in two ways:
 *
 * 1. OMISSION vs EMPTY STRING. Both envelope schemas list `workspaceId` in
 *    `required`, and on the MCP path that array IS enforced at runtime
 *    (ValidationService → validateParams → "Missing required parameter"), so
 *    omitting the field hard-fails. But `required` only asks whether the key is
 *    PRESENT — `workspaceId: ""` passed that check and then hit
 *    `params.workspaceId || 'default'` in ToolCliNormalizer.normalizeContext,
 *    which silently filed the call under the global workspace. A caller whose
 *    template rendered to empty behaved completely differently from one that
 *    omitted the field, and nothing told it so.
 *
 * 2. THE SCHEMA CONTRADICTED ITSELF. The parameter description read "Workspace
 *    ID. Optional. Defaults to \"default\"." while the same schema listed the
 *    field as required. The description was corrected first; then the other
 *    half of #214 — session stickiness — landed (docs/plans/
 *    session-sticky-context-plan.md, PR 1): a session's workspace is bound by
 *    the first call that names it and inherited by later calls, so
 *    `workspaceId` LEFT `required` on both schemas. Requiredness of the FIRST
 *    call is enforced where it can see the session, in the normalizer, after
 *    ToolExecutionStrategy.processSession has written the inherited value
 *    back onto `params`.
 *
 * What this file still pins: the normalizer receives the RESOLVED value, and
 * an empty one (never bound, nothing explicit) fails loudly with the one
 * "pass it once" steer — blank, whitespace and absent identically — rather
 * than silently becoming 'default'. The guard lives in the normalizer because
 * tool parameter schemas are documentation plus CLI-normalizer hints, not
 * runtime validation.
 */
import {
  ToolCliNormalizer,
  WORKSPACE_ID_REQUIRED_MESSAGE,
  normalizeRequiredWorkspaceId
} from '../../src/agents/toolManager/services/ToolCliNormalizer';
import { UseToolTool } from '../../src/agents/toolManager/tools/useTools';
import { GetToolsTool } from '../../src/agents/toolManager/tools/getTools';
import { ToolBatchExecutionService } from '../../src/agents/toolManager/services/ToolBatchExecutionService';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { UseToolParams } from '../../src/agents/toolManager/types';

const FILLED_CONTEXT = {
  sessionId: 'note-cleanup',
  memory: 'Reviewed the vault and listed the workspaces.',
  goal: 'Move the archived note into place.',
  tool: 'content read --path notes/source.md'
};

/** Minimal registry so `normalizeExecutionCalls` can resolve a real command. */
function createRegistry(): Map<string, IAgent> {
  const readTool = {
    slug: 'read',
    name: 'Read',
    description: 'Read a note',
    version: '1.0.0',
    execute: jest.fn().mockResolvedValue({ success: true }),
    getParameterSchema: () => ({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }),
    getResultSchema: () => ({ type: 'object' })
  };
  const agent = {
    name: 'contentManager',
    description: 'Content manager',
    version: '1.0.0',
    getTools: () => [readTool],
    getTool: (slug: string) => (slug === 'read' ? readTool : undefined),
    initialize: jest.fn(),
    executeTool: jest.fn(),
    setAgentManager: jest.fn()
  };
  return new Map<string, IAgent>([['contentManager', agent as unknown as IAgent]]);
}

function createNormalizer(): ToolCliNormalizer {
  return new ToolCliNormalizer(createRegistry());
}

function createUseTool(): { tool: UseToolTool; execute: jest.SpyInstance } {
  const batchExecutionService = {
    execute: jest.fn().mockResolvedValue({ success: true })
  } as unknown as ToolBatchExecutionService;
  const tool = new UseToolTool(batchExecutionService, createNormalizer());
  return { tool, execute: batchExecutionService.execute as unknown as jest.SpyInstance };
}

describe('envelope workspaceId requiredness (#214)', () => {
  describe('empty behaves exactly like omitted', () => {
    // Pre-fix these three diverged: undefined and '' both silently became
    // 'default' inside normalizeContext, while the MCP layer rejected only the
    // omission. Now all three fail identically, at the same layer.
    const blanks: Array<[string, unknown]> = [
      ['omitted', undefined],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['tab and newline', '\t\n'],
      ['null', null]
    ];

    it.each(blanks)('rejects %s with the one shared message', (_label, value) => {
      const normalizer = createNormalizer();
      expect(() =>
        normalizer.normalizeContext({ ...FILLED_CONTEXT, workspaceId: value } as UseToolParams)
      ).toThrow(WORKSPACE_ID_REQUIRED_MESSAGE);
    });

    it('steers toward "pass it once", naming both ways to bind and the inheritance', () => {
      // The caller most likely to hit this is a fresh session (or a template
      // that rendered to empty). The steer has to say what to do ONCE — name a
      // workspace or load one — and that later calls inherit it, or the model
      // goes back to restating it on every call.
      expect(WORKSPACE_ID_REQUIRED_MESSAGE).toContain('no workspace yet');
      expect(WORKSPACE_ID_REQUIRED_MESSAGE).toContain('"default"');
      expect(WORKSPACE_ID_REQUIRED_MESSAGE).toContain('memory load-workspace');
      expect(WORKSPACE_ID_REQUIRED_MESSAGE).toMatch(/inherit/i);
      // And it must never re-teach the every-call habit.
      expect(WORKSPACE_ID_REQUIRED_MESSAGE).not.toMatch(/every call/i);
    });

    it('never silently substitutes "default" for a blank value', () => {
      for (const [, value] of blanks) {
        expect(() => normalizeRequiredWorkspaceId(value)).toThrow(WORKSPACE_ID_REQUIRED_MESSAGE);
      }
    });
  });

  describe('a real workspace still passes', () => {
    it('keeps an explicit id', () => {
      const context = createNormalizer().normalizeContext({
        ...FILLED_CONTEXT,
        workspaceId: 'a8fbad11-7412-49c8-bce0-5690e2c1d197'
      } as UseToolParams);
      expect(context.workspaceId).toBe('a8fbad11-7412-49c8-bce0-5690e2c1d197');
    });

    it('keeps an explicit "default"', () => {
      const context = createNormalizer().normalizeContext({
        ...FILLED_CONTEXT,
        workspaceId: 'default'
      } as UseToolParams);
      expect(context.workspaceId).toBe('default');
    });

    it('trims surrounding whitespace instead of minting " Desenvolvedor "', () => {
      // Unambiguous, so trimming beats rejecting — and it stops a padded value
      // from reaching the repository guard as its own path segment.
      const context = createNormalizer().normalizeContext({
        ...FILLED_CONTEXT,
        workspaceId: '  Desenvolvedor  '
      } as UseToolParams);
      expect(context.workspaceId).toBe('Desenvolvedor');
    });
  });

  describe('useTools execution', () => {
    it('refuses to execute anything when workspaceId is an empty string', async () => {
      const { tool, execute } = createUseTool();
      await expect(
        tool.execute({ ...FILLED_CONTEXT, workspaceId: '' } as UseToolParams)
      ).rejects.toThrow(WORKSPACE_ID_REQUIRED_MESSAGE);
      // Pre-fix this batch ran, in the "default" workspace.
      expect(execute).not.toHaveBeenCalled();
    });

    it('executes normally with a real workspaceId', async () => {
      const { tool, execute } = createUseTool();
      const result = await tool.execute({
        ...FILLED_CONTEXT,
        workspaceId: 'Desenvolvedor'
      } as UseToolParams);
      expect(result).toEqual({ success: true });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0].context.workspaceId).toBe('Desenvolvedor');
    });
  });

  describe('schema text agrees with the enforced contract', () => {
    const schemas: Array<[string, () => Record<string, unknown>]> = [
      ['useTools', () => createUseTool().tool.getParameterSchema()],
      [
        'getTools',
        () =>
          new GetToolsTool(new Map<string, IAgent>(), {
            workspaces: [],
            customAgents: [],
            vaultRoot: []
          }).getParameterSchema()
      ]
    ];

    it.each(schemas)('%s does not list workspaceId or sessionId as required', (_name, getSchema) => {
      // On the MCP path `required` IS enforced (ValidationService), so listing
      // either would force every call to restate what the session already
      // remembers — the exact per-call tax the sticky contract removes.
      const schema = getSchema();
      expect(schema.required).not.toContain('workspaceId');
      expect(schema.required).not.toContain('sessionId');
      expect(schema.required).toEqual(expect.arrayContaining(['memory', 'goal', 'tool']));
    });

    it.each(schemas)('%s describes workspaceId as pass-once-and-inherited, never as defaulting', (_name, getSchema) => {
      const schema = getSchema();
      const properties = schema.properties as Record<string, { description: string }>;
      const description = properties.workspaceId.description;
      expect(description).toMatch(/inherit/i);
      expect(description).toMatch(/once/i);
      // The specific claim that regressed: "Defaults to \"default\"". An empty
      // string must be described as omitted, not as the global workspace.
      expect(description).not.toMatch(/defaults to/i);
      expect(description).toMatch(/never as "default"/i);
    });

    it('neither known-good example inlines "workspaceId":"default" any more', () => {
      // The example is what models copy. `"workspaceId":"default"` in it is how
      // whole sessions got filed under the global workspace (#214).
      const useTools = createUseTool().tool;
      const getTools = new GetToolsTool(new Map<string, IAgent>(), { workspaces: [], customAgents: [], vaultRoot: [] });
      expect(useTools.description).not.toContain('"workspaceId":"default"');
      expect(getTools.description).not.toContain('"workspaceId":"default"');
    });
  });
});
