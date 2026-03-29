/**
 * ProgressiveToolAccordion - Real-time tool execution display
 *
 * Shows tool execution progress in real-time with visual feedback:
 * - Shows tools as they start executing
 * - Updates with results as they complete
 * - Provides rich visual feedback during execution
 */

import { Component, setIcon } from 'obsidian';
import {
  ToolDisplayGroup,
  ToolDisplayStatus,
  ToolDisplayStep,
  normalizeToolCallForDisplay
} from '../utils/toolDisplayNormalizer';
import {
  formatToolGroupHeader,
  formatToolStepLabel
} from '../utils/toolDisplayFormatter';

export interface ProgressiveToolCall {
  id: string;
  name: string;
  technicalName?: string;
  type?: string;
  parameters?: Record<string, unknown>;
  status: ToolDisplayStatus;
  result?: unknown;
  error?: string;
  executionTime?: number;
  startTime?: number;
  parametersComplete?: boolean;
  isVirtual?: boolean;
}

export interface ProgressiveToolAccordionCallbacks {
  onViewBranch?: (branchId: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ProgressiveToolAccordion {
  private element: HTMLElement | null = null;
  private isExpanded = false;
  private displayGroup: ToolDisplayGroup | null = null;
  private callbacks: ProgressiveToolAccordionCallbacks = {};

  constructor(private component?: Component, callbacks?: ProgressiveToolAccordionCallbacks) {
    this.callbacks = callbacks || {};
  }

  setCallbacks(callbacks: ProgressiveToolAccordionCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  createElement(): HTMLElement {
    const accordion = document.createElement('div');
    accordion.addClass('progressive-tool-accordion');

    const header = accordion.createDiv('progressive-tool-header');
    const toggleHandler = () => this.toggle();
    if (this.component) {
      this.component.registerDomEvent(header, 'click', toggleHandler);
    } else {
      header.addEventListener('click', toggleHandler);
    }
    header.addClass('progressive-accordion-hidden');

    const summary = header.createDiv('tool-summary');
    summary.createSpan('tool-icon');
    summary.createSpan('tool-text');

    const expandIcon = header.createDiv('tool-expand-icon');
    setIcon(expandIcon, 'chevron-right');

    const content = accordion.createDiv('progressive-tool-content');
    content.addClass('progressive-accordion-hidden');

    this.element = accordion;
    this.refresh();
    return accordion;
  }

  setDisplayGroup(group: ToolDisplayGroup): void {
    this.displayGroup = this.cloneGroup(group);
    this.refresh();
  }

  getDisplayGroup(): ToolDisplayGroup | null {
    return this.displayGroup ? this.cloneGroup(this.displayGroup) : null;
  }

  detectTool(toolCall: {
    id: string;
    name: string;
    technicalName?: string;
    type?: string;
    parameters?: unknown;
    result?: unknown;
    isComplete?: boolean;
    isVirtual?: boolean;
    status?: string;
  }): void {
    this.setDisplayGroup(normalizeToolCallForDisplay(toolCall));
  }

  updateToolParameters(toolId: string, parameters: unknown, isComplete: boolean): void {
    if (!this.displayGroup) {
      return;
    }

    const step = this.findStep(toolId);
    if (!step) {
      return;
    }

    step.parameters = this.normalizeParameters(parameters);
    step.parametersComplete = isComplete;
    if (step.status === 'streaming' && isComplete) {
      step.status = 'pending';
    }

    this.updateDisplayNames();
    this.refresh();
  }

  startTool(toolCall: { id: string; name: string; technicalName?: string; parameters?: unknown }): void {
    if (!this.displayGroup) {
      this.setDisplayGroup(normalizeToolCallForDisplay({
        id: toolCall.id,
        name: toolCall.name,
        technicalName: toolCall.technicalName,
        parameters: toolCall.parameters,
        status: 'executing'
      }));
      return;
    }

    const step = this.findOrCreateStep(toolCall.id, toolCall.name, toolCall.technicalName, toolCall.parameters);
    step.status = 'executing';
    step.startTime = Date.now();
    step.parameters = this.normalizeParameters(toolCall.parameters);
    this.updateDisplayNames();
    this.refresh();
  }

  completeTool(toolId: string, result: unknown, success: boolean, error?: string): void {
    if (!this.displayGroup) {
      return;
    }

    const step = this.findStep(toolId) || this.findOrCreateStep(toolId, toolId, undefined, {});
    step.status = success ? 'completed' : 'failed';
    step.result = result;
    step.error = error;
    if (step.startTime) {
      step.executionTime = Date.now() - step.startTime;
    }

    this.displayGroup.status = this.computeGroupStatus();
    this.updateDisplayNames();
    this.refresh();
  }

  private refresh(): void {
    if (!this.element) {
      return;
    }

    const header = this.element.querySelector('.progressive-tool-header');
    const icon = this.element.querySelector('.tool-icon');
    const text = this.element.querySelector('.tool-text');
    const content = this.element.querySelector('.progressive-tool-content');

    if (!header || !icon || !text || !content) {
      return;
    }

    if (!this.displayGroup || this.displayGroup.steps.length === 0) {
      header.addClass('progressive-accordion-hidden');
      header.removeClass('progressive-accordion-header-visible');
      content.addClass('progressive-accordion-hidden');
      content.removeClass('progressive-accordion-content-visible');
      return;
    }

    header.removeClass('progressive-accordion-hidden');
    header.addClass('progressive-accordion-header-visible');

    const executing = this.displayGroup.steps.filter(step => step.status === 'executing');
    const failed = this.displayGroup.steps.filter(step => step.status === 'failed');

    icon.empty();
    if (this.displayGroup.kind === 'reasoning') {
      setIcon(icon, 'brain');
      icon.removeClass('tool-executing', 'tool-success', 'tool-failed');
      header.removeClass('tool-executing');
    } else if (executing.length > 0) {
      setIcon(icon, 'loader');
      icon.addClass('tool-executing');
      icon.removeClass('tool-success', 'tool-failed');
      header.addClass('tool-executing');
    } else if (failed.length > 0 || this.displayGroup.status === 'failed') {
      setIcon(icon, 'alert-triangle');
      icon.addClass('tool-failed');
      icon.removeClass('tool-executing', 'tool-success');
      header.removeClass('tool-executing');
    } else {
      setIcon(icon, 'check-circle');
      icon.addClass('tool-success');
      icon.removeClass('tool-executing', 'tool-failed');
      header.removeClass('tool-executing');
    }

    text.textContent = formatToolGroupHeader(this.displayGroup);
    this.renderGroupContent(content);
  }

  private renderGroupContent(content: HTMLElement): void {
    content.empty();

    if (!this.displayGroup) {
      return;
    }

    if (this.displayGroup.kind === 'reasoning') {
      this.renderReasoningItem(content, this.displayGroup.steps[0]);
      return;
    }

    for (const step of this.displayGroup.steps) {
      this.renderStepItem(content, step);
    }
  }

  private renderReasoningItem(content: HTMLElement, step: ToolDisplayStep | undefined): void {
    if (!step) {
      return;
    }

    const item = document.createElement('div');
    item.addClass('progressive-tool-item');
    item.addClass('reasoning-item');
    item.addClass(`tool-${step.status}`);
    item.setAttribute('data-tool-id', step.id);
    item.setAttribute('data-type', 'reasoning');

    const header = item.createDiv('progressive-tool-header-item reasoning-header');
    const iconSpan = header.createSpan('reasoning-icon');
    setIcon(iconSpan, 'brain');

    const name = header.createSpan('tool-name');
    name.textContent = step.displayName || 'Reasoning';

    const meta = header.createSpan('tool-meta');
    if (step.status === 'streaming' || step.status === 'executing') {
      meta.textContent = 'Thinking...';
      meta.addClass('reasoning-streaming');
    } else {
      meta.textContent = '';
      meta.removeClass('reasoning-streaming');
    }

    const reasoningSection = item.createDiv('reasoning-content-section');
    const reasoningContent = reasoningSection.createDiv('reasoning-text');
    reasoningContent.setAttribute('data-reasoning-content', step.id);
    reasoningContent.textContent = typeof step.result === 'string' ? step.result : '';

    if (step.status === 'streaming' || step.status === 'executing') {
      const streamingIndicator = reasoningSection.createDiv('reasoning-streaming-indicator');
      streamingIndicator.textContent = '⋯';
    }

    content.appendChild(item);
  }

  private renderStepItem(content: HTMLElement, step: ToolDisplayStep): void {
    const item = document.createElement('div');
    item.addClass('progressive-tool-item');
    item.addClass(`tool-${step.status}`);
    item.setAttribute('data-tool-id', step.id);

    const header = item.createDiv('progressive-tool-header-item');
    const name = header.createSpan('tool-name');
    name.textContent = step.displayName || formatToolStepLabel(step, this.getTenseForStep(step));
    if (step.technicalName) {
      name.setAttribute('title', step.technicalName);
    }

    const meta = header.createSpan('tool-meta');
    this.updateExecutionMeta(meta, step);

    if (step.parameters && Object.keys(step.parameters).length > 0) {
      const paramsSection = item.createDiv('tool-section');
      const paramsHeader = paramsSection.createDiv('tool-section-header');
      paramsHeader.createSpan({ text: 'Parameters:' });
      this.addCopyButton(paramsHeader, () => JSON.stringify(step.parameters, null, 2));

      const paramsContent = paramsSection.createEl('pre', { cls: 'tool-code' });
      paramsContent.textContent = JSON.stringify(step.parameters, null, 2);
    }

    const resultSection = item.createDiv('tool-section tool-result-section');
    resultSection.setAttribute('data-result-section', step.id);
    resultSection.addClass('progressive-accordion-hidden');

    const errorSection = item.createDiv('tool-section tool-error-section');
    errorSection.setAttribute('data-error-section', step.id);
    errorSection.addClass('progressive-accordion-hidden');

    if (step.status === 'completed' && step.result !== undefined) {
      this.renderResultSection(resultSection, step);
    }

    if (step.status === 'failed' && step.error) {
      this.renderErrorSection(errorSection, step.error);
    }

    content.appendChild(item);
  }

  private renderResultSection(resultSection: HTMLElement, step: ToolDisplayStep): void {
    resultSection.removeClass('progressive-accordion-hidden');
    resultSection.addClass('progressive-accordion-section-visible');

    const resultHeader = resultSection.createDiv('tool-section-header');
    resultHeader.createSpan({ text: 'Result:' });
    this.addCopyButton(resultHeader, () => {
      if (typeof step.result === 'string') {
        return step.result;
      }

      return JSON.stringify(step.result, null, 2);
    });

    const resultContent = resultSection.createEl('pre', { cls: 'tool-code' });
    if (typeof step.result === 'string') {
      resultContent.textContent = step.result;
    } else {
      resultContent.textContent = JSON.stringify(step.result, null, 2);
    }

    this.addViewBranchLink(resultSection, step);
  }

  private renderErrorSection(errorSection: HTMLElement, error: string): void {
    errorSection.removeClass('progressive-accordion-hidden');
    errorSection.addClass('progressive-accordion-section-visible');

    const errorHeader = errorSection.createDiv('tool-section-header');
    errorHeader.textContent = 'Error:';

    const errorContent = errorSection.createDiv('tool-error-content');
    errorContent.textContent = error;
  }

  private updateExecutionMeta(metaElement: HTMLElement, step: ToolDisplayStep): void {
    switch (step.status) {
      case 'executing':
      case 'streaming':
        if (step.startTime) {
          const elapsed = Date.now() - step.startTime;
          metaElement.textContent = `${Math.round(elapsed / 100) / 10}s`;
        }
        break;
      case 'completed':
      case 'failed':
        if (step.executionTime) {
          metaElement.textContent = `${step.executionTime}ms`;
        }
        break;
      case 'queued':
        metaElement.textContent = 'Queued';
        break;
      case 'skipped':
        metaElement.textContent = 'Skipped';
        break;
      default:
        metaElement.textContent = '';
    }
  }

  private toggle(): void {
    if (!this.element) {
      return;
    }

    this.isExpanded = !this.isExpanded;

    const content = this.element.querySelector('.progressive-tool-content');
    const expandIcon = this.element.querySelector('.tool-expand-icon');

    if (!content || !expandIcon) {
      return;
    }

    if (this.isExpanded) {
      content.removeClass('progressive-accordion-hidden');
      content.addClass('progressive-accordion-content-visible');
      expandIcon.empty();
      setIcon(expandIcon, 'chevron-down');
      this.element.addClass('expanded');
    } else {
      content.removeClass('progressive-accordion-content-visible');
      content.addClass('progressive-accordion-hidden');
      expandIcon.empty();
      setIcon(expandIcon, 'chevron-right');
      this.element.removeClass('expanded');
    }
  }

  getElement(): HTMLElement | null {
    return this.element;
  }

  getToolSummary(): { total: number; executing: number; completed: number; failed: number } {
    const steps = this.displayGroup?.steps || [];
    return {
      total: steps.length,
      executing: steps.filter(step => step.status === 'executing').length,
      completed: steps.filter(step => step.status === 'completed').length,
      failed: steps.filter(step => step.status === 'failed').length
    };
  }

  private addViewBranchLink(resultSection: HTMLElement, step: ToolDisplayStep): void {
    const isSubagentTool = step.displayName?.toLowerCase().includes('subagent') ||
      step.technicalName?.includes('subagent') ||
      step.displayName === 'Spawn Subagent';

    if (!isSubagentTool || !this.callbacks.onViewBranch) {
      return;
    }

    let branchId: string | null = null;
    try {
      const result: unknown = typeof step.result === 'string' ? JSON.parse(step.result) : step.result;
      if (isRecord(result)) {
        const payload = result;
        const data = payload.data;
        if (isRecord(data)) {
          const dataObject = data;
          if (typeof dataObject.branchId === 'string') {
            branchId = dataObject.branchId;
          }
        }

        if (!branchId && typeof payload.branchId === 'string') {
          branchId = payload.branchId;
        }
      }
    } catch {
      // Not JSON or no branchId.
    }

    if (!branchId) {
      return;
    }

    const linkContainer = resultSection.createDiv('nexus-view-branch-link-container');
    const viewLink = linkContainer.createEl('a', {
      text: 'View branch →',
      cls: 'nexus-view-branch-link clickable-icon',
      href: '#'
    });

    if (this.component) {
      this.component.registerDomEvent(viewLink, 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.callbacks.onViewBranch?.(branchId);
      });
    } else {
      viewLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.callbacks.onViewBranch?.(branchId);
      });
    }
  }

