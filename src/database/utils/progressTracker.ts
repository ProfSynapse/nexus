import type {
  ProgressUpdateData,
  ProgressCompleteData,
  ProgressCancelData
} from '../../components/ProgressBar';

/**
 * Tracks progress for long-running operations
 */
export class ProgressTracker {
  /**
   * Update progress
   */
  updateProgress(data: ProgressUpdateData): void {
    // Use global handler if available
    if (window.mcpProgressHandlers?.updateProgress) {
      window.mcpProgressHandlers.updateProgress(data);
    }
  }

  /**
   * Complete progress
   */
  completeProgress(data: ProgressCompleteData): void {
    // Use global handler if available
    if (window.mcpProgressHandlers?.completeProgress) {
      window.mcpProgressHandlers.completeProgress(data);
    }
  }

  /**
   * Cancel progress
   */
  cancelProgress(data: ProgressCancelData): void {
    // Use global handler if available
    if (window.mcpProgressHandlers?.cancelProgress) {
      window.mcpProgressHandlers.cancelProgress(data);
    }
  }
}