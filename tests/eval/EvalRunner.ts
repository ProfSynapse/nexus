/**
 * tests/eval/EvalRunner.ts — Core scenario runner for the eval harness.
 *
 * Orchestrates scenario execution by wiring EvalToolExecutor into the real
 * StreamingOrchestrator. Mirrors the production flow exactly:
 *
 * Production: User sends ONE message → StreamingOrchestrator calls adapter →
 * model returns tool_calls → ToolContinuationService executes tools via
 * IToolExecutor → builds continuation → sends back to adapter → repeats
 * until model responds with text. ALL rounds happen within ONE
 * generateResponseStream() call.
 *
 * The YAML scenario format uses "turns" where:
 * - A turn WITH userMessage starts a new "exchange" (new generateResponseStream call)
 * - Turns WITHOUT userMessage are additional tool-call ROUNDS within the same exchange
 * - All mock responses for all rounds are registered BEFORE the streaming call
 * - The orchestrator's internal pingpong handles all rounds automatically
 *
 * Two-tool architecture support: When META_TOOLS are passed, the executor
 * intercepts getTools/useTools calls and handles them according to the
 * production two-tool pattern. Domain tools (NEXUS_TOOLS) are provided
 * to the executor for getTools schema responses.
 */

import { StreamingOrchestrator } from '../../src/services/llm/core/StreamingOrchestrator';
import type { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import type { ConversationMessage, StreamingOptions } from '../../src/services/llm/core/ProviderMessageBuilder';
import type { Tool } from '../../src/services/llm/adapters/types';
import type { LLMProviderSettings } from '../../src/types';
import { EvalToolExecutor } from './EvalToolExecutor';
import { LiveToolExecutor } from './LiveToolExecutor';
import { EvalAdapterRegistry } from './EvalAdapterRegistry';
import { NEXUS_TOOLS } from './fixtures/tools';
import { assertToolCalls, assertToolCallRounds, assertNoHallucinatedTools } from './assertions';
import type { IToolExecutor } from '../../src/services/llm/adapters/shared/ToolExecutionUtils';
import type {
  CapturedToolCall,
  EvalConfig,
  EvalScenario,
  EvalTurn,
  TurnResult,
  ScenarioResult,
} from './types';

interface ProviderEntry {
  id: string;
  apiKey: string;
  models: string[];
}

/**
 * Group scenario turns into "exchanges". Each exchange starts with a
 * userMessage turn, and subsequent turns without userMessage are additional
 * tool-call rounds within the same streaming response.
 *
 * Example:
 *   turn 0: userMessage="Read X, write Y, move Z"  → exchange 0, round 0
 *   turn 1: (no userMessage)                        → exchange 0, round 1
 *   turn 2: (no userMessage)                        → exchange 0, round 2
 *   turn 3: userMessage="Now delete it"             → exchange 1, round 0
 */
interface Exchange {
  userMessage: string;
  rounds: EvalTurn[];
}

function groupTurnsIntoExchanges(turns: EvalTurn[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;

  for (const turn of turns) {
    if (turn.userMessage) {
      // New exchange
      current = { userMessage: turn.userMessage, rounds: [turn] };
      exchanges.push(current);
    } else if (current) {
      // Additional round in current exchange
      current.rounds.push(turn);
    } else {
      // Turn without userMessage and no prior exchange — treat as standalone
      current = { userMessage: '', rounds: [turn] };
      exchanges.push(current);
    }
  }

  return exchanges;
}

/**
 * Run a single scenario against a single provider+model combination.
 */
export async function runScenario(
  scenario: EvalScenario,
  provider: ProviderEntry,
  model: string,
  tools: Tool[],
  config: EvalConfig
): Promise<ScenarioResult> {
  const startTime = Date.now();
  const temperature = scenario.temperature ?? config.defaults.temperature;
  const maxRetries = scenario.maxRetries ?? config.defaults.maxRetries;
  const systemPrompt = scenario.systemPrompt ?? config.defaults.systemPrompt;

  let lastError: string | undefined;
  let retryCount = 0;

  // Retry loop
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const turnResults = await executeScenario(
        scenario,
        provider,
        model,
        tools,
        systemPrompt,
        temperature,
        config
      );

      const allPassed = turnResults.every((t) => t.passed);

      if (allPassed || attempt === maxRetries) {
        return {
          scenario: scenario.name,
          description: scenario.description,
          provider: provider.id,
          model,
          passed: allPassed,
          turns: turnResults,
          totalDurationMs: Date.now() - startTime,
          retryCount,
          error: allPassed ? undefined : lastError,
        };
      }

      // Retry on failure
      retryCount++;
      lastError = turnResults
        .filter((t) => !t.passed)
        .flatMap((t) => t.errors)
        .join('; ');

      if (config.defaults.retryDelayMs > 0) {
        await delay(config.defaults.retryDelayMs);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      retryCount++;

      if (attempt === maxRetries) {
        return {
          scenario: scenario.name,
          description: scenario.description,
          provider: provider.id,
          model,
          passed: false,
          turns: [],
          totalDurationMs: Date.now() - startTime,
          retryCount,
          error: lastError,
        };
      }

      if (config.defaults.retryDelayMs > 0) {
        await delay(config.defaults.retryDelayMs);
      }
    }
  }

  return {
    scenario: scenario.name,
    description: scenario.description,
    provider: provider.id,
    model,
    passed: false,
    turns: [],
    totalDurationMs: Date.now() - startTime,
    retryCount,
    error: lastError ?? 'Unknown error',
  };
}

/**
 * Determine if the given tool set is the two-tool (meta) architecture.
 */
function isMetaToolSet(tools: Tool[]): boolean {
  const names = new Set(tools.map(t => t.function?.name));
  return names.has('getTools') && names.has('useTools');
}

/**
 * Build the set of valid tool names for hallucination checking.
 * For meta mode, includes both the meta tool names AND domain tool names,
 * since the executor captures inner domain calls from useTools unwrapping.
 */
function buildValidToolNames(tools: Tool[]): string[] {
  const names = tools.map(t => t.function?.name).filter(Boolean) as string[];
  if (isMetaToolSet(tools)) {
    // Also allow domain tool names — these appear in captured calls
    // when useTools unwraps inner calls
    const domainNames = NEXUS_TOOLS.map(t => t.function?.name).filter(Boolean) as string[];
    return [...names, ...domainNames];
  }
  return names;
}

/**
 * Execute a scenario by grouping turns into exchanges and running each
 * exchange as a single generateResponseStream() call — matching production.
 */
/**
 * Create and initialize the appropriate tool executor for the current mode.
 * - mock: EvalToolExecutor with registered mock responses
 * - live: LiveToolExecutor backed by real agents on a test vault
 */
async function createToolExecutor(
  config: EvalConfig,
  tools: Tool[],
  runId: string,
): Promise<{ executor: IToolExecutor & { getCapturedCalls(): CapturedToolCall[]; resetCalls(): void }; cleanup?: () => void }> {
  if (config.mode === 'live') {
    const path = await import('node:path');
    const testVaultRoot = path.resolve(config.testVaultPath || 'tests/eval/test-vault');
    const sanitizedRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const testVaultPath = path.join(testVaultRoot, sanitizedRunId);
    const liveExecutor = new LiveToolExecutor({ testVaultPath });
    await liveExecutor.initialize();
    return { executor: liveExecutor };
  }

  const mockExecutor = new EvalToolExecutor();
  if (isMetaToolSet(tools)) {
    mockExecutor.setDomainTools(NEXUS_TOOLS);
  }
  return { executor: mockExecutor };
}

async function executeScenario(
  scenario: EvalScenario,
  provider: ProviderEntry,
  model: string,
  tools: Tool[],
  systemPrompt: string,
  temperature: number,
  config: EvalConfig
): Promise<TurnResult[]> {
  const runId = `${provider.id}-${model.replace(/[\\/]/g, '_')}-${scenario.name}`;
  const { executor: toolExecutor } = await createToolExecutor(config, tools, runId);
  const adapter = await createAdapter(provider);
  const registry = new EvalAdapterRegistry([[provider.id, adapter]]);

  const settings: LLMProviderSettings = {
    providers: {
      [provider.id]: { apiKey: provider.apiKey, enabled: true },
    },
    defaultModel: { provider: provider.id, model },
  };

  const orchestrator = new StreamingOrchestrator(registry, settings, toolExecutor);
  const validToolNames = buildValidToolNames(tools);
  const turnResults: TurnResult[] = [];

  // Conversation history accumulates across exchanges (multi-message conversations)
  const conversationMessages: ConversationMessage[] = [];

  // Group turns into exchanges
  const exchanges = groupTurnsIntoExchanges(scenario.turns);

  for (const exchange of exchanges) {
    const exchangeStart = Date.now();

    // Register ALL mock responses for ALL rounds in this exchange upfront.
    // The orchestrator's internal pingpong will call the tool executor
    // multiple times — each time it needs the right response ready.
    toolExecutor.resetCalls(); // clear captured calls but keep any prior handlers
    if (config.mode === 'mock' && toolExecutor instanceof EvalToolExecutor) {
      for (const round of exchange.rounds) {
        if (round.mockResponses) {
          toolExecutor.registerTurnResponses(round.mockResponses);
        }
      }
    }

    // Add user message to conversation
    if (exchange.userMessage) {
      conversationMessages.push({
        role: 'user',
        content: exchange.userMessage,
      });
    }

    // ONE generateResponseStream call — the orchestrator handles ALL tool rounds
    // internally via ToolContinuationService pingpong. This is exactly how
    // production works: user sends message → streaming response with tool calls
    // → tool execution → continuation → more tool calls → ... → final text.
    const streamOptions: StreamingOptions = {
      provider: provider.id,
      model,
      systemPrompt,
      tools,
      temperature,
    };

    let textContent = '';

    try {
      const stream = orchestrator.generateResponseStream(
        [...conversationMessages],
        streamOptions
      );

      for await (const yield_ of stream) {
        if (yield_.chunk) {
          textContent += yield_.chunk;
        }
      }
    } catch (err) {
      // Stream error — record as failed turn
      const errMsg = err instanceof Error ? err.message : String(err);
      turnResults.push({
        turnIndex: turnResults.length,
        passed: false,
        expectedTools: exchange.rounds.flatMap(r => r.expectedTools),
        actualToolCalls: toolExecutor.getCapturedCalls(),
        textContent: '',
        errors: [`Stream error: ${errMsg}`],
        durationMs: Date.now() - exchangeStart,
      });
      continue;
    }

    // Collect ALL tool calls that happened during this exchange's streaming response
    const capturedCalls = toolExecutor.getCapturedCalls();

    // Assert tool calls match expectations.
    // When allowReorder is set, check that all expected tools appear anywhere
    // in the captured calls (unordered). Otherwise, enforce round-by-round order.
    const roundExpectations = exchange.rounds.map(r => r.expectedTools);
    const allExpected = exchange.rounds.flatMap(r => r.expectedTools);
    const roundAssertion = scenario.allowReorder
      ? assertToolCalls(allExpected, capturedCalls)
      : assertToolCallRounds(roundExpectations, capturedCalls);
    const hallucinationAssertion = assertNoHallucinatedTools(capturedCalls, validToolNames);

    const errors = [...roundAssertion.errors, ...hallucinationAssertion.errors];

    turnResults.push({
      turnIndex: turnResults.length,
      passed: errors.length === 0,
      expectedTools: exchange.rounds.flatMap(r => r.expectedTools),
      actualToolCalls: capturedCalls,
      textContent: textContent.trim(),
      errors,
      durationMs: Date.now() - exchangeStart,
    });

    // Append assistant response and tool call/result pairs to conversation
    // history for multi-turn fidelity.
    //
    // In production, each tool round is a separate assistant→tool message pair:
    //   assistant: {tool_calls: [getTools]}
    //   tool: {tool_call_id: "...", content: "schemas..."}
    //   assistant: {tool_calls: [useTools]}
    //   tool: {tool_call_id: "...", content: "result..."}
    //   assistant: {content: "Here's what I found..."}
    //
    // We approximate this by putting each captured call into its own
    // assistant→tool pair. This gives the model proper multi-round context.
    if (capturedCalls.length > 0) {
      for (const tc of capturedCalls) {
        // Assistant message with this tool call
        conversationMessages.push({
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          }],
        });

        // Tool result with matching tool_call_id (required by OpenAI API)
        conversationMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ success: true, name: tc.name }),
        } as ConversationMessage);
      }

      // Final assistant text response (if any)
      if (textContent.trim()) {
        conversationMessages.push({
          role: 'assistant',
          content: textContent.trim(),
        });
      }
    } else if (textContent.trim()) {
      // No tool calls — just text response
      conversationMessages.push({
        role: 'assistant',
        content: textContent.trim(),
      });
    }
  }

  return turnResults;
}

