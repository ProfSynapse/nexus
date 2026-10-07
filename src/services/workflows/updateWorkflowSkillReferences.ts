import type { WorkspaceService } from '../WorkspaceService';
import type { ServiceResult, SkillReference } from '../instructions/types';

/** A rename changes explicit references, never a historical name alias. */
export async function updateWorkflowSkillReferences(
  workspaces: Pick<WorkspaceService, 'listWorkspaceDiscovery' | 'getWorkspace' | 'updateWorkspace'>,
  from: SkillReference,
  to: SkillReference
): Promise<ServiceResult<void>> {
  const failures: string[] = [];
  const matches = (ref: SkillReference) => ref.provider === from.provider && ref.name === from.name;
  try {
    const candidates = await workspaces.listWorkspaceDiscovery();
    for (const candidate of candidates) {
      if (!candidate.context?.workflows?.some(workflow => workflow.skills?.some(matches))) continue;
      try {
        // Read current definitions before writing so unrelated edits are retained.
        const current = await workspaces.getWorkspace(candidate.id);
        if (!current) throw new Error('Workspace is no longer available');
        const workflows = current.context?.workflows;
        if (!workflows?.some(workflow => workflow.skills?.some(matches))) continue;
        await workspaces.updateWorkspace(candidate.id, { context: { ...current.context,
          workflows: workflows.map(workflow => ({ ...workflow,
            ...(workflow.skills ? { skills: workflow.skills.map(ref => matches(ref) ? { ...to } : ref) } : {}) })) } });
      } catch (error) {
        failures.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return failures.length ? { ok: false, error: { code: 'persistence',
    message: `Skill renamed to ${to.provider}/${to.name}, but some workflow attachments could not be updated: ${failures.join('; ')}`,
    reference: { type: 'skill', ...to } } } : { ok: true, value: undefined };
}
