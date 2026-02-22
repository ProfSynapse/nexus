/**
 * ProvidersTab - LLM providers configuration
 *
 * Features:
 * - Grouped provider list (Local vs Cloud)
 * - Status badges (configured/not configured)
 * - Detail view opens LLMProviderModal
 * - Auto-save on all changes
 *
 * Note: Default provider/model/thinking settings moved to DefaultsTab
 */

import { App, Notice } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { LLMProviderSettings, LLMProviderConfig } from '../../types/llm/ProviderTypes';
import { LLMProviderModal, LLMProviderModalConfig } from '../../components/LLMProviderModal';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { Settings } from '../../settings';
import { Card, CardConfig } from '../../components/Card';
import { LLMSettingsNotifier } from '../../services/llm/LLMSettingsNotifier';
import { isDesktop, supportsLocalLLM, MOBILE_COMPATIBLE_PROVIDERS, isProviderComingSoon } from '../../utils/platform';
import type { OAuthModalConfig, SecondaryOAuthProviderConfig } from '../../components/llm-provider/types';
import { OAuthService } from '../../services/oauth/OAuthService';

/**
 * Provider display configuration
 */
interface ProviderDisplayConfig {
    name: string;
    keyFormat: string;
    signupUrl: string;
    category: 'local' | 'cloud';
    oauthConfig?: OAuthModalConfig;
}

export interface ProvidersTabServices {
    app: App;
    settings: Settings;
    llmProviderSettings?: LLMProviderSettings;
}

export class ProvidersTab {
    private container: HTMLElement;
    private router: SettingsRouter;
    private services: ProvidersTabServices;
    private providerManager: LLMProviderManager;

    // Provider configurations
    private readonly providerConfigs: Record<string, ProviderDisplayConfig> = {
        // ═══════════════════════════════════════════════════════════════════════
        // NEXUS/WEBLLM (Re-enabled Dec 2025)
        // Local LLM inference via WebGPU - Nexus models are fine-tuned on toolset
        // ═══════════════════════════════════════════════════════════════════════
        webllm: {
            name: 'Nexus (Local)',
            keyFormat: 'No API key required',
            signupUrl: '',
            category: 'local'
        },
        // Local providers
        ollama: {
            name: 'Ollama',
            keyFormat: 'http://127.0.0.1:11434',
            signupUrl: 'https://ollama.com/download',
            category: 'local'
        },
        lmstudio: {
            name: 'LM Studio',
            keyFormat: 'http://127.0.0.1:1234',
            signupUrl: 'https://lmstudio.ai',
            category: 'local'
        },
        // Cloud providers
        openai: {
            name: 'OpenAI',
            keyFormat: 'sk-proj-...',
            signupUrl: 'https://platform.openai.com/api-keys',
            category: 'cloud'
        },
        anthropic: {
            name: 'Anthropic',
            keyFormat: 'sk-ant-...',
            signupUrl: 'https://console.anthropic.com/login',
            category: 'cloud'
        },
        google: {
            name: 'Google AI',
            keyFormat: 'AIza...',
            signupUrl: 'https://aistudio.google.com/app/apikey',
            category: 'cloud'
        },
        mistral: {
            name: 'Mistral AI',
            keyFormat: 'msak_...',
            signupUrl: 'https://console.mistral.ai/api-keys',
            category: 'cloud'
        },
        groq: {
            name: 'Groq',
            keyFormat: 'gsk_...',
            signupUrl: 'https://console.groq.com/keys',
            category: 'cloud'
        },
        openrouter: {
            name: 'OpenRouter',
            keyFormat: 'sk-or-...',
            signupUrl: 'https://openrouter.ai/keys',
            category: 'cloud'
        },
        requesty: {
            name: 'Requesty',
            keyFormat: 'req_...',
            signupUrl: 'https://requesty.com/api-keys',
            category: 'cloud'
        },
        perplexity: {
            name: 'Perplexity',
            keyFormat: 'pplx-...',
            signupUrl: 'https://www.perplexity.ai/settings/api',
            category: 'cloud'
        },
        'openai-codex': {
            name: 'ChatGPT (Codex)',
            keyFormat: 'OAuth sign-in required',
            signupUrl: 'https://chatgpt.com',
            category: 'cloud'
        }
    };

