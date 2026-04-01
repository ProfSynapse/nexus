import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import obsidianPlugin from "eslint-plugin-obsidianmd";

export default defineConfig([
    // Global ignores (must be first so they apply to all configs)
    {
        ignores: [
            "node_modules/",
            "dist/",
            "main.js",
            "connector.js",
            "mlc-venv/",
            ".worktrees/",
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
        },
    },
]);
