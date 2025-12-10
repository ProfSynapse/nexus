/**
 * Platform detection utilities for mobile compatibility.
 * Uses Obsidian's Platform API which is the official way to detect platform.
 *
 * Key notes:
 * - Node.js and Electron APIs are NOT available on mobile (will crash)
 * - iOS does not support regex lookbehind (?<=...)
 * - Tablets use desktop layout, .is-mobile only applies to phones
 * - Use body.is-mobile in CSS for mobile-specific styles
 */

import { Platform } from 'obsidian';

/**
 * Check if running on mobile (iOS or Android phone)
 */
export const isMobile = (): boolean => {
    return Platform.isMobile;
};

/**
 * Check if running on desktop (Mac, Windows, Linux)
 */
export const isDesktop = (): boolean => {
    return Platform.isDesktop;
};

/**
 * Check if running on iOS
 */
export const isIOS = (): boolean => {
    return Platform.isIosApp;
};

/**
 * Check if running on Android
 */
export const isAndroid = (): boolean => {
    return Platform.isAndroidApp;
};

/**
 * Check if running on macOS
 */
export const isMacOS = (): boolean => {
    return Platform.isMacOS;
};

/**
 * Check if running on Windows
 */
export const isWindows = (): boolean => {
    return Platform.isWin;
};

/**
 * Check if running on Linux
 */
export const isLinux = (): boolean => {
    return Platform.isLinux;
};

/**
 * Check if local LLM providers are supported (Ollama, LM Studio).
 * These require localhost servers which only work on desktop.
 */
export const supportsLocalLLM = (): boolean => {
    return Platform.isDesktop;
};

/**
 * Check if MCP bridge is supported.
 * MCP requires Node.js HTTP server (Express) which is not available on mobile.
 */
export const supportsMCPBridge = (): boolean => {
    return Platform.isDesktop;
};

/**
 * Check if WebLLM/Nexus local is supported.
 * Currently disabled entirely due to WebGPU crash bugs on Apple Silicon.
 */
export const supportsWebLLM = (): boolean => {
    // Disabled - see WebLLMEngine.ts for details
    return false;
};

/**
 * Get a human-readable platform name for logging/display
 * Note: Platform.isMobile can be true even on macOS (Catalyst/simulator)
 */
export const getPlatformName = (): string => {
    if (Platform.isIosApp) return 'iOS';
    if (Platform.isAndroidApp) return 'Android';
    // Note: isMacOS can be true alongside isMobile for Mac Catalyst builds
    if (Platform.isMacOS) return 'macOS';
    if (Platform.isWin) return 'Windows';
    if (Platform.isLinux) return 'Linux';
    return 'Unknown';
};

/**
 * Get detailed platform info for debugging
 */
export const getPlatformDebugInfo = (): Record<string, boolean> => {
    return {
        isMobile: Platform.isMobile,
        isDesktop: Platform.isDesktop,
        isIosApp: Platform.isIosApp,
        isAndroidApp: Platform.isAndroidApp,
        isMacOS: Platform.isMacOS,
        isWin: Platform.isWin,
        isLinux: Platform.isLinux,
    };
};

/**
 * List of features unavailable on mobile
 */
export const getMobileUnavailableFeatures = (): string[] => {
    if (!isMobile()) return [];

    return [
        'MCP Server (Claude Desktop bridge)',
        'Local LLM providers (Ollama, LM Studio)',
        'WebLLM/Nexus local models',
        'SDK-based providers (OpenAI, Anthropic, Google, Mistral, Groq)',
    ];
};

/**
 * LLM providers that work on mobile (use fetch/requestUrl, no Node.js SDKs)
 * These providers make direct HTTP requests without SDK dependencies.
 */
export const MOBILE_COMPATIBLE_PROVIDERS = [
    'openrouter',   // Uses fetch - 400+ models via unified API
    'requesty',     // Uses fetch - Router for multiple providers
    'perplexity',   // Uses fetch - Web search focused
] as const;

/**
 * LLM providers that require Node.js SDKs (desktop only)
 * These use official SDK packages that have Node.js dependencies.
 */
export const DESKTOP_ONLY_PROVIDERS = [
    'openai',       // Uses openai SDK
    'anthropic',    // Uses @anthropic-ai/sdk
    'google',       // Uses @google/genai
    'mistral',      // Uses @mistralai/mistralai
    'groq',         // Uses groq-sdk
    'ollama',       // Local server - desktop only
    'lmstudio',     // Local server - desktop only
    'webllm',       // WebGPU - disabled due to bugs
] as const;

/**
 * Check if a provider is compatible with the current platform
 */
export const isProviderCompatible = (providerId: string): boolean => {
    if (isDesktop()) {
        return true; // All providers work on desktop
    }

    // On mobile, only allow fetch-based providers
    return (MOBILE_COMPATIBLE_PROVIDERS as readonly string[]).includes(providerId);
};

/**
 * Get list of providers available on current platform
 */
export const getAvailableProviders = (): string[] => {
    if (isDesktop()) {
        return [...MOBILE_COMPATIBLE_PROVIDERS, ...DESKTOP_ONLY_PROVIDERS];
    }
    return [...MOBILE_COMPATIBLE_PROVIDERS];
};