    constructor(
        container: HTMLElement,
        router: SettingsRouter,
        services: ProvidersTabServices
    ) {
        this.container = container;
        this.router = router;
        this.services = services;

        // Initialize provider manager with vault for local provider support
        if (this.services.llmProviderSettings) {
            this.providerManager = new LLMProviderManager(this.services.llmProviderSettings, this.services.app.vault);
        } else {
            this.providerManager = new LLMProviderManager({
                providers: {},
                defaultModel: { provider: '', model: '' }
            }, this.services.app.vault);
        }

        // Attach OAuth configs to providers that support it (desktop only)
        if (isDesktop()) {
            this.attachOAuthConfigs();
        }

        this.render();
    }

    /**
     * Attach OAuth configurations to providers that support OAuth connect.
     * Only called on desktop where the OAuth callback server can run.
     */
    private attachOAuthConfigs(): void {
        const oauthService = OAuthService.getInstance();

        // OpenRouter OAuth
        if (oauthService.hasProvider('openrouter')) {
            this.providerConfigs.openrouter.oauthConfig = {
                providerLabel: 'OpenRouter',
                preAuthFields: [
                    {
                        key: 'key_name',
                        label: 'Key label',
                        defaultValue: 'Claudesidian MCP',
                        required: false,
                    },
                    {
                        key: 'limit',
                        label: 'Credit limit (optional)',
                        placeholder: 'Leave blank for unlimited',
                        required: false,
                    },
                ],
                startFlow: (params) => this.startOAuthFlow('openrouter', params),
            };
        }

        // OpenAI Codex OAuth (experimental) — attaches to 'openai-codex' provider card,
        // NOT 'openai', so tokens are stored under providers['openai-codex'] where
        // AdapterRegistry.initializeCodexAdapter() reads them.
        if (oauthService.hasProvider('openai-codex')) {
            this.providerConfigs['openai-codex'] = {
                ...this.providerConfigs['openai-codex'],
                oauthConfig: {
                    providerLabel: 'ChatGPT',
                    startFlow: (params) => this.startOAuthFlow('openai-codex', params),
                },
            };
        }
    }

    /**
     * Start an OAuth flow for a given provider via OAuthService
     */
    private async startOAuthFlow(
        providerId: string,
        params: Record<string, string>,
    ): Promise<{ success: boolean; apiKey?: string; refreshToken?: string; expiresAt?: number; metadata?: Record<string, string>; error?: string }> {
        try {
            const oauthService = OAuthService.getInstance();
            // Cancel any stuck flow before starting a new one (e.g., user dismissed modal while connecting)
            if (oauthService.getState() !== 'idle') {
                oauthService.cancelFlow();
            }
            const result = await oauthService.startFlow(providerId, params);
            return {
                success: true,
                apiKey: result.apiKey,
                refreshToken: result.refreshToken,
                expiresAt: result.expiresAt,
                metadata: result.metadata,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'OAuth flow failed',
            };
        }
    }

    /**
     * Get current LLM settings
     */
    private getSettings(): LLMProviderSettings {
        return this.services.llmProviderSettings || {
            providers: {},
            defaultModel: { provider: '', model: '' }
        };
    }

    /**
     * Save settings and notify subscribers
     */
    private async saveSettings(): Promise<void> {
        if (this.services.settings && this.services.llmProviderSettings) {
            this.services.settings.settings.llmProviders = this.services.llmProviderSettings;
            await this.services.settings.saveSettings();

            // Notify all subscribers of the settings change
            LLMSettingsNotifier.notify(this.services.llmProviderSettings);
        }
    }

    /**
     * Main render method
     */
    render(): void {
        this.container.empty();

        // Provider groups only - defaults moved to DefaultsTab
        this.renderProviderGroups();
    }

    /**
     * Render provider groups (Local and Cloud)
     */
    private renderProviderGroups(): void {
        const settings = this.getSettings();

        // Mobile: Only fetch-based providers work (no Node.js/Electron SDKs)
        if (!isDesktop()) {
            this.container.createEl('p', {
                cls: 'setting-item-description',
                text: 'On mobile, only OpenRouter, Requesty, and Perplexity are supported. Configure local providers and SDK-based providers on desktop.'
            });
            this.container.createDiv('nexus-provider-group-title').setText('MOBILE PROVIDERS');
            this.renderProviderList([...MOBILE_COMPATIBLE_PROVIDERS], settings);
            return;
        }

        // Desktop: Local providers (require localhost servers or WebGPU)
        if (supportsLocalLLM()) {
            this.container.createDiv('nexus-provider-group-title').setText('LOCAL PROVIDERS');
            this.renderProviderList(['webllm', 'ollama', 'lmstudio'], settings);
        }

        // Desktop: Cloud providers (SDK + fetch-based)
        this.container.createDiv('nexus-provider-group-title').setText('CLOUD PROVIDERS');
        this.renderProviderList(
            ['openai', 'anthropic', 'google', 'mistral', 'groq', 'openrouter', 'requesty', 'perplexity'],
            settings
        );
    }

