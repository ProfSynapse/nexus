/**
 * tests/unit/ChatSettingsRendererTextOnlyWarning.test.ts
 *
 * Render coverage for ChatSettingsRenderer.renderTextOnlyProviderWarning — the
 * settings-panel notice that warns when a text-completion-only provider is
 * selected. Complements TextOnlyProviderSeam.test.ts (which pins the SSOT +
 * seam classification): this file pins the *rendered copy* surface.
 *
 * For Antigravity (google-gemini-cli) the copy MUST name BOTH limitations
 * (no tools/agents AND no streaming), for both the 'chat' and 'agent' variants.
 * Perplexity copy must remain unchanged after the renderPerplexityWarning ->
 * renderTextOnlyProviderWarning generalization (regression guard), and a normal
 * tool-capable provider must render nothing.
 *
 * The renderer constructor instantiates heavy LLM services, so we exercise the
 * two private copy/render methods directly over the real prototype with a
 * minimal `this` carrying only the `settings` field they read. This keeps the
 * test coupled to the REAL copy SSOT (getTextOnlyProviderWarningCopy) — not a
 * re-typed fixture — so a copy change in source turns it red.
 */
import { ChatSettingsRenderer } from '../../src/components/shared/ChatSettingsRenderer';
import { createMockElement } from '../helpers/mockFactories';

type RendererInternals = {
  settings: { provider?: string; agentProvider?: string };
  renderTextOnlyProviderWarning(content: unknown, variant: 'chat' | 'agent'): void;
};

/**
 * Build a minimal `this` for the private render method. Only `settings` is read
 * by renderTextOnlyProviderWarning / getTextOnlyProviderWarningCopy.
 */
function rendererWith(settings: { provider?: string; agentProvider?: string }): RendererInternals {
  return {
    settings,
    // Bind the real prototype methods so getTextOnlyProviderWarningCopy resolves
    // on `this` — both are private, hence the prototype indexing cast.
    renderTextOnlyProviderWarning: (
      ChatSettingsRenderer.prototype as unknown as RendererInternals
    ).renderTextOnlyProviderWarning,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTextOnlyProviderWarningCopy: (ChatSettingsRenderer.prototype as any).getTextOnlyProviderWarningCopy
  } as unknown as RendererInternals;
}

/**
 * Returns the {title, message} actually rendered into `content`, or null if the
 * warning short-circuited (no warning div created). Reads the mock's recorded
 * createDiv calls: content.createDiv({cls:'csr-provider-warning'}) -> warningEl,
 * then warningEl.createDiv({cls:'...-title', text}) and (...-text, text).
 */
function renderAndExtract(
  provider: string | undefined,
  variant: 'chat' | 'agent'
): { title: string; message: string } | null {
  const content = createMockElement('div');
  const settings = variant === 'agent' ? { agentProvider: provider } : { provider };
  const self = rendererWith(settings);

  self.renderTextOnlyProviderWarning(content, variant);

  const createDiv = content.createDiv as jest.Mock;
  // Find the warning wrapper creation; if absent the method short-circuited.
  const wrapperCall = createDiv.mock.results.find((result, index) => {
    const arg = createDiv.mock.calls[index]?.[0];
    return typeof arg === 'object' && arg?.cls === 'csr-provider-warning';
  });
  if (!wrapperCall) {
    return null;
  }

  const warningEl = wrapperCall.value as { createDiv: jest.Mock };
  const childCalls = warningEl.createDiv.mock.calls.map((args) => args[0]);
  const titleArg = childCalls.find((arg) => arg?.cls === 'csr-provider-warning-title');
  const messageArg = childCalls.find((arg) => arg?.cls === 'csr-provider-warning-text');

  return {
    title: titleArg?.text ?? '',
    message: messageArg?.text ?? ''
  };
}

describe('ChatSettingsRenderer text-only provider warning copy', () => {
  describe('Antigravity (google-gemini-cli) names BOTH limitations', () => {
    it.each(['chat', 'agent'] as const)(
      'renders the no-tools AND no-streaming warning for the %s variant',
      (variant) => {
        const rendered = renderAndExtract('google-gemini-cli', variant);

        expect(rendered).not.toBeNull();
        expect(rendered!.title).toBe('Antigravity is text completions only');
        // Limitation 1: cannot call tools/agents.
        expect(rendered!.message).toContain("can't call tools or agents");
        // Limitation 2: no streaming (replies arrive all at once).
        expect(rendered!.message).toContain('no streaming');
        expect(rendered!.message).toContain('all at once');
      }
    );

    it('uses agent-specific guidance for the agent variant only', () => {
      const chat = renderAndExtract('google-gemini-cli', 'chat');
      const agent = renderAndExtract('google-gemini-cli', 'agent');

      // Agent copy speaks to prompt actions + subagents; chat copy does not.
      expect(agent!.message).toContain('Prompt actions and subagents');
      expect(chat!.message).not.toContain('Prompt actions and subagents');
      // Both still carry the two-limitation lead sentence.
      expect(chat!.message).toContain("can't call tools or agents");
      expect(agent!.message).toContain("can't call tools or agents");
    });
  });

  describe('Perplexity copy is unchanged (no regression from the generalization)', () => {
    it.each(['chat', 'agent'] as const)(
      'renders the established Perplexity wording for the %s variant',
      (variant) => {
        const rendered = renderAndExtract('perplexity', variant);

        expect(rendered).not.toBeNull();
        expect(rendered!.title).toBe('Perplexity cannot use Nexus tools');
        // Perplexity copy must NOT have acquired Antigravity's Antigravity title.
        expect(rendered!.title).not.toContain('Antigravity');
      }
    );

    it('keeps the search-focused chat wording and text-only agent wording', () => {
      expect(renderAndExtract('perplexity', 'chat')!.message).toBe(
        'Chat and subagents will not receive tool schemas with Perplexity. Use it for search-heavy, text-only work.'
      );
      expect(renderAndExtract('perplexity', 'agent')!.message).toBe(
        'Prompt actions and subagents will run in text-only mode. Use another cloud model for vault edits or other tool-driven work.'
      );
    });
  });

  describe('tool-capable providers render no warning', () => {
    it.each([
      ['a normal cloud provider (chat)', 'openai', 'chat'],
      ['a normal cloud provider (agent)', 'openai', 'agent'],
      ['webllm (tools baked in)', 'webllm', 'chat'],
      ['an undefined provider', undefined, 'chat']
    ] as const)('stays silent for %s', (_label, provider, variant) => {
      expect(renderAndExtract(provider, variant)).toBeNull();
    });
  });
});
