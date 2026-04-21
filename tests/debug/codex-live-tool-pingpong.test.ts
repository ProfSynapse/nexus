/**
 * Live Codex pingpong reproduction test.
 *
 * Purpose:
 * - Use the locally connected ChatGPT Codex OAuth config from data.json
 * - Exercise a real two-tool flow against a temp headless Nexus vault
 * - Verify whether the final post-tool assistant text arrives
 *
 * Run:
 *   npx jest tests/debug/codex-live-tool-pingpong.test.ts --runInBand --no-coverage --verbose
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __setRequestUrlMock } from 'obsidian';

// Force requestStream() through requestUrl() so tests can use a real fetch-backed mock.
jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { OpenAICodexAdapter, type CodexOAuthTokens } from '../../src/services/llm/adapters/openai-codex/OpenAICodexAdapter';
import { StreamingOrchestrator, type ConversationMessage } from '../../src/services/llm/core/StreamingOrchestrator';
import { ProviderMessageBuilder } from '../../src/services/llm/core/ProviderMessageBuilder';
import type { LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import { ConversationContextBuilder } from '../../src/services/chat/ConversationContextBuilder';
import { EvalAdapterRegistry } from '../eval/EvalAdapterRegistry';
import { LiveToolExecutor } from '../eval/LiveToolExecutor';
import { META_TOOLS } from '../eval/fixtures/tools';
import { getTwoToolOnlyPrompt } from '../eval/fixtures/system-prompt';
import type { ToolCall, StreamChunk } from '../../src/services/llm/adapters/types';
import type { ToolResult } from '../../src/services/llm/adapters/shared/ToolExecutionUtils';

jest.setTimeout(180_000);

interface ProviderSettingsShape {
  llmProviders?: {
    providers?: Record<string, {
      apiKey?: string;
      enabled?: boolean;
      oauth?: {
        refreshToken?: string;
        expiresAt?: number;
        metadata?: {
          accountId?: string;
        };
      };
    }>;
  };
}

interface StreamTranscript {
  text: string;
  toolCalls: ToolCall[];
  chunks: Array<{ complete: boolean; content: string; toolCount: number }>;
}

type HttpCapture = {
  url: string;
  method: string;
  requestBody?: string;
  status: number;
  responseText: string;
};

const SHOULD_LOG_DEBUG = process.env.DEBUG_CODEX_LIVE === '1';

function redactSensitiveText(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  return value
    .replace(/(refresh_token=)[^&\s]+/g, '$1[REDACTED]')
    .replace(/("access_token"\s*:\s*")[^"]+/g, '$1[REDACTED]')
    .replace(/("refresh_token"\s*:\s*")[^"]+/g, '$1[REDACTED]')
    .replace(/("id_token"\s*:\s*")[^"]+/g, '$1[REDACTED]')
    .replace(/("email"\s*:\s*")[^"]+/g, '$1[REDACTED]');
}

function sanitizeCapture(capture: HttpCapture): Record<string, unknown> {
  return {
    url: capture.url,
    method: capture.method,
    status: capture.status,
    requestBody: redactSensitiveText(capture.requestBody)?.slice(0, 4000),
    responseText: redactSensitiveText(capture.responseText)?.slice(0, 4000),
  };
}

function logDebugIfNeeded(phase: string, payload: Record<string, unknown>, force = false): void {
  if (!force && !SHOULD_LOG_DEBUG) {
    return;
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ phase, ...payload }, null, 2));
}

function setRequestUrlToRealFetch(captures: HttpCapture[]): void {
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

    const response = await fetch(request.url ?? '', fetchOptions);
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);

    let json: unknown = {};
    try {
      json = JSON.parse(text);
    } catch {
      // SSE and non-JSON responses are expected here.
    }

    captures.push({
      url: request.url ?? '',
      method: request.method || 'GET',
      requestBody: typeof request.body === 'string' ? request.body : undefined,
      status: response.status,
      responseText: text,
    });

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json,
      arrayBuffer,
    };
  });
}

function loadCodexTokensFromLocalDataJson(): CodexOAuthTokens | null {
  const dataPath = path.join(process.cwd(), 'data.json');
  if (!fs.existsSync(dataPath)) {
    return null;
  }

  const settings = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as ProviderSettingsShape;
  const config = settings.llmProviders?.providers?.['openai-codex'];
  const accountId = config?.oauth?.metadata?.accountId;

  if (!config?.enabled || !config.apiKey || !config.oauth?.refreshToken || !accountId) {
    return null;
  }

  return {
    accessToken: config.apiKey,
    refreshToken: config.oauth.refreshToken,
    expiresAt: config.oauth.expiresAt || 0,
    accountId,
  };
}

async function consumeStream(
  stream: AsyncGenerator<StreamChunk, void, unknown>
): Promise<StreamTranscript> {
  let text = '';
  let toolCalls: ToolCall[] = [];
  const chunks: StreamTranscript['chunks'] = [];

  for await (const chunk of stream) {
    if (chunk.content) {
      text += chunk.content;
    }
    if (chunk.toolCalls && chunk.toolCalls.length > 0) {
      toolCalls = chunk.toolCalls;
    }
    chunks.push({
      complete: chunk.complete,
      content: chunk.content || '',
      toolCount: chunk.toolCalls?.length || 0,
    });
  }

  return { text, toolCalls, chunks };
}

describe('Codex live tool pingpong', () => {
  const liveTokens = loadCodexTokensFromLocalDataJson();
  const runLive = liveTokens ? it : it.skip;
  const httpCaptures: HttpCapture[] = [];

  beforeAll(() => {
    setRequestUrlToRealFetch(httpCaptures);
  });

  beforeEach(() => {
    httpCaptures.length = 0;
  });

  runLive('manual adapter continuation returns final text after a real tool turn', async () => {
    const tempVaultPath = path.join(os.tmpdir(), `nexus-codex-live-adapter-${Date.now()}`);
    const executor = new LiveToolExecutor({ testVaultPath: tempVaultPath, vaultName: 'codex-live-adapter' });

    try {
      await executor.reset({
        'notes/hello.md': '# Hello\n\nThis note proves the tool ran.',
      });

      const adapter = new OpenAICodexAdapter(liveTokens!);
      const systemPrompt = await getTwoToolOnlyPrompt();
      const prompt = 'Use Nexus tools to read notes/hello.md. After the tool result, reply with exactly FINAL_TEXT and nothing else.';
      const builder = new ProviderMessageBuilder(new Map<string, string>());
      let previousMessages: ConversationMessage[] = [];
      let continuation: ReturnType<ProviderMessageBuilder['buildContinuationOptions']> | null = null;
      let aggregateText = '';
      let currentPass: StreamTranscript | null = null;
      const passes: Array<{ text: string; toolCalls: string[]; chunks: StreamTranscript['chunks'] }> = [];

      for (let round = 0; round < 5; round++) {
        currentPass = await consumeStream(
          round === 0
            ? adapter.generateStreamAsync(prompt, {
                model: 'gpt-5.4',
                systemPrompt,
                tools: META_TOOLS,
              })
            : adapter.generateStreamAsync('', {
                model: 'gpt-5.4',
                systemPrompt: continuation?.systemPrompt,
                tools: continuation?.tools,
                conversationHistory: continuation?.conversationHistory as Array<Record<string, unknown>>,
              })
        );

        aggregateText += currentPass.text;
        passes.push({
          text: currentPass.text,
          toolCalls: currentPass.toolCalls.map(tc => tc.function?.name || tc.name || '(unknown)'),
          chunks: currentPass.chunks,
        });

        if (currentPass.toolCalls.length === 0) {
          break;
        }

        const toolResults = await executor.executeToolCalls(currentPass.toolCalls, {
          provider: 'openai-codex',
        });

        continuation = builder.buildContinuationOptions(
          'openai-codex',
          prompt,
          currentPass.toolCalls,
          toolResults as ToolResult[],
          previousMessages,
          { model: 'gpt-5.4', systemPrompt, tools: META_TOOLS }
        );

        previousMessages = ConversationContextBuilder.appendToolExecution(
          'openai-codex',
          currentPass.toolCalls,
          toolResults as ToolResult[],
          previousMessages
        ) as ConversationMessage[];
      }

      const debugPayload = {
        passes,
        aggregateText,
        capturedCalls: executor.getCapturedCalls().map(call => call.name),
        httpCaptures: httpCaptures.map(sanitizeCapture),
      };

      try {
        expect(executor.getCapturedCalls().map(call => call.name)).toEqual(
          expect.arrayContaining(['getTools', 'useTools', 'contentManager_read'])
        );
        expect(currentPass?.toolCalls.length).toBe(0);
        expect(aggregateText).toContain('FINAL_TEXT');
        logDebugIfNeeded('adapter-continuation', debugPayload);
      } catch (error) {
        logDebugIfNeeded('adapter-continuation', debugPayload, true);
        throw error;
      }
    } finally {
      fs.rmSync(tempVaultPath, { recursive: true, force: true });
    }
  });

  runLive('full orchestrator pingpong returns final text after real tool execution', async () => {
    const tempVaultPath = path.join(os.tmpdir(), `nexus-codex-live-orchestrator-${Date.now()}`);
    const executor = new LiveToolExecutor({ testVaultPath: tempVaultPath, vaultName: 'codex-live-orchestrator' });

    try {
      await executor.reset({
        'notes/hello.md': '# Hello\n\nThis note proves the tool ran.',
      });

      const adapter = new OpenAICodexAdapter(liveTokens!);
      const registry = new EvalAdapterRegistry([['openai-codex', adapter]]);
      const settings: LLMProviderSettings = {
        providers: {
          'openai-codex': {
            apiKey: liveTokens!.accessToken,
            enabled: true,
          },
        },
        defaultModel: { provider: 'openai-codex', model: 'gpt-5.4' },
      };
      const orchestrator = new StreamingOrchestrator(registry, settings, executor);
      const systemPrompt = await getTwoToolOnlyPrompt();
      const prompt = 'Use Nexus tools to read notes/hello.md. After the tool result, reply with exactly FINAL_TEXT and nothing else.';

      let text = '';
      const yielded: Array<{ chunk: string; complete: boolean; toolCount: number }> = [];
      const stream = orchestrator.generateResponseStream(
        [{ role: 'user', content: prompt }],
        {
          provider: 'openai-codex',
          model: 'gpt-5.4',
          systemPrompt,
          tools: META_TOOLS,
          temperature: 0,
          workspaceId: 'default',
          sessionId: 'codex-live-test',
          conversationId: 'codex-live-test-conversation',
        }
      );

      for await (const output of stream) {
        if (output.chunk) {
          text += output.chunk;
        }
        yielded.push({
          chunk: output.chunk,
          complete: output.complete,
          toolCount: output.toolCalls?.length || 0,
        });
      }

      const debugPayload = {
        text,
        yielded,
        capturedCalls: executor.getCapturedCalls().map(call => call.name),
        httpCaptures: httpCaptures.map(sanitizeCapture),
      };

      try {
        expect(executor.getCapturedCalls().map(call => call.name)).toEqual(
          expect.arrayContaining(['getTools', 'useTools', 'contentManager_read'])
        );
        expect(text).toContain('FINAL_TEXT');
        logDebugIfNeeded('orchestrator', debugPayload);
      } catch (error) {
        logDebugIfNeeded('orchestrator', debugPayload, true);
        throw error;
      }
    } finally {
      fs.rmSync(tempVaultPath, { recursive: true, force: true });
    }
  });
});