    /**
     * Render a list of providers as cards
     */
    private renderProviderList(providerIds: string[], settings: LLMProviderSettings): void {
        const grid = this.container.createDiv('card-manager-grid');

        providerIds.forEach(providerId => {
            const displayConfig = this.providerConfigs[providerId];
            if (!displayConfig) return;

            const providerConfig = settings.providers[providerId] || {
                apiKey: '',
                enabled: false
            };

            // Check if this provider is coming soon
            const comingSoon = isProviderComingSoon(providerId);

            if (comingSoon) {
                // Coming Soon card - no toggle, no edit
                const cardConfig: CardConfig = {
                    title: displayConfig.name,
                    description: 'Coming Soon',
                    isEnabled: false,
                    showToggle: false
                    // No onEdit - prevents edit button from appearing
                };
                const card = new Card(grid, cardConfig);
                card.getElement().addClass('provider-coming-soon');
            } else {
                const isConfigured = this.isProviderConfigured(providerId, providerConfig);

                // Create card for this provider
                const cardConfig: CardConfig = {
                    title: displayConfig.name,
                    description: isConfigured ? 'Configured' : 'Not configured',
                    isEnabled: providerConfig.enabled,
                    showToggle: true,
                    onToggle: async (enabled: boolean) => {
                        settings.providers[providerId] = {
                            ...providerConfig,
                            enabled
                        };
                        await this.saveSettings();
                        this.render(); // Re-render to update defaults dropdown
                    },
                    onEdit: () => {
                        this.openProviderModal(providerId, displayConfig, providerConfig);
                    }
                };

                new Card(grid, cardConfig);
            }
        });
    }

    /**
     * Check if a provider is configured
     */
    private isProviderConfigured(providerId: string, config: LLMProviderConfig): boolean {
        if (!config.enabled) return false;
        // WebLLM doesn't need an API key
        if (providerId === 'webllm') return true;
        // Other providers need an API key
        return !!config.apiKey;
    }

    /**
     * Open provider configuration modal
     */
    private openProviderModal(
        providerId: string,
        displayConfig: ProviderDisplayConfig,
        providerConfig: LLMProviderConfig
    ): void {
        const settings = this.getSettings();

        // Build secondary OAuth provider config for OpenAI (Codex sub-section)
        let secondaryOAuthProvider: SecondaryOAuthProviderConfig | undefined;
        if (providerId === 'openai') {
            const codexDisplay = this.providerConfigs['openai-codex'];
            if (codexDisplay?.oauthConfig) {
                const codexConfig = settings.providers['openai-codex'] || {
                    apiKey: '',
                    enabled: false,
                };
                secondaryOAuthProvider = {
                    providerId: 'openai-codex',
                    providerLabel: 'ChatGPT (Codex)',
                    description: 'Connect your ChatGPT Plus/Pro account to use GPT-5 models via OAuth.',
                    config: { ...codexConfig },
                    oauthConfig: codexDisplay.oauthConfig,
                    onConfigChange: async (updatedCodexConfig: LLMProviderConfig) => {
                        settings.providers['openai-codex'] = updatedCodexConfig;
                        await this.saveSettings();
                    },
                };
            }
        }

        const modalConfig: LLMProviderModalConfig = {
            providerId,
            providerName: displayConfig.name,
            keyFormat: displayConfig.keyFormat,
            signupUrl: displayConfig.signupUrl,
            config: { ...providerConfig },
            oauthConfig: displayConfig.oauthConfig,
            secondaryOAuthProvider,
            onSave: async (updatedConfig: LLMProviderConfig) => {
                settings.providers[providerId] = updatedConfig;

                // Handle Ollama model update
                if (providerId === 'ollama' && '__ollamaModel' in updatedConfig) {
                    const ollamaModel = (updatedConfig as LLMProviderConfig & { __ollamaModel: string }).__ollamaModel;
                    if (ollamaModel) {
                        delete (updatedConfig as LLMProviderConfig & { __ollamaModel?: string }).__ollamaModel;
                        if (settings.defaultModel.provider === 'ollama') {
                            settings.defaultModel.model = ollamaModel;
                        }
                    }
                }

                await this.saveSettings();
                this.render(); // Refresh the view
                new Notice(`${displayConfig.name} settings saved`);
            }
        };

        new LLMProviderModal(this.services.app, modalConfig, this.providerManager).open();
    }

    /**
     * Cleanup
     */
    destroy(): void {
        // No resources to clean up
    }
}