/**
 * Create an adapter for the given provider using dynamic imports.
 * Mirrors AdapterRegistry.initializeAdaptersAsync() — each provider
 * gets its own adapter class rather than routing everything through
 * OpenRouter.
 */
async function createAdapter(provider: ProviderEntry): Promise<BaseAdapter> {
  switch (provider.id) {
    case 'anthropic': {
      const { AnthropicAdapter } = await import('../../src/services/llm/adapters/anthropic/AnthropicAdapter');
      return new AnthropicAdapter(provider.apiKey);
    }
    case 'openai': {
      const { OpenAIAdapter } = await import('../../src/services/llm/adapters/openai/OpenAIAdapter');
      return new OpenAIAdapter(provider.apiKey);
    }
    case 'google': {
      const { GoogleAdapter } = await import('../../src/services/llm/adapters/google/GoogleAdapter');
      return new GoogleAdapter(provider.apiKey);
    }
    case 'mistral': {
      const { MistralAdapter } = await import('../../src/services/llm/adapters/mistral/MistralAdapter');
      return new MistralAdapter(provider.apiKey);
    }
    case 'groq': {
      const { GroqAdapter } = await import('../../src/services/llm/adapters/groq/GroqAdapter');
      return new GroqAdapter(provider.apiKey);
    }
    case 'perplexity': {
      const { PerplexityAdapter } = await import('../../src/services/llm/adapters/perplexity/PerplexityAdapter');
      return new PerplexityAdapter(provider.apiKey);
    }
    case 'requesty': {
      const { RequestyAdapter } = await import('../../src/services/llm/adapters/requesty/RequestyAdapter');
      return new RequestyAdapter(provider.apiKey);
    }
    case 'openrouter':
    default: {
      const { OpenRouterAdapter } = await import('../../src/services/llm/adapters/openrouter/OpenRouterAdapter');
      return new OpenRouterAdapter(provider.apiKey);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
