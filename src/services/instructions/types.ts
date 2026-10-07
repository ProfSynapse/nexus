import type { CliToolSchema } from '../../agents/toolManager/types';
import type { SkillRecord } from '../skills/types';

export interface SkillReference { provider: string; name: string }
export type InstructionReference = { type: 'prompt'; id: string } | ({ type: 'skill' } & SkillReference);
export type InstructionErrorCode = 'initializing' | 'unavailable' | 'not-found' | 'archived' | 'invalid' | 'ambiguous' | 'persistence' | 'superseded';
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: { code: InstructionErrorCode; message: string; reference?: InstructionReference; repairReferencesFrom?: SkillReference } };

export interface InstructionSummary {
  reference: InstructionReference;
  type: string;
  name: string;
  description: string;
  categories: string[];
  source: string;
  availability: 'available' | 'archived' | 'unavailable';
}
export interface PreparedInstruction {
  reference: InstructionReference;
  name: string;
  instructions: string;
  entrypointPath?: string;
  resourceRoot?: string;
  resources?: string[];
  toolSelectors: string[];
  contentHash: string;
}
export interface InstructionLibraryItemSettings { categories?: string[]; archived?: boolean }
export interface InstructionLibrarySettings {
  version: 1;
  items: Record<string, InstructionLibraryItemSettings>;
  skillArchiveImportComplete?: boolean;
}
export interface CoreSkillsSettings {
  version: 1;
  automaticImport: boolean;
  syncBackOnEdit: boolean;
  legacyMigrationComplete?: boolean;
}
export interface SkillAvailabilityPort {
  ensureLegacyArchiveImported(rows: readonly (SkillReference & { isArchived: boolean })[], queryReady: boolean): Promise<ServiceResult<void>>;
  isArchived(reference: SkillReference): boolean;
  setArchived(reference: SkillReference, archived: boolean): Promise<ServiceResult<void>>;
  transferIdentity(from: SkillReference, to: SkillReference): Promise<ServiceResult<void>>;
}
export interface SkillDetail {
  record: SkillRecord;
  reference: SkillReference;
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  entrypointPath: string;
  resourceRoot: string;
  resources: string[];
  toolSelectors: string[];
  contentHash: string;
  archived: boolean;
  declaredCategories: string[];
  previousReference?: SkillReference;
}
export interface SkillCreateInput {
  name: string;
  description: string;
  body?: string;
  source?: string;
  frontmatter?: Record<string, unknown>;
  toolSelectors?: string[];
}
export interface SkillUpdateInput {
  repairReferencesFrom?: SkillReference;
  description?: string;
  body?: string;
  rename?: string;
  frontmatter?: Record<string, unknown>;
  toolSelectors?: string[];
}
export interface SkillSyncResult {
  providers: string[];
  imported: string[];
  syncedBack: string[];
  skipped: string[];
  archived: string[];
  note?: string;
}
export interface InstructionSkillPort {
  list(options?: { search?: string; source?: string; includeArchived?: boolean }): Promise<ServiceResult<SkillRecord[]>>;
  prepareMany(references: readonly SkillReference[], options?: { recursive?: boolean }): Promise<ServiceResult<PreparedInstruction[]>>;
  getDetail(reference: SkillReference): Promise<ServiceResult<SkillDetail>>;
}
export interface InstructionSkillMutationPort extends InstructionSkillPort {
  create(input: SkillCreateInput): Promise<ServiceResult<SkillDetail>>;
  update(reference: SkillReference, input: SkillUpdateInput): Promise<ServiceResult<SkillDetail>>;
  archive(reference: SkillReference, archived: boolean): Promise<ServiceResult<SkillRecord>>;
  sync(options: { source?: string; direction: 'import' | 'sync-back' | 'both' }): Promise<ServiceResult<SkillSyncResult>>;
}
export interface InstructionPreparationPort {
  preparePrompt(id?: string, name?: string): Promise<ServiceResult<PreparedInstruction>>;
  prepareSkills(references: readonly SkillReference[]): Promise<ServiceResult<PreparedInstruction[]>>;
}
export interface ToolCatalogPort {
  resolve(selectors: readonly string[]): ServiceResult<CliToolSchema[]>;
}
export interface PreparedWorkflow {
  id: string;
  name: string;
  when: string;
  steps: string;
  prompt?: PreparedInstruction;
  skills: PreparedInstruction[];
  preloadedTools: CliToolSchema[];
  revision: string;
  estimatedTokens?: number;
  responseBytes?: number;
}
export interface WorkflowSelection { workspaceId: string; workflowId: string; revision: string }
export interface SessionWorkflowPort {
  begin(sessionId: string, workspaceId: string): number;
  commit(sessionId: string, workspaceId: string, bundle: PreparedWorkflow | null, token: number): Promise<ServiceResult<{ selection: WorkflowSelection | null; previousSelection: WorkflowSelection | null; activeSkills: string[] }>>;
  getSelection(sessionId: string): WorkflowSelection | null;
  restore(sessionId: string): Promise<ServiceResult<PreparedWorkflow | null>>;
  getActiveSkills(sessionId: string): string[];
  subscribe(listener: () => void): () => void;
}
