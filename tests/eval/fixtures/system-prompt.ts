/**
 * tests/eval/fixtures/system-prompt.ts — System prompts for eval scenarios.
 *
 * Uses the ACTUAL SystemPromptBuilder from production code. No hand-copied
 * prompt strings — the eval harness gets the same prompt users get.
 *
 * If the production prompt changes, the eval harness automatically picks it up.
 */

import { SystemPromptBuilder } from '../../../src/ui/chat/services/SystemPromptBuilder';
import type { SystemPromptOptions, ToolCatalogEntry } from '../../../src/ui/chat/services/SystemPromptBuilder';

/**
 * Default tool catalog — mirrors what the production agent registry exposes.
 * Source: CLAUDE.md "Available Agents" section + tool slugs from each agent.
 */
export const DEFAULT_TOOL_CATALOG: ToolCatalogEntry[] = [
  { agent: 'contentManager', tools: ['read', 'write', 'replace', 'insert', 'setProperty'] },
  { agent: 'storageManager', tools: ['list', 'createFolder', 'move', 'copy', 'archive', 'open'] },
  { agent: 'searchManager', tools: ['searchContent', 'searchDirectory', 'searchMemory'] },
  { agent: 'memoryManager', tools: ['createSession', 'loadSession', 'createWorkspace', 'createState'] },
  { agent: 'canvasManager', tools: ['read', 'write', 'update', 'list'] },
  { agent: 'taskManager', tools: ['createProject', 'listProjects', 'createTask', 'listTasks', 'updateTask'] },
  { agent: 'promptManager', tools: ['listModels', 'executePrompts', 'createPrompt', 'updatePrompt', 'deletePrompt', 'listPrompts', 'getPrompt', 'generateImage'] },
];

/**
 * Create a SystemPromptBuilder instance for eval use.
 * Uses stub callbacks since eval scenarios don't read real vault files.
 */
function createEvalPromptBuilder(): SystemPromptBuilder {
  // Stub: readNoteContent returns empty for eval (no vault)
  const readNoteContent = async (_path: string): Promise<string> => '';
  // Stub: loadWorkspace returns null
  const loadWorkspace = async (_id: string) => null;
  // Stub: no built-in docs workspace
  const getBuiltInDocsWorkspaceInfo = async () => null;

  return new SystemPromptBuilder(readNoteContent, loadWorkspace, getBuiltInDocsWorkspaceInfo);
}

/**
 * Build the production system prompt using the ACTUAL SystemPromptBuilder.
 * This is the same code path that runs when a user sends a message.
 */
export async function buildProductionSystemPrompt(options?: Partial<SystemPromptOptions>): Promise<string> {
  const builder = createEvalPromptBuilder();

  const promptOptions: SystemPromptOptions = {
    sessionId: options?.sessionId ?? 'eval_session_001',
    workspaceId: options?.workspaceId ?? 'default',
    toolCatalog: options?.toolCatalog ?? DEFAULT_TOOL_CATALOG,
    skipToolsSection: options?.skipToolsSection ?? false,
    ...options,
  };

  const prompt = await builder.build(promptOptions);
  return prompt ?? '';
}

/**
 * Get the default production system prompt (cached after first build).
 */
let _cachedDefaultPrompt: string | null = null;

export async function getDefaultSystemPrompt(): Promise<string> {
  if (_cachedDefaultPrompt === null) {
    _cachedDefaultPrompt = await buildProductionSystemPrompt();
  }
  return _cachedDefaultPrompt;
}

/**
 * Get the two-tool-only prompt (empty catalog forces getTools discovery).
 */
export async function getTwoToolOnlyPrompt(): Promise<string> {
  return await buildProductionSystemPrompt({ toolCatalog: [] });
}

// ---------------------------------------------------------------------------
// Synchronous exports for backward compatibility with YAML config resolution.
// These are populated by the eval.test.ts beforeAll() hook.
// ---------------------------------------------------------------------------

export let DEFAULT_SYSTEM_PROMPT = '';
export let MINIMAL_SYSTEM_PROMPT = 'You are a helpful assistant. Use the provided tools when the user asks for information. Always use tools rather than guessing. Call one tool at a time.';
export let TWO_TOOL_ONLY_SYSTEM_PROMPT = '';
export let ADVERSARIAL_SYSTEM_PROMPT = 'You are an assistant. You have some tools available. Use them if appropriate.';

/**
 * Initialize system prompts (call once in beforeAll).
 * Populates the synchronous exports with actual production prompt output.
 */
export async function initializeSystemPrompts(): Promise<void> {
  DEFAULT_SYSTEM_PROMPT = await getDefaultSystemPrompt();
  TWO_TOOL_ONLY_SYSTEM_PROMPT = await getTwoToolOnlyPrompt();
}
