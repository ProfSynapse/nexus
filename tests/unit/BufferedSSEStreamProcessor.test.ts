import { BufferedSSEStreamProcessor } from '../../src/services/llm/streaming/BufferedSSEStreamProcessor';

describe('BufferedSSEStreamProcessor', () => {
  it('replays SSE text into content and completion chunks', async () => {
    const sseText = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n'
    ].join('');

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: () => null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
      extractUsage: (parsed) => parsed.usage || null
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ content: 'Hello ', complete: false });
    expect(chunks[1]).toMatchObject({ content: 'world', complete: false });
    expect(chunks[2]).toMatchObject({
      complete: true,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }
    });
  });

  it('accumulates tool call argument deltas', async () => {
    const sseText = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"foo"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"bar"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n'
    ].join('');

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: () => null,
      extractToolCalls: (parsed) => parsed.choices?.[0]?.delta?.tool_calls || null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
      accumulateToolCalls: true,
      toolCallThrottling: {
        initialYield: true,
        progressInterval: 5
      }
    })) {
      chunks.push(chunk);
    }

    const finalChunk = chunks.find((chunk) => chunk.complete);
    expect(finalChunk.complete).toBe(true);
    expect(finalChunk.toolCalls?.[0]?.function?.arguments).toBe('foobar');
  });

  it('extracts metadata from SSE events', async () => {
    const sseText = [
      'data: {"id":"resp_123","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n'
    ].join('');

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: () => null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
      extractMetadata: (parsed) => parsed.id ? { responseId: parsed.id } : null
    })) {
      chunks.push(chunk);
    }

    const finalChunk = chunks.find((c) => c.complete);
    expect(finalChunk?.metadata).toEqual({ responseId: 'resp_123' });
  });

  it('extracts reasoning/thinking chunks', async () => {
    const sseText = [
      'data: {"choices":[{"delta":{}}],"thinking":{"text":"Let me think...","complete":false}}\n\n',
      'data: {"choices":[{"delta":{}}],"thinking":{"text":"Done thinking.","complete":true}}\n\n',
      'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\n'
    ].join('');

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: () => null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
      extractReasoning: (parsed) => parsed.thinking || null
    })) {
      chunks.push(chunk);
    }

    const reasoningChunks = chunks.filter((c) => c.reasoning);
    expect(reasoningChunks).toHaveLength(2);
    expect(reasoningChunks[0].reasoning).toBe('Let me think...');
    expect(reasoningChunks[0].reasoningComplete).toBe(false);
    expect(reasoningChunks[1].reasoning).toBe('Done thinking.');
    expect(reasoningChunks[1].reasoningComplete).toBe(true);
  });

  it('invokes onParseError for malformed JSON in SSE data', async () => {
    const sseText = 'data: {not valid json}\n\n';

    const errors: Array<{ error: Error; raw: string }> = [];
    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: () => null,
      extractToolCalls: () => null,
      extractFinishReason: () => null,
      onParseError: (error, rawData) => {
        errors.push({ error, raw: rawData });
      }
    })) {
      chunks.push(chunk);
    }

    expect(errors).toHaveLength(1);
    expect(errors[0].raw).toBe('{not valid json}');
  });

  it('extracts usage with prompt_tokens/completion_tokens field names', async () => {
    const sseText = 'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\n';

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: () => null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
      extractUsage: (parsed) => parsed.usage || null
    })) {
      chunks.push(chunk);
    }

    const finalChunk = chunks.find((c) => c.complete);
    expect(finalChunk?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30
    });
  });

  it('extracts usage with Google-style field names (promptTokenCount)', async () => {
    const sseText = 'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}],"usage":{"promptTokenCount":5,"candidatesTokenCount":15,"totalTokenCount":20}}\n\n';

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: () => null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
      extractUsage: (parsed) => parsed.usage || null
    })) {
      chunks.push(chunk);
    }

    const finalChunk = chunks.find((c) => c.complete);
    expect(finalChunk?.usage).toEqual({
      promptTokens: 5,
      completionTokens: 15,
      totalTokens: 20
    });
  });

  it('extracts usage with Anthropic-style field names (input_tokens)', async () => {
    const sseText = 'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}],"usage":{"input_tokens":8,"output_tokens":12,"total_tokens":0}}\n\n';

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: () => null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
      extractUsage: (parsed) => parsed.usage || null
    })) {
      chunks.push(chunk);
    }

    const finalChunk = chunks.find((c) => c.complete);
    expect(finalChunk?.usage).toEqual({
      promptTokens: 8,
      completionTokens: 12,
      totalTokens: 0
    });
  });

  it('completes on finish_reason "stop"', async () => {
    const sseText = 'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n';

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: () => null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.complete)).toBe(true);
  });

  it('completes on finish_reason "length"', async () => {
    const sseText = 'data: {"choices":[{"delta":{"content":"truncat"},"finish_reason":"length"}]}\n\n';

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: () => null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.complete)).toBe(true);
  });

  it('completes on finish_reason "tool_calls"', async () => {
    const sseText = 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n';

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: () => null,
      extractToolCalls: () => null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.complete)).toBe(true);
  });

  it('throttles tool call progress based on progressInterval', async () => {
    // Build SSE with many small argument deltas: 10 chunks of 5 chars each = 50 chars total
    const argChunks = Array.from({ length: 10 }, (_, i) =>
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"${String(i).repeat(5)}"}}]}}]}\n\n`
    );
    const sseText = [
      ...argChunks,
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n'
    ].join('');

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: () => null,
      extractToolCalls: (parsed) => parsed.choices?.[0]?.delta?.tool_calls || null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
      accumulateToolCalls: true,
      toolCallThrottling: {
        initialYield: true,
        progressInterval: 10
      }
    })) {
      chunks.push(chunk);
    }

    // The initial yield (first tool call seen) + progress yields (every 10 chars) + completion
    // Not every single delta should produce a chunk — throttling should reduce them
    const toolCallChunks = chunks.filter((c) => !c.complete && c.toolCalls);
    const completionChunk = chunks.find((c) => c.complete);

    expect(toolCallChunks.length).toBeLessThan(10);
    expect(toolCallChunks.length).toBeGreaterThanOrEqual(1);
    expect(completionChunk?.complete).toBe(true);
  });

  it('produces no content chunks for empty or comment-only SSE text', async () => {
    const sseText = ': this is a comment\n\ndata: [DONE]\n\n';

    const chunks = [];
    for await (const chunk of BufferedSSEStreamProcessor.processSSEText(sseText, {
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: () => null,
      extractFinishReason: () => null
    })) {
      chunks.push(chunk);
    }

    // [DONE] produces a completion chunk, but no content chunks
    const contentChunks = chunks.filter((c) => c.content && !c.complete);
    expect(contentChunks).toHaveLength(0);
    // The [DONE] event should still produce a completion chunk
    expect(chunks.some((c) => c.complete)).toBe(true);
  });
});
