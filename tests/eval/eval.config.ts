/**
 * tests/eval/eval.config.ts — TypeScript config entry point.
 *
 * Re-exports the ConfigLoader for programmatic access. Users can also set
 * EVAL_CONFIG env var to point to a YAML config file instead.
 *
 * Usage:
 *   import { loadConfig, getEnabledProviders } from './eval.config';
 *   const config = loadConfig('tests/eval/configs/default.yaml');
 */

export { loadConfig, getEnabledProviders, resolveApiKey } from './ConfigLoader';
