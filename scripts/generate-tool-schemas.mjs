/**
 * Export CLI-first tool schemas from the live ToolCliNormalizer path.
 *
 * Usage:
 *   node scripts/generate-tool-schemas.mjs
 *   node scripts/generate-tool-schemas.mjs --selector "storage"
 *   node scripts/generate-tool-schemas.mjs --selector "storage move, content read"
 *   node scripts/generate-tool-schemas.mjs --output docs/generated/storage-schemas.json
 *   node scripts/generate-tool-schemas.mjs --output -
 */

import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const obsidianMockPath = path.join(projectRoot, 'tests', 'mocks', 'obsidian', 'index.ts');
const require = Module.createRequire(import.meta.url);

const DEFAULT_OUTPUT = path.join('docs', 'generated', 'cli-first-tool-schemas.json');
const DEFAULT_SELECTOR = '--help';
const originalTsLoader = Module._extensions['.ts'];
const originalLoad = Module._load;

function parseArgs(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    selectors: [],
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value after --output');
      }
      options.output = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
      continue;
    }

    if (arg === '--selector') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value after --selector');
      }
      options.selectors.push(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--selector=')) {
      options.selectors.push(arg.slice('--selector='.length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printUsage() {
  console.log([
    'Export live CLI-first tool schemas from the runtime normalizer.',
    '',
    'Options:',
    `  --output <path>      Output file path (default: ${DEFAULT_OUTPUT})`,
    `  --selector <value>   CLI selector string, same shape as getTools (default: ${DEFAULT_SELECTOR})`,
    '  --help               Show this message',
    '',
    'Examples:',
    '  node scripts/generate-tool-schemas.mjs',
    '  node scripts/generate-tool-schemas.mjs --selector "storage"',
    '  node scripts/generate-tool-schemas.mjs --selector "storage move, content read"',
    '  node scripts/generate-tool-schemas.mjs --output docs/generated/task-tools.json --selector "task"',
    '  node scripts/generate-tool-schemas.mjs --output - --selector "prompt generate-image"',
  ].join('\n'));
}

function makeMockFn(implementation) {
  let currentImpl = implementation || (() => undefined);
  const fn = (...args) => currentImpl(...args);
  fn.mockImplementation = (next) => {
    currentImpl = next;
    return fn;
  };
  fn.mockReturnValue = (value) => {
    currentImpl = () => value;
    return fn;
  };
  fn.mockResolvedValue = (value) => {
    currentImpl = async () => value;
    return fn;
  };
  fn.mockRejectedValue = (value) => {
    currentImpl = async () => {
      throw value;
    };
    return fn;
  };
  return fn;
}

function createMockElement(tagName = 'div') {
  return {
    tagName: String(tagName).toUpperCase(),
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      }
    },
    addClass() {},
    removeClass() {},
    hasClass() {
      return false;
    },
    toggleClass() {},
    setText(text) {
      this.textContent = text;
    },
    createEl(tag) {
      return createMockElement(tag);
    },
    createDiv() {
      return createMockElement('div');
    },
    createSpan() {
      return createMockElement('span');
    },
    empty() {},
    remove() {},
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
    removeAttribute() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    parentElement: null,
    style: {},
    textContent: '',
    innerHTML: '',
    value: '',
    rows: 0,
    scrollTop: 0,
    scrollHeight: 0,
    focus() {}
  };
}

function installGlobals() {
  globalThis.jest = { fn: makeMockFn };
  globalThis.document = {
    createElement: createMockElement,
    body: createMockElement('body')
  };
  globalThis.window = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: {
      clipboard: {
        async writeText() {},
        async readText() {
          return '';
        }
      }
    }
  };
  try {
    globalThis.navigator = globalThis.window.navigator;
  } catch {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: globalThis.window.navigator
    });
  }
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
}

function installTypeScriptLoader() {
  Module._extensions['.ts'] = function compileTypeScript(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        skipLibCheck: true
      },
      fileName: filename
    });
    module._compile(outputText, filename);
  };
}

