/**
 * tests/eval/types.ts — Type definitions for the LLM eval harness.
 *
 * Defines EvalConfig, EvalScenario, EvalTurn, and related types used by
 * ConfigLoader, ScenarioLoader, EvalRunner, and the Jest entry point.
 */

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  apiKeyEnv: string;
  models: string[];
  enabled: boolean;
}

export interface CaptureConfig {
  enabled: boolean;
  dumpOnFailure: boolean;
  artifactsDir: string;
}

export interface EvalDefaults {
  temperature: number;
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
  retryMaxDelayMs: number;
  timeout: number;
  systemPrompt: string;
}

export interface EvalConfig {
  mode: 'mock' | 'live';
  testVaultPath?: string;
  providers: Record<string, ProviderConfig>;
  defaults: EvalDefaults;
  capture: CaptureConfig;
  scenarios: string;
  /**
   * Optional scenario tool-surface filter.
   * - 'all': run every scenario regardless of toolSet
   * - 'meta': production two-tool architecture only
   * - 'nexus' / 'simple': targeted legacy/direct tool surfaces
   */
  scenarioToolSet?: ToolSetType | 'all';
  /**
   * Optional scenario-name filter for focused debugging runs.
   */
  scenarioNames?: string[];
}

// ---------------------------------------------------------------------------
// Scenario types
// ---------------------------------------------------------------------------

export interface ExpectedToolCall {
  name: string;
  params?: Record<string, unknown>;
  optional?: boolean;
}

export interface MockToolResponse {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface EvalTurn {
  userMessage?: string;
  expectedTools: ExpectedToolCall[];
  mockResponses: Record<string, MockToolResponse>;
}

/**
 * Which tool set a scenario uses:
 * - 'meta' (default): getTools + useTools — mirrors production two-tool architecture
 * - 'nexus': domain tools exposed directly (for targeted domain-tool testing)
 * - 'simple': basic test tools (get_weather, get_time)
 */
export type ToolSetType = 'meta' | 'nexus' | 'simple';

export interface EvalScenario {
  name: string;
  description: string;
  /**
   * Files to seed into the headless live test vault before this scenario runs.
   * Mock mode ignores this because mockResponses provide tool outputs directly.
   */
  seedFiles?: Record<string, string>;
  providers?: string[];
  models?: string[];
  temperature?: number;
  maxRetries?: number;
  timeout?: number;
  systemPrompt?: string;
  toolSet?: ToolSetType;
  /**
   * When true, tool call round ordering is not enforced.
   * All expected tools must appear across all rounds, but the round
   * assignment doesn't matter. Use for scenarios where the model may
   * execute search before read or vice versa.
   */
  allowReorder?: boolean;
  /**
   * Enforce the production context contract (memory + goal required) on useTools
   * execution in mock mode. A bad context block gets the shared steering error
   * so we can grade whether the model recovers. Also enabled globally via
   * EVAL_ENFORCE_CONTEXT=1.
   */
  enforceContextContract?: boolean;
  /**
   * Max number of context steering errors tolerated before recovery is judged
   * failed. Default 3. Only meaningful with enforceContextContract /
   * forceContextSteering.
   */
  maxRecoveryRounds?: number;
  /**
   * Deterministically reject the first N useTools calls with a real context
   * steering error (regardless of input), then grade whether the model
   * re-issues a valid call. Use this to test recovery reliably — unlike
   * enforceContextContract, it does not depend on the model first making a
   * mistake. Implies recovery grading.
   */
  forceContextSteering?: number;
  /**
   * Consume mockResponses per round (FIFO) instead of last-write-wins, so the
   * SAME tool can return different results across rounds — enabling recovery
   * patterns like tool→error (round 0) then tool→success (round 1). Off by
   * default; existing scenarios are unaffected.
   */
  sequentialMockResponses?: boolean;
  /**
   * Exclude this scenario from leaderboard (byModel) aggregation. The result is
   * still run and reported, but does not count toward a model's pass rate. Use
   * for scenarios with a known fixture/scenario bug that would unfairly penalize
   * correct model behavior until the fixture is re-verified.
   */
  excludeFromBoard?: boolean;
  turns: EvalTurn[];
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CapturedToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  timestamp: number;
}

export interface TurnResult {
  turnIndex: number;
  passed: boolean;
  expectedTools: ExpectedToolCall[];
  actualToolCalls: CapturedToolCall[];
  textContent: string;
  errors: string[];
  durationMs: number;
}

export interface ScenarioResult {
  scenario: string;
  description: string;
  provider: string;
  model: string;
  passed: boolean;
  turns: TurnResult[];
  totalDurationMs: number;
  retryCount: number;
  error?: string;
  tracePath?: string;
  /** Run + reported, but excluded from byModel leaderboard aggregation (known fixture bug). */
  excludedFromBoard?: boolean;
}

export interface EvalRunResult {
  config: string;
  mode: 'mock' | 'live';
  results: ScenarioResult[];
  startTime: number;
  endTime: number;
}
