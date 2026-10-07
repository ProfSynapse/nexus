import type { ProjectWorkspace, WorkspaceWorkflow } from '../../database/types/workspace/WorkspaceTypes';
import type { SkillReference } from '../instructions/types';

export interface WorkflowSummary {
  id: string;
  name: string;
  when: string;
  promptName?: string;
  skills: SkillReference[];
  skillCount: number;
  skillsTruncated: boolean;
  tools: string[];
  toolCount: number;
  toolsTruncated: boolean;
  loadCommand: string;
}
export interface WorkspaceDiscoverySummary {
  id: string;
  name: string;
  description?: string;
  workflows: WorkflowSummary[];
  workflowCount: number;
  workflowsTruncated: boolean;
}
export type WorkspaceDiscoveryResult =
  | { status: 'ready'; workspaces: WorkspaceDiscoverySummary[] }
  | { status: 'initializing' | 'unavailable'; workspaces: WorkspaceDiscoverySummary[]; message: string };

/** Double quoted Nexus CLI literal: also inert when pasted into a POSIX shell. */
export function quoteWorkflowCliLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

export const WORKSPACE_SUMMARY_LIMITS = { workflows: 8, skills: 8, tools: 8, descriptionCharacters: 300, triggerCharacters: 200, nameCharacters: 120 };

/** No session/state/file/skill reads: discovery only projects workspace metadata. */
export class WorkspaceSummaryService {
  constructor(private readonly limits = WORKSPACE_SUMMARY_LIMITS) {}

  summarize(workspace: ProjectWorkspace, fullWorkflows = false): WorkspaceDiscoverySummary {
    const definitions = workspace.context?.workflows;
    const workflows = Array.isArray(definitions) ? definitions.filter(workflow => this.isWorkflow(workflow)) : [];
    const selected = fullWorkflows ? workflows : workflows.slice(0, this.limits.workflows);
    const description = workspace.description ?? workspace.context?.purpose;
    return { id: workspace.id, name: workspace.name,
      ...(description ? { description: description.slice(0, this.limits.descriptionCharacters) } : {}),
      workflows: selected.map(workflow => {
        const skills = Array.isArray(workflow.skills) ? workflow.skills.filter(ref => ref && typeof ref.provider === 'string' && typeof ref.name === 'string') : [];
        const tools = Array.isArray(workflow.tools) ? workflow.tools.filter((value): value is string => typeof value === 'string') : [];
        return { id: workflow.id, name: fullWorkflows ? workflow.name : workflow.name.slice(0, this.limits.nameCharacters), when: workflow.when.slice(0, this.limits.triggerCharacters),
          ...(workflow.promptName ? { promptName: workflow.promptName.slice(0, this.limits.nameCharacters) } : {}),
          // Response serialization tracks object identities globally: summary
          // refs must not alias the full definitions included in the same load.
          skills: (fullWorkflows ? skills : skills.slice(0, this.limits.skills)).map(ref => ({ provider: ref.provider, name: ref.name })), skillCount: skills.length,
          skillsTruncated: !fullWorkflows && skills.length > this.limits.skills,
          tools: fullWorkflows ? tools : tools.slice(0, this.limits.tools).map(tool => tool.slice(0, this.limits.nameCharacters)), toolCount: tools.length,
          toolsTruncated: !fullWorkflows && tools.length > this.limits.tools,
          loadCommand: `memory load-workspace ${quoteWorkflowCliLiteral(workspace.id)} --workflow ${quoteWorkflowCliLiteral(workflow.id)}` };
      }), workflowCount: workflows.length, workflowsTruncated: selected.length < workflows.length };
  }

  summarizeMany(workspaces: readonly ProjectWorkspace[]): WorkspaceDiscoverySummary[] {
    return workspaces.map(workspace => this.summarize(workspace));
  }

  private isWorkflow(workflow: WorkspaceWorkflow): boolean {
    return !!workflow && typeof workflow.id === 'string' && typeof workflow.name === 'string' && typeof workflow.when === 'string';
  }
}