function installObsidianMock() {
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'obsidian') {
      const base = originalLoad.call(this, obsidianMockPath, parent, isMain);
      class Events {
        on() {
          return {};
        }

        off() {}

        trigger() {}
      }
      return { ...base, Events };
    }

    return originalLoad.call(this, request, parent, isMain);
  };
}

function restoreLoaders() {
  if (originalTsLoader) {
    Module._extensions['.ts'] = originalTsLoader;
  } else {
    delete Module._extensions['.ts'];
  }
  Module._load = originalLoad;
}

function createRuntime() {
  const { App, Plugin } = require('obsidian');

  const app = new App();
  app.vault.getName = () => 'claudesidian-mcp';
  app.vault.getRoot = () => ({ children: [] });
  app.vault.getMarkdownFiles = () => [];
  app.vault.getFiles = () => [];
  app.vault.getAllLoadedFiles = () => [];
  app.vault.getAbstractFileByPath = () => null;
  app.vault.createFolder = async () => undefined;
  app.vault.createBinary = async () => undefined;
  app.vault.create = async () => undefined;
  app.vault.adapter = {
    exists: async () => false,
    read: async () => '',
    write: async () => undefined,
    append: async () => undefined,
    stat: async () => ({ mtime: Date.now(), ctime: Date.now(), size: 0 }),
    mkdir: async () => undefined,
    remove: async () => undefined,
    rename: async () => undefined,
    list: async () => ({ files: [], folders: [] }),
    writeBinary: async () => undefined
  };

  app.workspace.onLayoutReady = (callback) => callback();
  app.workspace.on = () => ({});
  app.workspace.off = () => undefined;
  app.workspace.getLeavesOfType = () => [];
  app.workspace.getMostRecentLeaf = () => null;
  app.workspace.getLeaf = () => null;
  app.workspace.openLinkText = async () => undefined;
  app.workspace.activeLeaf = null;
  app.plugins = undefined;

  const plugin = new Plugin(app, { id: 'nexus', name: 'Nexus', version: '0.0.0' });
  plugin.loadData = async () => ({});
  plugin.saveData = async () => undefined;
  plugin.registerEvent = () => undefined;
  plugin.registerDomEvent = () => undefined;
  plugin.addStatusBarItem = () => createMockElement('div');

  return { app, plugin };
}

