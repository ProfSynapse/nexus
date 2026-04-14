import { Component } from 'obsidian';
import { ToolStatusBar } from '../components/ToolStatusBar';
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
  private isDisposed = false;

  constructor(
    private toolStatusBar: ToolStatusBar,
    private streamingController: StreamingController,
    component: Component
  ) {
    component.register(() => {
      this.isDisposed = true;
    });
  }

  /**
   * Handle generic tool event, mapping it to status bar updates
   */
  handleToolEvent(messageId: string, event: 'detected' | 'updated' | 'started' | 'completed', data: ToolStatusEventData): void {
    if (this.isDisposed) return;
    // Filter events to the current streaming turn.
    // Allow 'completed' events through even if the streaming messageId has
    // been cleared by finalizeStreaming() — they are terminal, per-execution
    // events with no stale-data risk, and dropping them prevents the status
    // bar from ever showing past-tense ("Opened note") labels.
    if (messageId !== this.streamingController.getCurrentMessageId()) {
      if (event !== 'completed') return;
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

    // Push directly — tool events are low-frequency (handful per message).
    // ToolStatusLine.update() provides its own 400ms visual throttle.
    this.toolStatusBar.pushStatus({ text, state: tense });
  }

  getStatusBar(): ToolStatusBar {
    return this.toolStatusBar;
  }
}