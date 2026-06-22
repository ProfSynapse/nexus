import { buildGeminiCliEnv } from '../../src/utils/geminiCli';

/**
 * Direct unit tests for the agy child-process env-strip.
 *
 * SECURITY-LOAD-BEARING: buildGeminiCliEnv removes ambient provider credentials
 * from the spawned agy process's environment so agy falls back to its own
 * file-based OAuth (~/.gemini) and never silently authenticates with an
 * ambient API key. agy fronts Google, Anthropic, AND OpenAI models, so all
 * three credential families must be stripped.
 *
 * These call buildGeminiCliEnv() WITHOUT a nodePath so the PATH-prepend branch
 * (which needs the desktop `path` module via window.require) is skipped — the
 * key-strip logic runs unconditionally and is what we assert here.
 */
describe('buildGeminiCliEnv (credential strip)', () => {
  const STRIPPED_KEYS = [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY'
  ];

  // Snapshot + restore the real process.env keys we mutate, so the suite is isolated.
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [...STRIPPED_KEYS, 'NEXUS_UNRELATED_TEST_KEY']) {
      saved[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of [...STRIPPED_KEYS, 'NEXUS_UNRELATED_TEST_KEY']) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('strips all Google, Anthropic, and OpenAI credential keys', () => {
    for (const key of STRIPPED_KEYS) {
      process.env[key] = `sentinel-${key}`;
    }

    const env = buildGeminiCliEnv();

    for (const key of STRIPPED_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('explicitly strips ANTHROPIC_API_KEY and OPENAI_API_KEY (agy fronts Claude/GPT too)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-sentinel';
    process.env.OPENAI_API_KEY = 'sk-openai-sentinel';

    const env = buildGeminiCliEnv();

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('preserves unrelated environment variables', () => {
    process.env.NEXUS_UNRELATED_TEST_KEY = 'keep-me';

    const env = buildGeminiCliEnv();

    expect(env.NEXUS_UNRELATED_TEST_KEY).toBe('keep-me');
  });

  it('returns a copy — does not mutate the real process.env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-sentinel';

    buildGeminiCliEnv();

    // The strip happens on the returned copy, not the live process env.
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-sentinel');
  });
});
