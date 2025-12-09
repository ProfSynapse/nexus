/**
 * UIStateController - Manages all UI state transitions and visual feedback
 */

import { setIcon, ButtonComponent } from 'obsidian';

export interface UIStateControllerEvents {
  onSidebarToggled: (visible: boolean) => void;
}

export class UIStateController {
  private sidebarVisible = false;
  private onOpenSettings?: () => void;

  constructor(
    private containerEl: HTMLElement,
    private events: UIStateControllerEvents
  ) {}

  /**
   * Set callback for opening settings
   */
  setOpenSettingsCallback(callback: () => void): void {
    this.onOpenSettings = callback;
  }

  /**
   * Get sidebar visibility state
   */
  getSidebarVisible(): boolean {
    return this.sidebarVisible;
  }

  /**
   * Show welcome state when no conversation is selected
   * @param hasConfiguredProviders - Whether any LLM providers are set up
   */
  showWelcomeState(hasConfiguredProviders: boolean = true): void {
    const messageDisplay = this.containerEl.querySelector('.message-display-container');
    if (!messageDisplay) return;

    (messageDisplay as HTMLElement).empty();
    messageDisplay.addClass('message-display');

    const welcome = (messageDisplay as HTMLElement).createDiv('chat-welcome');
    const welcomeContent = welcome.createDiv('chat-welcome-content');

    const welcomeIcon = welcomeContent.createDiv('chat-welcome-icon');

    if (hasConfiguredProviders) {
      // Normal welcome - ready to create conversation
      setIcon(welcomeIcon, 'sparkles');

      welcomeContent.createEl('div', {
        text: 'Welcome to Nexus Chat',
        cls: 'chat-welcome-title'
      });

      welcomeContent.createEl('p', {
        text: 'Your AI assistant for exploring and managing your vault.',
        cls: 'chat-welcome-desc'
      });

      // Hotkey hints in a container
      const hotkeysContainer = welcomeContent.createDiv('chat-welcome-hotkeys-container');
      const hotkeys = hotkeysContainer.createDiv('chat-welcome-hotkeys');

      const hotkeyData = [
        { key: '/', desc: 'Select a tool to use' },
        { key: '@', desc: 'Select an agent to use' },
        { key: '[[', desc: 'Select a note to reference' }
      ];

      hotkeyData.forEach(h => {
        const row = hotkeys.createDiv('chat-welcome-hotkey');
        row.createEl('code', { text: h.key });
        row.createSpan({ text: h.desc });
      });

      welcomeContent.createEl('button', {
        cls: 'chat-welcome-button mod-cta',
        text: 'Start your first conversation'
      });
    } else {
      // Setup needed - no providers configured
      setIcon(welcomeIcon, 'settings');

      welcomeContent.createEl('p', {
        text: 'Configure an LLM provider to start chatting',
        cls: 'chat-welcome-hint'
      });

      const settingsBtn = welcomeContent.createEl('button', {
        cls: 'chat-welcome-button',
        text: 'Open Settings'
      });
      const settingsBtnIcon = settingsBtn.createSpan({ cls: 'chat-welcome-button-icon' });
      setIcon(settingsBtnIcon, 'settings');
      settingsBtn.insertBefore(settingsBtnIcon, settingsBtn.firstChild);
      settingsBtn.addEventListener('click', () => {
        if (this.onOpenSettings) {
          this.onOpenSettings();
        }
      });
    }
  }

  /**
   * Show chat state when conversation is selected
   */
  showChatState(): void {
    // Chat state is handled by MessageDisplay component
    // This method exists for state management consistency
  }

  /**
   * Toggle conversation list visibility
   */
  toggleConversationList(): void {
    const sidebar = this.containerEl.querySelector('.chat-sidebar');
    const backdrop = this.containerEl.querySelector('.chat-backdrop');
    if (!sidebar || !backdrop) return;
    
    this.sidebarVisible = !this.sidebarVisible;
    
    if (this.sidebarVisible) {
      sidebar.removeClass('chat-sidebar-hidden');
      sidebar.addClass('chat-sidebar-visible');
      backdrop.addClass('chat-backdrop-visible');
    } else {
      sidebar.removeClass('chat-sidebar-visible');
      sidebar.addClass('chat-sidebar-hidden');
      backdrop.removeClass('chat-backdrop-visible');
    }

    this.events.onSidebarToggled(this.sidebarVisible);
  }

  /**
   * Show error message with auto-dismiss
   */
  showError(message: string): void {
    // Create a temporary error display
    const container = this.containerEl.querySelector('.message-display-container');
    if (container) {
      const errorEl = container.createDiv('chat-error');
      errorEl.textContent = message;
      
      // Auto-remove after 5 seconds
      setTimeout(() => {
        errorEl.remove();
      }, 5000);
    }
  }

  /**
   * Set loading state on chat input
   * Note: ChatInput component now manages its own loading state and stop button
   * This method is kept for backward compatibility but does nothing
   */
  setInputLoading(loading: boolean): void {
    // ChatInput component handles its own state now
    // No-op to avoid conflicts with ChatInput's updateUI()
  }

  /**
   * Set input placeholder text
   */
  setInputPlaceholder(placeholder: string): void {
    const textarea = this.containerEl.querySelector('.chat-textarea') as HTMLTextAreaElement;
    if (textarea) {
      textarea.placeholder = placeholder;
    }
  }

  /**
   * Update context progress display
   */
  updateContextProgress(): void {
    // This will be handled by the ContextProgressBar component
    // Method exists for consistency with the original ChatView interface
  }

  /**
   * Initialize UI event listeners
   */
  initializeEventListeners(): void {
    // Hamburger menu button
    const hamburgerButton = this.containerEl.querySelector('.chat-hamburger-button');
    if (hamburgerButton) {
      hamburgerButton.addEventListener('click', () => this.toggleConversationList());
    }

    // Backdrop click to close sidebar
    const backdrop = this.containerEl.querySelector('.chat-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => {
        if (this.sidebarVisible) {
          this.toggleConversationList();
        }
      });
    }
  }

  /**
   * Clean up event listeners
   */
  cleanup(): void {
    // Remove event listeners if needed
    // Most listeners are attached to elements that will be removed with the container
  }
}