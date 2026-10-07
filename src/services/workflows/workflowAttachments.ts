import type { WorkspaceWorkflow } from '../../database/types/workspace/WorkspaceTypes';

/** Validate dependency data without looking up capabilities or executing commands. */
export function normalizeWorkflowAttachments(workflows: unknown): WorkspaceWorkflow[] {
  if (!Array.isArray(workflows)) throw new Error('Workflows must be an array.');
  return workflows.map((raw: unknown, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Workflow ${index + 1} must be an object.`);
    const value = raw as Record<string, unknown>;
    const next = { ...value };
    if (value.skills !== undefined) {
      if (!Array.isArray(value.skills)) throw new Error(`Workflow ${index + 1}: skills must be an array of provider/name references.`);
      const seen = new Set<string>();
      next.skills = value.skills.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Workflow ${index + 1}: invalid skill reference.`);
        const ref = item as Record<string, unknown>;
        if (typeof ref.provider !== 'string' || typeof ref.name !== 'string' || !safeSegment(ref.provider) || !safeSegment(ref.name)) {
          throw new Error(`Workflow ${index + 1}: each skill needs a safe provider and folder name.`);
        }
        return { provider: ref.provider, name: ref.name };
      }).filter(ref => {
        const key = JSON.stringify([ref.provider, ref.name]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
    }
    if (value.tools !== undefined) {
      if (!Array.isArray(value.tools)) throw new Error(`Workflow ${index + 1}: tools must be an array of selectors.`);
      next.tools = [...new Set(value.tools.map((selector: unknown) => {
        if (typeof selector !== 'string' || !/^[A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*)?$/.test(selector.trim())) {
          throw new Error(`Workflow ${index + 1}: use tool selectors such as "content read", without flags or arguments.`);
        }
        return selector.trim().replace(/\s+/g, ' ');
      }))];
    }
    return next as unknown as WorkspaceWorkflow;
  });
}

function safeSegment(value: string): boolean {
  return value.trim() === value && value.length > 0 && value !== '.' && value !== '..' && !/[\\/]/.test(value)
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export const WORKFLOW_ATTACHMENT_SCHEMA = {
  skills: {
    type: 'array', description: 'Exact provider and folder-name skill references to preload.',
    items: { type: 'object', properties: { provider: { type: 'string' }, name: { type: 'string' } }, required: ['provider', 'name'] }
  },
  tools: { type: 'array', description: 'Tool or agent selectors to preload, without flags or arguments.', items: { type: 'string' } }
};
