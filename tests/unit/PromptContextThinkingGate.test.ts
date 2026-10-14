/**
 * The chat request boundary gates thinking by model capability.
 *
 * Defect this buys: Chat settings hide the Thinking control for models that
 * cannot reason, but the stored `enabled: true` stayed in the snapshot and
 * `buildMessageOptions` sent `enableThinking: true` to Mistral Large anyway.
 * The model capability comes from the real registry, not a fixture.
 */
import {
  ModelAgentPromptContextAssembler,
  type ModelAgentPromptContextSnapshot
} from '../../src/ui/chat/services/ModelAgentPromptContextAssembler';
import type { ModelOption } from '../../src/ui/chat/types/SelectionTypes';

function model(providerId: string, modelId: string): ModelOption {
  return { providerId, providerName: providerId, modelId, modelName: modelId, contextWindow: 128_000 };
}

function snapshot(selectedModel: ModelOption): ModelAgentPromptContextSnapshot {
  return {
    selectedModel,
    selectedWorkspaceId: null,
    workspaceContext: null,
    loadedWorkspaceData: null,
    contextNotes: [],
    messageEnhancement: null,
    currentSystemPrompt: null,
    thinkingSettings: { enabled: true, effort: 'high' },
    webSearch: false,
    temperature: 0.5,
    imageProvider: 'google',
    imageModel: 'gemini-3.1-flash-image',
    transcriptionProvider: null,
    transcriptionModel: null,
    contextTokenTracker: null,
    compactionFrontier: [],
    latestCompactionRecord: null
  };
}

function createAssembler(): ModelAgentPromptContextAssembler {
  return new ModelAgentPromptContextAssembler({
    systemPromptBuilder: { build: jest.fn().mockResolvedValue('system prompt') },
    getSessionId: jest.fn().mockResolvedValue('session-1')
  });
}

describe('ModelAgentPromptContextAssembler thinking gate', () => {
  it('does not send a stored thinking preference to a model that cannot think', async () => {
    const input = snapshot(model('mistral', 'mistral-large-latest'));
    const options = await createAssembler().buildMessageOptions(input);

    expect(options.enableThinking).toBe(false);
    expect(options.thinkingEffort).toBe('high');
    // The stored preference is untouched, so switching back restores it.
    expect(input.thinkingSettings).toEqual({ enabled: true, effort: 'high' });
  });

  it('sends thinking for a model that can think', async () => {
    const options = await createAssembler().buildMessageOptions(snapshot(model('mistral', 'magistral-medium-latest')));

    expect(options.enableThinking).toBe(true);
    expect(options.thinkingEffort).toBe('high');
  });

  it('leaves discovered models without registry data to the adapter', async () => {
    const options = await createAssembler().buildMessageOptions(snapshot(model('ollama', 'qwen3:8b')));

    expect(options.enableThinking).toBe(true);
  });
});
