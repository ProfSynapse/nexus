import { App, DropdownComponent, TextComponent, TextAreaComponent, ButtonComponent } from 'obsidian';
import { ProjectWorkspace } from '../../database/workspace-types';
import { CustomPrompt } from '../../types/mcp/CustomPromptTypes';

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
    private app: App,
    private formData: Partial<ProjectWorkspace>,
    private availableAgents: CustomPrompt[],
    private onWorkflowEdit: (index?: number) => void,
    private onFilePick: (index: number) => void,
    private onRefresh: () => void
  ) {}

  /**
   * Render the scrollable form
   */
  render(container: HTMLElement): void {
    const form = container.createDiv('nexus-workspace-form');

    // Basic Info section
    this.renderBasicInfoSection(form);

    // Context section
    this.renderContextSection(form);

    // Agent & Files section
    this.renderAgentFilesSection(form);
  }

  /**
   * Destroy - no cleanup needed
   */
  destroy(): void {}

  /**
   * Render Basic Info section
   */
  private renderBasicInfoSection(container: HTMLElement): void {
    const section = container.createDiv('nexus-form-section');
    section.createEl('h4', { text: 'Basic Info', cls: 'nexus-section-header' });

    // Name field
    const nameField = section.createDiv('nexus-form-field');
    nameField.createEl('label', { text: 'Name', cls: 'nexus-form-label' });
    const nameInput = new TextComponent(nameField);
    nameInput.setPlaceholder('My Workspace');
    nameInput.setValue(this.formData.name || '');
    nameInput.onChange((value) => {
      this.formData.name = value;
    });

    // Description field
    const descField = section.createDiv('nexus-form-field');
    descField.createEl('label', { text: 'Description', cls: 'nexus-form-label' });
    const descInput = new TextAreaComponent(descField);
    descInput.setPlaceholder('Brief description of this workspace...');
    descInput.setValue(this.formData.description || '');
    descInput.onChange((value) => {
      this.formData.description = value;
    });

    // Root Folder field
    const folderField = section.createDiv('nexus-form-field');
    folderField.createEl('label', { text: 'Root Folder', cls: 'nexus-form-label' });
    const folderInput = new TextComponent(folderField);
    folderInput.setPlaceholder('/');
    folderInput.setValue(this.formData.rootFolder || '/');
    folderInput.onChange((value) => {
      this.formData.rootFolder = value;
    });
  }

  /**
   * Render Context section
   */
  private renderContextSection(container: HTMLElement): void {
    const section = container.createDiv('nexus-form-section');
    section.createEl('h4', { text: 'Context', cls: 'nexus-section-header' });

    // Ensure context exists
    if (!this.formData.context) {
      this.formData.context = {
        purpose: '',
        workflows: [],
        keyFiles: [],
        preferences: ''
      };
    }

    // Purpose field
    const purposeField = section.createDiv('nexus-form-field');
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
    const prefsField = section.createDiv('nexus-form-field');
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

    // Workflows section
    this.renderWorkflowsSection(section);
  }

  /**
   * Render Agent & Files section
   */
  private renderAgentFilesSection(container: HTMLElement): void {
    const section = container.createDiv('nexus-form-section');
    section.createEl('h4', { text: 'Agent & Files', cls: 'nexus-section-header' });

    // Ensure context exists
    if (!this.formData.context) {
      this.formData.context = {
        purpose: '',
        workflows: [],
        keyFiles: [],
        preferences: ''
      };
    }

    // Dedicated Agent field
    const agentField = section.createDiv('nexus-form-field');
    agentField.createEl('label', { text: 'Dedicated Agent', cls: 'nexus-form-label' });

    const dropdownContainer = agentField.createDiv('nexus-dropdown-container');
    const dropdown = new DropdownComponent(dropdownContainer);

    dropdown.addOption('', 'None');
    this.availableAgents.forEach(agent => {
      dropdown.addOption(agent.id, agent.name);
    });

    // Use top-level dedicatedAgentId field (matches backend MCP implementation)
    // Field can contain either ID or name - find matching agent by either
    const workspaceWithId = this.formData as ProjectWorkspace & { dedicatedAgentId?: string };
    const dedicatedId = workspaceWithId.dedicatedAgentId || '';

    // Try to find agent by ID first, then by name
    const matchingAgent = this.availableAgents.find(a => a.id === dedicatedId || a.name === dedicatedId);
    const dropdownValue = matchingAgent?.id || '';
    dropdown.setValue(dropdownValue);

    dropdown.onChange((value) => {
      // Set top-level dedicatedAgentId field (string: ID or name)
      const workspaceWithId = this.formData as ProjectWorkspace & { dedicatedAgentId?: string };
      if (value) {
        workspaceWithId.dedicatedAgentId = value;
      } else {
        delete workspaceWithId.dedicatedAgentId;
      }
    });

    // Key Files section
    this.renderKeyFilesSection(section);
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

    const listContainer = subsection.createDiv('nexus-item-list');

    if (this.formData.context.workflows.length === 0) {
      listContainer.createEl('span', { text: 'None', cls: 'nexus-form-hint' });
    } else {
      this.formData.context.workflows.forEach((workflow, index) => {
        const item = listContainer.createDiv('nexus-item-row');

        const info = item.createDiv('nexus-item-info');
        const workflowName = workflow.name || `Workflow ${index + 1}`;
        info.createEl('span', { text: workflowName, cls: 'nexus-item-title' });

        const actions = item.createDiv('nexus-item-actions');
        new ButtonComponent(actions)
          .setButtonText('Edit')
          .onClick(() => this.onWorkflowEdit(index));
        new ButtonComponent(actions)
          .setButtonText('×')
          .setWarning()
          .onClick(() => {
            this.formData.context!.workflows!.splice(index, 1);
            this.onRefresh();
          });
      });
    }

    new ButtonComponent(subsection)
      .setButtonText('+ Add Workflow')
      .onClick(() => {
        this.formData.context!.workflows!.push({ name: '', when: '', steps: '' });
        this.onWorkflowEdit(this.formData.context!.workflows!.length - 1);
      });
  }

  /**
   * Render Key Files subsection
   */
  private renderKeyFilesSection(container: HTMLElement): void {
    const subsection = container.createDiv('nexus-form-field');
    subsection.createEl('label', { text: 'Key Files', cls: 'nexus-form-label' });

    if (!this.formData.context?.keyFiles) {
      this.formData.context = this.formData.context || {
        purpose: '', workflows: [], keyFiles: [], preferences: ''
      };
      this.formData.context.keyFiles = [];
    }

    const listContainer = subsection.createDiv('nexus-item-list');

    const updateKeyFilesList = () => {
      listContainer.empty();

      if (this.formData.context!.keyFiles!.length === 0) {
        listContainer.createEl('span', { text: 'None', cls: 'nexus-form-hint' });
      } else {
        this.formData.context!.keyFiles!.forEach((filePath, index) => {
          const item = listContainer.createDiv('nexus-item-row');

          const input = new TextComponent(item);
          input.setPlaceholder('path/to/file.md');
          input.setValue(filePath);
          input.onChange((value) => {
            this.formData.context!.keyFiles![index] = value;
          });

          const actions = item.createDiv('nexus-item-actions');
          new ButtonComponent(actions)
            .setButtonText('Browse')
            .onClick(() => this.onFilePick(index));
          new ButtonComponent(actions)
            .setButtonText('×')
            .setWarning()
            .onClick(() => {
              this.formData.context!.keyFiles!.splice(index, 1);
              updateKeyFilesList();
            });
        });
      }
    };

    updateKeyFilesList();

    new ButtonComponent(subsection)
      .setButtonText('+ Add Key File')
      .onClick(() => {
        const newIndex = this.formData.context!.keyFiles!.length;
        this.formData.context!.keyFiles!.push('');
        this.onFilePick(newIndex);
      });
  }
}
