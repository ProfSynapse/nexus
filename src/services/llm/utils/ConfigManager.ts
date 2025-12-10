/**
 * Configuration Manager
 * Centralized configuration management for the lab kit
 * Handles environment variables, validation, and default settings
 *
 * MOBILE COMPATIBILITY (Dec 2025):
 * - Removed Node.js fs and path imports
 * - File config loading only works via Obsidian vault adapter
 * - Falls back to environment/default config if vault adapter not configured
 */

import { normalizePath } from 'obsidian';

export interface LabKitConfig {
  // Provider configurations
  providers: {
    openai: {
      apiKey?: string;
      baseUrl?: string;
      organization?: string;
      project?: string;
    };
    google: {
      apiKey?: string;
      projectId?: string;
      location?: string;
    };
    anthropic: {
      apiKey?: string;
      version?: string;
    };
    mistral: {
      apiKey?: string;
      endpoint?: string;
    };
    openrouter: {
      apiKey?: string;
      httpReferer?: string;
      xTitle?: string;
    };
    requesty: {
      apiKey?: string;
      baseUrl?: string;
    };
  };

  // Database configuration
  database: {
    supabase: {
      url?: string;
      anonKey?: string;
      serviceRoleKey?: string;
    };
  };


  // Default test settings
  defaults: {
    timeout: number;
    retries: number;
    concurrency: number;
    batchSize: number;
  };

  // Logging and debugging
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    enableFileLogging: boolean;
    logDirectory: string;
  };

  // Cache configuration
  cache: {
    llm: {
      enabled: boolean;
      type: 'memory' | 'file';
      maxSize: number;
      defaultTTL: number; // in milliseconds
      persistToDisk: boolean;
      cacheDir: string;
    };
    questions: {
      enabled: boolean;
      defaultTTL: number;
      cacheDir: string;
    };
  };
}

export class ConfigManager {
  private static instance: ConfigManager;
  private config: LabKitConfig;
  private configPath?: string;
  private static vaultAdapterConfig: { adapter: any; baseDir: string } | null = null;
  private vaultConfigLoaded: boolean = false;

