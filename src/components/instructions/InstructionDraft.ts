import type { InstructionDetail } from '../../services/instructions/InstructionLibraryService';
import type { InstructionReference, SkillReference } from '../../services/instructions/types';

export interface InstructionDraft {
  type: 'prompt' | 'skill';
  reference?: InstructionReference;
  repairReferencesFrom?: SkillReference;
  name: string;
  description: string;
  body: string;
  categories: string[];
  toolSelectors: string[];
  frontmatter?: Record<string, unknown>;
}
export function draftInstruction(detail: InstructionDetail): InstructionDraft {
  if (detail.type === 'prompt') return { type: 'prompt', reference: detail.reference, name: detail.name, description: detail.description, body: detail.body, categories: [...detail.categories], toolSelectors: [] };
  const skill = detail.detail;
  return { type: 'skill', reference: { type: 'skill', ...skill.reference }, name: skill.name, description: skill.description, body: skill.body, categories: [...detail.categories], toolSelectors: [...skill.toolSelectors], frontmatter: skill.frontmatter };
}
export function newInstructionDraft(type: 'prompt' | 'skill'): InstructionDraft {
  return { type, name: '', description: '', body: '', categories: [], toolSelectors: [] };
}
