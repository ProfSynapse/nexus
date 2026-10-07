import type { Workspace } from '../../database/types/workspace/WorkspaceTypes';
import type { SessionContextManager } from '../SessionContextManager';
import type { PreparedWorkflow, ServiceResult, SessionWorkflowPort, SkillReference, WorkflowSelection } from '../instructions/types';

export interface SessionWorkflowServiceDeps {
  sessions: SessionContextManager;
  getWorkspace(id: string): Promise<Pick<Workspace, 'context'> | null>;
  prepare(workspace: Pick<Workspace, 'context'>, identifier: string): Promise<ServiceResult<PreparedWorkflow>>;
  recordLoaded?(references: readonly SkillReference[]): Promise<void>;
}

/** Explicit selection survives independently of trace context and run provenance. */
export class SessionWorkflowService implements SessionWorkflowPort {
  private generations = new Map<string, { token: number; workspaceId: string }>();
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(private readonly deps: SessionWorkflowServiceDeps) {}

  begin(sessionId: string, workspaceId: string): number {
    const token = (this.generations.get(sessionId)?.token ?? 0) + 1;
    this.generations.set(sessionId, { token, workspaceId });
    return token;
  }
  getSelection(sessionId: string): WorkflowSelection | null { return this.deps.sessions.getWorkflowSelection(sessionId); }
  getActiveSkills(sessionId: string): string[] { return this.deps.sessions.getActiveSkills(sessionId); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* A view cannot undo committed state. */ } } }

  async commit(sessionId: string, workspaceId: string, bundle: PreparedWorkflow | null, token: number): Promise<ServiceResult<{
    selection: WorkflowSelection | null; previousSelection: WorkflowSelection | null; activeSkills: string[];
  }>> {
    const current = () => !this.disposed && this.generations.get(sessionId)?.token === token;
    if (!sessionId || !workspaceId || !current()) return { ok: false, error: { code: 'superseded', message: 'This workspace load was superseded or its session is unavailable' } };
    await this.deps.sessions.ensureBindingsRestored();
    const previousSelection = this.getSelection(sessionId);
    const selection = bundle ? { workspaceId, workflowId: bundle.id, revision: bundle.revision } : null;
    const references = bundle?.skills.flatMap(skill => skill.reference.type === 'skill' ? [{ provider: skill.reference.provider, name: skill.reference.name }] : []) ?? [];
    const skills = references.map(ref => `${ref.provider}/${ref.name}`);
    const committed = await this.deps.sessions.commitWorkspaceWorkflow(sessionId, workspaceId, selection, skills, current);
    if (!committed.ok) return committed;
    if (references.length && this.deps.recordLoaded) {
      try { await this.deps.recordLoaded(references); } catch { /* Recency is best-effort. */ }
    }
    this.notify();
    return { ok: true, value: { selection, previousSelection, activeSkills: this.getActiveSkills(sessionId) } };
  }

  async restore(sessionId: string): Promise<ServiceResult<PreparedWorkflow | null>> {
    await this.deps.sessions.ensureBindingsRestored();
    const selection = this.getSelection(sessionId);
    if (!selection) return { ok: true, value: null };
    try {
      const workspace = await this.deps.getWorkspace(selection.workspaceId);
      if (!workspace) return { ok: false, error: { code: 'not-found', message: `Selected workflow workspace ${selection.workspaceId} is unavailable; load a workspace explicitly to clear it.` } };
      const result = await this.deps.prepare(workspace, selection.workflowId);
      if (!result.ok) return result;
      // A refresh is passive. It restores attribution but stamps no recency and
      // never derives a choice from workspace defaults or historical run IDs.
      const current = this.getSelection(sessionId);
      if (!this.disposed && current?.workflowId === selection.workflowId && current.workspaceId === selection.workspaceId && current.revision === selection.revision) {
        this.deps.sessions.setWorkflowManagedSkills(sessionId, result.value.skills.flatMap(skill => skill.reference.type === 'skill' ? [`${skill.reference.provider}/${skill.reference.name}`] : []));
        return result;
      }
      return { ok: false, error: { code: 'superseded', message: 'Selection changed while restoring workflow context' } };
    } catch (error) {
      return { ok: false, error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) } };
    }
  }
  cleanup(): void { this.disposed = true; this.generations.clear(); this.listeners.clear(); }
}
