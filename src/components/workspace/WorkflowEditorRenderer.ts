import { ButtonComponent, Notice, Setting } from 'obsidian';
import type {
  WorkflowCatchUpPolicy,
  WorkflowFrequency,
  WorkflowSchedule,
  WorkspaceWorkflow
} from '../../database/types/workspace/WorkspaceTypes';
import type { CustomPrompt } from '../../types/mcp/CustomPromptTypes';
import { v4 as uuidv4 } from '../../utils/uuid';

export type Workflow = WorkspaceWorkflow;

type SaveOrRunHandler = (workflow: Workflow) => Promise<void> | void;

const DAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' }
];

const FREQUENCY_LABELS: Record<WorkflowFrequency, string> = {
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly'
};

const CATCH_UP_LABELS: Record<WorkflowCatchUpPolicy, string> = {
  skip: 'Skip missed runs',
  latest: 'Run latest missed',
  all: 'Run all missed'
};

export class WorkflowEditorRenderer {
  private workflow: Workflow = { id: '', name: '', when: '', steps: '' };

  constructor(
    private availablePrompts: CustomPrompt[],
    private onSave: SaveOrRunHandler,
    private onCancel: () => void,
    private onRunNow: SaveOrRunHandler
  ) {}

  render(container: HTMLElement, workflow: Workflow, isNew: boolean, options?: { showBackButton?: boolean }): void {
    container.empty();
    this.workflow = this.cloneWorkflow(workflow);

    const header = container.createDiv('nexus-workflow-header');

    if (options?.showBackButton !== false) {
      new ButtonComponent(header)
        .setButtonText('Back to workspace')
        .setIcon('chevron-left')
        .onClick(() => this.onCancel());
    }

    header.createEl('h2', {
      text: isNew ? 'Create workflow' : 'Edit workflow',
      cls: 'nexus-workflow-title'
    });

    const form = container.createDiv('nexus-workflow-form');

    new Setting(form)
      .setName('Workflow name')
      .setDesc('Name this workflow.')
      .addText(text => text
        .setPlaceholder('e.g. Weekly blog planning')
        .setValue(this.workflow.name)
        .onChange(value => {
          this.workflow.name = value;
        }));

    new Setting(form)
      .setName('When')
      .setDesc('Describe when this workflow should be used.')
      .addText(text => text
        .setPlaceholder('e.g. When I want help outlining next week\'s posts')
        .setValue(this.workflow.when)
        .onChange(value => {
          this.workflow.when = value;
        }));

    new Setting(form)
      .setName('Prompt')
      .setDesc('Optional saved prompt/agent to bind to this workflow.')
      .addDropdown(dropdown => {
        dropdown.addOption('', 'None');
        this.availablePrompts.forEach(prompt => {
          dropdown.addOption(prompt.id, prompt.name);
        });
        dropdown.setValue(this.workflow.promptId || '');
        dropdown.onChange(value => {
          const selectedPrompt = this.availablePrompts.find(prompt => prompt.id === value);
          this.workflow.promptId = selectedPrompt?.id;
          this.workflow.promptName = selectedPrompt?.name;
        });
      });

    new Setting(form)
      .setName('Steps')
      .setDesc('These instructions are sent as the workflow-specific extra context.')
      .addTextArea(text => {
        text.setPlaceholder('Research topic\nDraft outline\nWrite first section');
        text.setValue(this.workflow.steps);
        text.inputEl.rows = 8;
        text.onChange(value => {
          this.workflow.steps = value;
        });
      });

    const scheduleSection = form.createDiv('nexus-workflow-schedule');
    scheduleSection.createEl('h3', {
      text: 'Schedule',
      cls: 'nexus-workflow-section-title'
    });

    const scheduleFields = scheduleSection.createDiv('nexus-workflow-schedule-fields');

    new Setting(scheduleSection)
      .setName('Enable schedule')
      .setDesc('Run this workflow automatically on a recurring schedule.')
      .addToggle(toggle => {
        toggle.setValue(this.workflow.schedule?.enabled ?? false);
        toggle.onChange(value => {
          this.workflow.schedule = value ? this.buildEnabledSchedule(this.workflow.schedule) : undefined;
          this.renderScheduleFields(scheduleFields);
        });
      });

    this.renderScheduleFields(scheduleFields);

    const actions = container.createDiv('nexus-form-actions');

    const runNowButton = new ButtonComponent(actions)
      .setButtonText('Run now')
      .setIcon('play');
    runNowButton.buttonEl.setAttribute('aria-label', 'Run workflow now');
    runNowButton.onClick(() => {
      const nextWorkflow = this.validateAndBuildWorkflow();
      if (!nextWorkflow) {
        return;
      }
      void Promise.resolve(this.onRunNow(nextWorkflow));
    });

    new ButtonComponent(actions)
      .setButtonText('Save workflow')
      .setCta()
      .onClick(async () => {
        const nextWorkflow = this.validateAndBuildWorkflow();
        if (!nextWorkflow) {
          return;
        }
        await this.onSave(nextWorkflow);
      });

    new ButtonComponent(actions)
      .setButtonText('Cancel')
      .onClick(() => this.onCancel());
  }

  getWorkflow(): Workflow {
    return this.cloneWorkflow(this.workflow);
  }

