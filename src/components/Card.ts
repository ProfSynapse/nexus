/**
 * Reusable Card Component
 * Matches the existing Custom Agent card styling and behavior
 */

import { ToggleComponent, Component, setIcon } from 'obsidian';

export interface CardAction {
  icon: string; // Obsidian icon name (e.g., 'edit', 'trash') - uses setIcon
  label: string; // aria-label for accessibility
  onClick: () => void;
}

export interface CardConfig {
  title: string;
  description: string;
  isEnabled?: boolean;
  showToggle?: boolean; // Whether to show the toggle switch
  onToggle?: (enabled: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  additionalActions?: CardAction[];
}

export class Card {
  private containerEl: HTMLElement;
  private cardEl: HTMLElement;
  private config: CardConfig;
  private component?: Component;

  constructor(containerEl: HTMLElement, config: CardConfig, component?: Component) {
    this.containerEl = containerEl;
    this.config = config;
    this.component = component;
    this.cardEl = this.createCard();
  }

  /**
   * Create the card element with standard styling
   */
  private createCard(): HTMLElement {
    const cardEl = this.containerEl.createDiv('agent-management-card');
    
    // Header with name and toggle
    const headerEl = cardEl.createDiv('agent-management-card-header');
    const titleEl = headerEl.createDiv('agent-management-card-title');
    titleEl.setText(this.config.title);
    
    const actionsEl = headerEl.createDiv('agent-management-card-actions');
    
    // Toggle switch using Obsidian's ToggleComponent (only if showToggle is true)
    if (this.config.showToggle && this.config.onToggle) {
      const toggleContainer = actionsEl.createDiv('agent-management-toggle');
      new ToggleComponent(toggleContainer)
        .setValue(this.config.isEnabled || false)
        .onChange(async (value) => {
          this.config.isEnabled = value;
          this.config.onToggle!(value);
        });
    }
    
    if (this.config.onEdit) {
      const editBtn = actionsEl.createEl('button', {
        cls: 'clickable-icon agent-management-edit-btn',
        attr: { 'aria-label': 'Edit' }
      });
      setIcon(editBtn, 'edit');
      const editHandler = () => this.config.onEdit!();
      this.component!.registerDomEvent(editBtn, 'click', editHandler);
    }

    if (this.config.onDelete) {
      const deleteBtn = actionsEl.createEl('button', {
        cls: 'clickable-icon agent-management-delete-btn',
        attr: { 'aria-label': 'Delete' }
      });
      setIcon(deleteBtn, 'trash');
      const deleteHandler = () => this.config.onDelete!();
      this.component!.registerDomEvent(deleteBtn, 'click', deleteHandler);
    }

    if (this.config.additionalActions) {
      this.config.additionalActions.forEach(action => {
        const actionBtn = actionsEl.createEl('button', {
          cls: 'clickable-icon agent-management-action-btn',
          attr: { 'aria-label': action.label }
        });
        setIcon(actionBtn, action.icon);
        this.component!.registerDomEvent(actionBtn, 'click', action.onClick);
      });
    }
    
    // Description (only show if not empty)
    if (this.config.description && this.config.description.trim()) {
      const descEl = cardEl.createDiv('agent-management-card-description');
      descEl.setText(this.config.description);
    }
    
    return cardEl;
  }

  /**
   * Update the card's configuration and refresh display
   */
  updateConfig(config: Partial<CardConfig>): void {
    this.config = { ...this.config, ...config };
    this.refresh();
  }

  /**
   * Update the card's enabled state
   */
  setEnabled(enabled: boolean): void {
    this.config.isEnabled = enabled;
    // Just update the internal state - don't create new toggle components
    // The toggle state will be reflected when the card is refreshed
  }

  /**
   * Update the card's title
   */
  setTitle(title: string): void {
    this.config.title = title;
    const titleEl = this.cardEl.querySelector('.agent-management-card-title');
    if (titleEl) {
      titleEl.textContent = title;
    }
  }

  /**
   * Update the card's description
   */
  setDescription(description: string): void {
    this.config.description = description;
    
    // Remove existing description element
    const existingDescEl = this.cardEl.querySelector('.agent-management-card-description');
    if (existingDescEl) {
      existingDescEl.remove();
    }
    
    // Add new description element only if not empty
    if (description && description.trim()) {
      const descEl = this.cardEl.createDiv('agent-management-card-description');
      descEl.setText(description);
    }
  }

  /**
   * Refresh the entire card display
   */
  private refresh(): void {
    this.cardEl.remove();
    this.cardEl = this.createCard();
  }

  /**
   * Remove the card from the DOM
   */
  remove(): void {
    this.cardEl.remove();
  }

  /**
   * Get the card's DOM element
   */
  getElement(): HTMLElement {
    return this.cardEl;
  }

  /**
   * Check if the card is enabled
   */
  isEnabled(): boolean {
    return this.config.isEnabled || false;
  }
}