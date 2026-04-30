/**
 * tests/eval/headless/headless.smoke.test.ts — Smoke test for HeadlessAgentStack.
 *
 * Verifies:
 * 1. Stack initializes without errors
 * 2. getTools returns real schemas from real agents
 * 3. useTools routes to real tool execute() and operates on test vault files
 * 4. TestVaultManager reset/seed works
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHeadlessAgentStack, HeadlessAgentStackResult } from './HeadlessAgentStack';
import { TestVaultManager } from './TestVaultManager';

// Shared context for useTools calls — memory must be non-empty
const TEST_CONTEXT = {
  workspaceId: 'test-ws',
  sessionId: 'test-session',
  memory: 'Smoke test session — verifying headless agent stack.',
  goal: 'smoke test',
};

describe('HeadlessAgentStack', () => {
  let stack: HeadlessAgentStackResult;
  let vaultManager: TestVaultManager;
  let testDir: string;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `nexus-headless-test-${Date.now()}`);
    vaultManager = new TestVaultManager(testDir);
    vaultManager.reset();
    vaultManager.seed({
      'notes/hello.md': '# Hello World\n\nThis is a test note.',
      'notes/second.md': '# Second Note\n\nAnother test note.',
      'archive/old.md': '# Old Note\n\nArchived.',
    });

    stack = await createHeadlessAgentStack({
      basePath: testDir,
      vaultName: 'smoke-test-vault',
    });
  }, 30000);

  afterAll(() => {
    vaultManager.cleanup();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should initialize all agents', () => {
    expect(stack.agentRegistry.size).toBe(4);
    expect(stack.agentRegistry.has('contentManager')).toBe(true);
    expect(stack.agentRegistry.has('storageManager')).toBe(true);
    expect(stack.agentRegistry.has('canvasManager')).toBe(true);
    expect(stack.agentRegistry.has('searchManager')).toBe(true);
    expect(stack.toolManager).toBeDefined();
  });

  it('should expose CLI-first meta-tool schemas with required top-level context fields', () => {
    const getToolsSchema = stack.toolManager.getTool('getTools')?.getParameterSchema() as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const useToolsSchema = stack.toolManager.getTool('useTools')?.getParameterSchema() as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(getToolsSchema.required).toEqual(
      expect.arrayContaining(['workspaceId', 'sessionId', 'memory', 'goal', 'tool'])
    );
    expect(useToolsSchema.required).toEqual(
      expect.arrayContaining(['workspaceId', 'sessionId', 'memory', 'goal', 'tool'])
    );

    expect(getToolsSchema.properties).toHaveProperty('workspaceId');
    expect(getToolsSchema.properties).toHaveProperty('sessionId');
    expect(useToolsSchema.properties).toHaveProperty('workspaceId');
    expect(useToolsSchema.properties).toHaveProperty('sessionId');
  });

  it('should return real tool schemas from getTools', async () => {
    const result = await stack.getTools({
      ...TEST_CONTEXT,
      tool: 'content',
    });

    expect(result.success).toBe(true);
    expect(result.data?.tools).toBeDefined();
    expect(result.data!.tools.length).toBeGreaterThan(0);

    // Real getTools returns { agent, tool, description, inputSchema }
    const tools = result.data!.tools as Array<{ agent: string; tool: string; description: string; inputSchema: unknown }>;
    const toolIdentifiers = tools.map(t => `${t.agent}_${t.tool}`);
    expect(toolIdentifiers).toContain('contentManager_read');
    expect(toolIdentifiers).toContain('contentManager_write');
  });

  it('should return schemas for multiple agents', async () => {
    const result = await stack.getTools({
      ...TEST_CONTEXT,
      tool: 'content, storage, search',
    });

    expect(result.success).toBe(true);
    const tools = result.data!.tools as Array<{ agent: string; tool: string }>;
    const toolIdentifiers = tools.map(t => `${t.agent}_${t.tool}`);
    expect(toolIdentifiers).toContain('contentManager_read');
    expect(toolIdentifiers).toContain('storageManager_list');
    expect(toolIdentifiers).toContain('searchManager_content');
  });

  it('should execute useTools contentManager_read on real vault file', async () => {
    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'content read "notes/hello.md" 1',
    });

    if (!result.success) console.log('useTools read error:', JSON.stringify(result, null, 2));
    expect(result.success).toBe(true);
    // The result should contain the actual file content
    const resultStr = JSON.stringify(result);
    expect(resultStr).toContain('Hello World');
  });

  it('should execute useTools contentManager_write to create a new file', async () => {
    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'content write "notes/new-note.md" "# New Note\\n\\nCreated by test."',
    });

    if (!result.success) console.log('useTools write error:', JSON.stringify(result, null, 2));
    expect(result.success).toBe(true);
    // Verify file was actually created on disk
    const filePath = path.join(testDir, 'notes/new-note.md');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('Created by test');
  });

  it('should execute storageManager_list on real vault', async () => {
    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'storage list --path "notes"',
    });

    if (!result.success) console.log('useTools list error:', JSON.stringify(result, null, 2));
    expect(result.success).toBe(true);
    const resultStr = JSON.stringify(result);
    expect(resultStr).toContain('hello.md');
    expect(resultStr).toContain('second.md');
  });
});
