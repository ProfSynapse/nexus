import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function sh(command) {
  return execSync(command, { encoding: 'utf8' }).trim();
}

const repoRoot = sh('git rev-parse --show-toplevel');
const gitFiles = sh('git ls-files')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const dirSet = new Set();
for (const file of gitFiles) {
  const dir = path.posix.dirname(file);
  if (dir && dir !== '.') {
    dirSet.add(dir);
  }
}

const dirs = Array.from(dirSet).sort((a, b) => a.localeCompare(b));

function toFsPath(posixPath) {
  return path.join(repoRoot, ...posixPath.split('/'));
}

const args = new Set(process.argv.slice(2));
const overwrite = args.has('--overwrite');

// Curated READMEs are written by hand; don't clobber them.
const curatedReadmes = new Set([
  'scripts',
  'src',
  'src/agents',
  'src/agents/agentManager',
  'src/agents/commandManager',
  'src/agents/contentManager',
  'src/agents/interfaces',
  'src/agents/memoryManager',
  'src/agents/vaultLibrarian',
  'src/agents/vaultManager',
  'src/database',
  'src/server',
  'src/services',
  'src/services/llm/utils',
  'src/ui',
  'src/utils'
]);

function guessPurpose(dir) {
  const parts = dir.split('/');
  const top = parts[0];
  const last = parts[parts.length - 1];

  if (dir === 'scripts') return 'Developer/build scripts used during development and packaging.';
  if (dir === 'src') return 'Primary TypeScript source for the Obsidian plugin (and in-app MCP server).';

  if (top === 'src') {
    if (parts[1] === 'agents') {
      if (parts.length === 2) return 'Agent/mode tool surface: domain agents and their executable modes.';
      const agentName = parts[2];
      const agentMap = {
        agentManager: 'Prompt + agent-management capabilities (custom prompts, prompt execution helpers).',
        commandManager: 'Bridges to Obsidian command palette / app-level commands.',
        contentManager: 'Content operations on notes (read/write/edit/batch transforms).',
        memoryManager: 'Workspace/session/state management and memory trace recording.',
        vaultLibrarian: 'Search/retrieval across vault/workspace (query planning, formatting).',
        vaultManager: 'Vault filesystem operations (folders/files, paths, structure).',
        interfaces: 'Shared agent/mode interfaces used across the tool layer.'
      };

      if (parts.length === 3) return agentMap[agentName] || `Agent implementation for "${agentName}".`;
      if (last === 'modes') return `Mode implementations (individual tools) for agent "${agentName}".`;
      if (last === 'services') return `Internal services supporting agent "${agentName}" modes.`;
      if (last === 'utils') return `Agent-scoped helpers/utilities for "${agentName}".`;
      if (last === 'validators') return `Validation helpers for "${agentName}" inputs/operations.`;
      if (last === 'types') return `Type definitions scoped to "${agentName}" features.`;
      return `Submodule for "${agentName}" agent implementation.`;
    }

    if (parts[1] === 'server') return 'MCP server implementation (transport, handlers, lifecycle, execution).';
    if (parts[1] === 'services') {
      if (parts.length === 2) {
        return 'Cross-cutting service layer (LLM, MCP connection, chat, tracing, workspace/session, storage).';
      }

      const area = parts[2];
      const serviceMap = {
        agent: 'Agent lifecycle/registration services (creating and registering agents).',
        chat: 'Chat/conversation coordination services used by the native chat UI.',
        llm: 'LLM integration (provider adapters, streaming, validation, provider manager).',
        mcp: 'MCP connection + routing services used by the in-app server/connector.',
        'mcp-bridge': 'Bridging between MCP tool calls and provider-specific tool-calling formats.',
        memory: 'Memory-related helpers used across sessions/workspaces.',
        migration: 'Migration coordination services.',
        registry: 'Registries used to locate/configure services and providers.',
        search: 'Search/index services.',
        session: 'Session-level services (creation/lookup/instruction injection).',
        storage: 'Storage/IO services and adapters.',
        trace: 'Tool-call tracing and persistence services.',
        workspace: 'Workspace-level services and management.'
      };

      if (parts.length === 3) {
        return serviceMap[area] || `Service area for "${area}".`;
      }

      // More specific hints for common deep areas.
      if (area === 'llm') {
        const sub = parts[3];
        const llmMap = {
          adapters: 'Provider adapter implementations for LLM calls (OpenAI, Anthropic, etc.).',
          core: 'LLM core abstractions (base interfaces/classes used by adapters).',
          providers: 'Provider manager/registry and provider metadata.',
          streaming: 'Streaming response parsing and event handling for providers.',
          types: 'Types for LLM requests/responses and provider interoperability.',
          utils: 'LLM-specific helper utilities (config, retry, cost/token usage, caching).',
          validation: 'Validation for LLM configuration and request parameters.'
        };

        if (sub === 'adapters' && parts[4]) {
          return `LLM adapter for provider "${parts[4]}" (requests, streaming, tool-calls).`;
        }

        return llmMap[sub] || `LLM service submodule "${sub}".`;
      }

      if (area === 'mcp-bridge') {
        const sub = parts[3];
        const bridgeMap = {
          core: 'Core bridging utilities between MCP and provider-specific tool calling.',
          providers: 'Provider-specific bridge implementations.',
          types: 'Types shared across bridge implementations.'
        };
        return bridgeMap[sub] || `MCP bridge submodule "${sub}".`;
      }

      return `Service submodule for "${area}".`;
    }

    if (parts[1] === 'database') {
      if (parts.length === 2) {
        return 'Local persistence layer (sql.js/SQLite schema, repositories, migration, cache, sync).';
      }
      const area = parts[2];
      const dbMap = {
        adapters: 'Database adapters (sql.js integration, storage backing).',
        interfaces: 'Database abstraction interfaces.',
        migration: 'Schema/data migration utilities.',
        optimizations: 'Performance/optimization helpers for database operations.',
        repositories: 'Repository implementations per entity (CRUD/query helpers).',
        schema: 'SQLite schema definitions and versioning.',
        services: 'Database services (init, cache, utilities).',
        storage: 'Storage backends used by the database layer.',
        sync: 'Sync state tracking and synchronization primitives.',
        types: 'Types for database entities and storage/cache layers.',
        utils: 'Database utilities (graph helpers, helpers).'
      };
      return dbMap[area] || `Database submodule for "${area}".`;
    }

    if (parts[1] === 'ui') return 'UI layer (chat view components/controllers/coordinators and UI utilities).';
    if (parts[1] === 'components') return 'Reusable UI components used across settings/chat/workspace views.';
    if (parts[1] === 'core') return 'Core plugin infrastructure (lifecycle, service management, commands, UI plumbing).';
    if (parts[1] === 'handlers') return 'Request handling strategies and helper services for MCP/server integration.';
    if (parts[1] === 'settings') return 'Settings UI (tabs/components) and plugin configuration wiring.';
    if (parts[1] === 'types') return 'Type definitions shared across the codebase.';
    if (parts[1] === 'utils') return 'Shared utilities (schema helpers, validation, context handling, misc helpers).';
    if (parts[1] === 'config') return 'Static configuration (agent configs, defaults, registries).';
    if (parts[1] === 'constants') return 'Constants and branding/IDs used across the plugin.';
  }

  if (last === 'types') return 'Type definitions for this module area.';
  if (last === 'interfaces') return 'Shared interfaces/abstractions for this module area.';
  if (last === 'utils') return 'Utility helpers for this module area.';
  if (last === 'services') return 'Internal services for this module area.';
  if (last === 'adapters') return 'Adapter implementations for external/provider integrations.';
  if (last === 'providers') return 'Provider implementations / registries for this module area.';
  if (last === 'validation') return 'Validation logic (schemas, guards, normalizers) for this module area.';

  return `Module folder for "${dir}".`;
}

