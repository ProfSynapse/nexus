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

import * as fs from 'node:fs';
import * as path from 'node:path';
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

interface RetryDecision {
  retryable: boolean;
  reason: string;
}

interface EvalTrace {
  path: string;
  write(event: string, data?: Record<string, unknown>): void;
}

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const RETRYABLE_ERROR_PATTERNS = [
  /\b408\b/,
  /\b409\b/,
  /\b425\b/,
  /\b429\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /rate limit/i,
  /too many requests/i,
  /server error/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /timeout/i,
  /timed out/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /eai_again/i,
  /enotfound/i,
  /socket hang up/i,
  /network error/i,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const candidates = [
    error.status,
    error.statusCode,
    error.code,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number') {
      return candidate;
    }
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
      return Number(candidate);
    }
  }

  const response = error.response;
  if (isRecord(response)) {
    const responseStatus = response.status ?? response.statusCode;
    if (typeof responseStatus === 'number') {
      return responseStatus;
    }
    if (typeof responseStatus === 'string' && /^\d+$/.test(responseStatus)) {
      return Number(responseStatus);
    }
  }

  return undefined;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }

  return String(error);
}

export function isRetryableEvalError(error: unknown): boolean {
  const statusCode = readStatusCode(error);
  if (statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode)) {
    return true;
  }

  const message = readErrorMessage(error);
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function calculateRetryDelayMs(attemptIndex: number, config: EvalConfig): number {
  const baseDelayMs = Math.max(0, config.defaults.retryDelayMs);
  if (baseDelayMs === 0) {
    return 0;
  }

  const multiplier = Math.max(1, config.defaults.retryBackoffMultiplier);
  const maxDelayMs = Math.max(baseDelayMs, config.defaults.retryMaxDelayMs);
  const delayMs = baseDelayMs * Math.pow(multiplier, attemptIndex);

  return Math.min(delayMs, maxDelayMs);
}

export function calculateMaxRetryDelayMs(maxRetries: number, config: EvalConfig): number {
  let totalDelayMs = 0;
  for (let attemptIndex = 0; attemptIndex < maxRetries; attemptIndex++) {
    totalDelayMs += calculateRetryDelayMs(attemptIndex, config);
  }
  return totalDelayMs;
}

function collectTurnErrors(turnResults: TurnResult[]): string[] {
  return turnResults
    .filter((turn) => !turn.passed)
    .flatMap((turn) => turn.errors);
}

function getRetryDecisionForTurnResults(turnResults: TurnResult[]): RetryDecision | null {
  const errors = collectTurnErrors(turnResults);
  if (errors.length === 0) {
    return null;
  }

  const streamErrors = errors.filter((error) => error.startsWith('Stream error:'));
  if (streamErrors.length > 0) {
    const retryableStreamError = streamErrors.find((error) => isRetryableEvalError(error));
    if (retryableStreamError) {
      return {
        retryable: true,
        reason: retryableStreamError,
      };
    }

    if (streamErrors.length === errors.length) {
      return {
        retryable: false,
        reason: streamErrors.join('; '),
      };
    }
  }

  return {
    retryable: true,
    reason: errors.join('; '),
  };
}

function inferSeedFiles(scenario: EvalScenario): Record<string, string> {
  const seedFiles: Record<string, string> = {
    ...(scenario.seedFiles ?? {}),
  };

  for (const turn of scenario.turns) {
    const candidatePaths = extractMarkdownPaths(turn.userMessage ?? '');
    for (const response of Object.values(turn.mockResponses ?? {})) {
      collectSeedFilesFromValue(response.result, seedFiles, candidatePaths);
    }
  }

  return seedFiles;
}

function collectSeedFilesFromValue(
  value: unknown,
  seedFiles: Record<string, string>,
  candidatePaths: string[],
): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSeedFilesFromValue(entry, seedFiles, candidatePaths);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && typeof record.content === 'string') {
    seedFiles[record.path] = record.content;
  } else if (typeof record.content === 'string' && candidatePaths.length > 0) {
    seedFiles[candidatePaths[0]] ??= record.content;
  }

  for (const child of Object.values(record)) {
    collectSeedFilesFromValue(child, seedFiles, candidatePaths);
  }
}

function extractMarkdownPaths(value: string): string[] {
  return value.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.md/g) ?? [];
}

