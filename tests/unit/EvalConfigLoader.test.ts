describe('EvalConfigLoader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.EVAL_TARGETS;
    delete process.env.EVAL_PROVIDER;
    delete process.env.EVAL_MODEL;
    delete process.env.EVAL_MODELS;
    delete process.env.EVAL_MODE;
    delete process.env.EVAL_SCENARIOS;
    delete process.env.EVAL_SCENARIO_NAMES;
    delete process.env.EVAL_TOOL_SET;
    delete process.env.EVAL_MAX_RETRIES;
    delete process.env.EVAL_RETRY_DELAY_MS;
    delete process.env.EVAL_RETRY_BACKOFF_MULTIPLIER;
    delete process.env.EVAL_RETRY_MAX_DELAY_MS;
    delete process.env.EVAL_TIMEOUT_MS;
    delete process.env.EVAL_SCHEMA_VERSION;
    delete process.env.EVAL_MAX_TOKENS;
    delete process.env.EVAL_MAX_TOOL_ITERATIONS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('overrides providers from arbitrary EVAL_TARGETS entries', async () => {
    process.env.EVAL_TARGETS = [
      'openrouter=deepseek/deepseek-v4-pro',
      'openrouter=deepseek/deepseek-v4-flash',
      'openai=openai/gpt-5.4',
    ].join(',');

    const { loadConfig } = await import('../eval/ConfigLoader');
    const config = loadConfig();

    expect(Object.keys(config.providers).sort()).toEqual(['openai', 'openrouter']);
    expect(config.providers.openrouter).toMatchObject({
      apiKeyEnv: 'OPENROUTER_API_KEY',
      enabled: true,
      models: ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash'],
    });
    expect(config.providers.openai).toMatchObject({
      apiKeyEnv: 'OPENAI_API_KEY',
      enabled: true,
      models: ['gpt-5.4'],
    });
  });

  it('supports single-provider shorthand and eval filters', async () => {
    process.env.EVAL_PROVIDER = 'openrouter';
    process.env.EVAL_MODELS = 'anthropic/claude-sonnet-4.6,openai/gpt-5.4-mini';
    process.env.EVAL_MODE = 'live';
    process.env.EVAL_SCENARIOS = 'tests/eval/scenarios/search-variations.eval.yaml';
    process.env.EVAL_SCENARIO_NAMES = 'simple-read,replace-content,create-folder-structure';
    process.env.EVAL_TOOL_SET = 'meta';
    process.env.EVAL_MAX_RETRIES = '3';
    process.env.EVAL_RETRY_DELAY_MS = '500';
    process.env.EVAL_RETRY_BACKOFF_MULTIPLIER = '3';
    process.env.EVAL_RETRY_MAX_DELAY_MS = '10000';
    process.env.EVAL_TIMEOUT_MS = '90000';
    process.env.EVAL_SCHEMA_VERSION = '5.17.2';

    const { loadConfig } = await import('../eval/ConfigLoader');
    const config = loadConfig();

    expect(config.mode).toBe('live');
    expect(config.schemaVersion).toBe('5.17.2');
    expect(config.scenarios).toBe('tests/eval/scenarios/search-variations.eval.yaml');
    expect(config.scenarioNames).toEqual([
      'simple-read',
      'replace-content',
      'create-folder-structure',
    ]);
    expect(config.scenarioToolSet).toBe('meta');
    expect(config.defaults).toMatchObject({
      maxRetries: 3,
      retryDelayMs: 500,
      retryBackoffMultiplier: 3,
      retryMaxDelayMs: 10000,
      timeout: 90000,
    });
    expect(config.providers).toEqual({
      openrouter: {
        apiKeyEnv: 'OPENROUTER_API_KEY',
        enabled: true,
        models: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.4-mini'],
      },
    });
  });

  it('resolves enabled provider API keys from process env', async () => {
    process.env.EVAL_TARGETS = 'openrouter=deepseek/deepseek-v4-flash';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

    const { getEnabledProviders, loadConfig } = await import('../eval/ConfigLoader');
    const providers = getEnabledProviders(loadConfig());

    expect(providers).toEqual([
      {
        id: 'openrouter',
        apiKey: 'test-openrouter-key',
        models: ['deepseek/deepseek-v4-flash'],
      },
    ]);
  });

  it('loads the bounded Argon matrix and permits explicit budget overrides', async () => {
    const { loadConfig } = await import('../eval/ConfigLoader');
    const config = loadConfig('tests/eval/configs/gemini-4-argon-2026-10-13.yaml');
    expect(config.providers.google.models).toEqual(['gemini-4-argon']);
    expect(config.scenarioNames).toHaveLength(5);
    expect(config.defaults).toMatchObject({ maxTokens: 2048, maxToolIterations: 4, maxRetries: 0,
      enableThinking: true, thinkingEffort: 'low' });
    process.env.EVAL_MAX_TOKENS = '1024';
    process.env.EVAL_MAX_TOOL_ITERATIONS = '2';
    expect(loadConfig('tests/eval/configs/gemini-4-argon-2026-10-13.yaml').defaults)
      .toMatchObject({ maxTokens: 1024, maxToolIterations: 2 });
  });

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity'])('rejects unsafe budget %s instead of silently dropping it', async value => {
    const { loadConfig } = await import('../eval/ConfigLoader');
    process.env.EVAL_MAX_TOKENS = value;
    expect(() => loadConfig()).toThrow('maxTokens must be a positive integer');
    delete process.env.EVAL_MAX_TOKENS;
    process.env.EVAL_MAX_TOOL_ITERATIONS = value;
    expect(() => loadConfig()).toThrow('maxToolIterations must be a positive integer');
  });

  it('does not change the output or iteration limits of existing configs', async () => {
    const { loadConfig } = await import('../eval/ConfigLoader');
    expect(loadConfig().defaults.maxTokens).toBeUndefined();
    expect(loadConfig().defaults.maxToolIterations).toBeUndefined();
  });
});
