/**
 * Generate Tool Validation Schemas Script
 *
 * Generates JSON Schema for each tool in useTool call format.
 * Used for validating JSONL/ChatML tool calls.
 *
 * Run with: node scripts/generate-tool-schemas.mjs
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tool parameter definitions - extracted from codebase
const toolDefinitions = {
  contentManager: {
    readContent: {
      properties: {
        filePath: { type: 'string', description: 'Path to the file to read' },
        limit: { type: 'number', description: 'Number of lines to read' },
        offset: { type: 'number', description: 'Line number to start from (1-based)' },
        includeLineNumbers: { type: 'boolean', default: false, description: 'Include line numbers in output' }
      },
      required: ['filePath']
    },
    createContent: {
      properties: {
        filePath: { type: 'string', description: 'Path to the file to create' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['filePath', 'content']
    },
    appendContent: {
      properties: {
        filePath: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Content to append' }
      },
      required: ['filePath', 'content']
    },
    prependContent: {
      properties: {
        filePath: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Content to prepend' }
      },
      required: ['filePath', 'content']
    },
    deleteContent: {
      properties: {
        filePath: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Content to delete' },
        similarityThreshold: { type: 'number', default: 0.95, minimum: 0, maximum: 1, description: 'Fuzzy match threshold 0.0-1.0' }
      },
      required: ['filePath', 'content']
    },
    replaceContent: {
      properties: {
        filePath: { type: 'string', description: 'Path to the file' },
        oldContent: { type: 'string', description: 'Content to replace' },
        newContent: { type: 'string', description: 'Replacement content' },
        similarityThreshold: { type: 'number', default: 0.95, minimum: 0, maximum: 1, description: 'Fuzzy match threshold 0.0-1.0' }
      },
      required: ['filePath', 'oldContent', 'newContent']
    },
    findReplaceContent: {
      properties: {
        filePath: { type: 'string', description: 'Path to the file' },
        findText: { type: 'string', description: 'Text to find' },
        replaceText: { type: 'string', description: 'Replacement text' },
        replaceAll: { type: 'boolean', default: false, description: 'Replace all occurrences' },
        caseSensitive: { type: 'boolean', default: true, description: 'Case sensitive search' },
        wholeWord: { type: 'boolean', default: false, description: 'Whole word match' }
      },
      required: ['filePath', 'findText', 'replaceText']
    },
    replaceByLine: {
      properties: {
        filePath: { type: 'string', description: 'Path to the file' },
        startLine: { type: 'number', minimum: 1, description: 'Start line (1-based)' },
        endLine: { type: 'number', minimum: 1, description: 'End line (inclusive)' },
        newContent: { type: 'string', description: 'Replacement content' }
      },
      required: ['filePath', 'startLine', 'endLine', 'newContent']
    }
  },

  vaultManager: {
    listDirectory: {
      properties: {
        path: { type: 'string', description: 'Directory path (use "" or "/" for root)' },
        filter: { type: 'string', description: 'Filter pattern' },
        depth: { type: 'number', default: 0, minimum: 0, description: 'Recursive depth' },
        includeFiles: { type: 'boolean', default: true, description: 'Include files in results' }
      },
      required: ['path']
    },
    openNote: {
      properties: {
        path: { type: 'string', description: 'Path to the note' },
        mode: { type: 'string', enum: ['tab', 'split', 'window', 'current'], default: 'current', description: 'Where to open' },
        focus: { type: 'boolean', default: true, description: 'Focus the note' }
      },
      required: ['path']
    },
    createFolder: {
      properties: {
        path: { type: 'string', description: 'Path of folder to create' }
      },
      required: ['path']
    },
    editFolder: {
      properties: {
        path: { type: 'string', description: 'Current folder path' },
        newPath: { type: 'string', description: 'New folder path' }
      },
      required: ['path', 'newPath']
    },
    moveFolder: {
      properties: {
        path: { type: 'string', description: 'Folder path' },
        newPath: { type: 'string', description: 'New path' },
        overwrite: { type: 'boolean', description: 'Overwrite if exists' }
      },
      required: ['path', 'newPath']
    },
    deleteFolder: {
      properties: {
        path: { type: 'string', description: 'Folder path' },
        recursive: { type: 'boolean', description: 'Delete recursively' }
      },
      required: ['path']
    },
    moveNote: {
      properties: {
        path: { type: 'string', description: 'Note path' },
        newPath: { type: 'string', description: 'New path' },
        overwrite: { type: 'boolean', description: 'Overwrite if exists' }
      },
      required: ['path', 'newPath']
    },
    deleteNote: {
      properties: {
        path: { type: 'string', description: 'Path to delete' }
      },
      required: ['path']
    },
    duplicateNote: {
      properties: {
        sourcePath: { type: 'string', description: 'Source note path' },
        targetPath: { type: 'string', description: 'Target path' },
        overwrite: { type: 'boolean', default: false, description: 'Overwrite if exists' },
        autoIncrement: { type: 'boolean', default: false, description: 'Auto-increment filename' }
      },
      required: ['sourcePath', 'targetPath']
    }
  },

  vaultLibrarian: {
    searchContent: {
      properties: {
        query: { type: 'string', minLength: 1, description: 'Search query' },
        semantic: { type: 'boolean', default: false, description: 'AI search (true) or keyword (false)' },
        limit: { type: 'number', default: 10, maximum: 50, description: 'Max results' },
        includeContent: { type: 'boolean', default: true, description: 'Include snippets' },
        snippetLength: { type: 'number', default: 200, description: 'Snippet length' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Restrict to paths (glob patterns)' }
      },
      required: ['query']
    },
    searchDirectory: {
      properties: {
        query: { type: 'string', description: 'Search term for names/paths' },
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Directories to search (use ["/"] for root)' },
        searchType: { type: 'string', enum: ['files', 'folders', 'both'], default: 'both', description: 'What to search' },
        fileTypes: { type: 'array', items: { type: 'string' }, description: 'Extensions without dots (e.g., ["md"])' },
        depth: { type: 'number', minimum: 1, maximum: 10, description: 'Max depth' },
        pattern: { type: 'string', description: 'Regex pattern' },
        dateRange: {
          type: 'object',
          properties: {
            start: { type: 'string', format: 'date-time' },
            end: { type: 'string', format: 'date-time' }
          },
          description: 'ISO date range'
        },
        limit: { type: 'number', default: 20, maximum: 100, description: 'Max results' },
        includeContent: { type: 'boolean', default: true, description: 'Include content' }
      },
      required: ['query', 'paths']
    },
    searchMemory: {
      properties: {
        query: { type: 'string', minLength: 1, description: 'Search query' },
        workspaceId: { type: 'string', default: 'global-workspace', description: 'Workspace ID' },
        memoryTypes: {
          type: 'array',
          items: { type: 'string', enum: ['traces', 'toolCalls', 'sessions', 'states', 'workspaces'] },
          description: 'Memory types to search'
        },
        dateRange: {
          type: 'object',
          properties: {
            start: { type: 'string', format: 'date-time' },
            end: { type: 'string', format: 'date-time' }
          },
          description: 'ISO date range'
        },
        limit: { type: 'number', default: 20, maximum: 100, description: 'Max results' },
        searchMethod: { type: 'string', enum: ['semantic', 'exact', 'mixed'], default: 'mixed', description: 'Search method' },
        filterBySession: { type: 'boolean', default: false, description: 'Current session only' }
      },
      required: ['query', 'workspaceId']
    }
  },

  memoryManager: {
    createSession: {
      properties: {
        name: { type: 'string', description: 'Session name' },
        description: { type: 'string', description: 'Session description' },
        sessionGoal: { type: 'string', description: 'Goal/focus' },
        context: { type: ['object', 'string'], description: 'Context data' },
        previousSessionId: { type: 'string', description: 'Continue from session' },
        newSessionId: { type: 'string', description: 'Custom session ID' }
      },
      required: []
    },
    listSessions: {
      properties: {
        limit: { type: 'number', description: 'Max results' },
        order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order' }
      },
      required: []
    },
    loadSession: {
      properties: {
        sessionId: { type: 'string', description: 'Session ID to load' }
      },
      required: ['sessionId']
    },
    updateSession: {
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        sessionGoal: { type: 'string', description: 'New goal' }
      },
      required: ['sessionId']
    },
    createWorkspace: {
      properties: {
        name: { type: 'string', description: 'Workspace name' },
        rootFolder: { type: 'string', description: 'Root folder path' },
        purpose: { type: 'string', description: 'Overall purpose' },
        currentGoal: { type: 'string', description: 'Current focus' },
        workflows: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              when: { type: 'string' },
              steps: { type: 'string' }
            },
            required: ['name', 'when', 'steps']
          },
          description: 'Workflows [{name, when, steps}]'
        },
        keyFiles: { type: 'array', items: { type: 'string' }, description: 'Key file paths' },
        preferences: { type: 'string', description: 'User preferences' },
        dedicatedAgentId: { type: 'string', description: 'Dedicated agent ID' }
      },
      required: ['name', 'rootFolder', 'purpose', 'currentGoal', 'workflows']
    },
    listWorkspaces: {
      properties: {
        limit: { type: 'number', description: 'Max results' }
      },
      required: []
    },
    loadWorkspace: {
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID to load' }
      },
      required: ['workspaceId']
    },
    updateWorkspace: {
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID' },
        name: { type: 'string', description: 'New name' },
        purpose: { type: 'string', description: 'New purpose' },
        currentGoal: { type: 'string', description: 'New goal' },
        workflows: { type: 'array', description: 'New workflows' }
      },
      required: ['workspaceId']
    },
    createState: {
      properties: {
        name: { type: 'string', description: 'State name/title' },
        conversationContext: { type: 'string', description: 'What was happening' },
        activeTask: { type: 'string', description: 'Current task' },
        activeFiles: { type: 'array', items: { type: 'string' }, description: 'Files being worked on' },
        nextSteps: { type: 'array', items: { type: 'string' }, description: 'Next actions' },
        reasoning: { type: 'string', description: 'Why saving now' },
        description: { type: 'string', description: 'Additional notes' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' }
      },
      required: ['name', 'conversationContext', 'activeTask', 'activeFiles', 'nextSteps', 'reasoning']
    },
    listStates: {
      properties: {
        limit: { type: 'number', description: 'Max results' }
      },
      required: []
    },
    loadState: {
      properties: {
        stateId: { type: 'string', description: 'State ID to load' }
      },
      required: ['stateId']
    },
    updateState: {
      properties: {
        stateId: { type: 'string', description: 'State ID' },
        name: { type: 'string', description: 'New name' },
        conversationContext: { type: 'string', description: 'New context' },
        activeTask: { type: 'string', description: 'New task' }
      },
      required: ['stateId']
    }
  },

  commandManager: {
    listCommands: {
      properties: {
        filter: { type: 'string', description: 'Filter pattern' }
      },
      required: []
    },
    executeCommand: {
      properties: {
        commandId: { type: 'string', description: 'Command ID to execute' }
      },
      required: ['commandId']
    }
  },

  agentManager: {
    listModels: {
      properties: {},
      required: []
    },
    createAgent: {
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100, description: 'Unique name' },
        description: { type: 'string', minLength: 1, maxLength: 500, description: 'Description' },
        prompt: { type: 'string', description: 'Agent prompt/persona' },
        isEnabled: { type: 'boolean', default: true, description: 'Enabled status' }
      },
      required: ['name', 'description', 'prompt']
    },
    listAgents: {
      properties: {
        enabledOnly: { type: 'boolean', default: false, description: 'Only enabled agents' }
      },
      required: []
    },
    getAgent: {
      properties: {
        id: { type: 'string', description: 'Agent ID' },
        name: { type: 'string', description: 'Agent name' }
      },
      required: [],
      oneOf: [{ required: ['id'] }, { required: ['name'] }]
    },
    updateAgent: {
      properties: {
        id: { type: 'string', description: 'Agent ID' },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        prompt: { type: 'string', description: 'New prompt' },
        isEnabled: { type: 'boolean', description: 'Enabled status' }
      },
      required: ['id']
    },
    deleteAgent: {
      properties: {
        id: { type: 'string', description: 'Agent ID or name' }
      },
      required: ['id']
    },
    generateImage: {
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 32000, description: 'Image description' },
        savePath: { type: 'string', pattern: '^[^/].*\\.(png|jpg|jpeg|webp)$', description: 'Vault path (e.g., "images/out.png")' },
        provider: { type: 'string', enum: ['google', 'openrouter'], default: 'google', description: 'AI provider' },
        model: {
          type: 'string',
          enum: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'flux-2-pro', 'flux-2-flex'],
          default: 'gemini-2.5-flash-image',
          description: 'Model'
        },
        aspectRatio: {
          type: 'string',
          enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
          description: 'Aspect ratio'
        },
        numberOfImages: { type: 'number', minimum: 1, maximum: 4, description: 'Number of images (1-4)' },
        imageSize: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Resolution (4K only for 3-pro)' },
        referenceImages: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 14,
          description: 'Reference image paths (max 3 for 2.5, max 14 for 3-pro)'
        },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Output format' }
      },
      required: ['prompt', 'savePath']
    },
    executePrompts: {
      properties: {
        prompts: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['text', 'image'], description: 'Request type' },
              prompt: { type: 'string', description: 'Prompt text' },
              id: { type: 'string', description: 'Custom ID' },
              sequence: { type: 'number', description: 'Execution order' },
              parallelGroup: { type: 'string', description: 'Parallel execution group' },
              provider: { type: 'string', description: 'Provider override' },
              model: { type: 'string', description: 'Model override' },
              agent: { type: 'string', description: 'Custom agent name' },
              contextFiles: { type: 'array', items: { type: 'string' }, description: 'Context files' },
              includePreviousResults: { type: 'boolean', description: 'Include previous results' },
              contextFromSteps: { type: 'array', items: { type: 'string' }, description: 'Step IDs to include' },
              savePath: { type: 'string', description: 'For image: save path (REQUIRED for type=image)' },
              aspectRatio: { type: 'string', description: 'For image: aspect ratio' },
              action: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['save', 'append', 'prepend'] },
                  path: { type: 'string' }
                },
                description: 'Save result to file'
              }
            },
            required: ['type', 'prompt']
          },
          description: 'Array of prompt configs'
        },
        mergeResponses: { type: 'boolean', description: 'Merge all responses' }
      },
      required: ['prompts']
    }
  }
};

// Context schema - required for every useTool call
const contextSchema = {
  type: 'object',
  properties: {
    workspaceId: { type: 'string', description: 'Scope identifier (use "default" for global)' },
    sessionId: { type: 'string', description: 'Session name (system assigns ID)' },
    memory: { type: 'string', description: 'Conversation essence (1-3 sentences)' },
    goal: { type: 'string', description: 'Current objective (1-3 sentences)' },
    constraints: { type: 'string', description: 'Rules/limits (1-3 sentences)' }
  },
  required: ['workspaceId', 'sessionId', 'memory', 'goal'],
  additionalProperties: false
};

/**
 * Generate complete JSON Schema for a single tool's useTool call
 */
