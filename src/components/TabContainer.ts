/**
 * Reusable Tab Container Component
 * Matches the existing Memory Manager tab styling and behavior
 */

import { Component } from 'obsidian';

export interface TabConfig {
  key: string;
  label: string;
}

export class TabContainer {
  private containerEl: HTMLElement;
  private tabContainer!: HTMLElement;
  private contentContainer!: HTMLElement;
  private tabs: Record<string, HTMLElement> = {};
  private contents: Record<string, HTMLElement> = {};
  private activeTabKey: string;
  private onTabChange?: (tabKey: string) => void;
  private component?: Component;

  constructor(
    containerEl: HTMLElement,
    tabConfigs: TabConfig[],
    defaultTab: string = tabConfigs[0]?.key,
    onTabChange?: (tabKey: string) => void,
    component?: Component
  ) {
    this.containerEl = containerEl;
    this.activeTabKey = defaultTab;
    this.onTabChange = onTabChange;
    this.component = component;

    this.createTabStructure(tabConfigs);
  }

  /**
   * Create the tab structure using Memory Manager styling
   */
  private createTabStructure(tabConfigs: TabConfig[]): void {
    // Create tabs container (same as memory-settings-tabs)
    this.tabContainer = this.containerEl.createDiv({ cls: 'memory-settings-tabs' });
    
    // Create tab buttons
    tabConfigs.forEach(config => {
      const tabEl = this.tabContainer.createDiv({
        cls: 'memory-tab',
        text: config.label
      });

      const clickHandler = () => this.switchToTab(config.key);
      this.component!.registerDomEvent(tabEl, 'click', clickHandler);
      this.tabs[config.key] = tabEl;
    });

    // Content container (same as memory-tab-content)
    this.contentContainer = this.containerEl.createDiv({ cls: 'memory-tab-content' });
    
    // Create content panes
    tabConfigs.forEach(config => {
      const contentEl = this.contentContainer.createDiv({ cls: 'memory-tab-pane' });
      this.contents[config.key] = contentEl;
    });

    // Set initial active tab
    this.switchToTab(this.activeTabKey);
  }

  /**
   * Switch to a specific tab (same logic as Memory Manager)
   */
  private switchToTab(tabKey: string): void {
    this.activeTabKey = tabKey;
    
    // Remove active class from all tabs and contents
    Object.values(this.tabs).forEach(t => t.removeClass('active'));
    Object.values(this.contents).forEach(c => c.removeClass('active'));
    
    // Add active class to clicked tab and corresponding content
    this.tabs[tabKey]?.addClass('active');
    this.contents[tabKey]?.addClass('active');
    
    // Call callback if provided
    this.onTabChange?.(tabKey);
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
}