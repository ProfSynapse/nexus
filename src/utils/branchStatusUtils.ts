/**
 * Branch status utilities
 * Shared across UI components for consistent status display
 */

import { setIcon } from 'obsidian';
import type { BranchState, SubagentBranchMetadata } from '../types/branch/BranchTypes';

/**
 * Obsidian icon names for each branch state
 */
const STATE_ICONS: Record<BranchState, string> = {
  running: 'loader-2',      // Spinning loader
  complete: 'check',        // Checkmark
  cancelled: 'x',           // X mark
  max_iterations: 'pause',  // Pause icon
  abandoned: 'alert-triangle', // Warning triangle
  error: 'x-circle',        // Error circle
};

/**
 * Get the Obsidian icon name for a branch state
 * @param state The branch state
 * @returns Obsidian icon name
 */
export function getStateIconName(state: BranchState): string {
  return STATE_ICONS[state] || 'help-circle';
}

/**
 * Render a status icon into an element using Obsidian's setIcon
 * @param element The element to render the icon into
 * @param state The branch state
 */
export function renderStateIcon(element: HTMLElement, state: BranchState): void {
  const iconName = getStateIconName(state);
  setIcon(element, iconName);

  // Add state-specific class for styling (e.g., spinning animation for running)
  element.addClass(`nexus-state-icon-${state}`);
}

/**
 * Create a status icon element
 * @param state The branch state
 * @param parent Optional parent element to append to
 * @returns The created icon element
 */
export function createStateIcon(state: BranchState, parent?: HTMLElement): HTMLElement {
  const iconEl = document.createElement('span');
  iconEl.addClass('nexus-state-icon');
  renderStateIcon(iconEl, state);

  if (parent) {
    parent.appendChild(iconEl);
  }

  return iconEl;
}

/**
 * Get status text for subagent metadata
 * @param metadata Subagent branch metadata
 * @returns Human-readable status text
 */
export function getStatusText(metadata: SubagentBranchMetadata): string {
  const { state, iterations, maxIterations } = metadata;

  switch (state) {
    case 'running':
      return `Running ${iterations || 0}/${maxIterations || 10}`;
    case 'complete':
      return `Complete (${iterations || 0} iterations)`;
    case 'cancelled':
      return 'Cancelled';
    case 'max_iterations':
      return `Paused ${iterations || 0}/${maxIterations || 10}`;
    case 'abandoned':
      return 'Abandoned';
    case 'error':
      return `Error: ${metadata.error || 'Unknown error'}`;
    default:
      return '';
  }
}

/**
 * Build a full description for agent status display
 * @param metadata Subagent branch metadata
 * @param timeAgo Formatted time string (from formatTimeAgo)
 * @returns Full description string
 */
export function buildStatusDescription(
  metadata: SubagentBranchMetadata,
  timeAgo: string
): string {
  const { state, iterations, maxIterations } = metadata;

  switch (state) {
    case 'running':
      return `${iterations}/${maxIterations} iterations · Started ${timeAgo}`;
    case 'complete':
      return `Completed in ${iterations} iterations · ${timeAgo}`;
    case 'cancelled':
      return `Cancelled after ${iterations} iterations · ${timeAgo}`;
    case 'max_iterations':
      return `Paused at max iterations (${iterations}/${maxIterations}) · ${timeAgo}`;
    case 'abandoned':
      return `Abandoned after ${iterations} iterations · ${timeAgo}`;
    case 'error':
      return `Failed after ${iterations} iterations · ${timeAgo}`;
    default:
      return `${iterations} iterations · ${timeAgo}`;
  }
}
