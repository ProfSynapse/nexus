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
  onConnect: () => void;
  /** Called when the disconnect button is clicked */
  onDisconnect: () => void;
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
    disconnectBtn.onclick = () => config.onDisconnect();

    return { connectButton: null };
  } else {
    // Disconnected state: show standalone connect button
    const connectDiv = container.createDiv('oauth-connect-standalone');
    const connectButton = connectDiv.createEl('button', {
      text: `Connect with ${config.providerLabel}`,
      cls: 'mod-cta oauth-connect-btn',
    });
    connectButton.setAttribute('aria-label', `Connect with ${config.providerLabel} via OAuth`);
    connectButton.onclick = () => config.onConnect();

    return { connectButton: connectButton as HTMLButtonElement };
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