function instantiateAgents() {
  const { DEFAULT_LLM_PROVIDER_SETTINGS } = require(path.join(projectRoot, 'src', 'types', 'llm', 'ProviderTypes'));
  const { ToolCliNormalizer } = require(path.join(projectRoot, 'src', 'agents', 'toolManager', 'services', 'ToolCliNormalizer'));
  const { ContentManagerAgent } = require(path.join(projectRoot, 'src', 'agents', 'contentManager', 'contentManager'));
  const { StorageManagerAgent } = require(path.join(projectRoot, 'src', 'agents', 'storageManager', 'storageManager'));
  const { SearchManagerAgent } = require(path.join(projectRoot, 'src', 'agents', 'searchManager', 'searchManager'));
  const { MemoryManagerAgent } = require(path.join(projectRoot, 'src', 'agents', 'memoryManager', 'memoryManager'));
  const { PromptManagerAgent } = require(path.join(projectRoot, 'src', 'agents', 'promptManager', 'promptManager'));
  const { CanvasManagerAgent } = require(path.join(projectRoot, 'src', 'agents', 'canvasManager', 'canvasManager'));
  const { TaskManagerAgent } = require(path.join(projectRoot, 'src', 'agents', 'taskManager', 'taskManager'));
  const { IngestManagerAgent } = require(path.join(projectRoot, 'src', 'agents', 'ingestManager', 'ingestManager'));
  const { AgentManager } = require(path.join(projectRoot, 'src', 'services', 'AgentManager'));
  const { ElevenLabsAgent } = require(path.join(projectRoot, 'src', 'agents', 'apps', 'elevenlabs', 'ElevenLabsAgent'));
  const { ComposerAgent } = require(path.join(projectRoot, 'src', 'agents', 'apps', 'composer', 'ComposerAgent'));
  const { WebToolsAgent } = require(path.join(projectRoot, 'src', 'agents', 'apps', 'webTools', 'WebToolsAgent'));

  const { app, plugin } = createRuntime();
  const llmSettings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS));
  llmSettings.providers.google.apiKey = 'mock-google-key';
  llmSettings.providers.google.enabled = true;
  llmSettings.providers.openrouter.apiKey = 'mock-openrouter-key';
  llmSettings.providers.openrouter.enabled = true;
  llmSettings.defaultImageModel = {
    provider: 'google',
    model: 'gemini-2.5-flash-image'
  };

  const settings = {
    settings: {
      llmProviders: llmSettings,
      customPrompts: { prompts: [] }
    }
  };

  const providerManager = {
    getLLMService: () => ({}),
    getSettings: () => llmSettings
  };

  const agentManager = new AgentManager(app, plugin, undefined);
  const usageTracker = {};
  const memoryService = {};
  const workspaceService = {
    listWorkspaces: async () => [],
    getWorkspace: async () => null
  };
  const taskService = {
    getWorkspaceSummary: async () => ({})
  };

  const agents = [
    new ContentManagerAgent(app),
    new StorageManagerAgent(app),
    new SearchManagerAgent(app),
    new MemoryManagerAgent(app, plugin, memoryService, workspaceService),
    new PromptManagerAgent(settings, providerManager, agentManager, usageTracker, app, app.vault, null),
    new CanvasManagerAgent(app),
    new TaskManagerAgent(app, plugin, taskService),
    new IngestManagerAgent(app.vault, () => null),
    new ElevenLabsAgent(),
    new ComposerAgent(),
    new WebToolsAgent()
  ];

  for (const agent of agents) {
    if (typeof agent.setApp === 'function') {
      agent.setApp(app);
    }
    if (typeof agent.setVault === 'function') {
      agent.setVault(app.vault);
    }
  }

  const registry = new Map();
  for (const agent of agents) {
    registry.set(agent.name, agent);
  }

  return {
    agents,
    registry,
    normalizer: new ToolCliNormalizer(registry)
  };
}

function collectSchemas(agents, registry, normalizer, selectorInput) {
  const requests = normalizer.normalizeDiscoveryRequests({ tool: selectorInput });
  const tools = [];

  for (const request of requests) {
    const agent = registry.get(request.agent);
    if (!agent) {
      throw new Error(`Agent "${request.agent}" not found`);
    }

    if (!request.tools || request.tools.length === 0) {
      for (const tool of agent.getTools()) {
        tools.push(normalizer.buildCliSchema(agent.name, tool));
      }
      continue;
    }

    for (const toolSlug of request.tools) {
      const tool = agent.getTool(toolSlug);
      if (!tool) {
        throw new Error(`Tool "${toolSlug}" not found in agent "${agent.name}"`);
      }
      tools.push(normalizer.buildCliSchema(agent.name, tool));
    }
  }

  tools.sort((left, right) => left.command.localeCompare(right.command));

  const byAgent = {};
  for (const tool of tools) {
    byAgent[tool.agent] = (byAgent[tool.agent] || 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    selector: selectorInput,
    toolCount: tools.length,
    agentCount: Object.keys(byAgent).length,
    agents: byAgent,
    tools
  };
}

function writeOutput(outputPath, payload) {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath === '-') {
    process.stdout.write(json);
    return;
  }

  const resolvedOutput = path.resolve(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, json, 'utf8');
  console.log(JSON.stringify({
    outPath: resolvedOutput,
    toolCount: payload.toolCount,
    agentCount: payload.agentCount,
    agents: payload.agents
  }, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const selectorInput = options.selectors.length > 0
    ? options.selectors.join(', ')
    : DEFAULT_SELECTOR;

  installGlobals();
  installTypeScriptLoader();
  installObsidianMock();

  try {
    const runtime = instantiateAgents();
    const payload = collectSchemas(runtime.agents, runtime.registry, runtime.normalizer, selectorInput);
    writeOutput(options.output, payload);
  } finally {
    restoreLoaders();
  }
}

main();
