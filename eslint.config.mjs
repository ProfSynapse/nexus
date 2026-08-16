import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import obsidianPlugin from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

// ── Mobile-safety blocklists (issue #221) ────────────────────────────────────
// Central, extensible definition of what a UI-primitive file may not top-level
// import. A static import runs during module init, before any Platform.isDesktop
// check, so on a phone (isDesktopOnly: false) it is a launch crash, not a
// degraded feature. Add to these arrays rather than writing a second rule block.
//
// Complementary to the reachability gate (`npm run lint:mobile`), which asks a
// different question: whether anything the init graph *reaches* imports a Node
// built-in. That gate is a statement about today's import graph — a settings
// primitive that is not currently reachable from src/main.ts would pass it and
// still crash the moment the settings tab opens on a phone. These rules are the
// per-file guarantee underneath it.
const MOBILE_BANNED_NODE_BUILTINS = [
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
    "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
    "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
    "module", "net", "os", "path", "perf_hooks", "process", "punycode",
    "querystring", "readline", "repl", "stream", "stream/promises",
    "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url",
    "util", "v8", "vm", "wasi", "worker_threads", "zlib",
];

// npm packages (and package entry points) known to pull Node built-ins in.
// `pdfjs-dist`, `pdf-lib` and the rest of the dependency list are deliberately
// absent — they are browser-safe. Vet a new entry with
// .skills/nexus-mobile-compat/protocols/vet-a-dependency.md before removing one.
const MOBILE_BANNED_PACKAGES = [
    "mammoth",                  // → fs/stream via its docx pipeline
    "jszip",                    // → stream/buffer
    "xlsx",
    "yaml",
    "@dao-xyz/sqlite3-vec",     // native/wasm bridge, desktop only
];

// Package sub-paths that are Node-only even though the package root is not.
const MOBILE_BANNED_PACKAGE_PATTERNS = [
    "node:*",
    "@dao-xyz/sqlite3-vec/*",
    "@modelcontextprotocol/sdk/server/stdio*",  // stdio transport → node:process
];