  private addCopyButton(container: HTMLElement, getContent: () => string): void {
    const copyBtn = container.createSpan({ cls: 'tool-copy-button clickable-icon' });
    setIcon(copyBtn, 'copy');
    copyBtn.setAttribute('aria-label', 'Copy to clipboard');

    const copyHandler = (e: MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        try {
          await navigator.clipboard.writeText(getContent());
          copyBtn.empty();
          setIcon(copyBtn, 'check');
          copyBtn.addClass('tool-copy-success');
          setTimeout(() => {
            copyBtn.empty();
            setIcon(copyBtn, 'copy');
            copyBtn.removeClass('tool-copy-success');
          }, 1500);
        } catch (err) {
          console.error('Failed to copy:', err);
        }
      })();
    };

    if (this.component) {
      this.component.registerDomEvent(copyBtn, 'click', copyHandler);
    } else {
      copyBtn.addEventListener('click', copyHandler);
    }
  }

  cleanup(): void {
    this.displayGroup = null;
    this.element = null;
    this.callbacks = {};
  }

  private cloneGroup(group: ToolDisplayGroup): ToolDisplayGroup {
    return {
      ...group,
      steps: group.steps.map(step => ({ ...step }))
    };
  }

  private normalizeParameters(parameters: unknown): Record<string, unknown> | undefined {
    if (parameters === undefined || parameters === null) {
      return undefined;
    }

    if (typeof parameters === 'string') {
      try {
        const parsed: unknown = JSON.parse(parameters);
        return isRecord(parsed)
          ? parsed
          : undefined;
      } catch {
        return undefined;
      }
    }

    if (isRecord(parameters)) {
      return parameters;
    }

    return undefined;
  }

  private updateDisplayNames(): void {
    if (!this.displayGroup) {
      return;
    }

    this.displayGroup.displayName = formatToolGroupHeader(this.displayGroup);
    for (const step of this.displayGroup.steps) {
      step.displayName = formatToolStepLabel(step, this.getTenseForStep(step));
    }
  }

  private getTenseForStep(step: ToolDisplayStep): 'present' | 'past' | 'failed' {
    switch (step.status) {
      case 'completed':
        return 'past';
      case 'failed':
      case 'skipped':
        return 'failed';
      default:
        return 'present';
    }
  }

  private computeGroupStatus(): ToolDisplayStatus {
    if (!this.displayGroup) {
      return 'pending';
    }

    const steps = this.displayGroup.steps;
    if (steps.some(step => step.status === 'failed')) {
      return 'failed';
    }

    if (steps.length > 0 && steps.every(step => step.status === 'completed')) {
      return 'completed';
    }

    if (steps.some(step => step.status === 'executing')) {
      return 'executing';
    }

    if (steps.some(step => step.status === 'streaming')) {
      return 'streaming';
    }

    return 'pending';
  }

  private findStep(stepId: string): ToolDisplayStep | undefined {
    return this.displayGroup?.steps.find(step => step.id === stepId);
  }

  private findOrCreateStep(stepId: string, name: string, technicalName?: string, parameters?: unknown): ToolDisplayStep {
    if (!this.displayGroup) {
      this.displayGroup = {
        id: stepId,
        displayName: name,
        technicalName,
        kind: 'single',
        status: 'pending',
        steps: []
      };
    }

    const existing = this.findStep(stepId);
    if (existing) {
      return existing;
    }

    const step: ToolDisplayStep = {
      id: stepId,
      displayName: name,
      technicalName,
      parameters: this.normalizeParameters(parameters),
      status: 'pending'
    };

    this.displayGroup.steps.push(step);
    return step;
  }
}