function createTrace(runId: string, config: EvalConfig): EvalTrace | undefined {
  if (process.env.EVAL_TRACE_STREAM !== '1') {
    return undefined;
  }

  const traceDir = path.resolve(process.cwd(), config.capture.artifactsDir, 'traces');
  fs.mkdirSync(traceDir, { recursive: true });

  const safeRunId = sanitizeFilePart(runId);
  const tracePath = path.join(traceDir, `eval-trace-${safeRunId}-${Date.now()}.jsonl`);

  return {
    path: tracePath,
    write(event: string, data: Record<string, unknown> = {}) {
      fs.appendFileSync(
        tracePath,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event,
          ...data,
        }) + '\n',
        'utf-8'
      );
    },
  };
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
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
  const runId = `${provider.id}-${model.replace(/[\\/]/g, '_')}-${scenario.name}`;
  const trace = createTrace(runId, config);
  const temperature = scenario.temperature ?? config.defaults.temperature;
  const maxRetries = scenario.maxRetries ?? config.defaults.maxRetries;
  const systemPrompt = scenario.systemPrompt ?? config.defaults.systemPrompt;

  let lastError: string | undefined;
  let retryCount = 0;
  let lastTurnResults: TurnResult[] = [];

  trace?.write('scenario_start', {
    scenario: scenario.name,
    description: scenario.description,
    provider: provider.id,
    model,
    mode: config.mode,
    maxRetries,
  });

  // Retry loop
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    trace?.write('attempt_start', { attempt });

    try {
      const turnResults = await executeScenario(
        scenario,
        provider,
        model,
        tools,
        systemPrompt,
        temperature,
        config,
        trace
      );

      const allPassed = turnResults.every((t) => t.passed);
      lastTurnResults = turnResults;

      if (allPassed) {
        return {
          scenario: scenario.name,
          description: scenario.description,
          provider: provider.id,
          model,
          passed: true,
          turns: turnResults,
          totalDurationMs: Date.now() - startTime,
          retryCount,
          tracePath: trace?.path,
        };
      }

      const retryDecision = getRetryDecisionForTurnResults(turnResults);
      lastError = retryDecision?.reason;

      if (attempt === maxRetries || retryDecision?.retryable === false) {
        return {
          scenario: scenario.name,
          description: scenario.description,
          provider: provider.id,
          model,
          passed: false,
          turns: turnResults,
          totalDurationMs: Date.now() - startTime,
          retryCount,
          error: lastError,
          tracePath: trace?.path,
        };
      }

      retryCount++;
      const delayMs = calculateRetryDelayMs(attempt, config);
      trace?.write('retry_scheduled', {
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        reason: lastError,
      });
      await delay(delayMs);
    } catch (err) {
      lastError = readErrorMessage(err);
      trace?.write('attempt_error', {
        attempt,
        retryable: isRetryableEvalError(err),
        error: lastError,
      });

      if (attempt === maxRetries || !isRetryableEvalError(err)) {
        return {
          scenario: scenario.name,
          description: scenario.description,
          provider: provider.id,
          model,
          passed: false,
          turns: lastTurnResults,
          totalDurationMs: Date.now() - startTime,
          retryCount,
          error: lastError,
          tracePath: trace?.path,
        };
      }

      retryCount++;
      const delayMs = calculateRetryDelayMs(attempt, config);
      trace?.write('retry_scheduled', {
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        reason: lastError,
      });
      await delay(delayMs);
    }
  }

  return {
    scenario: scenario.name,
    description: scenario.description,
    provider: provider.id,
    model,
    passed: false,
    turns: lastTurnResults,
    totalDurationMs: Date.now() - startTime,
    retryCount,
    error: lastError ?? 'Unknown error',
    tracePath: trace?.path,
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
  scenario: EvalScenario,
): Promise<{ executor: IToolExecutor & { getCapturedCalls(): CapturedToolCall[]; resetCalls(): void }; cleanup?: () => void }> {
  if (config.mode === 'live') {
    const path = await import('node:path');
    const testVaultRoot = path.resolve(config.testVaultPath || 'tests/eval/test-vault');
    const sanitizedRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const testVaultPath = path.join(testVaultRoot, sanitizedRunId);
    const liveExecutor = new LiveToolExecutor({ testVaultPath });
    await liveExecutor.reset(inferSeedFiles(scenario));
    return { executor: liveExecutor };
  }

  const mockExecutor = new EvalToolExecutor();
  if (isMetaToolSet(tools)) {
    mockExecutor.setDomainTools(NEXUS_TOOLS);
  }
  // Must be set before registerTurnResponses so registrations route to the
  // per-round FIFO queue rather than the last-write-wins map.
  if (scenario.sequentialMockResponses === true) {
    mockExecutor.setSequentialResponses(true);
  }
  // Enforce the production context contract (recovery testing) when the scenario
  // opts in, or globally via EVAL_ENFORCE_CONTEXT=1 (handy for probing whether a
  // model that omits memory/goal can self-correct on the existing scenarios).
  if (scenario.enforceContextContract === true || process.env.EVAL_ENFORCE_CONTEXT === '1') {
    mockExecutor.setEnforceContextContract(true);
  }
  if (typeof scenario.forceContextSteering === 'number' && scenario.forceContextSteering > 0) {
    mockExecutor.setForceContextSteering(scenario.forceContextSteering);
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
  config: EvalConfig,
  trace?: EvalTrace
): Promise<TurnResult[]> {
  const runId = `${provider.id}-${model.replace(/[\\/]/g, '_')}-${scenario.name}`;
  const { executor: toolExecutor } = await createToolExecutor(config, tools, runId, scenario);
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
    const turnIndex = turnResults.length;

    trace?.write('exchange_start', {
      turnIndex,
      userMessage: exchange.userMessage,
      expectedTools: exchange.rounds.flatMap((round) => round.expectedTools),
    });

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
      trace?.write('user_message', {
        turnIndex,
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
      onToolEvent: (event, data) => {
        trace?.write('tool_event', {
          turnIndex,
          toolEvent: event,
          data: data as Record<string, unknown>,
        });
      },
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
          trace?.write('stream_chunk', {
            turnIndex,
            chunk: yield_.chunk,
          });
        }

        if (yield_.reasoning) {
          trace?.write('stream_reasoning', {
            turnIndex,
            reasoning: yield_.reasoning,
            reasoningComplete: yield_.reasoningComplete,
          });
        }

        if (yield_.toolCalls && yield_.toolCalls.length > 0) {
          trace?.write('stream_tool_calls', {
            turnIndex,
            toolCalls: yield_.toolCalls,
            toolCallsReady: yield_.toolCallsReady,
          });
        }
      }
    } catch (err) {
      // Stream error — record as failed turn
      const errMsg = err instanceof Error ? err.message : String(err);
      trace?.write('stream_error', {
        turnIndex,
        error: errMsg,
        capturedCalls: toolExecutor.getCapturedCalls(),
      });
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
    trace?.write('captured_calls', {
      turnIndex,
      capturedCalls,
      textContent,
    });

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

    // Context-contract recovery grading. If enforcement steered the model
    // (incomplete memory/goal), report whether it recovered within the allowed
    // rounds. Non-recovery already fails the round assertion (no valid call was
    // ever executed); this just gives a clearer, dedicated reason.
    if (config.mode === 'mock' && toolExecutor instanceof EvalToolExecutor) {
      const ctx = toolExecutor.getContextContractStats();
      if (ctx.enforced && ctx.steeringErrors > 0) {
        const maxRecovery = scenario.maxRecoveryRounds ?? 3;
        if (!ctx.recovered) {
          errors.push(
            `Context-contract: received ${ctx.steeringErrors} steering error(s) for an incomplete context block (empty memory/goal) and never re-issued a valid useTools call — no recovery.`
          );
        } else if (ctx.steeringErrors > maxRecovery) {
          errors.push(
            `Context-contract: recovered, but only after ${ctx.steeringErrors} steering errors (max ${maxRecovery}).`
          );
        }
        trace?.write('context_recovery', {
          turnIndex,
          steeringErrors: ctx.steeringErrors,
          recovered: ctx.recovered,
          maxRecovery,
        });
      }
    }

    trace?.write('assertion_result', {
      turnIndex,
      passed: errors.length === 0,
      errors,
      expectedTools: exchange.rounds.flatMap(r => r.expectedTools),
      actualToolCalls: capturedCalls,
      textContent: textContent.trim(),
    });

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
    case 'ollama': {
      // Ollama's OpenAI-compatible endpoint (/v1/chat/completions). The Nexus
      // OllamaAdapter is text-only (supportsFunctions: false), so reuse the
      // LMStudioAdapter — keyless, posts to `${serverUrl}/v1/chat/completions`,
      // and parses tool calls (native + [TOOL_CALLS]/XML fallbacks). Override
      // the host with OLLAMA_BASE_URL.
      const { LMStudioAdapter } = await import('../../src/services/llm/adapters/lmstudio/LMStudioAdapter');
      return new LMStudioAdapter(process.env.OLLAMA_BASE_URL || 'http://localhost:11434');
    }
    case 'lmstudio': {
      const { LMStudioAdapter } = await import('../../src/services/llm/adapters/lmstudio/LMStudioAdapter');
      return new LMStudioAdapter(process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234');
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
