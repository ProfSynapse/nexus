import type { Plugin } from 'obsidian';
import type { Settings } from '../../settings';
import type { ConversationService } from '../ConversationService';
import type { WorkspaceService } from '../WorkspaceService';
import type { WorkflowSchedule } from '../../database/types/workspace/WorkspaceTypes';
import type { WorkflowRunService } from './WorkflowRunService';

export interface WorkflowScheduleServiceDeps {
  plugin: Plugin;
  settings: Settings;
  workspaceService: WorkspaceService;
  conversationService: ConversationService;
  workflowRunService: WorkflowRunService;
}

export class WorkflowScheduleService {
  private started = false;
  private stopped = false;
  private intervalId: number | null = null;
  private scanPromise: Promise<void> | null = null;
  private shutdownController = new AbortController();

  constructor(private deps: WorkflowScheduleServiceDeps) {
    // Fence saves immediately on unload, before asynchronous service teardown.
    deps.plugin.register(() => { void this.cleanup(); });
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) {
      return;
    }

    this.started = true;
    await this.scanDueWorkflows(true);
    if (this.stopped) return;

    this.intervalId = window.setInterval(() => {
      void this.scanDueWorkflows(false).catch(error => {
        if (!this.stopped) console.error('[WorkflowScheduleService] Scheduled scan failed:', error);
      });
    }, 60_000);
    this.deps.plugin.registerInterval(this.intervalId);
  }

  scanDueWorkflows(isStartup: boolean): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.runScan(isStartup).finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  async cleanup(): Promise<void> {
    this.stopped = true;
    this.shutdownController.abort();
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    await this.scanPromise?.catch(() => undefined);
  }

  private async runScan(isStartup: boolean): Promise<void> {
    const now = Date.now();

    try {
      const workspaces = await this.deps.workspaceService.getAllWorkspaces();
      if (this.stopped) return;
      const lastCheckAt = this.deps.settings.settings.workflowScheduler?.lastCheckAt;

      for (const workspace of workspaces) {
        if (workspace.isActive === false) {
          continue;
        }

        for (const workflow of workspace.context?.workflows || []) {
          const schedule = workflow.schedule;
          if (!schedule?.enabled) {
            continue;
          }

          const dueSlots = this.computeDueSlots(schedule, lastCheckAt, now);
          const runSlots = isStartup ? this.applyCatchUpPolicy(dueSlots, schedule) : dueSlots;

          for (const scheduledFor of runSlots) {
            if (this.stopped) return;
            const runKey = `${workspace.id}:${workflow.id}:${scheduledFor}`;
            if (await this.deps.conversationService.hasRunKey(runKey)) {
              continue;
            }
            if (this.stopped) return;

            await this.deps.workflowRunService.start({
              workspaceId: workspace.id,
              workflowId: workflow.id,
              runTrigger: isStartup && lastCheckAt ? 'catch_up' : 'scheduled',
              scheduledFor,
              runKey,
              openInChat: false
            });
          }
        }
      }
    } finally {
      if (!this.stopped) {
        await this.deps.settings.saveWorkflowSchedulerState(now, this.shutdownController.signal);
      }
    }
  }

  private computeDueSlots(schedule: WorkflowSchedule, lastCheckAt: number | undefined, now: number): number[] {
    if (!lastCheckAt) {
      return [];
    }

    switch (schedule.frequency) {
      case 'hourly':
        return this.computeHourlySlots(schedule, lastCheckAt, now);
      case 'daily':
        return this.computeDailySlots(schedule, lastCheckAt, now);
      case 'weekly':
        return this.computeWeeklySlots(schedule, lastCheckAt, now);
      case 'monthly':
        return this.computeMonthlySlots(schedule, lastCheckAt, now);
      default:
        return [];
    }
  }

  private applyCatchUpPolicy(dueSlots: number[], schedule: WorkflowSchedule): number[] {
    if (dueSlots.length === 0) {
      return [];
    }

    switch (schedule.catchUp) {
      case 'skip':
        return [];
      case 'latest':
        return [dueSlots[dueSlots.length - 1]];
      case 'all':
      default:
        return dueSlots;
    }
  }

  private computeHourlySlots(schedule: WorkflowSchedule, lastCheckAt: number, now: number): number[] {
    const intervalHours = Math.max(1, schedule.intervalHours || 1);
    const slots: number[] = [];
    const cursor = new Date(lastCheckAt);
    cursor.setMinutes(0, 0, 0);
    cursor.setHours(cursor.getHours() + 1);

    while (cursor.getTime() <= now) {
      if (cursor.getHours() % intervalHours === 0) {
        slots.push(cursor.getTime());
      }
      cursor.setHours(cursor.getHours() + 1);
    }

    return slots;
  }

  private computeDailySlots(schedule: WorkflowSchedule, lastCheckAt: number, now: number): number[] {
    return this.computeDayBasedSlots(schedule, lastCheckAt, now, () => true);
  }

  private computeWeeklySlots(schedule: WorkflowSchedule, lastCheckAt: number, now: number): number[] {
    const targetDay = schedule.dayOfWeek ?? 0;
    return this.computeDayBasedSlots(schedule, lastCheckAt, now, date => date.getDay() === targetDay);
  }

  private computeMonthlySlots(schedule: WorkflowSchedule, lastCheckAt: number, now: number): number[] {
    const slots: number[] = [];
    const cursor = new Date(lastCheckAt);
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);

    while (cursor.getTime() <= now) {
      const candidate = new Date(cursor);
      const lastDay = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
      candidate.setDate(Math.min(schedule.dayOfMonth || 1, lastDay));
      candidate.setHours(schedule.hour || 0, schedule.minute || 0, 0, 0);

      if (candidate.getTime() > lastCheckAt && candidate.getTime() <= now) {
        slots.push(candidate.getTime());
      }

      cursor.setMonth(cursor.getMonth() + 1);
    }

    return slots;
  }

  private computeDayBasedSlots(
    schedule: WorkflowSchedule,
    lastCheckAt: number,
    now: number,
    predicate: (date: Date) => boolean
  ): number[] {
    const slots: number[] = [];
    const cursor = new Date(lastCheckAt);
    cursor.setHours(0, 0, 0, 0);

    while (cursor.getTime() <= now) {
      if (predicate(cursor)) {
        const candidate = new Date(cursor);
        candidate.setHours(schedule.hour || 0, schedule.minute || 0, 0, 0);
        if (candidate.getTime() > lastCheckAt && candidate.getTime() <= now) {
          slots.push(candidate.getTime());
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return slots;
  }
}
