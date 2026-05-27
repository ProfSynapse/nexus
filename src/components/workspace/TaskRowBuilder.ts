/**
 * TaskRowBuilder — pure helpers for converting a flat TaskMetadata[] into a
 * DFS-ordered, depth-annotated row list, plus shared display formatters.
 *
 * Extracted from WorkspaceDetailRenderer in Wave 3 PR2 Commit 2 so the
 * upcoming ProjectDetailRenderer can consume the same row-building +
 * formatting contract without re-importing the WorkspaceDetailRenderer
 * surface.
 */

import type { TaskMetadata, TaskPriority, TaskStatus } from '../../database/repositories/interfaces/ITaskRepository';

export interface TaskRowEntry {
    task: TaskMetadata;
    depth: number;
}

const STATUS_ORDER: Record<TaskStatus, number> = {
    todo: 0,
    in_progress: 1,
    done: 2,
    cancelled: 3
};

const PRIORITY_ORDER: Record<TaskPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3
};

export class TaskRowBuilder {
    /**
     * Build a flat, depth-annotated, DFS-ordered list of task rows.
     * Groups by `parentTaskId`; sorts each level by status, priority, then
     * `created` ascending.
     */
    static buildRows(tasks: TaskMetadata[]): TaskRowEntry[] {
        const children = new Map<string, TaskMetadata[]>();
        const roots: TaskMetadata[] = [];

        const sortTasks = (items: TaskMetadata[]) => items.sort((a, b) => {
            const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
            if (statusDiff !== 0) return statusDiff;

            const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
            if (priorityDiff !== 0) return priorityDiff;

            return a.created - b.created;
        });

        tasks.forEach(task => {
            if (task.parentTaskId) {
                const list = children.get(task.parentTaskId) || [];
                list.push(task);
                children.set(task.parentTaskId, list);
            } else {
                roots.push(task);
            }
        });

        sortTasks(roots);
        Array.from(children.values()).forEach(sortTasks);

        const rows: TaskRowEntry[] = [];
        const visit = (task: TaskMetadata, depth: number) => {
            rows.push({ task, depth });
            const childRows = children.get(task.id) || [];
            childRows.forEach(child => visit(child, depth + 1));
        };

        roots.forEach(task => visit(task, 0));
        return rows;
    }

    /**
     * Format a TaskStatus enum value for display
     * (e.g., 'in_progress' → 'In progress').
     */
    static formatStatus(status: TaskStatus): string {
        if (status === 'in_progress') return 'In progress';
        return status.charAt(0).toUpperCase() + status.slice(1);
    }

    /**
     * Format an optional timestamp for display ('—' if undefined; locale
     * date otherwise).
     */
    static formatDate(timestamp?: number): string {
        if (!timestamp) return '—';
        return new Date(timestamp).toLocaleDateString();
    }
}
