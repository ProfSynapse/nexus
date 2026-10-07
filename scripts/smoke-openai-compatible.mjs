/**
 * Live protocol spike, deliberately independent of the Nexus adapter/runtime.
 * Fails if the server cannot return text, stream, request a supplied tool, or
 * consume its result. Only the harmless local fixture tool is executable.
 * Usage: node scripts/smoke-openai-compatible.mjs --model qwen3.5:4b
 * Optional: --base-url http://127.0.0.1:11434/v1 --output-dir /tmp/compat-smoke
 * Optional authentication: COMPAT_SMOKE_API_KEY (never written to the report).
 * No vendor-specific generation fields, downloads, retries, or vault access.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value for ${name}`);
  return args[index + 1];
}
const model = option('--model');
assert(model, 'Specify --model using an already-installed local model.');
const base = new URL(option('--base-url', 'http://127.0.0.1:11434/v1'));
assert(['http:', 'https:'].includes(base.protocol), 'HTTP(S) required.');
assert(!base.username && !base.password && !base.search && !base.hash, 'Use a clean API base URL.');
assert(base.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Remote endpoints require HTTPS.');
const baseUrl = base.href.replace(/\/+$/, '');
const outputDir = path.resolve(option('--output-dir', '/tmp/nexus-openai-compatible-smoke'));
await mkdir(outputDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), baseUrl, model, scope: 'Live HTTP protocol only; not a Nexus integration test', tests: [], exchanges: [] };
const headers = { 'Content-Type': 'application/json' };
if (process.env.COMPAT_SMOKE_API_KEY) headers.Authorization = `Bearer ${process.env.COMPAT_SMOKE_API_KEY}`;

async function exchange(label, body, endpoint = '/chat/completions') {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request deadline exceeded (180s)')), 180000);
  const trace = { label, request: body ?? null };
  report.exchanges.push(trace);
  try {
    const response = await fetch(baseUrl + endpoint, {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal, redirect: 'error'
    });
    trace.status = response.status;
    trace.contentType = response.headers.get('content-type');
    if (!response.ok) {
      trace.response = await response.text();
      return { status: response.status, error: trace.response };
    }
    if (!body?.stream) {
      trace.response = await response.json();
      return { status: response.status, json: trace.response, message: trace.response.choices?.[0]?.message };
    }
    assert(response.headers.get('content-type')?.includes('text/event-stream'), 'Expected actual SSE for the streaming case');
    const message = { role: 'assistant', content: '' };
    const calls = new Map();
    const decoder = new TextDecoder();
    let buffer = '', raw = '', done = false, frames = 0, contentChunks = 0, reasoning = '';
    function parseLines(final = false) {
      const lines = buffer.split('\n');
      buffer = final ? '' : lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const value = line.slice(5).trim();
        if (!value) continue;
        if (value === '[DONE]') { done = true; continue; }
        const frame = JSON.parse(value);
        assert(!frame.error, `Stream error: ${JSON.stringify(frame.error)}`);
        frames++;
        const choice = frame.choices?.[0];
        if (choice?.finish_reason) trace.finishReason = choice.finish_reason;
        const delta = choice?.delta ?? {};
        if (delta.content) {
          contentChunks++;
          trace.firstContentMs ??= Math.round(performance.now() - start);
          message.content += delta.content;
        }
        reasoning += delta.reasoning ?? delta.reasoning_content ?? '';
        for (const call of delta.tool_calls ?? []) {
          assert(Number.isInteger(call.index), 'Streamed tool call requires an index');
          const target = calls.get(call.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (call.id) target.id = call.id;
          if (call.function?.name) target.function.name += call.function.name;
          if (call.function?.arguments) target.function.arguments += call.function.arguments;
          calls.set(call.index, target);
        }
      }
    }
    for await (const bytes of response.body) {
      const chunk = decoder.decode(bytes, { stream: true });
      raw += chunk; buffer += chunk; parseLines();
    }
    const tail = decoder.decode(); raw += tail; buffer += tail; parseLines(true);
    assert(done, 'Missing SSE [DONE] terminal marker');
    if (calls.size) message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
    if (reasoning) message.reasoning = reasoning;
    Object.assign(trace, { response: message, sseFrames: frames, contentChunks, rawSse: raw });
    return { status: response.status, message, contentChunks, frames };
  } finally { clearTimeout(timer); trace.elapsedMs = Math.round(performance.now() - start); }
}
async function test(name, fn) {
  const start = performance.now();
  process.stdout.write(`RUN ${name}\n`);
  try {
    const evidence = await fn();
    report.tests.push({ name, passed: true, elapsedMs: Math.round(performance.now() - start), ...evidence });
    console.log(`PASS ${name} ${JSON.stringify(evidence)}`);
  } catch (error) {
    report.tests.push({ name, passed: false, elapsedMs: Math.round(performance.now() - start), error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
const tools = [{ type: 'function', function: {
  name: 'read_test_note', description: 'Read the synthetic endpoint test note and its secret verification code.',
  parameters: { type: 'object', properties: { noteId: { type: 'string', enum: ['endpoint-smoke'] } }, required: ['noteId'], additionalProperties: false }
} }];

await test('model discovery', async () => {
  const result = await exchange('models', undefined, '/models');
  assert.equal(result.status, 200);
  const ids = result.json.data.map(item => item.id);
  assert(ids.includes(model), 'Selected model missing from discovery');
  return { models: ids };
});
for (const stream of [false, true]) {
  await test(`${stream ? 'streamed' : 'buffered'} text`, async () => {
    const result = await exchange(`text-${stream}`, {
      model, messages: [{ role: 'user', content: 'Reply with exactly: endpoint connection confirmed' }], stream
    });
    assert.equal(result.status, 200);
    assert.match(result.message?.content ?? '', /endpoint connection confirmed/i);
    if (stream) assert(result.contentChunks > 1, 'Expected multiple SSE content deltas');
    return { reply: result.message.content, ...(stream ? { contentChunks: result.contentChunks, frames: result.frames } : {}) };
  });
  await test(`${stream ? 'streamed' : 'buffered'} tool round trip`, async () => {
    const messages = [{ role: 'user', content: 'Use read_test_note to read noteId endpoint-smoke. Then reply with its exact verificationCode. You do not know the code until you read the note.' }];
    const first = await exchange(`tool-request-${stream}`, { model, messages, tools, tool_choice: 'auto', stream });
    assert.equal(first.status, 200);
    const calls = first.message?.tool_calls;
    assert.equal(calls?.length, 1, 'Expected exactly one tool call');
    const call = calls[0];
    assert.equal(call.type, 'function');
    assert.equal(call.function.name, 'read_test_note');
    assert(call.id, 'Tool call ID missing');
    assert.deepEqual(JSON.parse(call.function.arguments), { noteId: 'endpoint-smoke' });
    const verificationCode = `NEXUS-${randomBytes(8).toString('hex')}`;
    // Actual allowlisted local execution; generated only after the model calls.
    const toolResult = { noteId: 'endpoint-smoke', verificationCode };
    messages.push(first.message, { role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolResult) });
    const final = await exchange(`tool-result-${stream}`, { model, messages, tools, tool_choice: 'auto', stream });
    assert.equal(final.status, 200);
    assert(!final.message?.tool_calls?.length, 'Expected a final reply after the tool result');
    assert(final.message?.content?.includes(verificationCode), 'Final reply did not consume the fresh tool result');
    return { function: call.function.name, arguments: call.function.arguments, toolCallId: call.id, verificationCode, reply: final.message.content };
  });
}
await test('invalid-model error with stream requested', async () => {
  const result = await exchange('invalid-model', { model: `nexus-nonexistent-${randomBytes(8).toString('hex')}`, messages: [{ role: 'user', content: 'Hello' }], stream: true });
  assert(result.status >= 400, 'Invalid model must produce an HTTP error');
  assert(result.error, 'Error response missing');
  return { status: result.status, error: result.error };
});
report.finishedAt = new Date().toISOString();
report.passed = report.tests.every(item => item.passed);
await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Report: ${path.join(outputDir, 'report.json')}`);
process.exitCode = report.passed ? 0 : 1;