export default defineConfig([
    // Global ignores (must be first so they apply to all configs)
    {
        ignores: [
            "node_modules/",
            "dist/",
            "main.js",
            "coverage/",
            "connector.js",
            "nexus-cli.js",
            // Vendored runtime assets (downloaded engines) — not source
            "hucre/",
            "pyodide/",
            "mlc-venv/",
            ".codex-temp/",
            ".history/",
            ".worktrees/",
            ".claude/",
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
            // Standalone CLI — bundled separately (esbuild), not in the plugin tsconfig
            "cli/",
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

    // Disable type-checked rules for any remaining JS files.
    // disableTypeChecked only covers typescript-eslint's own rules, so the
    // obsidianmd typed rules (which call getParserServices) must be turned
    // off explicitly — same as the package.json block above. Exposed when
    // version-bump.mjs was restored (PR #255), the first non-ignored .mjs.
    {
        files: ["**/*.js", "**/*.mjs"],
        ...tseslint.configs.disableTypeChecked,
        languageOptions: {
            ...tseslint.configs.disableTypeChecked.languageOptions,
            globals: globals.node,
        },
        rules: {
            ...tseslint.configs.disableTypeChecked.rules,
            "obsidianmd/no-plugin-as-component": "off",
            "obsidianmd/no-view-references-in-plugin": "off",
            "obsidianmd/no-unsupported-api": "off",
            "obsidianmd/prefer-file-manager-trash-file": "off",
            "obsidianmd/prefer-instanceof": "off",
            // Build/release scripts (version-bump.mjs) run under Node during
            // development, never in the plugin runtime, so Node.js built-ins
            // are legitimate here. The obsidian-releases bot rejects inline
            // eslint-disable for this rule, so handle it at config level.
            "obsidianmd/no-nodejs-modules": "off",
        },
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

            // prefer-setting-definitions (new in eslint-plugin-obsidianmd 0.4.x)
            // pushes the declarative getSettingDefinitions() API. The plugin
            // ships a mature tab-based PluginSettingTab UI; adopting the
            // declarative API is a large refactor tracked as future work, not a
            // correctness issue. Disabled until that migration is scoped.
            "obsidianmd/settings-tab/prefer-setting-definitions": "off",

            // Extend sentence-case with project-specific acronyms and brands
            "obsidianmd/ui/sentence-case": ["error", {
                acronyms: [...DEFAULT_ACRONYMS, "MCP", "LLM", "KV", "MTP", "GLM"],
                brands: [...DEFAULT_BRANDS, "Claude Desktop", "Claude", "Codex", "Nexus", "LM Studio", "Ollama", "WebLLM"],
                ignoreRegex: [
                    "^e\\.g\\.",
                    "^ollama\\s",
                    "^OLLAMA_",
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

    // NOTE — there used to be a block here turning `obsidianmd/no-unsupported-api`
    // off for `basesAvailability.ts` and `baseResultHarvester.ts`, on the grounds
    // that the Bases API (1.10.0) post-dated `minAppVersion` (1.8.7) but was
    // reached only behind runtime guards. The reasoning was sound and the code
    // still carries those guards — but the suppression could never achieve its
    // purpose: Obsidian's community scanner runs this rule with its own config
    // and never reads ours, so it reported all 23 sites on every published
    // version regardless. Community review also disallows suppressing this rule.
    //
    // Fixed properly in 5.18.0 by raising `minAppVersion` to 1.10.0, which is
    // simply true — Nexus does name Bases APIs. Users below 1.10.0 are not
    // stranded: `versions.json` pins 5.17.1 at 1.8.7, so Obsidian offers them
    // that build instead. The rule now guards these files for real; do not add
    // the exemption back. If it fires, the code named an API newer than the
    // manifest claims, which is a fact to fix rather than silence.

    // ── Mobile-safety import guard for shared UI primitives (issue #221) ─────
    // src/settings/components/** holds the primitives every settings surface
    // composes (BoxedSection, ConfirmModal, row/picker helpers, breakpoint
    // helpers). They are pure DOM builders with no legitimate reason to touch
    // Node, and they are imported widely enough that one Node import here takes
    // mobile launch down. Errors, not warnings: obsidianmd/no-nodejs-modules
    // reports this class at "warn", which does not fail `npm run lint` and so
    // does not gate anything.
    //
    // Type-only imports are allowed — `import type` is erased at compile time and
    // never reaches the bundle. The sanctioned runtime escape hatch remains
    // desktopRequire()/await import() inside a Platform-guarded function, neither
    // of which is a top-level import and neither of which this rule touches.
    //
    // To widen the guard to another directory, add its glob to `files` below.
    {
        files: ["src/settings/components/**/*.ts", "src/settings/components/**/*.tsx"],
        rules: {
            "@typescript-eslint/no-restricted-imports": [
                "error",
                {
                    paths: [
                        ...MOBILE_BANNED_NODE_BUILTINS.map((name) => ({
                            name,
                            allowTypeImports: true,
                            message:
                                `Node built-in "${name}" must not be top-level imported from a settings UI primitive — ` +
                                "it executes during module init, before any Platform.isDesktop check, and crashes the " +
                                "plugin at launch on mobile. Use desktopRequire() or await import() inside a guarded function.",
                        })),
                        ...MOBILE_BANNED_PACKAGES.map((name) => ({
                            name,
                            allowTypeImports: true,
                            message:
                                `"${name}" pulls Node built-ins in transitively and must not be top-level imported from a ` +
                                "settings UI primitive. Load it with await import() inside the function that needs it.",
                        })),
                    ],
                    patterns: [
                        {
                            group: MOBILE_BANNED_PACKAGE_PATTERNS,
                            allowTypeImports: true,
                            message:
                                "This module is Node-only and must not be top-level imported from a settings UI primitive. " +
                                "Load it with await import() inside a Platform-guarded function.",
                        },
                    ],
                },
            ],
        },
    },

    // MCP SDK low-level `Server` class: tagged @deprecated in @modelcontextprotocol/sdk
    // >=1.26 in favor of the high-level `McpServer`, but explicitly retained for advanced
    // use cases. This plugin's custom RequestHandlerFactory/strategy/transport architecture
    // is exactly that advanced use case, so `Server` is used intentionally throughout the
    // src/server layer. The minimum SDK version that patches the ReDoS / cross-client
    // data-leak / DNS-rebinding advisories (1.26.0) already carries this deprecation, so
    // there is no patched version without it. Scoped off here (config-level, matching the
    // nodejs-modules pattern above) rather than 11 scattered inline disables.
    {
        files: ["src/server/**/*.ts"],
        rules: {
            "@typescript-eslint/no-deprecated": "off",
        },
    },

    // ── Vault-mutation confinement (Phase 3 arch guard) ──────────────────
    // Direct vault / adapter / fileManager MUTATION calls are the class of
    // code that produced the arbitrary-file-write escape (a caller-supplied
    // `--path` reaching `vault.create` without vault confinement). All writes
    // must be confined: untrusted (caller/LLM) paths through the shared
    // `resolveVaultPath` resolver, then through the typed VaultOperations
    // facade. This is a config-level restriction — the obsidian-releases bot
    // rejects inline eslint-disable, and the allowlist below re-enables the
    // legitimate direct-writers file-by-file.
    //
    // The selectors match method calls on `.vault` / `.adapter` / `.fileManager`
    // receivers regardless of the object prefix (`this.vault`, `app.vault`,
    // `deps.vault`, bare `vault`). Dry-run verified: 115 sites / 42 files, zero
    // false positives (no non-Obsidian receiver named vault/adapter/fileManager).
    // See docs/plans/vault-path-confinement-plan.md (Phase 3).
    {
        files: ["src/**/*.ts"],
        rules: {
            "no-restricted-syntax": [
                "error",
                {
                    selector:
                        "CallExpression[callee.property.name=/^(create|modify|modifyBinary|createBinary|createFolder|rename|append|process|copy|delete|trash)$/][callee.object.property.name='vault']",
                    message:
                        "Direct vault mutation is forbidden outside the VaultOperations facade. Resolve caller paths with resolveVaultPath() and write through VaultOperations (branded VaultPath). If this is a code-controlled internal path, add the file to the Phase 3 allowlist in eslint.config.mjs.",
                },
                {
                    selector:
                        "CallExpression[callee.property.name=/^(create|modify|modifyBinary|createBinary|createFolder|rename|append|process|copy|delete|trash)$/][callee.object.name='vault']",
                    message:
                        "Direct vault mutation is forbidden outside the VaultOperations facade. Resolve caller paths with resolveVaultPath() and write through VaultOperations (branded VaultPath). If this is a code-controlled internal path, add the file to the Phase 3 allowlist in eslint.config.mjs.",
                },
                {
                    selector:
                        "CallExpression[callee.property.name=/^(write|writeBinary|append|mkdir|remove|rename|copy|rmdir|trashLocal|trashSystem)$/][callee.object.property.name='adapter']",
                    message:
                        "Direct adapter write/mkdir/remove/rename/copy is forbidden outside VaultOperations / the storage-internal allowlist. Route through VaultOperations, or add the file to the Phase 3 allowlist in eslint.config.mjs if it is a code-controlled internal path.",
                },
                {
                    selector:
                        "CallExpression[callee.property.name=/^(write|writeBinary|append|mkdir|remove|rename|copy|rmdir|trashLocal|trashSystem)$/][callee.object.name='adapter']",
                    message:
                        "Direct adapter write/mkdir/remove/rename/copy is forbidden outside VaultOperations / the storage-internal allowlist. Route through VaultOperations, or add the file to the Phase 3 allowlist in eslint.config.mjs if it is a code-controlled internal path.",
                },
                {
                    selector:
                        "CallExpression[callee.property.name=/^(renameFile|trashFile)$/][callee.object.property.name='fileManager']",
                    message:
                        "Direct fileManager rename/trash is forbidden outside the VaultOperations facade. Resolve caller paths and route through VaultOperations, or add the file to the Phase 3 allowlist in eslint.config.mjs if it is code-controlled.",
                },
                {
                    selector:
                        "CallExpression[callee.property.name=/^(renameFile|trashFile)$/][callee.object.name='fileManager']",
                    message:
                        "Direct fileManager rename/trash is forbidden outside the VaultOperations facade. Resolve caller paths and route through VaultOperations, or add the file to the Phase 3 allowlist in eslint.config.mjs if it is code-controlled.",
                },
            ],
        },
    },

    // Phase 3 allowlist — files that legitimately call the raw mutation APIs.
    // Turning the rule off is file-level (the bot forbids inline disables), so
    // the guard is a tripwire: any NEW file that writes directly (a new agent
    // tool, a new service) fails lint until it either routes through the facade
    // or is consciously added here with a justification. Keep this list as short
    // as the facade migration allows — every entry is a spot the guard is blind
    // to. Three segments:
    {
        files: [
            // ── Segment 1: the sanctioned mutation boundary itself ───────────
            "src/core/VaultOperations.ts",          // the facade — requires branded VaultPath
            "src/core/ObsidianPathManager.ts",      // core path helper it calls (ensureParentExists)

            // ── Segment 2: trusted-internal writers (code-controlled paths, no
            //    caller/LLM input: event store, cache, migration, vendored
            //    runtime assets, logs, model downloads). Legitimately raw. ─────
            "src/database/storage/StorageRouter.ts",
            "src/database/storage/SQLiteCacheManager.ts",
            "src/database/storage/VaultAdapterCacheBlobStore.ts",
            "src/database/storage/vaultRoot/ShardedJsonlStreamStore.ts",
            "src/database/storage/vaultRoot/VaultEventStore.ts",
            "src/database/migration/MigrationStatusTracker.ts",
            "src/database/migration/CacheBackendMigration.ts", // removes code-controlled cache.db conflict siblings
            "src/database/migration/LegacyArchiver.ts",        // renames legacy storage folder to archive path
            "src/services/artifacts/ArtifactJobStore.ts",
            "src/services/storage/SnapshotArchiveService.ts",
            "src/services/llm/utils/CacheManager.ts",
            "src/services/llm/utils/Logger.ts",
            "src/services/llm/adapters/webllm/WebLLMModelManager.ts",
            "src/utils/WasmEnsurer.ts",
            "src/agents/apps/dataAnalysis/services/HucreEnsurer.ts",
            "src/agents/apps/dataAnalysis/services/PyodideEnsurer.ts",
            "src/agents/apps/dataAnalysis/spreadsheet/WorkbookMirrorService.ts",
            "src/agents/apps/dataAnalysis/DataAnalysisAgent.ts",
            "src/agents/apps/skills/services/SkillWriteService.ts", // confined via its own skillPaths resolver

            // ── Segment 3: TECH DEBT — untrusted-boundary tools that already
            //    call resolveVaultPath()/tryResolveVaultPath() before writing
            //    (Phase 1), but still issue the raw write directly rather than
            //    through the facade. They are confined today; the eslint guard
            //    cannot SEE the resolver call, so it is blind here. Phase 4
            //    should route these through VaultOperations (branded VaultPath)
            //    and DELETE them from this allowlist — see the plan doc. ───────
            "src/agents/contentManager/utils/ContentOperations.ts",
            "src/agents/contentManager/tools/write.ts",
            "src/agents/contentManager/tools/insert.ts",
            "src/agents/contentManager/tools/replace.ts",
            "src/agents/storageManager/utils/FileOperations.ts",
            "src/agents/storageManager/tools/createFolder.ts",
            "src/agents/canvasManager/utils/CanvasOperations.ts",
            // Twin of CanvasOperations for `.base` files: every write path
            // resolves through tryResolveVaultPath() first, and the facade
            // cannot express its create-only semantics (VaultOperations.writeFile
            // overwrites, while `base write` must fail when the file exists).
            "src/agents/baseManager/services/BaseFileOperations.ts",
            "src/agents/memoryManager/tools/workspaces/createWorkspace.ts",
            "src/agents/memoryManager/tools/workspaces/updateWorkspace.ts",
            "src/agents/ingestManager/tools/services/IngestionPipelineService.ts",
            "src/agents/apps/elevenlabs/tools/textToSpeech.ts",
            "src/agents/apps/elevenlabs/tools/soundEffects.ts",
            "src/agents/apps/elevenlabs/tools/musicGeneration.ts",
            "src/agents/apps/webTools/utils/webViewer.ts",
            "src/agents/apps/webTools/tools/capturePagePdf.ts",
            "src/agents/apps/webTools/tools/capturePagePng.ts",
            "src/agents/apps/webTools/tools/captureToMarkdown.ts",
            "src/agents/apps/composer/tools/compose.ts",
            "src/agents/apps/dataAnalysis/tools/runPython.ts",
            "src/services/video/VideoGenerationService.ts",
            "src/services/audio/AudioGenerationService.ts",
            "src/services/readAloud/ReadAloudSaveService.ts",
            "src/services/llm/ImageFileManager.ts",
        ],
        rules: {
            "no-restricted-syntax": "off",
        },
    },
]);