function guessImprovements(dir) {
  const parts = dir.split('/');
  const last = parts[parts.length - 1];

  const suggestions = [];

  if (dir.startsWith('src/services/llm/adapters')) {
    suggestions.push('Consolidate shared HTTP/streaming/error-mapping logic across adapters.');
  }
  if (dir.includes('/utils')) {
    suggestions.push('Prevent "utils" sprawl: promote stable helpers into well-named modules.');
  }
  if (last === 'types' || dir.includes('/types/')) {
    suggestions.push('Consider consolidating/re-exporting types to reduce cross-folder imports.');
  }
  if (last === 'interfaces' || dir.includes('/interfaces/')) {
    suggestions.push('Keep interfaces minimal; prefer shared types where possible to reduce duplication.');
  }
  if (dir.startsWith('src/server')) {
    suggestions.push('Centralize tool-name parsing and MCP error shaping across handlers/strategies.');
  }
  if (dir.startsWith('src/agents')) {
    suggestions.push('Tighten mode parameter typing and reduce `any` at the tool boundary.');
  }

  if (suggestions.length === 0) {
    suggestions.push('Add a short contract note for this module (inputs/outputs, side effects).');
  }

  suggestions.push('See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.');

  return Array.from(new Set(suggestions)).slice(0, 4);
}

function formatList(items, max = 16) {
  if (!items || items.length === 0) return '_None_';
  const shown = items.slice(0, max).map((x) => `\`${x}\``).join(', ');
  const remaining = items.length - max;
  return remaining > 0 ? `${shown}, … (+${remaining} more)` : shown;
}

let created = 0;
let skipped = 0;

for (const dir of dirs) {
  const fsDir = toFsPath(dir);
  const readmePath = path.join(fsDir, 'README.md');

  if (fs.existsSync(readmePath) && (!overwrite || curatedReadmes.has(dir))) {
    skipped += 1;
    continue;
  }

  const prefix = `${dir}/`;
  const immediateFiles = gitFiles
    .filter((f) => f.startsWith(prefix) && path.posix.dirname(f) === dir)
    .map((f) => path.posix.basename(f))
    .filter((name) => name.toLowerCase() !== 'readme.md')
    .sort((a, b) => a.localeCompare(b));

  const immediateSubdirs = dirs
    .filter((d) => path.posix.dirname(d) === dir)
    .map((d) => path.posix.basename(d))
    .sort((a, b) => a.localeCompare(b));

  const purpose = guessPurpose(dir);
  const improvements = guessImprovements(dir);

  const md = [
    `# \`${dir}\``,
    '',
    '## Purpose',
    purpose,
    '',
    "## What's Here",
    `- Subfolders: ${formatList(immediateSubdirs)}`,
    `- Files: ${formatList(immediateFiles)}`,
    '',
    '## Improvement Ideas',
    ...improvements.map((s) => `- ${s}`),
    ''
  ].join('\n');

  fs.writeFileSync(readmePath, md, 'utf8');
  created += 1;
}

console.log(`[generate-folder-readmes] created=${created} skipped=${skipped} totalDirs=${dirs.length}`);