  private constructor() {
    this.config = this.loadDefaultConfig();
    this.loadEnvironmentConfig();
    this.loadFileConfig();
    this.validateConfig();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Get the complete configuration
   */
  getConfig(): LabKitConfig {
    return { ...this.config };
  }

  /**
   * Get provider configuration
   */
  getProvider(name: keyof LabKitConfig['providers']): any {
    return this.config.providers[name];
  }

  /**
   * Get database configuration
   */
  getDatabase(): LabKitConfig['database'] {
    return this.config.database;
  }


  /**
   * Update configuration
   */
  updateConfig(updates: Partial<LabKitConfig>): void {
    this.config = this.mergeConfigs(this.config, updates);
    this.validateConfig();
    if (ConfigManager.vaultAdapterConfig) {
      void this.saveVaultConfig();
    }
  }

  /**
   * Load configuration from file
   */
  loadFromFile(path: string): void {
    this.configPath = path;
    this.loadFileConfig();
    this.validateConfig();
  }

  /**
   * Check if a provider is configured
   */
  isProviderConfigured(name: keyof LabKitConfig['providers']): boolean {
    const provider = this.config.providers[name];
    return !!(provider.apiKey);
  }

  /**
   * Get list of configured providers
   */
  getConfiguredProviders(): string[] {
    return Object.keys(this.config.providers).filter(name => 
      this.isProviderConfigured(name as keyof LabKitConfig['providers'])
    );
  }

  /**
   * Check if database is configured
   */
  isDatabaseConfigured(): boolean {
    const db = this.config.database.supabase;
    return !!(db.url && (db.anonKey || db.serviceRoleKey));
  }


  /**
   * Get cache configuration
   */
  getCacheConfig(): LabKitConfig['cache'] {
    return this.config.cache;
  }

  /**
   * Get LLM cache configuration
   */
  getLLMCacheConfig() {
    return this.config.cache.llm;
  }


  /**
   * Get questions cache configuration
   */
  getQuestionsCacheConfig() {
    return this.config.cache.questions;
  }

  /**
   * Check if LLM caching is enabled
   */
  isLLMCacheEnabled(): boolean {
    return this.config.cache.llm.enabled;
  }


  /**
   * Check if questions caching is enabled
   */
  isQuestionsCacheEnabled(): boolean {
    return this.config.cache.questions.enabled;
  }

  // Private methods

  private loadDefaultConfig(): LabKitConfig {
    return {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1'
        },
        google: {
          location: 'us-central1'
        },
        anthropic: {
          version: '2024-02-15'
        },
        mistral: {
          endpoint: 'https://api.mistral.ai/v1'
        },
        openrouter: {},
        requesty: {}
      },
      database: {
        supabase: {}
      },
      defaults: {
        timeout: 30000,
        retries: 3,
        concurrency: 5,
        batchSize: 10
      },
      logging: {
        level: 'info',
        enableFileLogging: false,
        logDirectory: './logs'
      },
      cache: {
        llm: {
          enabled: true,
          type: 'memory',
          maxSize: 1000,
          defaultTTL: 3600000, // 1 hour
          persistToDisk: false,
          cacheDir: '.cache/llm'
        },
        questions: {
          enabled: true,
          defaultTTL: 86400000, // 24 hours
          cacheDir: '.cache/questions'
        }
      }
    };
  }

  private loadEnvironmentConfig(): void {
    // Environment variables may not be available on mobile
    // This is a no-op on mobile platforms
    if (typeof process === 'undefined' || !process.env) {
      return;
    }

    // Provider API keys
    this.setIfExists('providers.openai.apiKey', process.env.OPENAI_API_KEY);
    this.setIfExists('providers.openai.organization', process.env.OPENAI_ORGANIZATION);
    this.setIfExists('providers.openai.project', process.env.OPENAI_PROJECT);
    
    this.setIfExists('providers.google.apiKey', process.env.GOOGLE_API_KEY);
    this.setIfExists('providers.google.projectId', process.env.GOOGLE_PROJECT_ID);
    
    this.setIfExists('providers.anthropic.apiKey', process.env.ANTHROPIC_API_KEY);
    
    this.setIfExists('providers.mistral.apiKey', process.env.MISTRAL_API_KEY);
    
    this.setIfExists('providers.openrouter.apiKey', process.env.OPENROUTER_API_KEY);
    this.setIfExists('providers.openrouter.httpReferer', process.env.OPENROUTER_HTTP_REFERER);
    this.setIfExists('providers.openrouter.xTitle', process.env.OPENROUTER_X_TITLE);
    
    this.setIfExists('providers.requesty.apiKey', process.env.REQUESTY_API_KEY);
    this.setIfExists('providers.requesty.baseUrl', process.env.REQUESTY_BASE_URL);

    // Database
    this.setIfExists('database.supabase.url', process.env.SUPABASE_URL);
    this.setIfExists('database.supabase.anonKey', process.env.SUPABASE_ANON_KEY);
    this.setIfExists('database.supabase.serviceRoleKey', process.env.SUPABASE_SERVICE_ROLE_KEY);


    // Defaults
    if (process.env.LAB_KIT_TIMEOUT) {
      this.config.defaults.timeout = parseInt(process.env.LAB_KIT_TIMEOUT);
    }
    if (process.env.LAB_KIT_RETRIES) {
      this.config.defaults.retries = parseInt(process.env.LAB_KIT_RETRIES);
    }
    if (process.env.LAB_KIT_CONCURRENCY) {
      this.config.defaults.concurrency = parseInt(process.env.LAB_KIT_CONCURRENCY);
    }

    // Logging
    if (process.env.LAB_KIT_LOG_LEVEL) {
      this.config.logging.level = process.env.LAB_KIT_LOG_LEVEL as any;
    }
    if (process.env.LAB_KIT_LOG_DIRECTORY) {
      this.config.logging.logDirectory = process.env.LAB_KIT_LOG_DIRECTORY;
    }

    // Cache configuration
    if (process.env.LAB_KIT_CACHE_LLM_ENABLED) {
      this.config.cache.llm.enabled = process.env.LAB_KIT_CACHE_LLM_ENABLED === 'true';
    }
    if (process.env.LAB_KIT_CACHE_LLM_TYPE) {
      this.config.cache.llm.type = process.env.LAB_KIT_CACHE_LLM_TYPE as 'memory' | 'file';
    }
    if (process.env.LAB_KIT_CACHE_LLM_MAX_SIZE) {
      this.config.cache.llm.maxSize = parseInt(process.env.LAB_KIT_CACHE_LLM_MAX_SIZE);
    }
    if (process.env.LAB_KIT_CACHE_LLM_TTL) {
      this.config.cache.llm.defaultTTL = parseInt(process.env.LAB_KIT_CACHE_LLM_TTL);
    }
    if (process.env.LAB_KIT_CACHE_LLM_PERSIST) {
      this.config.cache.llm.persistToDisk = process.env.LAB_KIT_CACHE_LLM_PERSIST === 'true';
    }
    if (process.env.LAB_KIT_CACHE_LLM_DIR) {
      this.config.cache.llm.cacheDir = process.env.LAB_KIT_CACHE_LLM_DIR;
    }


    if (process.env.LAB_KIT_CACHE_QUESTIONS_ENABLED) {
      this.config.cache.questions.enabled = process.env.LAB_KIT_CACHE_QUESTIONS_ENABLED === 'true';
    }
    if (process.env.LAB_KIT_CACHE_QUESTIONS_TTL) {
      this.config.cache.questions.defaultTTL = parseInt(process.env.LAB_KIT_CACHE_QUESTIONS_TTL);
    }
    if (process.env.LAB_KIT_CACHE_QUESTIONS_DIR) {
      this.config.cache.questions.cacheDir = process.env.LAB_KIT_CACHE_QUESTIONS_DIR;
    }
  }

  private loadFileConfig(): void {
    // File config loading only supported via vault adapter (mobile compatible)
    // Desktop file system access removed for mobile compatibility
    // Config will be loaded from vault adapter when setVaultAdapter is called
  }

  private setIfExists(path: string, value: any): void {
    if (value !== undefined && value !== null && value !== '') {
      this.setNestedValue(this.config, path, value);
    }
  }

  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!key) continue;
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key];
    }
    
    const lastKey = keys[keys.length - 1];
    if (lastKey) {
      current[lastKey] = value;
    }
  }

  private mergeConfigs(base: any, override: any): any {
    const result = { ...base };
    
    for (const key in override) {
      if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])) {
        result[key] = this.mergeConfigs(result[key] || {}, override[key]);
      } else {
        result[key] = override[key];
      }
    }
    
    return result;
  }

  private validateConfig(): void {
    const errors: string[] = [];

    // Check for at least one provider
    const configuredProviders = this.getConfiguredProviders();
    if (configuredProviders.length === 0) {
      errors.push('At least one LLM provider must be configured');
    }

    // Validate timeout values
    if (this.config.defaults.timeout < 1000) {
      errors.push('Timeout must be at least 1000ms');
    }

    if (this.config.defaults.retries < 0 || this.config.defaults.retries > 10) {
      errors.push('Retries must be between 0 and 10');
    }

    if (this.config.defaults.concurrency < 1 || this.config.defaults.concurrency > 50) {
      errors.push('Concurrency must be between 1 and 50');
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
  }

  /**
   * Get configuration summary for debugging
   */
  getConfigSummary(): Record<string, any> {
    return {
      providers: {
        configured: this.getConfiguredProviders(),
        total: Object.keys(this.config.providers).length
      },
      database: {
        configured: this.isDatabaseConfigured()
      },
      defaults: this.config.defaults,
      logging: this.config.logging
    };
  }

  /**
   * Configure vault adapter for Obsidian environments (uses vault-relative config paths).
   */
  static setVaultAdapter(adapter: any, baseDir: string = '.nexus/config') {
    this.vaultAdapterConfig = { adapter, baseDir };
    if (ConfigManager.instance) {
      void ConfigManager.instance.loadVaultConfigFromAdapter().then(() => {
        void ConfigManager.instance?.saveVaultConfig();
      });
    }
  }

  /**
   * Ensure vault-backed config is loaded (no-op if already loaded or adapter missing).
   */
  static async ensureVaultConfigLoaded(): Promise<void> {
    if (ConfigManager.instance) {
      await ConfigManager.instance.loadVaultConfigFromAdapter();
    }
  }

  /**
   * Persist current config into vault-backed path (if adapter configured).
   */
  async saveVaultConfig(): Promise<void> {
    if (!ConfigManager.vaultAdapterConfig) return;
    const adapter = ConfigManager.vaultAdapterConfig.adapter;
    const baseDir = normalizePath(ConfigManager.vaultAdapterConfig.baseDir || '.nexus/config');
    const targetPath = this.getVaultConfigPath();
    try {
      await adapter.mkdir(baseDir);
      await adapter.write(targetPath, JSON.stringify(this.config, null, 2));
      console.log(`📁 Saved configuration to vault path ${targetPath}`);
    } catch (error) {
      console.warn(`Failed to save config to vault path ${targetPath}:`, error);
    }
  }

  private async loadVaultConfigFromAdapter(): Promise<void> {
    if (this.vaultConfigLoaded || !ConfigManager.vaultAdapterConfig) return;
    const adapter = ConfigManager.vaultAdapterConfig.adapter;
    const targetPath = this.getVaultConfigPath();
    try {
      const exists = await adapter.exists(targetPath);
      if (!exists) {
        this.vaultConfigLoaded = true;
        return;
      }
      const content = await adapter.read(targetPath);
      const parsed = JSON.parse(content);
      this.config = this.mergeConfigs(this.config, parsed);
      this.vaultConfigLoaded = true;
      console.log(`📁 Loaded configuration from vault path ${targetPath}`);
    } catch (error) {
      console.warn(`Failed to load config from vault path ${targetPath}:`, error);
    }
  }

  private getVaultConfigPath(): string {
    const baseDir = ConfigManager.vaultAdapterConfig?.baseDir || '.nexus/config';
    return normalizePath(`${baseDir}/lab-kit.config.json`);
  }
}
