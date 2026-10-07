import type { LoadWorkspaceParameters, LoadWorkspaceResult } from '../../database/types/workspace/ParameterTypes';
import type { PreparedWorkflow, SessionWorkflowPort, ServiceResult } from '../instructions/types';
import { WorkflowPreparationService, type WorkflowPreparationBudget } from '../workflows/WorkflowPreparationService';

export type WorkspaceLoadValidation = (bundle: PreparedWorkflow | null, briefing: LoadWorkspaceResult) => Promise<ServiceResult<void>>;
export type PassiveWorkspaceReader = (params: LoadWorkspaceParameters) => Promise<LoadWorkspaceResult>;

/** Deliberate public activation shares the same success gate for every caller. */
export class WorkspaceLoadService {
  constructor(private readonly reader: PassiveWorkspaceReader, private readonly preparation: WorkflowPreparationService, private readonly activation: SessionWorkflowPort, private readonly validate?: WorkspaceLoadValidation) {}

  /** Internal refresh never changes bindings, usage, selection or last-access timestamps. */
  read(params: LoadWorkspaceParameters): Promise<LoadWorkspaceResult> { return this.reader(params); }

  async load(params: LoadWorkspaceParameters, budget?: WorkflowPreparationBudget): Promise<LoadWorkspaceResult> {
    const injected = params as LoadWorkspaceParameters & { sessionId?: unknown };
    const sessionId = injected.sessionId !== undefined ? injected.sessionId : params.context?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) return this.error('Workspace activation requires the canonical session ID from the execution context.');
    if (params.workflow !== undefined && (typeof params.workflow !== 'string' || !params.workflow.trim())) return this.error('Workflow must be a non-empty name or ID when --workflow is supplied.');
    const token = this.activation.begin(sessionId, params.workspace);
    const result = await this.read(params);
    if (!result.success) return result;
    const workspaceId = result.workspaceContext?.workspaceId;
    if (!workspaceId) return this.error('The workspace reader did not return its canonical workspace ID.', result);
    let bundle: PreparedWorkflow | null = null;
    if (params.workflow !== undefined) {
      const prepared = await this.preparation.prepare({ context: { workflows: result.data.workflowDefinitions ?? [] } }, params.workflow, budget);
      if (!prepared.ok) return this.error(prepared.error.message, result);
      bundle = prepared.value;
    }
    if (this.validate) {
      try {
        const validated = await this.validate(bundle, result);
        if (!validated.ok) return this.error(validated.error.message, result);
      } catch (error) { return this.error(error instanceof Error ? error.message : String(error), result); }
    }
    const committed = await this.activation.commit(sessionId, workspaceId, bundle, token);
    if (!committed.ok) return this.error(committed.error.message, result);
    let loadedWorkflow: LoadWorkspaceResult['data']['loadedWorkflow'] = null;
    if (bundle) {
      loadedWorkflow = { id: bundle.id, name: bundle.name, when: bundle.when, steps: bundle.steps, prompt: bundle.prompt,
        skills: bundle.skills, revision: bundle.revision, estimatedTokens: bundle.estimatedTokens, responseBytes: bundle.responseBytes };
    }
    return { ...result, data: { ...result.data, loadedWorkflow, preloadedTools: bundle?.preloadedTools ?? [], workflowActivation: { ...committed.value, workspaceId },
      // The bound workflow prompt is supplied once, inside the prepared bundle.
      ...(bundle?.prompt ? { prompt: undefined } : {}) } };
  }

  private error(message: string, result?: LoadWorkspaceResult): LoadWorkspaceResult {
    return { success: false, error: message, data: result?.data ?? { context: { name: 'Unknown', rootFolder: '', recentActivity: [message] }, workflows: [], workflowDefinitions: [], availableWorkflows: [], loadedWorkflow: null, preloadedTools: [], workspaceStructure: [], recentFiles: [], keyFiles: {}, preferences: '', sessions: [], states: [] } };
  }
}
