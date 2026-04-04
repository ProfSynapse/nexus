import type { App, Plugin } from 'obsidian';
import type NexusPlugin from '../../main';
import { openTaskBoardView, TASK_BOARD_VIEW_TYPE } from '../../ui/tasks/taskBoardNavigation';

export interface TaskBoardUIManagerConfig {
  plugin: Plugin;
  app: App;
}

export class TaskBoardUIManager {
  private viewRegistered = false;
  private commandRegistered = false;

  constructor(private config: TaskBoardUIManagerConfig) {}

  async registerViewEarly(): Promise<void> {
    if (this.viewRegistered) {
      return;
    }

    try {
      const { plugin } = this.config;
      const { TaskBoardView } = await import('../../ui/tasks/TaskBoardView');

      plugin.registerView(TASK_BOARD_VIEW_TYPE, (leaf) => {
        return new TaskBoardView(leaf, plugin as NexusPlugin);
      });

      this.viewRegistered = true;
    } catch (error) {
      console.error('Failed to register TaskBoardView early:', error);
    }
  }

  async registerTaskBoardUI(): Promise<void> {
    if (this.commandRegistered) {
      return;
    }

    try {
      await this.registerViewEarly();
      this.config.plugin.addCommand({
        id: 'open-task-board',
        name: 'Open task board',
        callback: () => {
          void this.activateTaskBoardView();
        }
      });

      this.commandRegistered = true;
    } catch (error) {
      console.error('Failed to register task board UI:', error);
    }
  }

  async activateTaskBoardView(): Promise<void> {
    await openTaskBoardView(this.config.app, undefined, 'tab');
  }
}