function generateToolSchema(agentName, toolName, toolDef) {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: `useTool - ${agentName}_${toolName}`,
    description: `Validation schema for ${agentName}_${toolName} tool call`,
    type: 'object',
    properties: {
      context: contextSchema,
      calls: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            agent: { type: 'string', const: agentName },
            tool: { type: 'string', const: toolName },
            params: {
              type: 'object',
              properties: toolDef.properties,
              required: toolDef.required,
              ...(toolDef.oneOf ? { oneOf: toolDef.oneOf } : {}),
              additionalProperties: false
            }
          },
          required: ['agent', 'tool', 'params'],
          additionalProperties: false
        }
      }
    },
    required: ['context', 'calls'],
    additionalProperties: false
  };
}

/**
 * Generate all tool schemas
 */
function generateAllSchemas() {
  const schemas = {};

  for (const [agentName, tools] of Object.entries(toolDefinitions)) {
    for (const [toolName, toolDef] of Object.entries(tools)) {
      const key = `${agentName}_${toolName}`;
      schemas[key] = generateToolSchema(agentName, toolName, toolDef);
    }
  }

  return schemas;
}

// Main execution
const output = generateAllSchemas();
const outputPath = path.join(__dirname, '..', 'docs', 'tool-schemas.json');

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

// Summary
const agentCount = Object.keys(toolDefinitions).length;
const toolCount = Object.keys(output).length;

console.log(`Generated tool validation schemas at: ${outputPath}`);
console.log(`Total agents: ${agentCount}`);
console.log(`Total tool schemas: ${toolCount}`);
console.log('\nSchemas can be used with JSON Schema validators (ajv, etc.) to validate tool calls.');
