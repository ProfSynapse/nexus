/**
 * BranchHeader - Navigation header when viewing a branch
 *
 * Displays above the message list when user navigates into a subagent or human branch.
 * Shows:
 * - Back button to return to parent conversation
 * - Branch task/description
 * - Status badge (running, complete, paused, etc.)
 *
 * Uses Obsidian's setIcon helper for consistent iconography.
 * Uses shared utilities for status display (DRY).
 */

import { setIcon, Component } from 'obsidian';
import type { SubagentBranchMetadata, HumanBranchMetadata } from '../../../types/branch/BranchTypes';
import { isSubagentMetadata } from '../../../types/branch/BranchTypes';
import { getStatusText, createStateIcon } from '../../../utils/branchStatusUtils';

export interface BranchViewContext {
  conversationId: string;
  branchId: string;
  parentMessageId: string;
  branchType: 'human' | 'subagent';
  metadata?: SubagentBranchMetadata | HumanBranchMetadata;
}

export interface BranchHeaderCallbacks {
  onNavigateToParent: () => void;
  onCancel?: (subagentId: string) => void;
  onContinue?: (branchId: string) => void;
}

export class BranchHeader {
  private element: HTMLElement | null = null;
  private context: BranchViewContext | null = null;
  private clickListeners: Array<{ element: HTMLElement; handler: () => void }> = []; // Track fallback listeners

  constructor(
    private container: HTMLElement,
    private callbacks: BranchHeaderCallbacks,
    private component?: Component
  ) {}

  /**
   * Show the branch header with the given context
   */
  show(context: BranchViewContext): void {
    this.context = context;
    this.render();
  }

  /**
   * Hide the branch header
   */
  hide(): void {
    this.context = null;
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
  }

  /**
   * Update the context (e.g., when iteration count changes)
   */
  update(context: Partial<BranchViewContext>): void {
    if (!this.context) return;
    this.context = { ...this.context, ...context };
    this.render();
  }

  /**
   * Check if header is currently visible
   */
  isVisible(): boolean {
    return this.element !== null;
  }

  /**
   * Get current branch context
   */
  getContext(): BranchViewContext | null {
    return this.context;
  }

  /**
   * Render the header
   */
  private render(): void {
    if (!this.context) return;

    // Remove existing element if any
    if (this.element) {
      this.element.remove();
    }

    const header = document.createElement('div');
    header.addClass('nexus-branch-header');

    // Back button
    const backBtn = header.createEl('button', {
      cls: 'nexus-branch-back clickable-icon',
    });
    backBtn.setAttribute('aria-label', 'Go back to parent conversation');
    const backIcon = backBtn.createSpan('nexus-branch-back-icon');
    setIcon(backIcon, 'arrow-left');
    backBtn.createSpan({ text: ' Back' });

    const handleBack = () => {
      this.callbacks.onNavigateToParent();
    };

    if (this.component) {
      this.component.registerDomEvent(backBtn, 'click', handleBack);
    } else {
      backBtn.addEventListener('click', handleBack);
      this.clickListeners.push({ element: backBtn, handler: handleBack });
    }

    // Branch info container
    const info = header.createDiv('nexus-branch-info');

    // Branch task/description - use type guard to narrow metadata type
    if (this.context.branchType === 'subagent' && isSubagentMetadata(this.context.metadata)) {
      const metadata = this.context.metadata; // Now properly typed as SubagentBranchMetadata
      const task = metadata.task || 'Subagent';
      const taskEl = info.createSpan({
        text: `Subagent: "${this.truncateTask(task)}"`,
        cls: 'nexus-branch-task',
      });
      taskEl.setAttribute('title', task);

      // Status badge using shared utilities
      const statusContainer = info.createSpan('nexus-branch-status');
      const statusText = getStatusText(metadata);

      statusContainer.createSpan({
        text: statusText,
        cls: `nexus-status-text nexus-status-${metadata.state || 'running'}`,
      });

      // Use setIcon-based status icon
      const iconEl = statusContainer.createSpan('nexus-status-icon');
      createStateIcon(metadata.state, iconEl);

      // Action buttons for running/paused agents
      if (metadata.state === 'running' && this.callbacks.onCancel && metadata.subagentId) {
        const cancelBtn = header.createEl('button', {
          cls: 'nexus-branch-action-btn nexus-branch-cancel-btn clickable-icon',
          text: 'Cancel',
        });
        const subagentId = metadata.subagentId;
        const handleCancel = () => {
          this.callbacks.onCancel!(subagentId);
        };
        if (this.component) {
          this.component.registerDomEvent(cancelBtn, 'click', handleCancel);
        } else {
          cancelBtn.addEventListener('click', handleCancel);
          this.clickListeners.push({ element: cancelBtn, handler: handleCancel });
        }
      }

      if (metadata.state === 'max_iterations' && this.callbacks.onContinue) {
        const continueBtn = header.createEl('button', {
          cls: 'nexus-branch-action-btn nexus-branch-continue-btn mod-cta',
          text: 'Continue',
        });
        const branchId = this.context.branchId;
        const handleContinue = () => {
          this.callbacks.onContinue!(branchId);
        };
        if (this.component) {
          this.component.registerDomEvent(continueBtn, 'click', handleContinue);
        } else {
          continueBtn.addEventListener('click', handleContinue);
          this.clickListeners.push({ element: continueBtn, handler: handleContinue });
        }
      }
    } else {
      // Human branch
      info.createSpan({
        text: 'Alternative Branch',
        cls: 'nexus-branch-task',
      });
    }

    this.element = header;
    this.container.prepend(header);
  }

  /**
   * Truncate long task descriptions
   */
  private truncateTask(task: string, maxLength: number = 50): string {
    if (task.length <= maxLength) return task;
    return task.substring(0, maxLength - 3) + '...';
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    // Remove fallback click listeners
    for (const { element, handler } of this.clickListeners) {
      element.removeEventListener('click', handler);
    }
    this.clickListeners = [];

    this.hide();
  }
}
