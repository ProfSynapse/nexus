/**
 * ProgressiveToolAccordion - Real-time tool execution display
 *
 * Shows tool execution progress in real-time with visual feedback:
 * - Shows tools as they start executing (glow effect)
 * - Updates with results as they complete
 * - Provides rich visual feedback during execution
 */

import { setIcon, Component } from 'obsidian';

export interface ProgressiveToolCall {
  id: string;
  name: string;
  technicalName?: string;
  type?: string;  // Tool type: 'function', 'reasoning', etc.
  parameters?: any;
  status: 'pending' | 'streaming' | 'executing' | 'completed' | 'failed';
  result?: any;
  error?: string;
  executionTime?: number;
  startTime?: number;
  parametersComplete?: boolean; // True when parameters are fully streamed
  isVirtual?: boolean; // True for synthetic tools like reasoning (not executable)
}

export interface ProgressiveToolAccordionCallbacks {
  onViewBranch?: (branchId: string) => void;
}

export class ProgressiveToolAccordion {
  private element: HTMLElement | null = null;
  private isExpanded = false;
  private tools: ProgressiveToolCall[] = [];
  private callbacks: ProgressiveToolAccordionCallbacks = {};

  constructor(private component?: Component, callbacks?: ProgressiveToolAccordionCallbacks) {
    this.callbacks = callbacks || {};
  }

