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
import { isDesktop, supportsLocalLLM, MOBILE_COMPATIBLE_PROVIDERS } from '../../utils/platform';

/**
 * Provider display configuration
 */
interface ProviderDisplayConfig {
    name: string;
    keyFormat: string;
    signupUrl: string;
    category: 'local' | 'cloud';
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

        this.render();
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

        const modalConfig: LLMProviderModalConfig = {
            providerId,
            providerName: displayConfig.name,
            keyFormat: displayConfig.keyFormat,
            signupUrl: displayConfig.signupUrl,
            config: { ...providerConfig },
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
