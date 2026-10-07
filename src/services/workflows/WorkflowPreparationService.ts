import type { Workspace, WorkspaceWorkflow } from '../../database/types/workspace/WorkspaceTypes';
import type { InstructionPreparationPort, PreparedWorkflow, ServiceResult, ToolCatalogPort } from '../instructions/types';
import { fnv1aHex } from '../skills/skillHash';
import { normalizeWorkflowAttachments } from './workflowAttachments';

/** A response ceiling, not a promise that an external model has this much remaining context. */
export const MAX_PREPARED_WORKFLOW_BYTES = 1024 * 1024;
export interface WorkflowPreparationBudget { maxBytes?: number; maxTokens?: number; maxEstimatedTokens?: number }
export interface WorkflowBundleSize { bytes: number; characters: number; estimatedTokens: number }

export class WorkflowPreparationService {
  constructor(private readonly instructions: InstructionPreparationPort, private readonly catalog: ToolCatalogPort) {}

  resolve(workspace: Pick<Workspace, 'context'>, identifier: string): ServiceResult<WorkspaceWorkflow> {
    if (typeof identifier !== 'string' || !identifier.trim()) return { ok: false, error: { code: 'invalid', message: 'Workflow must be a non-empty name or ID.' } };
    const workflows = workspace.context?.workflows ?? [];
    if (!Array.isArray(workflows)) return { ok: false, error: { code: 'invalid', message: 'Workspace workflows must be an array.' } };
    const byId = workflows.find(item => item && item.id === identifier);
    const matches = byId ? [byId] : workflows.filter(item => item && typeof item.name === 'string' && item.name.toLocaleLowerCase() === identifier.trim().toLocaleLowerCase());
    if (matches.length > 1) return { ok: false, error: { code: 'ambiguous', message: `More than one workflow is named "${identifier}". Select its ID.` } };
    if (!matches.length) return { ok: false, error: { code: 'not-found', message: `Workflow "${identifier}" was not found in this workspace. Choose one of its listed workflows.` } };
    const selected = matches[0];
    if (typeof selected.id !== 'string' || !selected.id.trim() || typeof selected.name !== 'string' || typeof selected.steps !== 'string' || typeof selected.when !== 'string') {
      return { ok: false, error: { code: 'invalid', message: `Workflow "${identifier}" has an invalid definition. Edit its name, instructions and trigger.` } };
    }
    try { return { ok: true, value: normalizeWorkflowAttachments([selected])[0] }; }
    catch (error) { return { ok: false, error: { code: 'invalid', message: error instanceof Error ? error.message : String(error) } }; }
  }

  async prepare(workspace: Pick<Workspace, 'context'>, identifier: string, budget: WorkflowPreparationBudget = {}): Promise<ServiceResult<PreparedWorkflow>> {
    const resolved = this.resolve(workspace, identifier);
    if (!resolved.ok) return resolved;
    return this.prepareDefinition(resolved.value, budget);
  }

  async prepareDefinition(definition: WorkspaceWorkflow, budget: WorkflowPreparationBudget = {}): Promise<ServiceResult<PreparedWorkflow>> {
    const resolved = this.resolve({ context: { workflows: [definition] } }, definition.id);
    if (!resolved.ok) return resolved;
    const workflow = resolved.value;
    try {
      let prompt: PreparedWorkflow['prompt'];
      if (workflow.promptId !== undefined || workflow.promptName !== undefined) {
        if ((workflow.promptId !== undefined && (typeof workflow.promptId !== 'string' || !workflow.promptId.trim()))
          || (workflow.promptName !== undefined && (typeof workflow.promptName !== 'string' || !workflow.promptName.trim()))) {
          return { ok: false, error: { code: 'invalid', message: `Workflow "${workflow.name}" has an empty or invalid prompt binding.` } };
        }
        const result = await this.instructions.preparePrompt(workflow.promptId, workflow.promptName);
        if (!result.ok) return result;
        prompt = result.value;
      }
      const preparedSkills = workflow.skills?.length ? await this.instructions.prepareSkills(workflow.skills) : { ok: true as const, value: [] };
      if (!preparedSkills.ok) return preparedSkills;
      const selectors = [...new Set([...(workflow.tools ?? []), ...preparedSkills.value.flatMap(skill => skill.toolSelectors)])];
      const tools = selectors.length ? this.catalog.resolve(selectors) : { ok: true as const, value: [] };
      if (!tools.ok) return tools;
      const content = { id: workflow.id, name: workflow.name, when: workflow.when, steps: workflow.steps, ...(prompt ? { prompt } : {}), skills: preparedSkills.value, preloadedTools: tools.value };
      const bundle: PreparedWorkflow = { ...content, revision: fnv1aHex(JSON.stringify(content)) };
      let size = this.measure(bundle);
      // Estimate fields themselves consume a few bytes; settle their digit widths.
      for (let iteration = 0; iteration < 6; iteration++) {
        bundle.estimatedTokens = size.estimatedTokens;
        bundle.responseBytes = size.bytes;
        const measured = this.measure(bundle);
        if (measured.bytes === size.bytes && measured.estimatedTokens === size.estimatedTokens) break;
        size = measured;
      }
      const maxBytes = Math.min(budget.maxBytes ?? MAX_PREPARED_WORKFLOW_BYTES, MAX_PREPARED_WORKFLOW_BYTES);
      const maxTokens = budget.maxTokens ?? budget.maxEstimatedTokens;
      if (!Number.isFinite(maxBytes) || maxBytes < 0 || (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens < 0))) {
        return { ok: false, error: { code: 'invalid', message: 'Workflow context budget must be a finite non-negative number.' } };
      }
      if (size.bytes > maxBytes || (maxTokens !== undefined && size.estimatedTokens > maxTokens)) {
        return { ok: false, error: { code: 'invalid', message: `Workflow "${workflow.name}" needs approximately ${size.estimatedTokens} tokens (${size.bytes} bytes); its context budget is ${maxTokens ?? 'external model unknown'} tokens and ${maxBytes} bytes. Reduce the selected instructions/tools or choose a larger model context.` } };
      }
      return { ok: true, value: bundle };
    } catch (error) {
      return { ok: false, error: { code: 'unavailable', message: `Workflow "${workflow.name}" could not be prepared: ${error instanceof Error ? error.message : String(error)}` } };
    }
  }

  measure(bundle: PreparedWorkflow): WorkflowBundleSize {
    const json = JSON.stringify(bundle);
    return { bytes: new TextEncoder().encode(json).length, characters: json.length, estimatedTokens: Math.ceil(json.length / 4) };
  }
}
