import { Events, EventRef } from 'obsidian';

export interface TaskBoardDataChangedEvent {
  workspaceId: string;
  entity: 'task' | 'project';
  action: 'created' | 'updated' | 'deleted' | 'moved' | 'archived';
  taskId?: string;
  projectId?: string;
}

class TaskBoardEventsImpl extends Events {
  onDataChanged(callback: (event: TaskBoardDataChangedEvent) => void): EventRef {
    return this.on('task-board:data-changed', callback as (...data: unknown[]) => unknown);
  }

  notify(event: TaskBoardDataChangedEvent): void {
    this.trigger('task-board:data-changed', event);
  }

  unsubscribe(ref: EventRef): void {
    this.offref(ref);
  }
}

export const TaskBoardEvents = new TaskBoardEventsImpl();
