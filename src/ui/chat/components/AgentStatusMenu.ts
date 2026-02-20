/**
 * AgentStatusMenu - Header icon + badge showing running subagent count
 *
 * Displays in the chat header next to settings button.
 * Shows:
 * - Robot icon with badge when agents are running
 * - Clicking opens AgentStatusModal
 *
 * Uses Obsidian's setIcon helper for consistent iconography.
 * Uses event-based updates instead of polling for efficiency.
 */

import { setIcon, Component, Events } from 'obsidian';
import type { SubagentExecutor } from '../../../services/chat/SubagentExecutor';
import type { SubagentExecutorEvents } from '../../../types/branch/BranchTypes';

export interface AgentStatusMenuCallbacks {
  onOpenModal: () => void;
}

/**
 * Event emitter for subagent status updates
 * Allows UI components to subscribe to status changes without polling.
 *
 * Instance-scoped: each ChatView creates its own SubagentEventBus to avoid
 * cross-pane status leakage in split-pane layouts. The owning controller
 * should call destroy() on plugin unload to prevent hot-reload listener leaks.
 *
 * API for Wave 2 agents:
 * - Create: `new SubagentEventBus()`
 * - Listen: `const ref = bus.on('status-changed', callback)`
 * - Emit: `bus.trigger('status-changed')`
 * - Unlisten: `bus.offref(ref)`
 * - Cleanup: `bus.destroy()` — removes all listeners
 */
export class SubagentEventBus extends Events {
  private destroyed = false;

  trigger(name: 'status-changed'): void {
    if (this.destroyed) return;
    super.trigger(name);
  }

  on(name: 'status-changed', callback: () => void): ReturnType<Events['on']> {
    return super.on(name, callback);
  }

  /**
   * Remove all listeners and mark as destroyed.
   * Call on plugin unload or ChatView cleanup to prevent hot-reload leaks.
   */
  destroy(): void {
    this.destroyed = true;
    // Events base class stores listeners internally; we clear all by
    // resetting the internal _events property (Obsidian's Events uses this pattern)
    (this as any)._events = {};
  }
}

/**
 * @deprecated Use instance-scoped SubagentEventBus instead.
 * Retained temporarily for backward compatibility during migration.
 * Wave 2 agents should receive the bus instance via dependency injection.
 */
let globalEventBus: SubagentEventBus | null = null;

/**
 * @deprecated Use instance-scoped SubagentEventBus instead.
 * Creates or returns the legacy global singleton.
 */
export function getSubagentEventBus(): SubagentEventBus {
  if (!globalEventBus) {
    globalEventBus = new SubagentEventBus();
  }
  return globalEventBus;
}

/**
 * Reset the global event bus. Call on plugin unload to prevent hot-reload leaks.
 * @deprecated Will be removed once all consumers use instance-scoped bus.
 */
export function resetGlobalEventBus(): void {
  if (globalEventBus) {
    globalEventBus.destroy();
    globalEventBus = null;
  }
}

/**
 * Create event handlers that notify the event bus
 * Wire these to SubagentExecutor.setEventHandlers()
 */
export function createSubagentEventHandlers(): Partial<SubagentExecutorEvents> {
  const eventBus = getSubagentEventBus();

  return {
    onSubagentStarted: () => {
      eventBus.trigger('status-changed');
    },
    onSubagentProgress: () => {
      // Trigger on progress updates (tool changes, iteration updates)
      eventBus.trigger('status-changed');
    },
    onSubagentComplete: () => {
      eventBus.trigger('status-changed');
    },
    onSubagentError: () => {
      eventBus.trigger('status-changed');
    },
  };
}

export class AgentStatusMenu {
  private element: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private iconEl: HTMLElement | null = null;
  private lastCount: number = 0;
  private eventRef: ReturnType<Events['on']> | null = null;
  private hasShownSuccess: boolean = false; // Track if green state was shown
  private isShowingSpinner: boolean = false; // Track current icon state
  private runningStartTime: number = 0; // Timestamp when running state began
  private pendingTransitionTimer: ReturnType<typeof setTimeout> | null = null; // Timer for delayed transition
  private clickListeners: Array<{ element: HTMLElement; handler: () => void }> = []; // Track fallback listeners

  constructor(
    private container: HTMLElement,
    private subagentExecutor: SubagentExecutor | null,
    private callbacks: AgentStatusMenuCallbacks,
    private component?: Component,
    private insertBefore?: HTMLElement // Insert before this element (e.g., settings button)
  ) {}

  /**
   * Create and render the status menu button
   */
  render(): HTMLElement {
    // Create the button element
    const button = document.createElement('button');
    button.addClass('clickable-icon', 'nexus-agent-status-button');
    button.setAttribute('aria-label', 'Running agents');
    button.setAttribute('title', 'Running agents');

    // Icon container
    const iconContainer = button.createDiv('nexus-agent-status-icon');
    setIcon(iconContainer, 'bot');
    this.iconEl = iconContainer;

    // Badge (hidden by default)
    const badge = button.createDiv('nexus-agent-status-badge');
    badge.addClass('nexus-badge-hidden');
    badge.textContent = '0';
    this.badgeEl = badge;

    // Click handler - clears success state when modal opens
    const clickHandler = () => {
      this.clearSuccessState();
      this.callbacks.onOpenModal();
    };
    if (this.component) {
      this.component.registerDomEvent(button, 'click', clickHandler);
    } else {
      button.addEventListener('click', clickHandler);
      this.clickListeners.push({ element: button, handler: clickHandler });
    }

    this.element = button;

    // Insert before settings button (left side) or append (right side)
    if (this.insertBefore) {
      this.container.insertBefore(button, this.insertBefore);
    } else {
      this.container.appendChild(button);
    }

    // Subscribe to event bus for status updates (replaces polling)
    this.subscribeToEvents();

    // Initial update
    this.updateDisplay();

    return button;
  }

