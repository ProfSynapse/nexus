/**
 * Live integration test for Mistral chat + tool continuation.
 *
 * Requires:
 *   MISTRAL_API_KEY=...
 *
 * Run:
 *   source .env && npx jest tests/integration/MistralChatLive.test.ts --runInBand --no-coverage --verbose
 */

import { MistralAdapter } from '../../src/services/llm/adapters/mistral/MistralAdapter';
import type { GenerateOptions, ToolCall } from '../../src/services/llm/adapters/types';

type StreamCapture = {
  content: string;
  toolCalls: ToolCall[];
};

async function collectStream(
  adapter: MistralAdapter,
  prompt: string,
  options?: GenerateOptions
): Promise<StreamCapture> {
  let content = '';
  let toolCalls: ToolCall[] = [];

  for await (const chunk of adapter.generateStreamAsync(prompt, options)) {
    if (chunk.content) {
      content += chunk.content;
    }

    if (chunk.toolCalls && chunk.toolCalls.length > 0) {
      toolCalls = chunk.toolCalls;
    }
  }

  return { content, toolCalls };
}

const mistralKey = process.env.MISTRAL_API_KEY;

describe('Live Chat: Mistral tool continuations', () => {
  const runTest = mistralKey ? it : it.skip;

  runTest('executes a real tool call and accepts the continuation payload', async () => {
    const adapter = new MistralAdapter(mistralKey!);
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'get_weather',
          description: 'Look up the current weather for a city.',
          parameters: {
            type: 'object',
            properties: {
              city: {
                type: 'string',
                description: 'City name'
              }
            },
            required: ['city']
          }
        }
      }
    ];

    const firstPass = await collectStream(
      adapter,
      'You must call the get_weather tool exactly once for New York City. Do not answer directly before the tool call.',
      {
        model: 'mistral-large-latest',
        tools,
        temperature: 0
      }
    );

    expect(firstPass.toolCalls.length).toBeGreaterThan(0);
    expect(firstPass.toolCalls[0]?.function.name).toBe('get_weather');

    const firstToolCall = firstPass.toolCalls[0];
    const continuationHistory = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: firstToolCall.id,
            type: 'function',
            function: {
              name: firstToolCall.function.name,
              arguments: firstToolCall.function.arguments
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: firstToolCall.id,
        name: firstToolCall.function.name,
        content: JSON.stringify({
          city: 'New York City',
          temperature_f: 72,
          condition: 'Sunny'
        })
      }
    ];

    const secondPass = await collectStream(adapter, '', {
      model: 'mistral-large-latest',
      tools,
      conversationHistory: continuationHistory,
      temperature: 0
    });

    expect(secondPass.content.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
