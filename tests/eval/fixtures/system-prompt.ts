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
 * Default tool catalog — the agent→tools list the production SystemPromptBuilder
 * renders into the prompt as "Available agents and tools".
 *
 * INVARIANT: every command here must have a matching tool in NEXUS_TOOLS
 * (fixtures/tools.ts). The prompt is the model's only statement of what exists;
 * anything advertised here that the executor cannot resolve is scored as a
 * hallucinated tool call, so the harness punishes a model for obeying its own
 * instructions. `nexus-model-eval/scripts/check_advertised_tools.py` enforces
 * the invariant — run it after editing either file.
 *
 * Membership rule (both conditions, or the entry does not belong here):
 *  1. The command exists in the production registry (cli-first-tool-schemas.json).
 *  2. Some scenario in tests/eval/scenarios/ could plausibly make a well-behaved
 *     model reach for it — either as the right answer or as a live misroute.
 *
 * Deliberately NOT advertised, and why:
 *  - memoryManager createSession/loadSession — REMOVED from production (see
 *    src/agents/memoryManager/types.ts). Advertising a tool the app does not
 *    have can never produce a transferable grade.
 *  - memoryManager createWorkspace/createState — real, but no scenario asks the
 *    model to persist workspace or session state, and nothing in the prompt
 *    tells it to. (`memory` in a useTools payload is the context field, not this
 *    agent.)
 *  - canvasManager (read/write/update/list) — real, but no scenario mentions a
 *    canvas, so a call here is a genuine invention and should grade as one.
 *  - promptManager (listModels/execute/create/update/list/get/generateImage) —
 *    real, but no scenario asks for prompt management or media generation.
 *    `deletePrompt` was never real at all: promptManager has `archive`, because
 *    the AI never gets a destructive delete.
 */
export const DEFAULT_TOOL_CATALOG: ToolCatalogEntry[] = [
  { agent: 'contentManager', tools: ['read', 'write', 'replace', 'insert', 'setProperty'] },
  { agent: 'storageManager', tools: ['list', 'createFolder', 'move', 'copy', 'archive', 'open'] },
  { agent: 'searchManager', tools: ['content', 'directory', 'memory'] },
  { agent: 'taskManager', tools: ['createProject', 'listProjects', 'create', 'list', 'update'] },
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
