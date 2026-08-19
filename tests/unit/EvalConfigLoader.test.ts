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
});
