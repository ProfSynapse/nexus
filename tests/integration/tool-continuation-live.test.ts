/**
 * Live integration tests for tool continuation flows.
 *
 * These tests hit REAL APIs with real credentials.
 * They exercise the full production code path:
 *   OpenRouterAdapter.generateStreamAsync() → collect tool calls →
 *   OpenAIContextBuilder.buildToolContinuation() / appendToolExecution() →
 *   send continuation back via adapter → verify response
 *
 * Set environment variables before running (see .env).
 *
 * Run:
 *   npx jest tests/integration/tool-continuation-live.test.ts --no-coverage --verbose
 */

import { __setRequestUrlMock } from 'obsidian';
import { OpenRouterAdapter } from '../../src/services/llm/adapters/openrouter/OpenRouterAdapter';
import { OpenAIContextBuilder } from '../../src/services/chat/builders/OpenAIContextBuilder';
import type { Tool, ToolCall, StreamChunk } from '../../src/services/llm/adapters/types';
import type { LLMToolCall, ToolExecutionResult, LLMMessage } from '../../src/services/chat/builders/IContextBuilder';

// ---------------------------------------------------------------------------
// requestUrl → real HTTP (needed for non-streaming calls like generation stats)
// ---------------------------------------------------------------------------
beforeAll(() => {
  __setRequestUrlMock(async (request) => {
    const headers: Record<string, string> = {};
    if (request.headers) {
      for (const [k, v] of Object.entries(request.headers)) {
        headers[k] = String(v);
      }
    }

    const fetchOptions: RequestInit = {
      method: request.method || 'GET',
      headers,
    };

    if (request.body !== undefined && request.body !== null) {
      if (request.body instanceof ArrayBuffer) {
        fetchOptions.body = request.body;
      } else if (typeof request.body === 'string') {
        fetchOptions.body = request.body;
      } else {
        fetchOptions.body = request.body as BodyInit;
      }
    }

    const resp = await fetch(request.url, fetchOptions);
    const arrayBuf = await resp.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuf);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }

    return {
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      text,
      json,
      arrayBuffer: arrayBuf,
    };
  });
});

// ---------------------------------------------------------------------------
// Credential & skip guard
// ---------------------------------------------------------------------------
const openrouterKey = process.env.OPENROUTER_API_KEY;
const RUN_LIVE = !!openrouterKey;

// ---------------------------------------------------------------------------
// Tool definitions — simple tools that LLMs reliably call
// ---------------------------------------------------------------------------
const TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a given city.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'Get the current time in a given timezone.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone (e.g. America/New_York)' },
        },
        required: ['timezone'],
      },
    },
  },
];

/**
 * Simulate tool execution — returns deterministic fake results.
 */
function executeToolLocally(tc: ToolCall): ToolExecutionResult {
  const name = tc.function?.name || tc.name || '';
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.function?.arguments || '{}');
  } catch { /* keep empty */ }

  if (name === 'get_weather') {
    return {
      id: tc.id,
      name,
      success: true,
      result: { city: args.city || 'unknown', temperature: 72, unit: 'F', condition: 'sunny' },
      function: tc.function,
    };
  }

  if (name === 'get_time') {
    return {
      id: tc.id,
      name,
      success: true,
      result: { timezone: args.timezone || 'UTC', time: '2026-04-15T12:00:00Z' },
      function: tc.function,
    };
  }

  return {
    id: tc.id,
    name,
    success: false,
    error: `Unknown tool: ${name}`,
    function: tc.function,
  };
}

/**
 * Collect all chunks from a streaming generator.
 * Returns accumulated text content and the final tool calls (if any).
 */
async function consumeStream(
  gen: AsyncGenerator<StreamChunk, void, unknown>
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  let text = '';
  let toolCalls: ToolCall[] = [];

  for await (const chunk of gen) {
    text += chunk.content || '';
    if (chunk.toolCalls && chunk.toolCalls.length > 0) {
      toolCalls = chunk.toolCalls;
    }
  }

  return { text, toolCalls };
}

/**
 * Convert adapter ToolCall[] to IContextBuilder LLMToolCall[]
 */
function toLLMToolCalls(toolCalls: ToolCall[]): LLMToolCall[] {
  return toolCalls.map(tc => ({
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.function?.name || tc.name || '',
      arguments: tc.function?.arguments || '{}',
    },
  }));
}

