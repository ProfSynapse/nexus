import { App, Component, DropdownComponent, TextComponent, TextAreaComponent, ButtonComponent } from 'obsidian';
import { BoxedSection } from '../../settings/components/BoxedSection';
import { ConfirmModal } from '../../settings/components/ConfirmModal';
import { ProjectWorkspace } from '../../database/workspace-types';
import type { WorkspaceWorkflow } from '../../database/types/workspace/WorkspaceTypes';
import { CustomPrompt } from '../../types/mcp/CustomPromptTypes';
import { formatWorkflowScheduleSummary } from '../../services/workflows/types';

/**
 * WorkspaceFormRenderer - Single scrollable workspace form
 *
 * Responsibilities:
 * - Render all sections in one scrollable view
 * - Render workflows section with summaries
 * - Render key files section with list
 * - Manage formData binding
 * - Delegate workflow editing to WorkflowEditorRenderer
 * - Delegate file picking to FilePickerRenderer
 */
export class WorkspaceFormRenderer {
  constructor(
    private formData: Partial<ProjectWorkspace>,
    private availableAgents: CustomPrompt[],
    private onWorkflowEdit: (index?: number) => void,
    private onWorkflowRun: (index: number) => void,
    private onFilePick: (index: number) => void,
    private onRefresh: () => void,
    private component: Component,
    private app: App
  ) {}

  /**
   * Render the scrollable form
   */
  render(container: HTMLElement): void {
    const form = container.createDiv('nexus-workspace-form');

    // Basic Info section
    this.renderBasicInfoSection(form);

    // Context section — holds purpose/preferences + dedicated agent + key files + workflows
    this.renderContextSection(form);
  }

  /**
   * Destroy - no cleanup needed
   */
  destroy(): void {
    return;
  }

  /**
   * Render Basic Info section
   */
  private renderBasicInfoSection(container: HTMLElement): void {
    new BoxedSection(container, {
      title: 'Basic info',
      unbounded: true,
      body: (body) => {
        // Name field
        const nameField = body.createDiv('nexus-form-field');
        nameField.createEl('label', { text: 'Name', cls: 'nexus-form-label' });
        const nameInput = new TextComponent(nameField);
        nameInput.setPlaceholder('My workspace');
        nameInput.setValue(this.formData.name || '');
        nameInput.onChange((value) => {
          this.formData.name = value;
        });

        // Description field
        const descField = body.createDiv('nexus-form-field');
        descField.createEl('label', { text: 'Description', cls: 'nexus-form-label' });
        const descInput = new TextAreaComponent(descField);
        descInput.setPlaceholder('Brief description of this workspace...');
        descInput.setValue(this.formData.description || '');
        descInput.onChange((value) => {
          this.formData.description = value;
        });

        // Root Folder field
        const folderField = body.createDiv('nexus-form-field');
        folderField.createEl('label', { text: 'Root folder', cls: 'nexus-form-label' });
        const folderInput = new TextComponent(folderField);
        folderInput.setPlaceholder('/');
        folderInput.setValue(this.formData.rootFolder || '/');
        folderInput.onChange((value) => {
          this.formData.rootFolder = value;
        });
      }
    }, this.component);
  }

  /**
   * Render Context section
   */
  private renderContextSection(container: HTMLElement): void {
    // Ensure context exists
    if (!this.formData.context) {
      this.formData.context = {
        purpose: '',
        workflows: [],
        keyFiles: [],
        preferences: ''
      };
    }

    new BoxedSection(container, {
      title: 'Context',
      unbounded: true,
      body: (body) => {
        // Purpose field
        const purposeField = body.createDiv('nexus-form-field');
        purposeField.createEl('label', { text: 'Purpose', cls: 'nexus-form-label' });
        const purposeInput = new TextComponent(purposeField);
        purposeInput.setPlaceholder('What is this workspace for?');
        purposeInput.setValue(this.formData.context?.purpose || '');
        purposeInput.onChange((value) => {
          if (this.formData.context) {
            this.formData.context.purpose = value;
          }
        });

        // Preferences field
        const prefsField = body.createDiv('nexus-form-field');
        prefsField.createEl('label', { text: 'Preferences', cls: 'nexus-form-label' });
        const prefsInput = new TextAreaComponent(prefsField);
        prefsInput.setPlaceholder('Guidelines: tone, focus areas, constraints...');
        prefsInput.setValue(this.formData.context?.preferences || '');
        prefsInput.onChange((value) => {
          if (this.formData.context) {
            this.formData.context.preferences = value;
          }
        });
        prefsInput.inputEl.rows = 3;

        // Dedicated agent (single agent, top-level dedicatedAgentId binding)
        this.renderDedicatedAgentField(body);

        // Key Files subsection (nested — stays inline)
        this.renderKeyFilesSection(body);

        // Workflows section (nested subsection — stays inline)
        this.renderWorkflowsSection(body);
      }
    }, this.component);
  }

