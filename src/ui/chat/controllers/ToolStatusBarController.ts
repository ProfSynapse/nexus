import { Component } from 'obsidian';
import { ToolStatusBar } from '../components/ToolStatusBar';
import type { ToolStatusEntry } from '../components/ToolStatusBar';
import type { StreamingController } from './StreamingController';

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
   * Push a pre-formatted status entry to the status bar.
   * Filters events to the current streaming turn before forwarding.
   */
  pushStatus(messageId: string, entry: ToolStatusEntry): void {
    if (this.isDisposed) return;

    // Filter events to the current streaming turn.
    // Allow through when: (a) messageId matches current streaming turn,
    // (b) currentMsgId is null (streaming just started, not registered yet),
    // (c) entry state is 'past' or 'failed' (terminal, no stale-data risk).
    const currentMsgId = this.streamingController.getCurrentMessageId();
    if (currentMsgId !== null && messageId !== currentMsgId && entry.state === 'present') {
      return;
    }

    this.toolStatusBar.pushStatus(entry);
  }

  getStatusBar(): ToolStatusBar {
    return this.toolStatusBar;
  }
}
