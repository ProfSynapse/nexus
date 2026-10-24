import { SearchMemoryTool } from '../../src/agents/searchManager/tools/searchMemory';
import { previouslyUsedTools, selectPreviousToolSchemas } from '../../src/services/chat/CompactionToolContext';
import { BaseAgent } from '../../src/agents/baseAgent';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import { CONSERVATIVE_TOOL_EXECUTION_POLICY } from '../../src/agents/policy/ToolExecutionPolicy';
import { ToolCatalogService } from '../../src/agents/toolManager/services/ToolCatalogService';
import { ModelAgentPromptContextAssembler, type ModelAgentPromptContextSnapshot } from '../../src/ui/chat/services/ModelAgentPromptContextAssembler';
import { SystemPromptBuilder } from '../../src/ui/chat/services/SystemPromptBuilder';
import { CompactionFrontierService } from '../../src/services/chat/CompactionFrontierService';
import type { CompactedContext } from '../../src/services/chat/ContextCompactionService';
import type { ConversationMessage } from '../../src/types/chat/ChatTypes';

function tool(slug: string): ITool {
  return { slug, name: slug, version: '1', description: `Current signature for ${slug}`,
    execute: jest.fn(), getExecutionPolicy: () => CONSERVATIVE_TOOL_EXECUTION_POLICY,
    getParameterSchema: () => ({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' } }, required: ['path'] }),
    getResultSchema: () => ({ type: 'object' }) };
}
class Agent extends BaseAgent { constructor() { super('contentManager', 'Content', '1'); [tool('read'), tool('write')].forEach(value => this.registerTool(value)); } }
function setup() {
  const search = new class extends BaseAgent { constructor() { super('searchManager', 'Search', '1'); this.registerTool(new SearchMemoryTool({} as never, undefined, undefined, undefined, {} as never)); } }();
  const registry = new Map<string, IAgent>([['contentManager', new Agent()], ['searchManager', search]]);
  return { registry, catalog: new ToolCatalogService(() => registry) };
}
const savedState = { name: 'Verified checkpoint', conversationContext: 'User goal and confirmed work. '.repeat(35), activeTask: 'Verify exact path', activeFiles: ['Notes/Exact path.md'], nextSteps: ['Do the next check'] };
const record: CompactedContext = { summary: 'Do not duplicate this summary', savedState, toolSelectors: ['content write', 'content read', 'web open'], messagesRemoved: 20, messagesKept: 4, filesReferenced: [], topics: [], compactedAt: 10, boundaryMessageId: 'u20' };
function snapshot(window: number, frontier = [record]): ModelAgentPromptContextSnapshot {
  return { selectedModel: { providerId: 'ollama', providerName: 'Ollama', modelId: 'small', modelName: 'Small', contextWindow: 128000 }, effectiveContextWindow: window,
    selectedWorkspaceId: null, workspaceContext: null, loadedWorkspaceData: null, contextNotes: [], messageEnhancement: null, currentSystemPrompt: null,
    thinkingSettings: { enabled: false }, webSearch: false, temperature: .5, imageProvider: 'google', imageModel: '', transcriptionProvider: null, transcriptionModel: null,
    contextTokenTracker: null, compactionFrontier: frontier, latestCompactionRecord: null };
}

describe('previously used compaction schemas', () => {
  it('parses quoted batches and orders the most recent actual calls first', () => {
    const messages: ConversationMessage[] = [{ id: 'a', conversationId: 'c', timestamp: 1, role: 'assistant', content: '', toolCalls: [
      { id: 'old', type: 'function', function: { name: 'contentManager_read', arguments: '{}' } },
      { id: 'batch', type: 'function', function: { name: 'toolManager_useTools', arguments: JSON.stringify({ tool: 'content read "A, content read B.md" --start-line 1, content write "C.md" --content "x"' }) } }
    ] }];
    expect(previouslyUsedTools(messages, ['web open', 'content read'])).toEqual(['content write', 'content read', 'contentManager read', 'web open']);
  });

  it('loads current full schemas in recency order, defers those that do not fit, and deduplicates aliases', () => {
    const { catalog, registry } = setup();
    const all = selectPreviousToolSchemas(['content write', 'content read', 'contentManager write', 'web open'], catalog, 10000);
    expect(all.tools.map(value => value.command)).toEqual(['content write', 'content read']);
    expect(all.tools[0].arguments).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'path' })]));
    expect(all.deferred).toEqual(['web open']);
    const oneCost = Math.ceil(JSON.stringify([all.tools[0]], null, 2).length / 4 * 1.2) + 64;
    const limited = selectPreviousToolSchemas(['content write', 'content read'], catalog, oneCost);
    expect(limited.tools.map(value => value.command)).toEqual(['content write']);
    expect(limited.deferred).toEqual(['content read']);
    expect(selectPreviousToolSchemas(['content write'], catalog, 0, [all.tools[0]]).deferred).toEqual([]);
    registry.delete('contentManager');
    expect(selectPreviousToolSchemas(['content write'], catalog, 10000)).toEqual({ tools: [], deferred: ['content write'] });
  });

  it('retains the entire saved state across replacement/reload and renders it with fresh schemas', async () => {
    const { catalog } = setup();
    const frontier = new CompactionFrontierService().appendRecord([{ ...record, savedState: undefined, summary: 'Old summary' }], record);
    const restored = JSON.parse(JSON.stringify(frontier));
    expect(restored).toHaveLength(1);
    expect(restored[0].savedState).toEqual(savedState);
    const assembler = new ModelAgentPromptContextAssembler({ systemPromptBuilder: new SystemPromptBuilder(async () => ''), getSessionId: async () => 'session', getToolCatalogService: async () => catalog });
    const prompt = await assembler.buildSystemPrompt(snapshot(128000, restored));
    for (const value of [savedState.conversationContext, savedState.activeTask, savedState.activeFiles[0], savedState.nextSteps[0], 'Current signature for write', '--start-line']) expect(prompt).toContain(value);
    expect(prompt).not.toContain('Do not duplicate this summary');
    expect(prompt).toContain('<saved_state>');
    expect(prompt).toContain('<previous_tools_pending_discovery>');
    expect(prompt).toContain('web open');
  });

  it('preloads the real conversation search schema after compaction even when never previously used', async () => {
    const { catalog } = setup();
    const assembler = new ModelAgentPromptContextAssembler({ systemPromptBuilder: new SystemPromptBuilder(async () => ''), getSessionId: async () => 'session', getToolCatalogService: async () => catalog });
    const input = snapshot(128000, [{ ...record, toolSelectors: [] }]);
    const prompt = await assembler.buildSystemPrompt(input);
    expect(prompt).toContain('"command": "search memory"');
    expect(prompt).toContain('"flag": "--session-name"');
    expect(prompt).toContain('"flag": "--memory-types"');
    expect(prompt).toContain('"flag": "--window-size"');
    expect(prompt).toContain('<history_recovery>');
    expect(prompt).toContain('search before guessing');
    expect(prompt).toContain('Conversation search requires an available conversation index');
    const small = await assembler.buildSystemPrompt(snapshot(4096));
    expect(small).toContain('"command": "search memory"');
    expect(small).toContain(savedState.conversationContext);
  });

  it('deduplicates recovery search against explicitly loaded tool schemas', async () => {
    const { catalog } = setup();
    const search = catalog.resolve(['search memory']);
    if (!search.ok) throw new Error('search catalog failed');
    const assembler = new ModelAgentPromptContextAssembler({ systemPromptBuilder: new SystemPromptBuilder(async () => ''), getSessionId: async () => 'session', getToolCatalogService: async () => catalog,
      prepareIndividualSkills: async () => ({ skills: [], tools: search.value }) });
    const prompt = await assembler.buildSystemPrompt(snapshot(128000, [{ ...record, toolSelectors: ['search memory', 'searchManager memory'] }]));
    expect(prompt?.match(/"command": "search memory"/g)).toHaveLength(1);
  });

  it('preserves state and provides recovery discovery guidance if its full schema cannot fit', async () => {
    const { catalog } = setup();
    const assembler = new ModelAgentPromptContextAssembler({ systemPromptBuilder: new SystemPromptBuilder(async () => ''), getSessionId: async () => 'session', getToolCatalogService: async () => catalog });
    const input = snapshot(4096, [{ ...record, retainedTokensAtCompaction: 4000 }]);
    const prompt = await assembler.buildSystemPrompt(input);
    expect(prompt).toContain(savedState.conversationContext);
    expect(prompt).not.toContain('"command": "search memory"');
    expect(prompt).toContain('<previous_tools_pending_discovery>');
    expect(prompt).toContain('discover it with getTools');
    expect(await assembler.buildSystemPrompt(snapshot(128000, []))).not.toContain('"command": "search memory"');
  });

  it('preserves the complete replacement handoff after a saved-state context changes models', () => {
    const replacement = { ...record, savedState: undefined, summary: 'Full handoff with prior checkpoint and exact next actions. '.repeat(100), supersedesFrontier: true };
    const frontier = new CompactionFrontierService().appendRecord([record], replacement);
    expect(frontier).toHaveLength(1);
    expect(frontier[0].summary).toBe(replacement.summary);
  });

  it('prioritizes the full state and retained turns when a selected small window cannot fit all schemas', async () => {
    const { catalog } = setup();
    const assembler = new ModelAgentPromptContextAssembler({ systemPromptBuilder: new SystemPromptBuilder(async () => ''), getSessionId: async () => undefined, getToolCatalogService: async () => catalog });
    const prompt = await assembler.buildSystemPrompt(snapshot(4096, [{ ...record, retainedTokensAtCompaction: 2900 }]));
    expect(prompt).toContain(savedState.conversationContext);
    expect(prompt).toContain('<previous_tools_pending_discovery>');
    expect(prompt).not.toContain('Current signature for write');
  });
});
