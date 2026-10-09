import { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import { ModelAgentCompactionState } from '../../src/ui/chat/services/ModelAgentCompactionState';
import type { ConversationData } from '../../src/types/chat/ChatTypes';
type ManagerWithUpdate = {
  updateContextTokenTracker(providerId: string): void;
};

function expectDefined<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull();
  return value as T;
}

function createManager() {
  return new ModelAgentManager(
    {},
    {
      onModelChanged: jest.fn(),
      onPromptChanged: jest.fn(),
      onSystemPromptChanged: jest.fn()
    }
  );
}

describe('ModelAgentManager context gating rollout', () => {
  it('checks retained context after a local tracker resets during compaction', () => {
    const state = new ModelAgentCompactionState();
    state.updateContextTokenTracker('openai-codex', 1024);
    state.resetTokenTracker();
    const conversation = {
      id: 'conversation',
      messages: [{ id: 'retained', role: 'user', content: 'x'.repeat(5000), timestamp: 1 }],
    } as ConversationData;

    expect(state.shouldCompactBeforeSending(conversation, 'continue', 'summary', 'openai-codex', 1024)).toBe(true);
  });

  const softCapProviders = [
    'anthropic-claude-code',
    'google-gemini-cli',
    'openai-codex',
    'github-copilot'
  ];

  it.each(softCapProviders)(
    'enables pre-send compaction gating for %s',
    (providerId) => {
      const manager = createManager();
      (manager as unknown as ManagerWithUpdate).updateContextTokenTracker(providerId);

      const tracker = expectDefined(manager.getContextTokenTracker());
      expect(tracker.getStatus().maxTokens).toBe(200000);
      tracker.setConversationTokens(180000);
      expect(manager.shouldCompactBeforeSending('short follow-up')).toBe(true);
    }
  );

  it.each(softCapProviders)(
    'applies the 1.15 pre-send estimate buffer for %s',
    (providerId) => {
      const manager = createManager();
      (manager as unknown as ManagerWithUpdate).updateContextTokenTracker(providerId);

      const tracker = expectDefined(manager.getContextTokenTracker());
      const message = 'deterministic follow-up message for compaction gating';
      const estimatedTokens = tracker.estimateTokens(message);

      tracker.setConversationTokens(180000 - estimatedTokens - 1);

      expect(manager.shouldCompactBeforeSending(message)).toBe(true);
    }
  );

  it('still enables the 4k tracker for webllm', () => {
    const manager = createManager();
    (manager as unknown as ManagerWithUpdate).updateContextTokenTracker('webllm');

    const tracker = expectDefined(manager.getContextTokenTracker());
    expect(tracker.getStatus().maxTokens).toBe(4096);
  });

  it('does not apply the 1.15 pre-send estimate buffer to webllm', () => {
    const manager = createManager();
    (manager as unknown as ManagerWithUpdate).updateContextTokenTracker('webllm');

    const tracker = expectDefined(manager.getContextTokenTracker());
    const message = 'deterministic follow-up message for compaction gating';
    const estimatedTokens = tracker.estimateTokens(message);
    const criticalThreshold = Math.ceil(4096 * 0.9);

    tracker.setConversationTokens(criticalThreshold - estimatedTokens - 1);

    expect(manager.shouldCompactBeforeSending(message)).toBe(false);
  });
});