// ---------------------------------------------------------------------------
// Models to test
// ---------------------------------------------------------------------------
const MODELS = [
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
  { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4-mini' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.each(MODELS)('Tool continuation: $label', ({ id: modelId, label }) => {
  const runTest = RUN_LIVE ? it : it.skip;

  runTest('single tool call round-trip', async () => {
    const adapter = new OpenRouterAdapter(openrouterKey!);
    const contextBuilder = new OpenAIContextBuilder();

    // Round 1: Initial request that should trigger a tool call
    const prompt = 'What is the weather in San Francisco?';
    const systemPrompt = 'You are a helpful assistant. Use the get_weather tool to answer weather questions. Always use the tool, never guess.';

    console.log(`\n[${label}] Round 1: Sending initial prompt...`);
    const stream1 = adapter.generateStreamAsync(prompt, {
      model: modelId,
      systemPrompt,
      tools: TOOLS,
      temperature: 0,
    });

    const result1 = await consumeStream(stream1);
    console.log(`[${label}] Round 1: text="${result1.text.slice(0, 100)}", toolCalls=${result1.toolCalls.length}`);

    // We expect tool calls
    expect(result1.toolCalls.length).toBeGreaterThan(0);
    const firstToolCall = result1.toolCalls[0];
    expect(firstToolCall.function.name).toBe('get_weather');

    // Execute tools locally
    const toolResults = result1.toolCalls.map(tc => executeToolLocally(tc));

    // Build continuation using OpenAIContextBuilder
    const llmToolCalls = toLLMToolCalls(result1.toolCalls);
    const continuationMessages = contextBuilder.buildToolContinuation(
      prompt,
      llmToolCalls,
      toolResults,
    );

    console.log(`[${label}] Round 1 continuation: ${continuationMessages.length} messages`);

    // Send continuation back to the adapter
    const stream2 = adapter.generateStreamAsync('', {
      model: modelId,
      systemPrompt,
      tools: TOOLS,
      conversationHistory: continuationMessages as unknown as Array<Record<string, unknown>>,
      temperature: 0,
    });

    const result2 = await consumeStream(stream2);
    console.log(`[${label}] Round 1 response: "${result2.text.slice(0, 200)}"`);

    // The model should respond with text (not more tool calls)
    expect(result2.text.length).toBeGreaterThan(0);
    console.log(`[${label}] PASS: Single round-trip succeeded`);
  }, 60_000);

  runTest('multi-round tool continuation (3 rounds)', async () => {
    const adapter = new OpenRouterAdapter(openrouterKey!);
    const contextBuilder = new OpenAIContextBuilder();

    const systemPrompt = [
      'You are a helpful assistant with access to weather and time tools.',
      'When asked about weather AND time, call get_weather first, then get_time in a separate turn.',
      'Always use tools - never guess. Call one tool per turn.',
    ].join(' ');

    const prompt = 'What is the weather in Tokyo and what time is it there (Asia/Tokyo)?';

    let accumulatedMessages: LLMMessage[] = [];
    let roundCount = 0;
    const maxRounds = 5; // safety cap

    console.log(`\n[${label}] Multi-round: Sending initial prompt...`);

    // Round 1: Initial streaming request
    const stream1 = adapter.generateStreamAsync(prompt, {
      model: modelId,
      systemPrompt,
      tools: TOOLS,
      temperature: 0,
    });

    let lastResult = await consumeStream(stream1);
    console.log(`[${label}] Round 1: text="${lastResult.text.slice(0, 80)}", toolCalls=${lastResult.toolCalls.length}`);

    // Loop: process tool calls until model responds with text only
    while (lastResult.toolCalls.length > 0 && roundCount < maxRounds) {
      roundCount++;
      const toolResults = lastResult.toolCalls.map(tc => executeToolLocally(tc));
      const llmToolCalls = toLLMToolCalls(lastResult.toolCalls);

      if (accumulatedMessages.length === 0) {
        // First continuation: use buildToolContinuation (includes user prompt)
        accumulatedMessages = contextBuilder.buildToolContinuation(
          prompt,
          llmToolCalls,
          toolResults,
        );
      } else {
        // Subsequent rounds: use appendToolExecution (no user prompt added)
        accumulatedMessages = contextBuilder.appendToolExecution(
          llmToolCalls,
          toolResults,
          accumulatedMessages,
        );
      }

      console.log(`[${label}] Round ${roundCount + 1}: Sending continuation (${accumulatedMessages.length} messages)...`);

      const streamN = adapter.generateStreamAsync('', {
        model: modelId,
        systemPrompt,
        tools: TOOLS,
        conversationHistory: accumulatedMessages as unknown as Array<Record<string, unknown>>,
        temperature: 0,
      });

      lastResult = await consumeStream(streamN);
      console.log(`[${label}] Round ${roundCount + 1}: text="${lastResult.text.slice(0, 120)}", toolCalls=${lastResult.toolCalls.length}`);
    }

    // We should have done at least 2 tool-call rounds (weather + time)
    console.log(`[${label}] Completed ${roundCount} tool-call rounds`);
    expect(roundCount).toBeGreaterThanOrEqual(2);

    // Final response should be text
    expect(lastResult.text.length).toBeGreaterThan(0);
    expect(lastResult.toolCalls.length).toBe(0);

    console.log(`[${label}] Final response: "${lastResult.text.slice(0, 200)}"`);
    console.log(`[${label}] PASS: Multi-round continuation succeeded (${roundCount} rounds)`);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
describe('Tool continuation summary', () => {
  it('lists configuration', () => {
    if (!RUN_LIVE) {
      console.log('\nTool continuation tests skipped: set OPENROUTER env var to enable.');
    } else {
      console.log(`\nOpenRouter: configured`);
      console.log(`Models under test: ${MODELS.map(m => m.label).join(', ')}`);
    }
    expect(true).toBe(true);
  });
});
