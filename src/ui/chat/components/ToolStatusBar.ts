import { Component, setIcon } from 'obsidian';
import { ContextBadge } from './ContextBadge';
import { ContextTracker } from '../services/ContextTracker';
import { ToolStatusLine } from './toolStatusLine';

export interface ToolStatusBarCallbacks {
  onInspectClick?: () => void;
  onTaskClick?: () => void;
  onCompactClick?: () => void;
}

export interface ToolStatusEntry {
  text: string;
  state: 'present' | 'past' | 'failed';
}

export class ToolStatusBar {
  private statusBarEl: HTMLElement;
  private row1El!: HTMLElement;
  private slotEl!: HTMLElement;
  private row2El!: HTMLElement;
  private statusLine!: ToolStatusLine;
  private isDisposed = false;
  
  // Elements
  private inspectBtn!: HTMLButtonElement;
  private taskBtn!: HTMLButtonElement;
  private agentSlotEl!: HTMLElement;
  private compactBtn!: HTMLButtonElement;
  private costEl!: HTMLElement;
  
  private contextBadge!: ContextBadge;

  constructor(
    container: HTMLElement,
    private readonly contextTracker: ContextTracker,
    callbacks: ToolStatusBarCallbacks,
    private readonly component: Component
  ) {
    this.statusBarEl = container.createEl('div', {
      cls: 'tool-status-bar tool-status-bar-hidden'
    });

    // Setup row 1 (primary)
    this.row1El = this.statusBarEl.createEl('div', { cls: 'tool-status-row--primary' });
    this.slotEl = this.row1El.createEl('div', { cls: 'tool-status-slot' });
    this.statusLine = new ToolStatusLine(this.slotEl, this.component);
    
    // Setup row 2 (meta)
    this.row2El = this.statusBarEl.createEl('div', { cls: 'tool-status-row--meta' });
    
    // Action icons
    this.inspectBtn = this.row2El.createEl('button', { cls: 'tool-status-inspect-icon' });
    this.inspectBtn.setAttribute('aria-label', 'Inspect tools');
    this.inspectBtn.setAttribute('aria-haspopup', 'dialog');
    setIcon(this.inspectBtn, 'eye');
    if (callbacks.onInspectClick) {
      this.component.registerDomEvent(this.inspectBtn, 'click', callbacks.onInspectClick);
    }
    
    this.taskBtn = this.row2El.createEl('button', { cls: 'tool-status-task-icon' });
    this.taskBtn.setAttribute('aria-label', 'Task board');
    setIcon(this.taskBtn, 'clipboard-check');
    if (callbacks.onTaskClick) {
      this.component.registerDomEvent(this.taskBtn, 'click', callbacks.onTaskClick);
    }
    
    this.agentSlotEl = this.row2El.createEl('button', { cls: 'nexus-agent-status-button' });
    this.agentSlotEl.setAttribute('aria-label', 'Agent status');
    setIcon(this.agentSlotEl, 'bot');
    
    this.compactBtn = this.row2El.createEl('button', { cls: 'tool-status-compact-icon' });
    this.compactBtn.setAttribute('aria-label', 'Compact conversation');
    setIcon(this.compactBtn, 'library');
    if (callbacks.onCompactClick) {
      this.component.registerDomEvent(this.compactBtn, 'click', callbacks.onCompactClick);
    }
    
    // Right group
    this.costEl = this.row2El.createEl('div', { cls: 'tool-status-cost' });
    this.contextBadge = new ContextBadge(this.row2El);
  }

  public pushStatus(entry: ToolStatusEntry): void {
    this.show();
    this.statusLine.update(entry.text, entry.state);
  }

  public clearStatus(): void {
    this.statusLine.clear();
  }

  public show(): void {
    this.statusBarEl.removeClass('tool-status-bar-hidden');
  }

  public hide(): void {
    this.statusBarEl.addClass('tool-status-bar-hidden');
  }
  
  public getAgentSlotEl(): HTMLElement {
    return this.agentSlotEl;
  }
  
  public getContextBadge(): ContextBadge {
    return this.contextBadge;
  }
  
  public async updateContext(): Promise<void> {
    if (this.isDisposed) return;
    const usage = await this.contextTracker.getContextUsage();
    // Obsidian Component.onClose() does not await — the view may have torn
    // down during the await above, leaving us holding detached DOM refs.
    if (this.isDisposed) return;
    this.contextBadge.setPercentage(usage.percentage);

    const cost = this.contextTracker.getConversationCost();
    if (cost && cost.totalCost !== undefined) {
      this.costEl.textContent = `$${cost.totalCost.toFixed(2)}`;
    } else {
      this.costEl.textContent = '$0.00';
    }

    this.show();
  }

  public cleanup(): void {
    this.isDisposed = true;
    this.statusLine.clear();
    this.contextBadge?.cleanup();
    if (this.statusBarEl && this.statusBarEl.parentElement) {
      this.statusBarEl.parentElement.removeChild(this.statusBarEl);
    }
  }
}