  /**
   * Set callbacks (can be called after construction if needed)
   */
  setCallbacks(callbacks: ProgressiveToolAccordionCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Create the progressive tool accordion element
   */
  createElement(): HTMLElement {
    const accordion = document.createElement('div');
    accordion.addClass('progressive-tool-accordion');

    // Header with summary (initially hidden until first tool)
    const header = accordion.createDiv('progressive-tool-header');
    const toggleHandler = () => this.toggle();
    this.component!.registerDomEvent(header, 'click', toggleHandler);
    header.addClass('progressive-accordion-hidden'); // Hidden until first tool starts

    // Status summary
    const summary = header.createDiv('tool-summary');
    
    // Icon (will update based on status)
    const icon = summary.createSpan('tool-icon');
    
    // Text (will update as tools execute)
    const text = summary.createSpan('tool-text');
    
    // Expand indicator
    const expandIcon = header.createDiv('tool-expand-icon');
    setIcon(expandIcon, 'chevron-right');

    // Content (initially hidden)
    const content = accordion.createDiv('progressive-tool-content');
    content.addClass('progressive-accordion-hidden');

    this.element = accordion;
    return accordion;
  }

  /**
   * Detect a tool (parameters streaming) - shows it immediately with streaming state
   * Handles special tool types like 'reasoning' differently
   */
  detectTool(toolCall: { id: string; name: string; technicalName?: string; type?: string; parameters?: any; result?: any; isComplete?: boolean; isVirtual?: boolean; status?: string }): void {
    // Special handling for reasoning tools - update result instead of parameters
    const isReasoningTool = toolCall.type === 'reasoning';

    // Check if tool already exists
    const existingTool = this.tools.find(t => t.id === toolCall.id);
    if (existingTool) {
      // Tool already detected, just update
      existingTool.name = toolCall.name;
      existingTool.technicalName = toolCall.technicalName;

      if (isReasoningTool) {
        // For reasoning tools, update the result (reasoning text) and status
        existingTool.result = toolCall.result;
        existingTool.status = toolCall.status === 'completed' ? 'completed' : 'streaming';
        this.updateReasoningItem(existingTool);
      } else {
        // For regular tools, update parameters
        this.updateToolParameters(toolCall.id, toolCall.parameters, toolCall.isComplete || false);
        this.updateToolItem(existingTool);
      }
      return;
    }

    // Create new tool entry
    const progressiveTool: ProgressiveToolCall = {
      id: toolCall.id,
      name: toolCall.name,
      technicalName: toolCall.technicalName,
      type: toolCall.type,
      parameters: toolCall.parameters,
      result: isReasoningTool ? toolCall.result : undefined,  // Reasoning stores content in result
      status: isReasoningTool ? 'streaming' : (toolCall.isComplete ? 'pending' : 'streaming'),
      parametersComplete: toolCall.isComplete || false,
      isVirtual: toolCall.isVirtual,
      startTime: Date.now()
    };

    this.tools.push(progressiveTool);
    this.updateDisplay();

    if (isReasoningTool) {
      this.renderReasoningItem(progressiveTool);
    } else {
      this.renderToolItem(progressiveTool);
    }
  }

  /**
   * Update tool parameters during streaming
   */
  updateToolParameters(toolId: string, parameters: any, isComplete: boolean): void {
    const tool = this.tools.find(t => t.id === toolId);
    if (!tool) return;

    tool.parameters = parameters;
    tool.parametersComplete = isComplete;

    if (isComplete && tool.status === 'streaming') {
      tool.status = 'pending'; // Ready to execute
    }

    this.updateDisplay();
    this.updateToolItemParameters(tool);
  }

  /**
   * Start executing a tool - shows it immediately with glow effect
   */
  startTool(toolCall: { id: string; name: string; technicalName?: string; parameters?: any }): void {
    const tool = this.tools.find(t => t.id === toolCall.id);
    if (tool) {
      // Tool already exists from detection, just update status
      tool.status = 'executing';
      tool.startTime = Date.now();
      tool.name = toolCall.name;
      tool.technicalName = toolCall.technicalName;
      this.updateDisplay();
      this.updateToolItem(tool);
    } else {
      // New tool execution (legacy path)
      const progressiveTool: ProgressiveToolCall = {
        id: toolCall.id,
        name: toolCall.name,
        technicalName: toolCall.technicalName,
        parameters: toolCall.parameters,
        status: 'executing',
        parametersComplete: true,
        startTime: Date.now()
      };

      this.tools.push(progressiveTool);
      this.updateDisplay();
      this.renderToolItem(progressiveTool);
    }
  }

  /**
   * Complete a tool execution with results
   */
  completeTool(toolId: string, result: any, success: boolean, error?: string): void {
    const tool = this.tools.find(t => t.id === toolId);
    if (!tool) return;

    tool.status = success ? 'completed' : 'failed';
    tool.result = result;
    tool.error = error;
    if (tool.startTime) {
      tool.executionTime = Date.now() - tool.startTime;
    }

    this.updateDisplay();
    this.updateToolItem(tool);
  }

  /**
   * Update the header display based on current tools
   */
  private updateDisplay(): void {
    if (!this.element) return;

    const header = this.element.querySelector('.progressive-tool-header') as HTMLElement;
    const icon = this.element.querySelector('.tool-icon') as HTMLElement;
    const text = this.element.querySelector('.tool-text') as HTMLElement;

    if (this.tools.length === 0) {
      header.addClass('progressive-accordion-hidden');
      header.removeClass('progressive-accordion-header-visible');
      return;
    }

    header.removeClass('progressive-accordion-hidden');
    header.addClass('progressive-accordion-header-visible');

    const executing = this.tools.filter(t => t.status === 'executing');
    const completed = this.tools.filter(t => t.status === 'completed');
    const failed = this.tools.filter(t => t.status === 'failed');
    const total = this.tools.length;

    // Update icon based on status with color states
    if (executing.length > 0) {
      icon.empty();
      setIcon(icon, 'loader'); // Executing - spinning
      icon.addClass('tool-executing');
      icon.removeClass('tool-success', 'tool-failed');
      header.addClass('tool-executing');
    } else if (failed.length > 0) {
      icon.empty();
      setIcon(icon, 'alert-triangle'); // Some failed - orange
      icon.addClass('tool-failed');
      icon.removeClass('tool-executing', 'tool-success');
      header.removeClass('tool-executing');
    } else {
      icon.empty();
      setIcon(icon, 'check-circle'); // All completed - green
      icon.addClass('tool-success');
      icon.removeClass('tool-executing', 'tool-failed');
      header.removeClass('tool-executing');
    }

    // Update text based on tool names and status
    if (total === 1) {
      const tool = this.tools[0];
      if (tool.status === 'executing') {
        text.textContent = `${tool.name} (running...)`;
      } else {
        text.textContent = tool.name;
      }
    } else {
      const runningTools = executing.map(t => t.name).slice(0, 2);
      if (executing.length > 0) {
        if (executing.length === 1) {
          text.textContent = `${runningTools[0]} (running...) +${total - 1} more`;
        } else {
          text.textContent = `${runningTools.join(', ')} +${total - 2} more (running...)`;
        }
      } else {
        const toolNames = this.tools.map(t => t.name).slice(0, 2);
        const remaining = total - 2;
        if (remaining > 0) {
          text.textContent = `${toolNames.join(', ')} +${remaining} more`;
        } else {
          text.textContent = toolNames.join(', ');
        }
      }
    }
  }

  /**
   * Render individual tool execution item
   */
  private renderToolItem(tool: ProgressiveToolCall): void {
    if (!this.element) return;

    const content = this.element.querySelector('.progressive-tool-content') as HTMLElement;
    
    const item = document.createElement('div');
    item.addClass('progressive-tool-item');
    item.addClass(`tool-${tool.status}`);
    item.setAttribute('data-tool-id', tool.id);

    // Tool header
      const header = item.createDiv('progressive-tool-header-item');

      // Tool name (no status icon - it's in the accordion header now)
      const name = header.createSpan('tool-name');
      name.textContent = tool.name;
      if (tool.technicalName) {
        name.setAttribute('title', tool.technicalName);
      }
      
      // Execution info
      const meta = header.createSpan('tool-meta');
      this.updateExecutionMeta(meta, tool);

    // Parameters section (collapsible)
    if (tool.parameters && Object.keys(tool.parameters).length > 0) {
      const paramsSection = item.createDiv('tool-section');
      const paramsHeader = paramsSection.createDiv('tool-section-header');
      paramsHeader.createSpan({ text: 'Parameters:' });
      this.addCopyButton(paramsHeader, () => JSON.stringify(tool.parameters, null, 2));

      const paramsContent = paramsSection.createEl('pre', { cls: 'tool-code' });
      paramsContent.textContent = JSON.stringify(tool.parameters, null, 2);
    }

    // Result section (will be filled when completed)
    const resultSection = item.createDiv('tool-section tool-result-section');
    resultSection.setAttribute('data-result-section', tool.id);
    resultSection.addClass('progressive-accordion-hidden'); // Hidden until completed

    // Error section (will be shown if failed)
    const errorSection = item.createDiv('tool-section tool-error-section');
    errorSection.setAttribute('data-error-section', tool.id);
    errorSection.addClass('progressive-accordion-hidden'); // Hidden unless failed

    content.appendChild(item);
  }

  /**
   * Render a reasoning item (special display for LLM thinking/reasoning)
   * Displays as collapsible accordion showing streamed reasoning text
   */
  private renderReasoningItem(tool: ProgressiveToolCall): void {
    if (!this.element) return;

    const content = this.element.querySelector('.progressive-tool-content') as HTMLElement;

    const item = document.createElement('div');
    item.addClass('progressive-tool-item');
    item.addClass('reasoning-item');  // Special class for styling
    item.addClass(`tool-${tool.status}`);
    item.setAttribute('data-tool-id', tool.id);
    item.setAttribute('data-type', 'reasoning');

    // Reasoning header with brain icon
    const header = item.createDiv('progressive-tool-header-item reasoning-header');

    // Brain icon for reasoning
    const iconSpan = header.createSpan('reasoning-icon');
    setIcon(iconSpan, 'brain');

    // Title
    const name = header.createSpan('tool-name');
    name.textContent = tool.name || 'Reasoning';

    // Status indicator
    const meta = header.createSpan('tool-meta');
    if (tool.status === 'streaming') {
      meta.textContent = 'thinking...';
      meta.addClass('reasoning-streaming');
    } else {
      meta.textContent = '';
    }

    // Reasoning content section (shows the actual reasoning text)
    const reasoningSection = item.createDiv('reasoning-content-section');
    const reasoningContent = reasoningSection.createDiv('reasoning-text');
    reasoningContent.setAttribute('data-reasoning-content', tool.id);

    // Display reasoning text with proper formatting
    if (tool.result) {
      reasoningContent.textContent = tool.result;
    } else {
      reasoningContent.textContent = '';
    }

    // Add streaming indicator if still streaming
    if (tool.status === 'streaming') {
      const streamingIndicator = reasoningSection.createDiv('reasoning-streaming-indicator');
      streamingIndicator.textContent = '⋯';
    }

    content.appendChild(item);
  }

  /**
   * Update reasoning item with new content
   */
  private updateReasoningItem(tool: ProgressiveToolCall): void {
    if (!this.element) return;

    const item = this.element.querySelector(`[data-tool-id="${tool.id}"]`) as HTMLElement;
    if (!item) {
      // Item doesn't exist yet, render it
      this.renderReasoningItem(tool);
      return;
    }

    // Update status classes
    item.className = item.className.replace(/tool-(pending|streaming|executing|completed|failed)/g, '');
    item.addClass(`tool-${tool.status}`);

    // Update the reasoning text content
    const reasoningContent = item.querySelector(`[data-reasoning-content="${tool.id}"]`) as HTMLElement;
    if (reasoningContent && tool.result) {
      reasoningContent.textContent = tool.result;
    }

    // Update meta status
    const meta = item.querySelector('.tool-meta') as HTMLElement;
    if (meta) {
      if (tool.status === 'streaming') {
        meta.textContent = 'thinking...';
        meta.addClass('reasoning-streaming');
      } else if (tool.status === 'completed') {
        meta.textContent = '';
        meta.removeClass('reasoning-streaming');
      }
    }

    // Remove streaming indicator if complete
    if (tool.status === 'completed') {
      const streamingIndicator = item.querySelector('.reasoning-streaming-indicator');
      if (streamingIndicator) {
        streamingIndicator.remove();
      }
    }
  }

  /**
   * Update existing tool item when execution completes
   */
  private updateToolItem(tool: ProgressiveToolCall): void {
    if (!this.element) return;

    const item = this.element.querySelector(`[data-tool-id="${tool.id}"]`) as HTMLElement;
    if (!item) return;

    // Update status classes
    item.className = item.className.replace(/tool-(pending|streaming|executing|completed|failed)/g, '');
    item.addClass(`tool-${tool.status}`);

    // Update execution meta (status icon removed - now only in accordion header)
    const meta = item.querySelector('.tool-meta') as HTMLElement;
    this.updateExecutionMeta(meta, tool);

    // Show result section if completed successfully
    if (tool.status === 'completed' && tool.result) {
      const resultSection = item.querySelector(`[data-result-section="${tool.id}"]`) as HTMLElement;
      resultSection.removeClass('progressive-accordion-hidden');
      resultSection.addClass('progressive-accordion-section-visible');

      const resultHeader = resultSection.createDiv('tool-section-header');
      resultHeader.createSpan({ text: 'Result:' });
      this.addCopyButton(resultHeader, () => {
        if (typeof tool.result === 'string') {
          return tool.result;
        }
        return JSON.stringify(tool.result, null, 2);
      });

      const resultContent = resultSection.createEl('pre', { cls: 'tool-code' });
      if (typeof tool.result === 'string') {
        resultContent.textContent = tool.result;
      } else {
        resultContent.textContent = JSON.stringify(tool.result, null, 2);
      }

      // Add [View Branch] link for subagent tool results
      this.addViewBranchLink(resultSection, tool);
    }

    // Show error section if failed
    if (tool.status === 'failed' && tool.error) {
      const errorSection = item.querySelector(`[data-error-section="${tool.id}"]`) as HTMLElement;
      errorSection.removeClass('progressive-accordion-hidden');
      errorSection.addClass('progressive-accordion-section-visible');
      
      const errorHeader = errorSection.createDiv('tool-section-header');
      errorHeader.textContent = 'Error:';
      
      const errorContent = errorSection.createDiv('tool-error-content');
      errorContent.textContent = tool.error;
    }
  }

  /**
   * Update tool item parameters display during streaming
   */
  private updateToolItemParameters(tool: ProgressiveToolCall): void {
    if (!this.element) return;

    const item = this.element.querySelector(`[data-tool-id="${tool.id}"]`) as HTMLElement;
    if (!item) return;

    // Find the parameters section
    const paramsContent = item.querySelector('.tool-code') as HTMLElement;
    if (!paramsContent) return;

    // Parse parameters for display
    let displayText = '';
    try {
      const params = typeof tool.parameters === 'string'
        ? JSON.parse(tool.parameters)
        : tool.parameters;
      displayText = JSON.stringify(params, null, 2);
    } catch {
      // If parsing fails, show raw parameters
      displayText = typeof tool.parameters === 'string'
        ? tool.parameters
        : JSON.stringify(tool.parameters);
    }

    paramsContent.textContent = displayText;

    // Update streaming indicator
    let streamingIndicator = paramsContent.nextElementSibling as HTMLElement;

    if (!tool.parametersComplete) {
      // Add or update streaming indicator
      if (!streamingIndicator || !streamingIndicator.hasClass('tool-streaming-indicator')) {
        streamingIndicator = paramsContent.parentElement!.createDiv('tool-streaming-indicator');
        streamingIndicator.textContent = '⋯ streaming parameters';
      }
      paramsContent.addClass('tool-parameters-streaming');
    } else {
      // Remove streaming indicator
      if (streamingIndicator && streamingIndicator.hasClass('tool-streaming-indicator')) {
        streamingIndicator.remove();
      }
      paramsContent.removeClass('tool-parameters-streaming');
    }

    // Update status classes (status icon removed - now only in accordion header)
    item.className = item.className.replace(/tool-(pending|streaming|executing|completed|failed)/g, '');
    item.addClass(`tool-${tool.status}`);
  }

  /**
   * Update execution metadata display
   */
  private updateExecutionMeta(metaElement: HTMLElement, tool: ProgressiveToolCall): void {
    switch (tool.status) {
      case 'executing':
        if (tool.startTime) {
          const elapsed = Date.now() - tool.startTime;
          metaElement.textContent = `${Math.round(elapsed / 100) / 10}s`;
        }
        break;
      case 'completed':
      case 'failed':
        if (tool.executionTime) {
          metaElement.textContent = `${tool.executionTime}ms`;
        }
        break;
    }
  }

  /**
   * Toggle accordion expansion
   */
  private toggle(): void {
    if (!this.element) return;

    this.isExpanded = !this.isExpanded;
    
    const content = this.element.querySelector('.progressive-tool-content') as HTMLElement;
    const expandIcon = this.element.querySelector('.tool-expand-icon') as HTMLElement;

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

  /**
   * Get the DOM element
   */
  getElement(): HTMLElement | null {
    return this.element;
  }

  /**
   * Get current tool status summary
   */
  getToolSummary(): { total: number; executing: number; completed: number; failed: number } {
    return {
      total: this.tools.length,
      executing: this.tools.filter(t => t.status === 'executing').length,
      completed: this.tools.filter(t => t.status === 'completed').length,
      failed: this.tools.filter(t => t.status === 'failed').length
    };
  }

  /**
   * Add [View Branch] link for subagent tool results
   * Shows only for agentManager.subagent tool results that have a branchId
   */
  private addViewBranchLink(resultSection: HTMLElement, tool: ProgressiveToolCall): void {
    // Check if this is a subagent tool result with a branchId
    const isSubagentTool = tool.name?.toLowerCase().includes('subagent') ||
                           tool.technicalName?.includes('subagent') ||
                           tool.name === 'Spawn Subagent';

    if (!isSubagentTool || !this.callbacks.onViewBranch) {
      return;
    }

    // Extract branchId from result
    let branchId: string | null = null;
    try {
      const result = typeof tool.result === 'string' ? JSON.parse(tool.result) : tool.result;
      branchId = result?.data?.branchId || result?.branchId || null;
    } catch {
      // Not JSON or no branchId - ignore
    }

    if (!branchId) {
      return;
    }

    // Create the view branch link
    const linkContainer = resultSection.createDiv('nexus-view-branch-link-container');
    const viewLink = linkContainer.createEl('a', {
      text: 'View Branch →',
      cls: 'nexus-view-branch-link clickable-icon',
      href: '#',
    });

    this.component!.registerDomEvent(viewLink, 'click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.callbacks.onViewBranch?.(branchId!);
    });
  }

  /**
   * Add a copy button to a container element
   */
  private addCopyButton(container: HTMLElement, getContent: () => string): void {
    const copyBtn = container.createSpan({ cls: 'tool-copy-button clickable-icon' });
    setIcon(copyBtn, 'copy');
    copyBtn.setAttribute('aria-label', 'Copy to clipboard');

    this.component!.registerDomEvent(copyBtn, 'click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(getContent());
        // Show success feedback
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
    });
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.tools = [];
    this.element = null;
    this.callbacks = {};
  }
}
