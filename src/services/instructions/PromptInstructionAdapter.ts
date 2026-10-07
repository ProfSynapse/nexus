import type { CustomPrompt } from '../../types';
import type { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import { fnv1aHex } from '../skills/skillHash';
import type { PreparedInstruction, ServiceResult } from './types';

export type PromptInstructionStorage = Pick<CustomPromptStorageService, 'getAllPrompts' | 'createPrompt' | 'updatePrompt'>;

/** Existing prompt storage and IDs remain authoritative; workflow lookup is deliberately strict. */
export class PromptInstructionAdapter {
  constructor(readonly storage: PromptInstructionStorage) {}

  resolve(id?: string, name?: string): ServiceResult<CustomPrompt> {
    const prompts = this.storage.getAllPrompts();
    let prompt: CustomPrompt | undefined;
    if (id !== undefined) prompt = prompts.find(item => item.id === id);
    else if (name?.trim()) {
      const identifier = name.trim();
      prompt = prompts.find(item => item.id === identifier);
      if (!prompt) {
        const matches = prompts.filter(item => item.name.toLocaleLowerCase() === identifier.toLocaleLowerCase());
        if (matches.length > 1) return { ok: false, error: { code: 'ambiguous', message: `More than one prompt is named "${identifier}". Select its ID.` } };
        prompt = matches[0];
      }
    }
    if (!prompt) return { ok: false, error: { code: 'not-found', message: `Prompt "${id ?? name ?? ''}" was not found.` } };
    return { ok: true, value: prompt };
  }

  prepare(id?: string, name?: string): ServiceResult<PreparedInstruction> {
    const resolved = this.resolve(id, name);
    if (!resolved.ok) return resolved;
    const prompt = resolved.value;
    const reference = { type: 'prompt' as const, id: prompt.id };
    if (!prompt.isEnabled) return { ok: false, error: { code: 'archived', message: `Prompt "${prompt.name}" is archived.`, reference } };
    return { ok: true, value: { reference, name: prompt.name, instructions: prompt.prompt, toolSelectors: [], contentHash: fnv1aHex(prompt.prompt) } };
  }
}
