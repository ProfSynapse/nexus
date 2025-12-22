/**
 * AgentStatusModal - Compact modal for viewing running and completed subagents
 *
 * Shows for each agent:
 * - Task name (truncated) + iterations count (x/y)
 * - Last tool used (human-readable)
 * - View link to navigate to agent conversation
 * - Stop button (when running) or status icon (when complete)
 *
 * Fixed height (~200px) with scroll for many agents.
 */

import { App, Modal, setIcon, Events } from 'obsidian';
import type { SubagentExecutor } from '../../../services/chat/SubagentExecutor';
import type { BranchService } from '../../../services/chat/BranchService';
import type { AgentStatusItem, SubagentBranchMetadata } from '../../../types/branch/BranchTypes';
import { getStateIconName } from '../../../utils/branchStatusUtils';
import { formatToolDisplayName } from '../../../utils/toolNameUtils';
import { getSubagentEventBus } from './AgentStatusMenu';

export interface AgentStatusModalCallbacks {
  onViewBranch: (branchId: string) => void;
  onContinueAgent: (branchId: string) => void;
}

export class AgentStatusModal extends Modal {
  private subagentExecutor: SubagentExecutor;
  private branchService: BranchService | null;
  private conversationId: string | null;
  private callbacks: AgentStatusModalCallbacks;
  private eventRef: ReturnType<Events['on']> | null = null;
  private cachedCompletedAgents: AgentStatusItem[] = [];

  constructor(
    app: App,
    subagentExecutor: SubagentExecutor,
    callbacks: AgentStatusModalCallbacks,
    branchService?: BranchService | null,
    conversationId?: string | null
  ) {
    super(app);
    this.subagentExecutor = subagentExecutor;
    this.branchService = branchService ?? null;
    this.conversationId = conversationId ?? null;
    this.callbacks = callbacks;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('nexus-agent-status-modal');

    this.titleEl.setText('Agents');

    // Load completed agents from branch storage
    await this.loadCompletedAgentsFromStorage();

    // Subscribe to real-time updates
    const eventBus = getSubagentEventBus();
    this.eventRef = eventBus.on('status-changed', () => {
      this.renderContent();
    });

    this.renderContent();
  }

  /**
   * Load completed agents from branch storage
   * These persist across conversation switches and app restarts
   */
  private async loadCompletedAgentsFromStorage(): Promise<void> {
    if (!this.branchService || !this.conversationId) {
      this.cachedCompletedAgents = [];
      return;
    }

    try {
      const subagentBranches = await this.branchService.getSubagentBranches(this.conversationId);

      this.cachedCompletedAgents = subagentBranches
        .filter(info => {
          // Only include branches with subagent metadata
          const metadata = info.branch.metadata;
          return metadata && 'subagentId' in metadata;
        })
        .map(info => {
          const metadata = info.branch.metadata as SubagentBranchMetadata;
          return {
            subagentId: metadata.subagentId,
            branchId: info.branch.id,
            conversationId: this.conversationId!,
            parentMessageId: info.parentMessageId,
            task: metadata.task,
            state: metadata.state,
            iterations: metadata.iterations,
            maxIterations: metadata.maxIterations,
            startedAt: metadata.startedAt,
            completedAt: metadata.completedAt,
            // lastToolUsed not available for completed agents (not persisted)
          } satisfies AgentStatusItem;
        });
    } catch (error) {
      console.error('Failed to load completed agents from storage:', error);
      this.cachedCompletedAgents = [];
    }
  }

  private renderContent(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Get running agents from executor (in-memory, has lastToolUsed)
    const executorAgents = this.subagentExecutor.getAgentStatusList();

    // Merge with completed agents from storage (persisted)
    // Executor agents take priority (they have more real-time data like lastToolUsed)
    const executorBranchIds = new Set(executorAgents.map(a => a.branchId));
    const storedCompletedAgents = this.cachedCompletedAgents.filter(
      a => !executorBranchIds.has(a.branchId)
    );

    // Combine: executor agents + stored agents not in executor
    const allAgents = [...executorAgents, ...storedCompletedAgents];

    const running = allAgents.filter(a => a.state === 'running');
    const completed = allAgents.filter(a => a.state !== 'running');

    // Scrollable list container
    const listEl = contentEl.createDiv({ cls: 'nexus-agent-list' });

    // Running section
    if (running.length === 0 && completed.length === 0) {
      listEl.createDiv({ cls: 'nexus-agent-empty', text: 'No agents spawned' });
    } else {
      if (running.length > 0) {
        listEl.createDiv({ cls: 'nexus-agent-section-header', text: 'Running' });
        for (const agent of running) {
          this.renderCompactRow(listEl, agent, true);
        }
      }

      if (completed.length > 0) {
        listEl.createDiv({ cls: 'nexus-agent-section-header', text: 'Completed' });
        for (const agent of completed) {
          this.renderCompactRow(listEl, agent, false);
        }
      }
    }
  }

  /**
   * Render a compact agent row
   * Layout: [Task description + iterations] | [Tool badge] | [View + Stop/Icon]
   */
  private renderCompactRow(container: HTMLElement, agent: AgentStatusItem, isRunning: boolean): void {
    const row = container.createDiv({ cls: 'nexus-agent-row-compact' });

    // Left: Task description with iterations inline
    const info = row.createDiv({ cls: 'nexus-agent-info' });
    const taskText = `${this.truncateTask(agent.task, 40)} (${agent.iterations}/${agent.maxIterations})`;
    info.createDiv({ cls: 'nexus-agent-task', text: taskText });

    // Middle: Tool badge
    const toolContainer = row.createDiv({ cls: 'nexus-agent-tool-container' });
    if (agent.lastToolUsed) {
      toolContainer.createSpan({
        cls: 'nexus-agent-tool-badge',
        text: formatToolDisplayName(agent.lastToolUsed),
      });
    }

    // Right: View button + Stop/Status icon
    const actions = row.createDiv({ cls: 'nexus-agent-actions' });
    const viewBtn = actions.createEl('button', {
      cls: 'nexus-agent-view-btn clickable-icon',
      attr: { 'aria-label': 'View agent conversation' },
    });
    setIcon(viewBtn, 'eye');
    viewBtn.addEventListener('click', () => {
      this.close();
      this.callbacks.onViewBranch(agent.branchId);
    });

    if (isRunning) {
      const stopBtn = actions.createEl('button', {
        cls: 'nexus-agent-stop-btn clickable-icon',
        attr: { 'aria-label': 'Stop agent' },
      });
      setIcon(stopBtn, 'square');
      stopBtn.addEventListener('click', () => {
        this.subagentExecutor.cancelSubagent(agent.subagentId);
        this.renderContent();
      });
    } else {
      const iconEl = actions.createSpan({ cls: `nexus-state-icon nexus-state-icon-${agent.state}` });
      setIcon(iconEl, getStateIconName(agent.state));
    }
  }

  /**
   * Truncate task to max length with ellipsis
   */
  private truncateTask(task: string, maxLength: number): string {
    if (task.length <= maxLength) return task;
    return task.substring(0, maxLength - 1) + '…';
  }

  onClose(): void {
    // Unsubscribe from events
    if (this.eventRef) {
      getSubagentEventBus().offref(this.eventRef);
      this.eventRef = null;
    }
    this.contentEl.empty();
  }
}
