import { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
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
      (manager as any).updateContextTokenTracker(providerId);

      const tracker = manager.getContextTokenTracker();
      expect(tracker).not.toBeNull();
      expect(tracker?.getStatus().maxTokens).toBe(200000);
      tracker?.setConversationTokens(180000);
      expect(manager.shouldCompactBeforeSending('short follow-up')).toBe(true);
    }
  );

  it.each(softCapProviders)(
    'applies the 1.15 pre-send estimate buffer for %s',
    (providerId) => {
      const manager = createManager();
      (manager as any).updateContextTokenTracker(providerId);

      const tracker = manager.getContextTokenTracker();
      const message = 'deterministic follow-up message for compaction gating';
      const estimatedTokens = tracker!.estimateTokens(message);

      tracker!.setConversationTokens(180000 - estimatedTokens - 1);

      expect(manager.shouldCompactBeforeSending(message)).toBe(true);
    }
  );

  it('still enables the 4k tracker for webllm', () => {
    const manager = createManager();
    (manager as any).updateContextTokenTracker('webllm');

    const tracker = manager.getContextTokenTracker();
    expect(tracker).not.toBeNull();
    expect(tracker?.getStatus().maxTokens).toBe(4096);
  });

  it('does not apply the 1.15 pre-send estimate buffer to webllm', () => {
    const manager = createManager();
    (manager as any).updateContextTokenTracker('webllm');

    const tracker = manager.getContextTokenTracker();
    const message = 'deterministic follow-up message for compaction gating';
    const estimatedTokens = tracker!.estimateTokens(message);
    const criticalThreshold = Math.ceil(4096 * 0.9);

    tracker!.setConversationTokens(criticalThreshold - estimatedTokens - 1);

    expect(manager.shouldCompactBeforeSending(message)).toBe(false);
  });
});
