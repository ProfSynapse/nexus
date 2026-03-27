import type { App, WorkspaceLeaf } from 'obsidian';

export const TASK_BOARD_VIEW_TYPE = 'nexus-task-board';

export type TaskBoardOpenMode = 'tab' | 'split' | 'current' | 'sidebar';

export interface TaskBoardViewState extends Record<string, unknown> {
  workspaceId?: string;
  projectId?: string;
  search?: string;
  sortField?: string;
  sortOrder?: string;
}

function normalizeTaskBoardState(state?: TaskBoardViewState): TaskBoardViewState {
  return {
    workspaceId: state?.workspaceId || '',
    projectId: state?.projectId || '',
    search: state?.search || '',
    sortField: state?.sortField || 'created',
    sortOrder: state?.sortOrder || 'asc'
  };
}

function resolveLeaf(app: App, mode: TaskBoardOpenMode): WorkspaceLeaf | null {
  switch (mode) {
    case 'current':
      return app.workspace.getLeaf(false);
    case 'split':
      return app.workspace.getLeaf('split');
    case 'sidebar':
      return app.workspace.getRightLeaf(false);
    case 'tab':
    default:
      return app.workspace.getLeavesOfType(TASK_BOARD_VIEW_TYPE)[0] || app.workspace.getLeaf('tab');
  }
}

export async function openTaskBoardView(
  app: App,
  state?: TaskBoardViewState,
  mode: TaskBoardOpenMode = 'tab'
): Promise<WorkspaceLeaf | null> {
  const leaf = resolveLeaf(app, mode);
  if (!leaf) {
    return null;
  }

  await leaf.setViewState({
    type: TASK_BOARD_VIEW_TYPE,
    active: true,
    state: normalizeTaskBoardState(state)
  });

  await app.workspace.revealLeaf(leaf);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  return leaf;
}
