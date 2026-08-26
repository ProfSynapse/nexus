import fs from 'node:fs';
import path from 'node:path';
import {
  TOOL_EXECUTION_POLICY_CATALOG,
  UNKNOWN_TOOL_POLICY_ALLOWLIST,
} from '../../src/agents/policy/ToolExecutionPolicyCatalog';
import type { App } from 'obsidian';
import { BaseTool } from '../../src/agents/baseTool';
import { ContentManagerAgent } from '../../src/agents/contentManager/contentManager';
import type { CommonParameters, CommonResult } from '../../src/types';
import type { JSONSchema } from '../../src/types/schema/JSONSchemaTypes';

interface CatalogTool {
  agent: string;
  tool: string;
}

interface GeneratedCatalog {
  tools: CatalogTool[];
}

class RegisteredReadTool extends BaseTool<CommonParameters, CommonResult> {
  constructor() {
    super('read', 'Read', 'Test eager registration', '1.0.0');
  }

  execute(): Promise<CommonResult> {
    return Promise.resolve({ success: true });
  }

  getParameterSchema(): JSONSchema {
    return { type: 'object' };
  }
}

describe('Tool execution policy catalog', () => {
  const generated = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'cli-first-tool-schemas.json'), 'utf8')
  ) as GeneratedCatalog;
  const liveKeys = generated.tools.map(tool => `${tool.agent}/${tool.tool}`).sort();
  const policyKeys = Object.keys(TOOL_EXECUTION_POLICY_CATALOG).sort();

  it('has one explicit policy for every live caller-visible tool', () => {
    expect(policyKeys).toEqual(liveKeys);
  });

  it('contains no inherited unknown policies outside a valid temporary allowlist', () => {
    const unknownKeys = policyKeys.filter(
      key => TOOL_EXECUTION_POLICY_CATALOG[key].effect === 'unknown'
    );

    for (const key of unknownKeys) {
      const exception = UNKNOWN_TOOL_POLICY_ALLOWLIST[key];
      expect(exception?.owner).toBeTruthy();
      expect(exception?.reason).toBeTruthy();
      expect(Date.parse(exception?.expires ?? '')).toBeGreaterThan(Date.now());
    }

    expect(unknownKeys).toEqual(Object.keys(UNKNOWN_TOOL_POLICY_ALLOWLIST).sort());
  });

  it('only permits safe read tools to execute in parallel', () => {
    const invalid = policyKeys.filter(key => {
      const policy = TOOL_EXECUTION_POLICY_CATALOG[key];
      return policy.parallelSafe && (policy.effect !== 'read' || policy.replay !== 'safe');
    });
    expect(invalid).toEqual([]);
  });

  it('binds catalog policy to eager and lazy registrations while retaining the standalone default', () => {
    const app = { vault: { getName: () => 'Policy test vault' } } as unknown as App;
    const agent = new ContentManagerAgent(app);
    const standalone = new RegisteredReadTool();

    expect(standalone.getExecutionPolicy().effect).toBe('unknown');
    expect(agent.getTool('read')?.getExecutionPolicy()).toEqual({
      effect: 'read', parallelSafe: true, replay: 'safe', undo: 'none'
    });

    agent.registerTool(standalone);
    expect(agent.getTool('read')?.getExecutionPolicy()).toEqual({
      effect: 'read', parallelSafe: true, replay: 'safe', undo: 'none'
    });
  });

  it('limits vault-preimage undo to the initial supported writer set', () => {
    const undoable = policyKeys.filter(
      key => TOOL_EXECUTION_POLICY_CATALOG[key].undo === 'vault-preimage'
    );
    expect(undoable).toEqual([
      'canvasManager/update',
      'canvasManager/write',
      'contentManager/insert',
      'contentManager/removeProperty',
      'contentManager/replace',
      'contentManager/setProperty',
      'contentManager/write',
      'storageManager/archive',
      'storageManager/copy',
      'storageManager/move',
    ]);
  });
});
