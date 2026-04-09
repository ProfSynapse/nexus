/**
 * OAuthBannerComponent
 *
 * Renders OAuth connected/disconnected banners for provider modals.
 * Extracted from GenericProviderModal to eliminate duplication between
 * primary and secondary OAuth banner rendering.
 *
 * Connected state: status text ("Connected via {label}") + disconnect button
 * Disconnected state: connect button ("Connect with {label}")
 */

/**
 * Configuration for rendering an OAuth banner
 */
export interface OAuthBannerConfig {
  /** The provider label to display (e.g., "ChatGPT", "ChatGPT (Codex)") */
  providerLabel: string;
  /** Whether the provider is currently connected */
  isConnected: boolean;
  /** Called when the connect button is clicked */
  onConnect: () => void | Promise<void>;
  /** Called when the disconnect button is clicked */
  onDisconnect: () => void | Promise<void>;
}

/**
 * Result of rendering a banner, providing references to key elements
 */
export interface OAuthBannerRenderResult {
  /** The connect button element (only present when disconnected) */
  connectButton: HTMLButtonElement | null;
}

/**
 * Render an OAuth banner into the given container.
 * Produces the same DOM structure and CSS classes as the original
 * GenericProviderModal renderOAuthBanner/renderSecondaryOAuthBanner methods.
 *
 * @param container - The container element to render into (will be emptied first)
 * @param config - Banner configuration
 * @returns References to rendered elements
 */
export function renderOAuthBanner(
  container: HTMLElement,
  config: OAuthBannerConfig,
): OAuthBannerRenderResult {
  container.empty();

  if (config.isConnected) {
    // Connected state: show connected banner with disconnect button
    const banner = container.createDiv('oauth-connected-banner');

    const statusText = banner.createSpan('oauth-connected-status');
    statusText.textContent = `Connected via ${config.providerLabel}`;

    const disconnectBtn = banner.createEl('button', {
      text: 'Disconnect',
      cls: 'oauth-disconnect-btn',
    });
    disconnectBtn.setAttribute('aria-label', `Disconnect ${config.providerLabel} OAuth`);
    disconnectBtn.onclick = () => {
      void config.onDisconnect();
    };

    return { connectButton: null };
  } else {
    // Disconnected state: show standalone connect button
    const connectDiv = container.createDiv('oauth-connect-standalone');
    const connectButton = connectDiv.createEl('button', {
      text: `Connect with ${config.providerLabel}`,
      cls: 'mod-cta oauth-connect-btn',
    });
    connectButton.setAttribute('aria-label', `Connect with ${config.providerLabel} via OAuth`);
    connectButton.onclick = () => {
      void config.onConnect();
    };

    return { connectButton: connectButton };
  }
}

/**
 * Configuration for rendering a CLI status banner
 */
export interface CliStatusBannerConfig {
  /** The provider label to display (e.g., "Gemini CLI") */
  providerLabel: string;
  /** Whether the provider is currently authenticated */
  isAuthenticated: boolean;
  /** Error/instruction text when not authenticated (e.g., "run `gemini auth` in your terminal") */
  notAuthenticatedHint?: string;
  /** Called when the "Check status" button is clicked */
  onCheckStatus: () => void | Promise<void>;
}

/**
 * Result of rendering a CLI status banner
 */
export interface CliStatusBannerRenderResult {
  /** The "Check status" button element */
  checkStatusButton: HTMLButtonElement;
}

/**
 * Render a CLI status banner into the given container.
 * Shows authentication status with a "Check status" button instead of
 * OAuth connect/disconnect controls.
 *
 * @param container - The container element to render into (will be emptied first)
 * @param config - Banner configuration
 * @returns References to rendered elements
 */
export function renderCliStatusBanner(
  container: HTMLElement,
  config: CliStatusBannerConfig,
): CliStatusBannerRenderResult {
  container.empty();

  const banner = container.createDiv('cli-status-banner');

  const statusRow = banner.createDiv('cli-status-row');

  const statusText = statusRow.createSpan('cli-status-text');
  if (config.isAuthenticated) {
    statusText.addClass('cli-status-authenticated');
    statusText.textContent = `${config.providerLabel} authenticated`;
  } else {
    statusText.addClass('cli-status-not-authenticated');
    statusText.textContent = config.notAuthenticatedHint
      ? `Not authenticated \u2014 ${config.notAuthenticatedHint}`
      : `${config.providerLabel} not authenticated`;
  }

  const checkStatusButton = statusRow.createEl('button', {
    text: 'Check status',
    cls: 'cli-status-check-btn',
  });
  checkStatusButton.setAttribute('aria-label', `Check ${config.providerLabel} authentication status`);
  checkStatusButton.onclick = () => {
    void config.onCheckStatus();
  };

  return { checkStatusButton };
}

/**
 * Update a "Check status" button's visual state while a status check is running.
 *
 * @param button - The check status button to update
 * @param checking - Whether a check is in progress
 */
export function updateCheckStatusButtonState(
  button: HTMLButtonElement | null,
  checking: boolean,
): void {
  if (!button) return;

  if (checking) {
    button.textContent = 'Checking...';
    button.disabled = true;
    button.addClass('cli-status-checking');
  } else {
    button.textContent = 'Check status';
    button.disabled = false;
    button.removeClass('cli-status-checking');
  }
}

/**
 * Update a connect button's visual state during an OAuth flow.
 *
 * @param button - The connect button to update (may be null if connected)
 * @param connecting - Whether a connection is in progress
 * @param providerLabel - The provider label to restore when done
 */
export function updateConnectButtonState(
  button: HTMLButtonElement | null,
  connecting: boolean,
  providerLabel: string,
): void {
  if (!button) return;

  if (connecting) {
    button.textContent = 'Connecting...';
    button.disabled = true;
    button.addClass('oauth-connecting');
  } else {
    button.textContent = `Connect with ${providerLabel}`;
    button.disabled = false;
    button.removeClass('oauth-connecting');
  }
}
