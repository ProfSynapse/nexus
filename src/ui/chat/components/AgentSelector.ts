/**
 * AgentSelector - Dropdown for selecting AI agents with custom prompts
 *
 * Displays available agents from the agent manager.
 * When an agent is selected, its prompt becomes the system prompt.
 */

import { Component } from 'obsidian';

export interface AgentOption {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
}

export class AgentSelector {
  private element: HTMLElement | null = null;
  private selectElement: HTMLSelectElement | null = null;
  private currentAgent: AgentOption | null = null;

  constructor(
    private container: HTMLElement,
    private onAgentChange: (agent: AgentOption | null) => void,
    private getAvailableAgents: () => Promise<AgentOption[]>,
    private component?: Component
  ) {
    this.render();
  }

  /**
   * Render the agent selector dropdown
   */
  private async render(): Promise<void> {
    this.container.empty();
    this.container.addClass('agent-selector');

    // Label
    const label = this.container.createDiv('agent-selector-label');
    label.textContent = 'Agent:';

    // Dropdown container
    const dropdownContainer = this.container.createDiv('agent-selector-dropdown');
    
    this.selectElement = dropdownContainer.createEl('select', {
      cls: 'agent-select'
    });

    // Add loading option
    const defaultOption = this.selectElement.createEl('option', {
      value: '',
      text: 'Loading agents...'
    });
    defaultOption.disabled = true;
    defaultOption.selected = true;

    // Load and populate agents
    await this.loadAgents();

    // Handle selection changes
    const changeHandler = () => {
      this.handleAgentChange();
    };
    this.component!.registerDomEvent(this.selectElement, 'change', changeHandler);

    this.element = this.container;
  }

  /**
   * Load available agents
   */
  private async loadAgents(): Promise<void> {
    if (!this.selectElement) return;

    try {
      const agents = await this.getAvailableAgents();
      
      // Clear loading option
      this.selectElement.innerHTML = '';
      
      // Add default "no agent" option
      const defaultOption = this.selectElement.createEl('option', {
        value: '',
        text: 'No agent (default)'
      });
      defaultOption.selected = true;

      // Add available agents
      agents.forEach(agent => {
        const option = this.selectElement!.createEl('option', {
          value: agent.id,
          text: agent.name
        });
        
        if (agent.description) {
          option.title = agent.description;
        }
      });

      // Set initial state (no agent selected)
      this.currentAgent = null;
      this.onAgentChange(null);

    } catch (error) {
      console.error('[AgentSelector] Failed to load agents:', error);
      
      if (this.selectElement) {
        this.selectElement.innerHTML = '';
        const errorOption = this.selectElement.createEl('option', {
          value: '',
          text: 'Error loading agents'
        });
        errorOption.disabled = true;
        errorOption.selected = true;
      }
    }
  }

  /**
   * Handle agent selection change
   */
  private handleAgentChange(): void {
    if (!this.selectElement) return;

    const selectedValue = this.selectElement.value;
    
    if (!selectedValue) {
      // No agent selected (default)
      this.currentAgent = null;
      this.onAgentChange(null);
      this.updateAgentInfo();
      return;
    }

    // Find the selected agent
    this.getAvailableAgents().then(agents => {
      const selectedAgent = agents.find(agent => agent.id === selectedValue);
      
      if (selectedAgent) {
        this.currentAgent = selectedAgent;
        this.onAgentChange(selectedAgent);
        this.updateAgentInfo();
      }
    });
  }

  /**
   * Get currently selected agent
   */
  getCurrentAgent(): AgentOption | null {
    return this.currentAgent;
  }

  /**
   * Set the selected agent programmatically
   */
  setAgent(agentId: string | null): void {
    if (!this.selectElement) return;

    if (!agentId) {
      this.selectElement.value = '';
      this.handleAgentChange();
      return;
    }

    const option = this.selectElement.querySelector(`option[value="${agentId}"]`);
    
    if (option) {
      this.selectElement.value = agentId;
      this.handleAgentChange();
    }
  }

  /**
   * Refresh the agent list
   */
  async refresh(): Promise<void> {
    await this.loadAgents();
  }


  /**
   * Update the agent info display
   */
  private updateAgentInfo(): void {
    const existingInfo = this.container.querySelector('.agent-info');
    if (existingInfo) {
      existingInfo.remove();
    }
    
    // Removed agent info display - no longer showing description card
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.element = null;
    this.selectElement = null;
    this.currentAgent = null;
  }
}