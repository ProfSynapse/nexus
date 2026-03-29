import { Platform } from '../mocks/obsidian';

describe('platform compatibility', () => {
  afterEach(() => {
    Platform.isMobile = false;
    Platform.isDesktop = true;
  });

  it('treats remote cloud providers as mobile compatible', async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;

    const platform = await import('../../src/utils/platform');

    expect(platform.isProviderCompatible('openai')).toBe(true);
    expect(platform.isProviderCompatible('anthropic')).toBe(true);
    expect(platform.isProviderCompatible('google')).toBe(true);
    expect(platform.isProviderCompatible('mistral')).toBe(true);
    expect(platform.isProviderCompatible('groq')).toBe(true);
  });

  it('keeps local and codex providers desktop only', async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;

    const platform = await import('../../src/utils/platform');

    expect(platform.isProviderCompatible('openai-codex')).toBe(false);
    expect(platform.isProviderCompatible('ollama')).toBe(false);
    expect(platform.isProviderCompatible('lmstudio')).toBe(false);
    expect(platform.isProviderCompatible('webllm')).toBe(false);
  });
});
