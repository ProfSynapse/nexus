/**
 * Unified Tabs Component
 * Exact replication of Memory Manager tab pattern for consistent UI across the plugin
 */

import { Component } from 'obsidian';

export interface UnifiedTabConfig {
  key: string;
  label: string;
}

export interface UnifiedTabsOptions {
  containerEl: HTMLElement;
  tabs: UnifiedTabConfig[];
  defaultTab?: string;
  onTabChange?: (tabKey: string) => void;
  component?: Component;
}

export class UnifiedTabs {
  private containerEl: HTMLElement;
  private tabContainer!: HTMLElement;
  private contentContainer!: HTMLElement;
  private tabs: Record<string, HTMLElement> = {};
  private contents: Record<string, HTMLElement> = {};
  private activeTabKey: string;
  private onTabChange?: (tabKey: string) => void;
  private component?: Component;

  constructor(options: UnifiedTabsOptions) {
    this.containerEl = options.containerEl;
    this.activeTabKey = options.defaultTab || options.tabs[0]?.key || '';
    this.onTabChange = options.onTabChange;
    this.component = options.component;

    this.createTabStructure(options.tabs);
    this.activateDefaultTab();
  }

  /**
   * Create the tab structure exactly like MemorySettingsTab
   */
  private createTabStructure(tabConfigs: UnifiedTabConfig[]): void {
    // Create tabs container with exact same class as Memory Manager
    this.tabContainer = this.containerEl.createDiv({ cls: 'memory-settings-tabs' });
    
    // Create individual tab elements exactly like Memory Manager
    tabConfigs.forEach(config => {
      this.tabs[config.key] = this.tabContainer.createDiv({ 
        cls: 'memory-tab', 
        text: config.label 
      });
    });

    // Content container with exact same class as Memory Manager
    this.contentContainer = this.containerEl.createDiv({ cls: 'memory-tab-content' });
    
    // Create content panes exactly like Memory Manager
    tabConfigs.forEach(config => {
      this.contents[config.key] = this.contentContainer.createDiv({ 
        cls: 'memory-tab-pane' 
      });
    });

    // Setup tab switching logic exactly like Memory Manager
    Object.entries(this.tabs).forEach(([key, tab]) => {
      const clickHandler = () => {
        this.switchToTab(key);
      };
      this.component!.registerDomEvent(tab, 'click', clickHandler);
    });
  }

  /**
   * Switch to a specific tab using exact Memory Manager logic
   */
  private switchToTab(tabKey: string): void {
    this.activeTabKey = tabKey;
    
    // Remove active class from all tabs and contents (exact Memory Manager pattern)
    Object.values(this.tabs).forEach(t => t.removeClass('active'));
    Object.values(this.contents).forEach(c => c.removeClass('active'));
    
    // Add active class to clicked tab and corresponding content (exact Memory Manager pattern)
    this.tabs[tabKey]?.addClass('active');
    this.contents[tabKey]?.addClass('active');
    
    // Call callback if provided
    this.onTabChange?.(tabKey);
  }

  /**
   * Activate the default tab
   */
  private activateDefaultTab(): void {
    if (this.activeTabKey && this.tabs[this.activeTabKey]) {
      this.switchToTab(this.activeTabKey);
    } else if (Object.keys(this.tabs).length > 0) {
      // Fallback to first tab
      const firstTabKey = Object.keys(this.tabs)[0];
      this.activeTabKey = firstTabKey;
      this.switchToTab(firstTabKey);
    }
  }

  /**
   * Get content container for a specific tab
   */
  getTabContent(tabKey: string): HTMLElement | undefined {
    return this.contents[tabKey];
  }

  /**
   * Get the currently active tab key
   */
  getActiveTab(): string {
    return this.activeTabKey;
  }

  /**
   * Programmatically switch to a tab
   */
  activateTab(tabKey: string): void {
    if (this.contents[tabKey]) {
      this.switchToTab(tabKey);
    }
  }

  /**
   * Get all tab keys
   */
  getTabKeys(): string[] {
    return Object.keys(this.tabs);
  }

  /**
   * Update a tab's label
   */
  updateTabLabel(tabKey: string, newLabel: string): void {
    if (this.tabs[tabKey]) {
      this.tabs[tabKey].textContent = newLabel;
    }
  }

  /**
   * Check if a tab exists
   */
  hasTab(tabKey: string): boolean {
    return !!this.tabs[tabKey];
  }

  /**
   * Destroy the tabs component
   */
  destroy(): void {
    this.containerEl.empty();
    this.tabs = {};
    this.contents = {};
  }
}