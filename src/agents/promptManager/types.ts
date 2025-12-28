import { CommonParameters, CommonResult, CustomPrompt } from '../../types';

// List Prompts Tool
export interface ListPromptsParams extends CommonParameters {
  enabledOnly?: boolean;
  includeArchived?: boolean;
}

export interface ListPromptsResult extends CommonResult {
  data: {
    prompts: Array<Pick<CustomPrompt, 'id' | 'name' | 'description' | 'isEnabled'>>;
    totalCount: number;
    enabledCount: number;
    message: string;
  };
}

// Get Prompt Tool
export interface GetPromptParams extends CommonParameters {
  id?: string;
  name?: string;
}

export interface GetPromptResult extends CommonResult {
  data: (CustomPrompt & { message: string }) | null;
}

// Create Prompt Tool
export interface CreatePromptParams extends CommonParameters {
  name: string;
  description: string;
  prompt: string;
  isEnabled?: boolean;
}

export interface CreatePromptResult extends CommonResult {
  data: CustomPrompt;
}

// Update Prompt Tool
export interface UpdatePromptParams extends CommonParameters {
  id: string;
  name?: string;
  description?: string;
  prompt?: string;
  isEnabled?: boolean;
}

export interface UpdatePromptResult extends CommonResult {
  data: CustomPrompt;
}

// Archive Prompt Tool
export interface ArchivePromptParams extends CommonParameters {
  name: string;
}

export interface ArchivePromptResult extends CommonResult {
  // Lean result - no data needed, LLM knows what it archived
}

// Delete Prompt Tool (deprecated - replaced by archivePrompt)
export interface DeletePromptParams extends CommonParameters {
  id: string;
}

export interface DeletePromptResult extends CommonResult {
  data: {
    deleted: boolean;
    id: string;
  };
}
