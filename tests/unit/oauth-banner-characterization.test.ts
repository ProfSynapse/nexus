/**
 * Characterization Tests: OAuth Banner Rendering Pattern
 *
 * Documents the current behavior of GenericProviderModal's OAuth rendering:
 * - renderOAuthBanner(): Primary OAuth connected/disconnected state
 * - renderSecondaryOAuthBanner(): Secondary OAuth provider (e.g., Codex inside OpenAI)
 *
 * Both follow the same pattern:
 *   if (oauth.connected) → show connected banner + disconnect button
 *   else → show connect button
 *
 * These tests capture the DOM structure and CSS classes that Wave 1c
 * (OAuthBannerComponent extraction) needs to preserve.
 */

import { App } from 'obsidian';
import { GenericProviderModal } from '../../src/components/llm-provider/providers/GenericProviderModal';
import { ProviderModalConfig, ProviderModalDependencies } from '../../src/components/llm-provider/types';
import { createTrackingElement } from '../helpers/mockFactories';

type TrackingElement = ReturnType<typeof createTrackingElement>;

// Mock the OAuth dependencies
jest.mock('../../src/services/llm/validation/ValidationService', () => ({
  LLMValidationService: jest.fn().mockImplementation(() => ({
    validateProvider: jest.fn().mockResolvedValue({ valid: true }),
  })),
}));

jest.mock('../../src/services/oauth/OAuthService', () => ({
  OAuthService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../src/components/llm-provider/providers/OAuthModals', () => ({
  OAuthConsentModal: jest.fn(),
  OAuthPreAuthModal: jest.fn(),
}));


function createMockProviderConfig(oauthConnected: boolean): ProviderModalConfig {
  return {
    providerId: 'openai',
    providerName: 'OpenAI',
    keyFormat: 'sk-...',
    signupUrl: 'https://platform.openai.com',
    config: {
      enabled: true,
      apiKey: oauthConnected ? 'key-from-oauth' : '',
      oauth: oauthConnected ? {
        connected: true,
        providerId: 'openai',
        connectedAt: Date.now(),
      } : undefined,
    },
    oauthConfig: {
      providerLabel: 'ChatGPT',
      startFlow: jest.fn(),
    },
    onConfigChange: jest.fn(),
    secondaryOAuthProvider: undefined,
  };
}

function createMockDeps(): ProviderModalDependencies {
  const app = new App();
  return {
    app,
    vault: app.vault,
    providerManager: {} as ProviderModalDependencies['providerManager'],
    staticModelsService: {} as ProviderModalDependencies['staticModelsService'],
  };
}

describe('GenericProviderModal OAuth banner characterization', () => {
  describe('renderOAuthBanner — connected state', () => {
    it('shows connected banner with provider label and disconnect button', () => {
      const config = createMockProviderConfig(true);
      const deps = createMockDeps();
      const modal = new GenericProviderModal(config, deps);

      const container: TrackingElement = createTrackingElement();
      modal.render(container);

      // Find the oauth-banner-container (created during renderApiKeySection)
      // The structure is: container > h2, oauth-banner-container, Setting
      const bannerContainer = container._children.find(
        c => c._cls === 'oauth-banner-container'
      );
      expect(bannerContainer).toBeDefined();

      // When connected: banner container should have 'oauth-connected-banner' child
      const connectedBanner = bannerContainer?._children.find(
        c => c._cls === 'oauth-connected-banner'
      );
      expect(connectedBanner).toBeDefined();

      // Connected banner has status text and disconnect button
      const statusSpan = connectedBanner?._children.find(
        c => c._cls === 'oauth-connected-status'
      );
      expect(statusSpan).toBeDefined();
      expect(statusSpan?.textContent).toBe('Connected via ChatGPT');

      const disconnectBtn = connectedBanner?._children.find(
        c => c._cls === 'oauth-disconnect-btn'
      );
      expect(disconnectBtn).toBeDefined();
      expect(disconnectBtn?.textContent).toBe('Disconnect');
    });
  });

  describe('renderOAuthBanner — disconnected state', () => {
    it('shows connect button with provider label', () => {
      const config = createMockProviderConfig(false);
      const deps = createMockDeps();
      const modal = new GenericProviderModal(config, deps);

      const container: TrackingElement = createTrackingElement();
      modal.render(container);

      const bannerContainer = container._children.find(
        c => c._cls === 'oauth-banner-container'
      );
      expect(bannerContainer).toBeDefined();

      // When disconnected: banner has 'oauth-connect-standalone' div with connect button
      const connectDiv = bannerContainer?._children.find(
        c => c._cls === 'oauth-connect-standalone'
      );
      expect(connectDiv).toBeDefined();

      const connectBtn = connectDiv?._children.find(
        c => c._cls === 'mod-cta oauth-connect-btn'
      );
      expect(connectBtn).toBeDefined();
      expect(connectBtn?.textContent).toBe('Connect with ChatGPT');
    });
  });

  describe('secondary OAuth banner', () => {
    it('renders secondary OAuth section when secondaryOAuthProvider is configured', () => {
      const config = createMockProviderConfig(false);
      config.secondaryOAuthProvider = {
        providerId: 'openai-codex',
        providerLabel: 'Codex (ChatGPT)',
        description: 'Connect via ChatGPT for Codex models',
        config: {
          apiKey: '',
          enabled: true,
          oauth: { connected: true, providerId: 'openai-codex', connectedAt: Date.now() },
        },
        oauthConfig: {
          providerLabel: 'ChatGPT (Codex)',
          startFlow: jest.fn(),
        },
        onConfigChange: jest.fn(),
      };

      const deps = createMockDeps();
      const modal = new GenericProviderModal(config, deps);

      const container: TrackingElement = createTrackingElement();
      modal.render(container);

      // Find the secondary-oauth-section
      const secondarySection = container._children.find(
        c => c._cls === 'secondary-oauth-section'
      );
      expect(secondarySection).toBeDefined();

      // Should have an h2 with the provider label
      const heading = secondarySection?._children.find(
        c => c._tag === 'h2'
      );
      expect(heading).toBeDefined();
      expect(heading?.textContent).toBe('Codex (ChatGPT)');

      // Should have the banner container
      const bannerContainer = secondarySection?._children.find(
        c => c._cls === 'oauth-banner-container'
      );
      expect(bannerContainer).toBeDefined();
    });
  });
});
