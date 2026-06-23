import { Platform, Vault } from 'obsidian';
import { resolveDesktopBinaryPath } from './binaryDiscovery';
import { getVaultBasePath } from './cliPathUtils';

export interface GeminiCliRuntime {
    geminiPath: string | null;
    nodePath: string | null;
    vaultPath: string | null;
}

type GeminiCliDesktopModuleMap = {
    path: typeof import('path');
};

function loadDesktopModule<TModuleName extends keyof GeminiCliDesktopModuleMap>(
    moduleName: TModuleName
): GeminiCliDesktopModuleMap[TModuleName] {
    if (!Platform.isDesktop) {
        throw new Error(`${moduleName} is only available on desktop.`);
    }

    const maybeRequire = (window.activeWindow as Window & {
        require?: (moduleId: string) => unknown;
    }).require;

    if (typeof maybeRequire !== 'function') {
        throw new Error('Desktop module loader is unavailable.');
    }

    return maybeRequire(moduleName) as GeminiCliDesktopModuleMap[TModuleName];
}

export function resolveGeminiCliRuntime(vault: Vault): GeminiCliRuntime {
    const geminiPath = resolveDesktopBinaryPath('agy');
    const nodePath = resolveDesktopBinaryPath('node');
    const vaultPath = getVaultBasePath(vault);

    return {
        geminiPath,
        nodePath,
        vaultPath
    };
}

export function buildGeminiCliEnv(nodePath?: string | null): NodeJS.ProcessEnv {
    const env = { ...process.env };

    // Strip provider credentials from the child's environment so agy uses its
    // own file-based OAuth (~/.gemini) and never an ambient API key. agy fronts
    // Google, Anthropic, and OpenAI models, so strip all three families.
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    delete env.GOOGLE_GENAI_USE_VERTEXAI;
    delete env.GOOGLE_CLOUD_PROJECT;
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;

    // Prepend the node binary's directory to PATH so that subprocess spawns
    // succeed when Obsidian runs with a restricted PATH that omits
    // nvm/homebrew/system node locations.
    if (nodePath) {
        const pathMod = loadDesktopModule('path');
        const nodeDir = pathMod.dirname(nodePath);
        const separator = process.platform === 'win32' ? ';' : ':';
        env.PATH = nodeDir + separator + (env.PATH || '');
    }

    return env;
}


