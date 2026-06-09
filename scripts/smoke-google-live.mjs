import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const GOOGLE_LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';
const DEFAULT_PROMPT = 'Reply with exactly the single word pong.';
const DEFAULT_TIMEOUT_MS = 30000;

loadEnvFiles(process.cwd(), ['.env.local', '.env']);

const apiKey = firstNonEmpty(process.env.GOOGLE_API_KEY, process.env.GEMINI_API_KEY);
if (!apiKey) {
  console.error('Missing GOOGLE_API_KEY or GEMINI_API_KEY. Add one to your shell or repo .env before running this smoke test.');
  process.exit(1);
}

if (typeof WebSocket === 'undefined') {
  console.error('Global WebSocket is unavailable in this Node runtime.');
  process.exit(1);
}

const model = firstNonEmpty(process.env.GOOGLE_LIVE_MODEL, process.env.GEMINI_LIVE_MODEL) ?? DEFAULT_MODEL;
const prompt = process.env.GOOGLE_LIVE_SMOKE_PROMPT?.trim() || DEFAULT_PROMPT;
const voice = firstNonEmpty(process.env.GOOGLE_LIVE_SMOKE_VOICE, process.env.GOOGLE_LIVE_VOICE) ?? 'Kore';
const timeoutMs = parsePositiveInteger(process.env.GOOGLE_LIVE_SMOKE_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

const url = `${GOOGLE_LIVE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
const websocket = new WebSocket(url);

const summary = {
  opened: false,
  setupComplete: false,
  generationComplete: false,
  turnComplete: false,
  audioChunkCount: 0,
  audioBytes: 0,
  outputTranscript: '',
  closeCode: null,
  firstMessageType: null,
  firstServerFrame: null,
};

let settled = false;

const timeout = setTimeout(() => {
  finish(new Error(`Timed out after ${timeoutMs}ms waiting for Gemini Live response.`));
}, timeoutMs);

websocket.addEventListener('open', () => {
  summary.opened = true;
  websocket.send(JSON.stringify({
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      },
      outputAudioTranscription: {},
    },
  }));
});

websocket.addEventListener('message', async (event) => {
  try {
    const rawText = await coerceMessageText(event.data);
    if (!rawText) {
      return;
    }

    if (!summary.firstMessageType) {
      summary.firstMessageType = describeMessagePayload(event.data);
      summary.firstServerFrame = rawText.slice(0, 500);
    }

    const message = JSON.parse(rawText);
    if (message.setupComplete !== undefined) {
      summary.setupComplete = true;
      websocket.send(JSON.stringify({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
          turnComplete: true,
        },
      }));
      return;
    }

    if (message.serverContent) {
      const { serverContent } = message;
      if (typeof serverContent.outputTranscription?.text === 'string') {
        summary.outputTranscript = serverContent.outputTranscription.text.trim();
      }

      const parts = Array.isArray(serverContent.modelTurn?.parts) ? serverContent.modelTurn.parts : [];
      for (const part of parts) {
        const data = part?.inlineData?.data;
        if (typeof data !== 'string' || data.length === 0) {
          continue;
        }
        summary.audioChunkCount += 1;
        summary.audioBytes += estimateBase64Bytes(data);
      }

      if (serverContent.generationComplete === true) {
        summary.generationComplete = true;
      }

      if (serverContent.turnComplete === true) {
        summary.turnComplete = true;
      }

      if (summary.turnComplete && (summary.audioChunkCount > 0 || summary.outputTranscript.length > 0)) {
        finish();
      }
      return;
    }

    if (message.goAway) {
      finish(new Error('Gemini Live sent goAway before the smoke test completed.'));
      return;
    }

    if (message.toolCall) {
      finish(new Error('Gemini Live requested a tool call during the smoke test, which this harness does not handle.'));
    }
  } catch (error) {
    finish(error);
  }
});

websocket.addEventListener('error', () => {
  finish(new Error('Gemini Live WebSocket failed. Check network access and API key configuration.'));
});

websocket.addEventListener('close', (event) => {
  summary.closeCode = event.code;
  if (!settled) {
    finish(new Error(`Gemini Live WebSocket closed before completion (code ${event.code}${event.reason ? `, reason: ${event.reason}` : ''}).`));
  }
});

function finish(error) {
  if (settled) {
    return;
  }
  settled = true;
  clearTimeout(timeout);

  if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
    websocket.close();
  }

  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    status: 'ok',
    model,
    voice,
    prompt,
    ...summary,
  }, null, 2));
}

function loadEnvFiles(rootDir, fileNames) {
  for (const fileName of fileNames) {
    const filePath = path.join(rootDir, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) {
        continue;
      }

      const [, key, rawValue] = match;
      if (process.env[key]) {
        continue;
      }

      process.env[key] = stripMatchingQuotes(rawValue);
    }
  }
}

function stripMatchingQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function parsePositiveInteger(value) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function estimateBase64Bytes(base64) {
  const normalized = base64.replace(/=+$/, '');
  return Math.floor(normalized.length * 3 / 4);
}

async function coerceMessageText(data) {
  if (typeof data === 'string') {
    return data;
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return await data.text();
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  return null;
}

function describeMessagePayload(data) {
  if (typeof data === 'string') {
    return 'string';
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return 'blob';
  }

  if (data instanceof ArrayBuffer) {
    return 'arraybuffer';
  }

  if (ArrayBuffer.isView(data)) {
    return data.constructor?.name ?? 'typed-array';
  }

  return typeof data;
}