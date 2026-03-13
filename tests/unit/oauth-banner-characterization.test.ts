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

import { App, Notice } from 'obsidian';
import { GenericProviderModal } from '../../src/components/llm-provider/providers/GenericProviderModal';

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

// Helper to create DOM-like mock elements that track child creation
function createTrackingElement(): any {
  const children: any[] = [];
  const element: any = {
    _children: children,
    _tag: 'div',
    _cls: '',
    _text: '',
    textContent: '',
    onclick: null,
    disabled: false,
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(() => false),
    },
    addClass: jest.fn(function(this: any, cls: string) { this._cls += ' ' + cls; return this; }),
    removeClass: jest.fn().mockReturnThis(),
    empty: jest.fn(function(this: any) { this._children.length = 0; }),
    setAttribute: jest.fn(),
    createEl: jest.fn((tag: string, opts?: any) => {
      const child = createTrackingElement();
      child._tag = tag;
      if (opts?.text) child.textContent = opts.text;
      if (opts?.cls) child._cls = opts.cls;
      children.push(child);
      return child;
    }),
    createDiv: jest.fn((cls?: string) => {
      const child = createTrackingElement();
      child._tag = 'div';
      if (cls) child._cls = cls;
      children.push(child);
      return child;
    }),
    createSpan: jest.fn((cls?: string) => {
      const child = createTrackingElement();
      child._tag = 'span';
      if (typeof cls === 'string') child._cls = cls;
      children.push(child);
      return child;
    }),
  };
  return element;
}

function createMockProviderConfig(oauthConnected: boolean): any {
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
    secondaryOAuthProvider: undefined,
  };
}

function createMockDeps(): any {
  return {
    app: new App(),
    onSave: jest.fn(),
    onValidationChange: jest.fn(),
  };
}

describe('GenericProviderModal OAuth banner characterization', () => {
  describe('renderOAuthBanner — connected state', () => {
    it('shows connected banner with provider label and disconnect button', () => {
      const config = createMockProviderConfig(true);
      const deps = createMockDeps();
      const modal = new GenericProviderModal(config, deps);

      const container = createTrackingElement();
      modal.render(container);

      // Find the oauth-banner-container (created during renderApiKeySection)
      // The structure is: container > h2, oauth-banner-container, Setting
      const bannerContainer = container._children.find(
        (c: any) => c._cls === 'oauth-banner-container'
      );
      expect(bannerContainer).toBeDefined();

      // When connected: banner container should have 'oauth-connected-banner' child
      const connectedBanner = bannerContainer._children.find(
        (c: any) => c._cls === 'oauth-connected-banner'
      );
      expect(connectedBanner).toBeDefined();

      // Connected banner has status text and disconnect button
      const statusSpan = connectedBanner._children.find(
        (c: any) => c._cls === 'oauth-connected-status'
      );
      expect(statusSpan).toBeDefined();
      expect(statusSpan.textContent).toBe('Connected via ChatGPT');

      const disconnectBtn = connectedBanner._children.find(
        (c: any) => c._cls === 'oauth-disconnect-btn'
      );
      expect(disconnectBtn).toBeDefined();
      expect(disconnectBtn.textContent).toBe('Disconnect');
    });
  });

  describe('renderOAuthBanner — disconnected state', () => {
    it('shows connect button with provider label', () => {
      const config = createMockProviderConfig(false);
      const deps = createMockDeps();
      const modal = new GenericProviderModal(config, deps);

      const container = createTrackingElement();
      modal.render(container);

      const bannerContainer = container._children.find(
        (c: any) => c._cls === 'oauth-banner-container'
      );
      expect(bannerContainer).toBeDefined();

      // When disconnected: banner has 'oauth-connect-standalone' div with connect button
      const connectDiv = bannerContainer._children.find(
        (c: any) => c._cls === 'oauth-connect-standalone'
      );
      expect(connectDiv).toBeDefined();

      const connectBtn = connectDiv._children.find(
        (c: any) => c._cls === 'mod-cta oauth-connect-btn'
      );
      expect(connectBtn).toBeDefined();
      expect(connectBtn.textContent).toBe('Connect with ChatGPT');
    });
  });

  describe('secondary OAuth banner', () => {
    it('renders secondary OAuth section when secondaryOAuthProvider is configured', () => {
      const config = createMockProviderConfig(false);
      config.secondaryOAuthProvider = {
        providerLabel: 'Codex (ChatGPT)',
        description: 'Connect via ChatGPT for Codex models',
        config: {
          oauth: { connected: true, providerId: 'openai-codex', connectedAt: Date.now() },
        },
        oauthConfig: {
          providerLabel: 'ChatGPT (Codex)',
          startFlow: jest.fn(),
        },
      };

      const deps = createMockDeps();
      const modal = new GenericProviderModal(config, deps);

      const container = createTrackingElement();
      modal.render(container);

      // Find the secondary-oauth-section
      const secondarySection = container._children.find(
        (c: any) => c._cls === 'secondary-oauth-section'
      );
      expect(secondarySection).toBeDefined();

      // Should have an h2 with the provider label
      const heading = secondarySection._children.find(
        (c: any) => c._tag === 'h2'
      );
      expect(heading).toBeDefined();
      expect(heading.textContent).toBe('Codex (ChatGPT)');

      // Should have the banner container
      const bannerContainer = secondarySection._children.find(
        (c: any) => c._cls === 'oauth-banner-container'
      );
      expect(bannerContainer).toBeDefined();
    });
  });
});
