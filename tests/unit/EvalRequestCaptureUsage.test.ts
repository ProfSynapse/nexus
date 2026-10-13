/** Usage must survive capture truncation and count each response once, including retries/errors. */
import { extractGoogleUsage, RequestCapture } from '../eval/RequestCapture';
import { requestUrl } from 'obsidian';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('eval HTTP usage accounting', () => {
  it('uses the final SSE usage snapshot, including thinking separately from candidate tokens', () => {
    const text = [
      'data: ' + JSON.stringify({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1 } }),
      'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x'.repeat(60000) }] } }] }),
      'data: ' + JSON.stringify({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20,
        thoughtsTokenCount: 30, cachedContentTokenCount: 40, totalTokenCount: 150 } }),
      'data: [DONE]',
    ].join('\n\n');
    expect(extractGoogleUsage(text)).toEqual({
      inputTokens: 100, outputTokens: 50, reasoningTokens: 30, cachedInputTokens: 40, totalTokens: 150,
    });
  });

  it('retains supplied usage from an error response or incomplete stream', () => {
    expect(extractGoogleUsage(JSON.stringify({ error: { message: 'truncated' },
      usageMetadata: { promptTokenCount: 100, thoughtsTokenCount: 7, totalTokenCount: 107 } })))
      .toEqual({ inputTokens: 100, outputTokens: 7, reasoningTokens: 7, totalTokens: 107 });
    expect(extractGoogleUsage('data: {"usageMetadata":{"promptTokenCount":100}}\n\ndata: {'))
      .toEqual({ inputTokens: 100 });
  });

  it('leaves absent provider usage unknown rather than claiming zero billing', () => {
    expect(extractGoogleUsage('{"error":{"message":"invalid schema"}}')).toBeUndefined();
  });

  it('persists per-request usage before truncating transport captures without leaking credentials', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-usage-'));
    const text = JSON.stringify({ text: 'x'.repeat(60000), usageMetadata: {
      promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30,
    } });
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(text, { status: 429 }));
    try {
      const capture = new RequestCapture();
      capture.install({ enabled: true, dumpOnFailure: true, artifactsDir: dir });
      await capture.runWithScope('scenario-one', async () => {
        await requestUrl({ url: 'https://example.com/models/gemini-4-argon:streamGenerateContent?key=secret',
          headers: { Authorization: 'secret' } });
      });
      expect(capture.getCapturedRequests()[0].response.body).not.toContain('usageMetadata');
      const saved = fs.readFileSync(capture.dumpUsage(dir)!, 'utf8');
      expect(saved).not.toContain('secret');
      expect(JSON.parse(saved)).toEqual([expect.objectContaining({ scopeId: 'scenario-one', status: 429,
        usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 30 } })]);
    } finally {
      fetchMock.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
