import { ModelSpec } from '../modelTypes';

/**
 * Catalog of BASE Gemini models exposed by the Antigravity CLI (`agy`) for the
 * `google-gemini-cli` provider.
 *
 * Effort is NOT baked into the catalog. agy exposes each base model at several
 * effort levels (`agy models`: Gemini 3.5 Flash = Low/Medium/High; Gemini 3.1
 * Pro = Low/High — no Medium), but that effort comes from Nexus's existing
 * thinking/effort SLIDER, not from distinct model entries. So the catalog lists
 * just the 2 BASE models; the adapter composes the agy `--model "Base (Effort)"`
 * label at invocation time from base slug + slider effort (see
 * geminiCliModelNormalize.ts `composeAgyModelLabel`). Keep this catalog and that
 * module in LOCKSTEP — every base `apiName` here must be a known base there.
 *
 * Non-Gemini agy models (Claude Sonnet/Opus, GPT-OSS) are intentionally excluded
 * per product decision: this provider is Gemini-only.
 *
 * CAPABILITY NOTE — text-completion only. The Antigravity `agy --print` surface
 * supports NEITHER tool/function calling NOR streaming (investigation #62/#64/#66
 * proved every tool-use path NOT-FEASIBLE, and `--print` buffers one response).
 * So `supportsFunctions` and `supportsStreaming` are BOTH false here — this is the
 * single source of truth for the limitation; the user-facing warning surfaces
 * (settings notice + runtime guard) and the chat tool-schema suppression all key
 * off the text-only provider seam (see isTextOnlyProvider in ToolSchemaSupport.ts).
 */
export const GOOGLE_GEMINI_CLI_MODELS: ModelSpec[] = [
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 3.5 Flash',
    apiName: 'gemini-3.5-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: false,
      supportsStreaming: false,
      supportsThinking: true
    }
  },
  {
    provider: 'google-gemini-cli',
    name: 'Gemini 3.1 Pro',
    apiName: 'gemini-3.1-pro',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: false,
      supportsStreaming: false,
      supportsThinking: true
    }
  }
];

export const GOOGLE_GEMINI_CLI_DEFAULT_MODEL = 'gemini-3.5-flash';
