import { WebLLMLifecycleManager } from '../../src/services/llm/adapters/webllm/WebLLMLifecycleManager';
import type { WebLLMAdapter } from '../../src/services/llm/adapters/webllm/WebLLMAdapter';

describe('WebLLMLifecycleManager adapter ownership', () => {
  it('does not let disposal of an old adapter clear its replacement', () => {
    const manager = new WebLLMLifecycleManager();
    const oldAdapter = {} as WebLLMAdapter;
    const replacement = { isModelLoaded: jest.fn(() => false) } as unknown as WebLLMAdapter;

    manager.setAdapter(oldAdapter);
    manager.setAdapter(replacement);
    manager.clearAdapter(oldAdapter);

    expect((manager as unknown as { adapter: WebLLMAdapter | null }).adapter).toBe(replacement);
  });
});
