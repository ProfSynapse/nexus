/**
 * OAuthModals Unit Tests
 *
 * Tests the OAuth consent and pre-auth modals:
 * - OAuthConsentModal: experimental warning display, confirm/cancel callbacks
 * - OAuthPreAuthModal: field rendering, confirm/cancel callbacks
 */

import { App } from 'obsidian';
import { OAuthConsentModal, OAuthPreAuthModal } from '../../src/components/llm-provider/providers/OAuthModals';
import type { OAuthModalConfig } from '../../src/components/llm-provider/types';

// Add addText method to Setting mock (OAuthModals use Setting.addText, not addTextArea)
jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');

  // Extend the Setting mock with addText
  class SettingWithText extends actual.Setting {
    addText(callback: (text: any) => void): SettingWithText {
      const mockText = {
        _value: '',
        _onChange: null as ((value: string) => void) | null,
        setPlaceholder() { return this; },
        setValue(v: string) { this._value = v; return this; },
        getValue() { return this._value; },
        onChange(cb: (value: string) => void) { this._onChange = cb; return this; },
      };
      callback(mockText);
      return this;
    }
  }

  return {
    ...actual,
    Setting: SettingWithText,
  };
});

function createMockApp(): App {
  return new App();
}

function createConsentConfig(overrides?: Partial<OAuthModalConfig>): OAuthModalConfig {
  return {
    providerLabel: 'ChatGPT (Experimental)',
    experimental: true,
    experimentalWarning: 'This is an experimental feature.',
    preAuthFields: [],
    startFlow: jest.fn(async () => ({ success: true, apiKey: 'key-123' })),
    ...overrides,
  };
}

function createPreAuthConfig(overrides?: Partial<OAuthModalConfig>): OAuthModalConfig {
  return {
    providerLabel: 'OpenRouter',
    preAuthFields: [
      {
        key: 'key_label',
        label: 'Key Name',
        placeholder: 'My Obsidian Key',
        required: true,
        defaultValue: '',
      },
      {
        key: 'credit_limit',
        label: 'Credit Limit (USD)',
        placeholder: '10',
        required: false,
        defaultValue: '',
      },
    ],
    startFlow: jest.fn(async () => ({ success: true, apiKey: 'or-key' })),
    ...overrides,
  };
}

describe('OAuthConsentModal', () => {
  let app: App;

  beforeEach(() => {
    app = createMockApp();
  });

  it('should construct without errors', () => {
    const config = createConsentConfig();
    const modal = new OAuthConsentModal(app, config, jest.fn(), jest.fn());
    expect(modal).toBeDefined();
  });

  it('should call onOpen without errors', () => {
    const config = createConsentConfig();
    const modal = new OAuthConsentModal(app, config, jest.fn(), jest.fn());
    expect(() => modal.onOpen()).not.toThrow();
  });

  it('should call onClose without errors', () => {
    const config = createConsentConfig();
    const modal = new OAuthConsentModal(app, config, jest.fn(), jest.fn());
    modal.onOpen();
    expect(() => modal.onClose()).not.toThrow();
  });

  it('should create heading element with "Experimental feature" text', () => {
    const config = createConsentConfig();
    const modal = new OAuthConsentModal(app, config, jest.fn(), jest.fn());
    modal.onOpen();

    // The mock contentEl should have createEl called with 'h2'
    expect(modal.contentEl.createEl).toHaveBeenCalledWith('h2', {
      text: 'Experimental feature',
    });
  });

  it('should display experimental warning when provided', () => {
    const config = createConsentConfig({
      experimentalWarning: 'This is risky!',
    });
    const modal = new OAuthConsentModal(app, config, jest.fn(), jest.fn());
    modal.onOpen();

    expect(modal.contentEl.createEl).toHaveBeenCalledWith('p', {
      text: 'This is risky!',
      cls: 'oauth-consent-warning',
    });
  });

  it('should create button container and buttons', () => {
    const config = createConsentConfig({ preAuthFields: [] });
    const modal = new OAuthConsentModal(app, config, jest.fn(), jest.fn());
    modal.onOpen();

    // Verify the button container div was created
    expect(modal.contentEl.createDiv).toHaveBeenCalledWith('oauth-consent-buttons');

    // Get the mock button container returned by createDiv
    const createDivCalls = (modal.contentEl.createDiv as jest.Mock).mock.calls;
    const buttonContainerCallIndex = createDivCalls.findIndex(
      (call: any) => call[0] === 'oauth-consent-buttons'
    );
    const buttonContainer = (modal.contentEl.createDiv as jest.Mock).mock.results[buttonContainerCallIndex].value;

    // Verify buttons were created on the container
    const buttonCreateElCalls = (buttonContainer.createEl as jest.Mock).mock.calls;
    const buttonCalls = buttonCreateElCalls.filter(
      (call: any) => call[0] === 'button'
    );
    expect(buttonCalls.length).toBe(2); // Cancel + Confirm
  });

  it('should add oauth-consent-modal class to contentEl', () => {
    const config = createConsentConfig();
    const modal = new OAuthConsentModal(app, config, jest.fn(), jest.fn());
    modal.onOpen();

    expect(modal.contentEl.addClass).toHaveBeenCalledWith('oauth-consent-modal');
  });
});

describe('OAuthPreAuthModal', () => {
  let app: App;

  beforeEach(() => {
    app = createMockApp();
  });

  it('should construct without errors', () => {
    const config = createPreAuthConfig();
    const modal = new OAuthPreAuthModal(app, config, jest.fn(), jest.fn());
    expect(modal).toBeDefined();
  });

  it('should call onOpen without errors', () => {
    const config = createPreAuthConfig();
    const modal = new OAuthPreAuthModal(app, config, jest.fn(), jest.fn());
    expect(() => modal.onOpen()).not.toThrow();
  });

  it('should call onClose without errors', () => {
    const config = createPreAuthConfig();
    const modal = new OAuthPreAuthModal(app, config, jest.fn(), jest.fn());
    modal.onOpen();
    expect(() => modal.onClose()).not.toThrow();
  });

  it('should create heading with provider name', () => {
    const config = createPreAuthConfig({ providerLabel: 'OpenRouter' });
    const modal = new OAuthPreAuthModal(app, config, jest.fn(), jest.fn());
    modal.onOpen();

    expect(modal.contentEl.createEl).toHaveBeenCalledWith('h2', {
      text: 'Connect with OpenRouter',
    });
  });

  it('should add oauth-preauth-modal class to contentEl', () => {
    const config = createPreAuthConfig();
    const modal = new OAuthPreAuthModal(app, config, jest.fn(), jest.fn());
    modal.onOpen();

    expect(modal.contentEl.addClass).toHaveBeenCalledWith('oauth-preauth-modal');
  });

  it('should create buttons container', () => {
    const config = createPreAuthConfig();
    const modal = new OAuthPreAuthModal(app, config, jest.fn(), jest.fn());
    modal.onOpen();

    expect(modal.contentEl.createDiv).toHaveBeenCalledWith('oauth-preauth-buttons');
  });

  it('should handle empty preAuthFields gracefully', () => {
    const config = createPreAuthConfig({ preAuthFields: [] });
    const modal = new OAuthPreAuthModal(app, config, jest.fn(), jest.fn());
    expect(() => modal.onOpen()).not.toThrow();
  });

  it('should handle undefined preAuthFields gracefully', () => {
    const config = createPreAuthConfig({ preAuthFields: undefined });
    const modal = new OAuthPreAuthModal(app, config, jest.fn(), jest.fn());
    expect(() => modal.onOpen()).not.toThrow();
  });
});
