import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import obsidianPlugin from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

export default defineConfig([
    // Global ignores (must be first so they apply to all configs)
    {
        ignores: [
            "node_modules/",
            "dist/",
            "main.js",
            "coverage/",
            "connector.js",
            "mlc-venv/",
            ".codex-temp/",
            ".history/",
            ".worktrees/",
            "src/services/claude-code-sourcemap-main/**",
            // Config/build files — not application code
            "jest.config.js",
            "esbuild.config.mjs",
            "eslint.config.mjs",
            "scripts/",
            "docs/",
            // Test files — not covered by tsconfig.json include paths;
            // type-checked obsidian rules require project coverage
            "tests/",
            // Root TS file compiled separately (own tsc invocation)
            "connector.ts",
        ],
    },

    // Obsidian plugin recommended config (includes js recommended,
    // typescript-eslint recommendedTypeChecked, @microsoft/sdl, eslint-plugin-import,
    // eslint-plugin-depend, and JSON linting for package.json)
    ...obsidianPlugin.configs.recommended,

    // eslint-plugin-obsidianmd 0.3.0 enables a few typed rules through a
    // global wrapper. Keep package.json dependency checks, but do not run
    // TypeScript parser-service rules on JSON.
    {
        files: ["package.json"],
        rules: {
            "obsidianmd/no-plugin-as-component": "off",
            "obsidianmd/no-view-references-in-plugin": "off",
            "obsidianmd/no-unsupported-api": "off",
            "obsidianmd/prefer-file-manager-trash-file": "off",
            "obsidianmd/prefer-instanceof": "off",
        },
    },

    // Type-aware linting for source files covered by tsconfig.json
    {
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: {
            parserOptions: {
                project: "./tsconfig.json",
            },
        },
    },

    // Disable type-checked rules for any remaining JS files
    {
        files: ["**/*.js", "**/*.mjs"],
        ...tseslint.configs.disableTypeChecked,
    },

    // Project-specific rule overrides
    {
        files: ["**/*.ts", "**/*.tsx"],
        rules: {
            "no-undef": "off",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            "no-console": ["warn", { allow: ["warn", "error"] }],

            // Bot parity: obsidianmd recommended sets severity 0, but the
            // obsidian-releases bot scanner treats require-await as Required.
            "@typescript-eslint/require-await": "error",

            // Bot parity: obsidianmd recommended sets "warn", but the bot
            // treats prefer-file-manager-trash-file as Required (error).
            "obsidianmd/prefer-file-manager-trash-file": "error",

            // Extend sentence-case with project-specific acronyms and brands
            "obsidianmd/ui/sentence-case": ["error", {
                acronyms: [...DEFAULT_ACRONYMS, "MCP", "LLM"],
                brands: [...DEFAULT_BRANDS, "Claude Desktop", "Claude", "Nexus", "LM Studio", "Ollama", "WebLLM"],
                ignoreRegex: [
                    "^e\\.g\\.",
                    "^ollama\\s",
                    "^https?://",
                    "^Enter your .* URL \\(default: https?://",
                    "^Please enter a valid URL \\(e\\.g\\., https?://",
                    "^Enter this code at github\\.com/login/device:$",
                ],
            }],
        },
    },

    // Node.js import exemptions — desktop-only files that legitimately use
    // Node.js APIs (child_process, net, http, fs, etc.) in Electron.
    // The obsidian-releases bot rejects inline eslint-disable for this rule,
    // so we handle it at config level.
    {
        files: [
            "src/server/**/*.ts",
            "src/services/external/**/*.ts",
            "src/services/llm/adapters/anthropic-claude-code/**/*.ts",
            "src/services/llm/adapters/google-gemini-cli/**/*.ts",
            "src/services/llm/adapters/shared/**/*.ts",
            "src/services/oauth/**/*.ts",
            "src/services/chat/MessageQueueService.ts",
            "src/services/embeddings/IndexingQueue.ts",
            "src/settings/getStartedStatus.ts",
            "src/utils/cli*.ts",
        ],
        rules: {
            "import/no-nodejs-modules": "off",
        },
    },
]);