  private renderScheduleFields(container: HTMLElement): void {
    container.empty();

    if (!this.workflow.schedule?.enabled) {
      container.createDiv({
        cls: 'nexus-form-hint',
        text: 'Scheduling is off. This workflow can still be run manually.'
      });
      return;
    }

    const schedule = this.workflow.schedule;

    new Setting(container)
      .setName('Frequency')
      .addDropdown(dropdown => {
        Object.entries(FREQUENCY_LABELS).forEach(([value, label]) => {
          dropdown.addOption(value, label);
        });
        dropdown.setValue(schedule.frequency);
        dropdown.onChange(value => {
          schedule.frequency = value as WorkflowFrequency;
          this.applyFrequencyDefaults(schedule);
          this.renderScheduleFields(container);
        });
      });

    if (schedule.frequency === 'hourly') {
      new Setting(container)
        .setName('Every')
        .setDesc('Choose how many hours between runs.')
        .addDropdown(dropdown => {
          for (let hour = 1; hour <= 24; hour++) {
            dropdown.addOption(String(hour), `${hour} hour${hour === 1 ? '' : 's'}`);
          }
          dropdown.setValue(String(schedule.intervalHours || 1));
          dropdown.onChange(value => {
            schedule.intervalHours = Number(value);
          });
        });
    } else {
      if (schedule.frequency === 'weekly') {
        new Setting(container)
          .setName('Day of week')
          .addDropdown(dropdown => {
            DAY_OPTIONS.forEach(option => dropdown.addOption(option.value, option.label));
            dropdown.setValue(String(schedule.dayOfWeek ?? 0));
            dropdown.onChange(value => {
              schedule.dayOfWeek = Number(value);
            });
          });
      }

      if (schedule.frequency === 'monthly') {
        new Setting(container)
          .setName('Day of month')
          .addDropdown(dropdown => {
            for (let day = 1; day <= 31; day++) {
              dropdown.addOption(String(day), String(day));
            }
            dropdown.setValue(String(schedule.dayOfMonth ?? 1));
            dropdown.onChange(value => {
              schedule.dayOfMonth = Number(value);
            });
          });
      }

      new Setting(container)
        .setName('Hour')
        .addDropdown(dropdown => {
          for (let hour = 0; hour <= 23; hour++) {
            dropdown.addOption(String(hour), String(hour).padStart(2, '0'));
          }
          dropdown.setValue(String(schedule.hour ?? 9));
          dropdown.onChange(value => {
            schedule.hour = Number(value);
          });
        });

      new Setting(container)
        .setName('Minute')
        .addDropdown(dropdown => {
          for (let minute = 0; minute <= 59; minute++) {
            dropdown.addOption(String(minute), String(minute).padStart(2, '0'));
          }
          dropdown.setValue(String(schedule.minute ?? 0));
          dropdown.onChange(value => {
            schedule.minute = Number(value);
          });
        });
    }

    new Setting(container)
      .setName('Catch up')
      .setDesc('Choose what happens if Obsidian was closed during a scheduled run.')
      .addDropdown(dropdown => {
        Object.entries(CATCH_UP_LABELS).forEach(([value, label]) => {
          dropdown.addOption(value, label);
        });
        dropdown.setValue(schedule.catchUp || 'latest');
        dropdown.onChange(value => {
          schedule.catchUp = value as WorkflowCatchUpPolicy;
        });
      });
  }

  private validateAndBuildWorkflow(): Workflow | null {
    const name = this.workflow.name.trim();
    const when = this.workflow.when.trim();
    const steps = this.workflow.steps.trim();

    if (!name || !when || !steps) {
      new Notice('Workflow name, when, and steps are required');
      return null;
    }

    const prompt = this.workflow.promptId
      ? this.availablePrompts.find(item => item.id === this.workflow.promptId)
      : undefined;

    return {
      id: this.workflow.id || uuidv4(),
      name,
      when,
      steps,
      promptId: prompt?.id,
      promptName: prompt?.name,
      schedule: this.workflow.schedule?.enabled ? this.cloneSchedule(this.workflow.schedule) : undefined
    };
  }

  private cloneWorkflow(workflow: Workflow): Workflow {
    return {
      ...workflow,
      schedule: workflow.schedule ? this.cloneSchedule(workflow.schedule) : undefined
    };
  }

  private cloneSchedule(schedule: WorkflowSchedule): WorkflowSchedule {
    return { ...schedule };
  }

  private buildEnabledSchedule(schedule?: WorkflowSchedule): WorkflowSchedule {
    const nextSchedule = schedule ? this.cloneSchedule(schedule) : {
      enabled: true,
      frequency: 'daily' as WorkflowFrequency,
      hour: 9,
      minute: 0,
      catchUp: 'latest' as WorkflowCatchUpPolicy
    };
    nextSchedule.enabled = true;
    this.applyFrequencyDefaults(nextSchedule);
    return nextSchedule;
  }

  private applyFrequencyDefaults(schedule: WorkflowSchedule): void {
    if (schedule.frequency === 'hourly') {
      schedule.intervalHours = schedule.intervalHours || 1;
      delete schedule.hour;
      delete schedule.minute;
      delete schedule.dayOfWeek;
      delete schedule.dayOfMonth;
      return;
    }

    schedule.hour = schedule.hour ?? 9;
    schedule.minute = schedule.minute ?? 0;
    delete schedule.intervalHours;

    if (schedule.frequency === 'weekly') {
      schedule.dayOfWeek = schedule.dayOfWeek ?? 0;
      delete schedule.dayOfMonth;
      return;
    }

    if (schedule.frequency === 'monthly') {
      schedule.dayOfMonth = schedule.dayOfMonth ?? 1;
      delete schedule.dayOfWeek;
      return;
    }

    delete schedule.dayOfWeek;
    delete schedule.dayOfMonth;
  }
}