  /**
   * Update the executor reference (if initialized later)
   */
  setSubagentExecutor(executor: SubagentExecutor): void {
    this.subagentExecutor = executor;
    this.updateDisplay();
  }

  /**
   * Subscribe to subagent status events
   */
  private subscribeToEvents(): void {
    const eventBus = getSubagentEventBus();
    this.eventRef = eventBus.on('status-changed', () => {
      this.updateDisplay();
    });
  }

  /**
   * Update the badge display based on running agent count
   * Handles three states: running (spinner icon), success (green bot), default (bot)
   */
  updateDisplay(): void {
    if (!this.element || !this.badgeEl || !this.iconEl) return;

    const statusList = this.subagentExecutor?.getAgentStatusList() ?? [];
    const runningCount = statusList.filter(a => a.state === 'running').length;
    const completedCount = statusList.filter(a =>
      ['complete', 'cancelled', 'max_iterations', 'abandoned', 'error'].includes(a.state)
    ).length;
    // Update badge
    this.badgeEl.textContent = runningCount.toString();
    this.badgeEl.toggleClass('nexus-badge-hidden', runningCount === 0);

    // State logic: running > success > default
    if (runningCount > 0) {
      // Cancel any pending transition away from running state
      if (this.pendingTransitionTimer !== null) {
        clearTimeout(this.pendingTransitionTimer);
        this.pendingTransitionTimer = null;
      }
      // Running state - swap to spinner icon
      if (!this.isShowingSpinner) {
        setIcon(this.iconEl, 'loader-2');
        this.isShowingSpinner = true;
        this.runningStartTime = Date.now();
      }
      this.element.addClass('nexus-status-running');
      this.element.removeClass('nexus-status-success');
      this.element.addClass('nexus-agents-active');
      this.element.setAttribute('title', `${runningCount} agent${runningCount > 1 ? 's' : ''} running`);
      this.hasShownSuccess = false; // Reset on new activity
    } else if (this.isShowingSpinner) {
      // Transitioning away from running state - enforce minimum display duration
      const MIN_RUNNING_DISPLAY_MS = 500;
      const elapsed = Date.now() - this.runningStartTime;
      const remaining = MIN_RUNNING_DISPLAY_MS - elapsed;

      if (remaining > 0 && this.pendingTransitionTimer === null) {
        // Delay the transition so the spinner is visible for at least 500ms
        this.pendingTransitionTimer = setTimeout(() => {
          this.pendingTransitionTimer = null;
          this.updateDisplay();
        }, remaining);
        return;
      }
      // Minimum duration met - apply the non-running state
      this.applyNonRunningState(completedCount);
    } else {
      this.applyNonRunningState(completedCount);
    }

    this.lastCount = runningCount;
  }

  /**
   * Apply the visual state when no agents are running (success or default)
   */
  private applyNonRunningState(completedCount: number): void {
    if (!this.element || !this.iconEl) return;

    if (this.isShowingSpinner) {
      setIcon(this.iconEl, 'bot');
      this.isShowingSpinner = false;
    }

    if (completedCount > 0 && !this.hasShownSuccess) {
      // Success state - show green bot icon
      this.element.removeClass('nexus-status-running');
      this.element.addClass('nexus-status-success');
      this.element.removeClass('nexus-agents-active');
      this.element.setAttribute('title', 'Agents completed');
      this.hasShownSuccess = true;
    } else if (!this.hasShownSuccess) {
      // Default state - show bot icon
      this.element.removeClass('nexus-status-running', 'nexus-status-success', 'nexus-agents-active');
      this.element.setAttribute('title', 'Running agents');
    }
    // If hasShownSuccess is true, keep the green state until clearSuccessState() is called
  }

  /**
   * Clear the success (green) state - called when modal is opened
   */
  clearSuccessState(): void {
    if (!this.element) return;
    this.element.removeClass('nexus-status-success');
    this.hasShownSuccess = false;
    this.element.setAttribute('title', 'Running agents');
  }

  /**
   * Force refresh the display (call after agent state changes)
   */
  refresh(): void {
    this.lastCount = -1; // Force update
    this.updateDisplay();
  }

  /**
   * Show visual feedback when an agent completes
   */
  showCompletionPulse(): void {
    if (!this.element) return;

    this.element.addClass('nexus-agent-completion-pulse');
    setTimeout(() => {
      this.element?.removeClass('nexus-agent-completion-pulse');
    }, 1000);
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    // Clear pending transition timer
    if (this.pendingTransitionTimer !== null) {
      clearTimeout(this.pendingTransitionTimer);
      this.pendingTransitionTimer = null;
    }

    // Remove fallback click listeners
    for (const { element, handler } of this.clickListeners) {
      element.removeEventListener('click', handler);
    }
    this.clickListeners = [];

    // Unsubscribe from events
    if (this.eventRef) {
      getSubagentEventBus().offref(this.eventRef);
      this.eventRef = null;
    }

    this.element?.remove();
    this.element = null;
    this.badgeEl = null;
    this.iconEl = null;
    this.isShowingSpinner = false;
  }
}
