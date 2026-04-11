import { debounce } from 'obsidian';
import { ToolStatusBar, ToolStatusEntry } from '../components/ToolStatusBar';
import { formatToolStepLabel } from '../utils/toolDisplayFormatter';
import type { StreamingController } from './StreamingController';
import type { ToolDisplayStatus, ToolDisplayStep } from '../utils/toolDisplayNormalizer';

export interface ToolStatusEventData {
  [key: string]: unknown;
  id?: string | null;
  toolId?: string;
  name?: unknown;
  rawName?: unknown;
  technicalName?: unknown;
  displayName?: unknown;
  actionName?: unknown;
  parameters?: unknown;
  result?: unknown;
  error?: unknown;
  status?: unknown;
  success?: unknown;
  isVirtual?: unknown;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function toRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toBooleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function toErrorString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message;
  }

  return undefined;
}

function hasFailure(data: ToolStatusEventData): boolean {
  return data.success === false || toErrorString(data.error) !== undefined;
}

function toStep(data: ToolStatusEventData, status: ToolDisplayStatus): Partial<ToolDisplayStep> & {
  result?: unknown;
  error?: string;
  status?: ToolDisplayStatus;
} {
  return {
    technicalName: toStringOrUndefined(data.technicalName) || toStringOrUndefined(data.rawName) || toStringOrUndefined(data.name),
    displayName: toStringOrUndefined(data.displayName) || toStringOrUndefined(data.name),
    actionName: toStringOrUndefined(data.actionName),
    parameters: toRecordOrUndefined(data.parameters),
    result: data.result,
    error: toErrorString(data.error),
    status,
    isVirtual: toBooleanOrUndefined(data.isVirtual),
  };
};

export class ToolStatusBarController {
  private pushStatusDebounced: (entry: ToolStatusEntry) => void;

  constructor(
    private toolStatusBar: ToolStatusBar,
    private streamingController: StreamingController
  ) {
    // Phase 3 requirement: 400ms debounce
    this.pushStatusDebounced = debounce((entry: ToolStatusEntry) => {
      this.toolStatusBar.pushStatus(entry);
    }, 400, true);
  }

  /**
   * Handle generic tool event, mapping it to status bar updates
   */
  handleToolEvent(messageId: string, event: 'detected' | 'updated' | 'started' | 'completed', data: ToolStatusEventData): void {
    // Phase 3 requirement: filter events to the current streaming turn
    if (messageId !== this.streamingController.getCurrentMessageId()) {
      return;
    }

    let statusType: ToolDisplayStatus = 'executing';
    let tense: 'present' | 'past' | 'failed' = 'present';

    if (event === 'completed') {
      if (hasFailure(data)) {
        statusType = 'failed';
        tense = 'failed';
      } else {
        statusType = 'completed';
        tense = 'past';
      }
    }

    const step = toStep(data, statusType);

    const text = formatToolStepLabel(step, tense);
    if (!text) {
      return;
    }

    // Apply debounce function
    this.pushStatusDebounced({
      text,
      state: tense
    });
  }

  getStatusBar(): ToolStatusBar {
    return this.toolStatusBar;
  }
}