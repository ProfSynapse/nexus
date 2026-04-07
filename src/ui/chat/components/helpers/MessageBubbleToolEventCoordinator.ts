import { Component } from 'obsidian';

import { ConversationMessage } from '../../../../types/chat/ChatTypes';
import { ProgressiveToolAccordion } from '../ProgressiveToolAccordion';
import { ToolBubbleFactory } from '../factories/ToolBubbleFactory';
import { ToolEventParser } from '../../utils/ToolEventParser';
import { normalizeToolCallForDisplay } from '../../utils/toolDisplayNormalizer';
import { MessageBubbleImageRenderer } from './MessageBubbleImageRenderer';

interface MessageBubbleToolEventCoordinatorDependencies {
  component: Component;
  getMessage: () => ConversationMessage;
  getElement: () => HTMLElement | null;
  getToolBubbleElement: () => HTMLElement | null;
  setToolBubbleElement: (element: HTMLElement | null) => void;
  progressiveToolAccordions: Map<string, ProgressiveToolAccordion>;
  onViewBranch?: (branchId: string) => void;
  imageRenderer: MessageBubbleImageRenderer;
}

export class MessageBubbleToolEventCoordinator {
  constructor(private readonly deps: MessageBubbleToolEventCoordinatorDependencies) {}

  handleToolEvent(event: 'detected' | 'updated' | 'started' | 'completed', data: Parameters<typeof ToolEventParser.getToolEventInfo>[0]): void {
    const info = ToolEventParser.getToolEventInfo(data, event);
    const eventData = (data ?? {}) as {
      result?: unknown;
      success?: boolean;
      error?: unknown;
      [key: string]: unknown;
    };
    const toolId = info.toolId || info.batchId || info.parentToolCallId || info.stepId;
    if (!toolId) {
      return;
    }

    let accordion = this.deps.progressiveToolAccordions.get(toolId);

    if (!accordion && (event === 'detected' || event === 'started' || event === 'completed')) {
      accordion = new ProgressiveToolAccordion(this.deps.component);
      const accordionElement = accordion.createElement();

      if (this.deps.onViewBranch) {
        accordion.setCallbacks({ onViewBranch: this.deps.onViewBranch });
      }

      if (!this.deps.getToolBubbleElement()) {
        this.createToolBubbleOnDemand();
      }

      const toolContent = this.deps.getToolBubbleElement()?.querySelector('.tool-bubble-content');
      if (toolContent) {
        toolContent.appendChild(accordionElement);
      }

      this.deps.progressiveToolAccordions.set(toolId, accordion);
    }

    if (!accordion) {
      return;
    }

    const hasToolMetadata =
      Boolean(data?.toolCall) ||
      Boolean(data?.name) ||
      Boolean(data?.technicalName) ||
      Boolean(data?.displayName);

    const isLiveBatchStep = Boolean(info.isBatchStepEvent);
    const eventError = typeof eventData.error === 'string' ? eventData.error : undefined;

    if (event === 'completed' && !hasToolMetadata) {
      accordion.completeTool(toolId, eventData.result, eventData.success !== false, eventError);
    } else {
      const currentGroup = accordion.getDisplayGroup();
      const nextDisplayGroup = isLiveBatchStep
        ? normalizeToolCallForDisplay({
            ...eventData,
            id: toolId,
            toolId,
            parentToolCallId: info.parentToolCallId ?? info.batchId ?? toolId,
            batchId: info.batchId ?? toolId,
            callIndex: info.callIndex,
            totalCalls: info.totalCalls,
            strategy: info.strategy,
            stepId: info.stepId ?? undefined,
            status: info.status ?? undefined,
            error: eventError
          }, currentGroup)
        : info.displayGroup;

      const shouldPreserveCurrentBatch =
        !isLiveBatchStep &&
        Boolean(currentGroup) &&
        currentGroup?.kind === 'batch' &&
        currentGroup.steps.length > 0 &&
        nextDisplayGroup.kind === 'batch' &&
        nextDisplayGroup.steps.length === 0 &&
        (
          nextDisplayGroup.technicalName === 'useTools' ||
          nextDisplayGroup.technicalName?.endsWith('.useTools')
        );

      const displayGroup = shouldPreserveCurrentBatch && currentGroup ? currentGroup : nextDisplayGroup;
      accordion.setDisplayGroup(displayGroup);
    }

    if (event === 'completed' && eventData.success && eventData.result) {
      this.deps.imageRenderer.renderFromResult(eventData.result);
    }
  }

  private createToolBubbleOnDemand(): void {
    if (this.deps.getToolBubbleElement()) {
      return;
    }

    this.deps.setToolBubbleElement(ToolBubbleFactory.createToolBubbleOnDemand(this.deps.getMessage(), this.deps.getElement()));
  }
}