  /**
   * Render the dedicated-agent dropdown bound to the top-level dedicatedAgentId
   * field (matches the backend MCP implementation). Single agent only.
   */
  private renderDedicatedAgentField(container: HTMLElement): void {
    const agentField = container.createDiv('nexus-form-field');
    agentField.createEl('label', { text: 'Dedicated agent', cls: 'nexus-form-label' });

    const dropdownContainer = agentField.createDiv('nexus-dropdown-container');
    const dropdown = new DropdownComponent(dropdownContainer);

    dropdown.addOption('', 'None');
    this.availableAgents.forEach(agent => {
      dropdown.addOption(agent.id, agent.name);
    });

    // Field can contain either ID or name — find matching agent by either.
    const workspaceWithId = this.formData as ProjectWorkspace & { dedicatedAgentId?: string };
    const dedicatedId = workspaceWithId.dedicatedAgentId || '';
    const matchingAgent = this.availableAgents.find(a => a.id === dedicatedId || a.name === dedicatedId);
    dropdown.setValue(matchingAgent?.id || '');

    dropdown.onChange((value) => {
      const workspaceWithId = this.formData as ProjectWorkspace & { dedicatedAgentId?: string };
      if (value) {
        workspaceWithId.dedicatedAgentId = value;
      } else {
        delete workspaceWithId.dedicatedAgentId;
      }
    });
  }

  /**
   * Render Workflows subsection
   */
  private renderWorkflowsSection(container: HTMLElement): void {
    const subsection = container.createDiv('nexus-form-field');
    subsection.createEl('label', { text: 'Workflows', cls: 'nexus-form-label' });

    // Ensure workflows array exists
    if (!this.formData.context?.workflows) {
      this.formData.context = this.formData.context || {
        purpose: '', workflows: [], keyFiles: [], preferences: ''
      };
      this.formData.context.workflows = [];
    }

    const workflows = this.formData.context.workflows;

    const listContainer = subsection.createDiv('nexus-item-list');

    if (workflows.length === 0) {
      listContainer.createEl('span', { text: 'None', cls: 'nexus-form-hint' });
    } else {
      workflows.forEach((workflow, index) => {
        const item = listContainer.createDiv('nexus-item-row');

        const info = item.createDiv('nexus-item-info');
        const workflowName = workflow.name || `Workflow ${index + 1}`;
        info.createEl('span', { text: workflowName, cls: 'nexus-item-title' });
        const summary = this.buildWorkflowSummary(workflow);
        if (summary) {
          info.createEl('span', { text: summary, cls: 'nexus-item-subtitle' });
        }

        const actions = item.createDiv('nexus-item-actions');
        const runButton = new ButtonComponent(actions).setIcon('play');
        runButton.buttonEl.addClass('clickable-icon');
        runButton.buttonEl.setAttribute('aria-label', `Run ${workflowName} now`);
        runButton.onClick(() => this.onWorkflowRun(index));
        new ButtonComponent(actions)
          .setButtonText('Edit')
          .onClick(() => this.onWorkflowEdit(index));
        new ButtonComponent(actions)
          .setButtonText('×')
          .setWarning()
          .onClick(async () => {
            await ConfirmModal.confirm(this.app, {
              variant: 'remove',
              title: 'Remove workflow',
              body: 'Remove this workflow from the workspace? It will not be deleted.',
              ctaLabel: 'Remove',
              onConfirm: () => {
                workflows.splice(index, 1);
                this.onRefresh();
              }
            });
          });
      });
    }

    new ButtonComponent(subsection)
      .setButtonText('Add workflow')
      .onClick(() => this.onWorkflowEdit());
  }

  /**
   * Render Key Files subsection
   */
  private renderKeyFilesSection(container: HTMLElement): void {
    const subsection = container.createDiv('nexus-form-field');
    subsection.createEl('label', { text: 'Key files', cls: 'nexus-form-label' });

    if (!this.formData.context) {
      this.formData.context = {
        purpose: '', workflows: [], keyFiles: [], preferences: ''
      };
    } else if (!this.formData.context.keyFiles) {
      this.formData.context.keyFiles = [];
    }

    const keyFiles = this.formData.context.keyFiles ?? [];

    const listContainer = subsection.createDiv('nexus-item-list');

    const updateKeyFilesList = () => {
      listContainer.empty();

      if (keyFiles.length === 0) {
        listContainer.createEl('span', { text: 'None', cls: 'nexus-form-hint' });
      } else {
        keyFiles.forEach((filePath, index) => {
          const item = listContainer.createDiv('nexus-item-row');

          const input = new TextComponent(item);
          input.setPlaceholder('path/to/file.md');
          input.setValue(filePath);
          input.onChange((value) => {
            keyFiles[index] = value;
          });

          const actions = item.createDiv('nexus-item-actions');
          new ButtonComponent(actions)
            .setButtonText('Browse')
            .onClick(() => this.onFilePick(index));
          new ButtonComponent(actions)
            .setButtonText('×')
            .setWarning()
            .onClick(async () => {
              await ConfirmModal.confirm(this.app, {
                variant: 'remove',
                title: 'Remove key file',
                body: 'Remove this key file from the workspace? The file itself will not be deleted.',
                ctaLabel: 'Remove',
                onConfirm: () => {
                  keyFiles.splice(index, 1);
                  updateKeyFilesList();
                }
              });
            });
        });
      }
    };

    updateKeyFilesList();

    new ButtonComponent(subsection)
      .setButtonText('Add key file')
      .onClick(() => {
        const newIndex = keyFiles.length;
        keyFiles.push('');
        this.onFilePick(newIndex);
      });
  }

  private buildWorkflowSummary(workflow: WorkspaceWorkflow): string {
    const details: string[] = [];

    if (workflow.when) {
      details.push(workflow.when);
    }

    if (workflow.promptName) {
      details.push(`Prompt: ${workflow.promptName}`);
    }

    const scheduleSummary = formatWorkflowScheduleSummary(workflow.schedule);
    if (scheduleSummary) {
      details.push(`Schedule: ${scheduleSummary}`);
    }

    return details.join(' • ');
  }
}
