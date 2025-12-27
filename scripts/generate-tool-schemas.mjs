/**
 * Generate Tool Validation Schemas Script
 *
 * Dynamically extracts schemas from actual tool implementations.
 * Parses TypeScript files to extract getParameterSchema() return values.
 *
 * Run with: node scripts/generate-tool-schemas.mjs
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcDir = path.join(__dirname, '..', 'src');

/**
 * Extract balanced braces content starting from a position
 */
function extractBalancedBraces(content, startIdx) {
  let braceCount = 1;
  let idx = startIdx + 1;

  while (braceCount > 0 && idx < content.length) {
    const char = content[idx];
    if (char === '{') braceCount++;
    else if (char === '}') braceCount--;
    idx++;
  }

  return content.substring(startIdx, idx);
}

/**
 * Extract tool metadata from a tool file
 */
function extractToolFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath, '.ts');

  // Skip index files and non-tool files
  if (fileName === 'index' || fileName.startsWith('base') || fileName.startsWith('Base')) {
    return null;
  }

  // Extract tool name from super() call: super('toolName', ...
  const superMatch = content.match(/super\s*\(\s*['"]([^'"]+)['"]/);
  if (!superMatch) {
    return null;
  }

  const toolName = superMatch[1];

  // Extract description from super() call (second param)
  const descMatch = content.match(/super\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/);
  const description = descMatch ? descMatch[1] : `${toolName} tool`;

  // Find getParameterSchema method and extract its body using balanced braces
  const methodMatch = content.match(/getParameterSchema\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/);
  if (!methodMatch) {
    return null;
  }

  const methodStart = content.indexOf(methodMatch[0]) + methodMatch[0].length - 1;
  const methodBody = extractBalancedBraces(content, methodStart);

  // Find toolSchema = { in method body
  const schemaVarMatch = methodBody.match(/const\s+toolSchema\s*=\s*\{/);
  if (!schemaVarMatch) {
    return null;
  }

  const schemaStart = methodBody.indexOf(schemaVarMatch[0]) + schemaVarMatch[0].length - 1;
  let schemaStr = extractBalancedBraces(methodBody, schemaStart);

  // Replace template literals and expressions with placeholders
  schemaStr = schemaStr.replace(/\$\{[^}]+\}/g, '');

  const schema = extractPropertiesFromSchema(schemaStr);

  if (!schema || Object.keys(schema.properties).length === 0) {
    return null;
  }

  return {
    name: toolName,
    description,
    schema
  };
}

/**
 * Extract properties from a schema string using balanced brace matching
 */
function extractPropertiesFromSchema(schemaStr) {
  const result = {
    properties: {},
    required: []
  };

  // Find properties: { and extract with balanced braces
  const propsStartMatch = schemaStr.match(/properties\s*:\s*\{/);
  if (propsStartMatch) {
    const startIdx = schemaStr.indexOf(propsStartMatch[0]) + propsStartMatch[0].length - 1;
    const propsBlock = extractBalancedBraces(schemaStr, startIdx);

    // Remove outer braces
    const propsContent = propsBlock.substring(1, propsBlock.length - 1);

    // Find each property using balanced braces
    let pos = 0;
    while (pos < propsContent.length) {
      // Find property name: {
      const propStartMatch = propsContent.substring(pos).match(/(\w+)\s*:\s*\{/);
      if (!propStartMatch) break;

      const propName = propStartMatch[1];
      const propStart = pos + propsContent.substring(pos).indexOf(propStartMatch[0]) + propStartMatch[0].length - 1;
      const propBlock = extractBalancedBraces(propsContent, propStart);

      const prop = {};

      // Extract type
      const typeMatch = propBlock.match(/type\s*:\s*['"]?(\w+)['"]?/);
      if (typeMatch) prop.type = typeMatch[1];

      // Extract description
      const descMatch = propBlock.match(/description\s*:\s*['"]([^'"]+)['"]/);
      if (descMatch) prop.description = descMatch[1];

      // Extract enum
      const enumMatch = propBlock.match(/enum\s*:\s*\[([^\]]+)\]/);
      if (enumMatch) {
        prop.enum = enumMatch[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
      }

      // Extract default
      const defaultMatch = propBlock.match(/default\s*:\s*([^,\n}]+)/);
      if (defaultMatch) {
        const val = defaultMatch[1].trim();
        if (val === 'true') prop.default = true;
        else if (val === 'false') prop.default = false;
        else if (!isNaN(Number(val))) prop.default = Number(val);
        else prop.default = val.replace(/['"]/g, '');
      }

      // Extract minimum/maximum
      const minMatch = propBlock.match(/minimum\s*:\s*(\d+)/);
      if (minMatch) prop.minimum = Number(minMatch[1]);

      const maxMatch = propBlock.match(/maximum\s*:\s*(\d+)/);
      if (maxMatch) prop.maximum = Number(maxMatch[1]);

      result.properties[propName] = prop;
      pos = propStart + propBlock.length;
    }
  }

  // Extract required array
  const reqMatch = schemaStr.match(/required\s*:\s*\[([^\]]*)\]/);
  if (reqMatch) {
    result.required = reqMatch[1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(s => s.length > 0);
  }

  return result;
}

/**
 * Get agent name from file path
 */
function getAgentName(filePath) {
  const parts = filePath.split(path.sep);
  const agentsIndex = parts.indexOf('agents');
  if (agentsIndex >= 0 && agentsIndex + 1 < parts.length) {
    return parts[agentsIndex + 1];
  }
  return 'unknown';
}

/**
 * Context schema - required for every useTools call
 */
const contextSchema = {
  type: 'object',
  description: 'Context for session tracking (required in every useTools call)',
  properties: {
    workspaceId: { type: 'string', description: 'Scope identifier (use "default" for global)' },
    sessionId: { type: 'string', description: 'Session name (system assigns ID)' },
    memory: { type: 'string', description: 'Conversation essence (1-3 sentences)' },
    goal: { type: 'string', description: 'Current objective (1-3 sentences)' },
    constraints: { type: 'string', description: 'Rules/limits (optional, 1-3 sentences)' }
  },
  required: ['workspaceId', 'sessionId', 'memory', 'goal'],
  additionalProperties: false
};

/**
 * Recursively find tool files
 */
function findToolFiles(dir, results = []) {
  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      // Skip services directories
      if (item.name !== 'services') {
        findToolFiles(fullPath, results);
      }
    } else if (item.isFile() && item.name.endsWith('.ts')) {
      // Skip index, base, types files
      if (item.name !== 'index.ts' &&
          !item.name.startsWith('base') &&
          !item.name.startsWith('Base') &&
          item.name !== 'types.ts') {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * Agents to exclude from schema generation
 */
const EXCLUDED_AGENTS = ['commandManager', 'toolManager'];

/**
 * Main function
 */
async function main() {
  console.log('Scanning for tool files...\n');

  // Find all tool files in agent directories
  const agentsDir = path.join(__dirname, '..', 'src', 'agents');
  const toolFiles = [];

  // Look in each agent's tools folder
  const agents = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => !EXCLUDED_AGENTS.includes(d.name));

  for (const agent of agents) {
    const toolsDir = path.join(agentsDir, agent.name, 'tools');
    if (fs.existsSync(toolsDir)) {
      findToolFiles(toolsDir, toolFiles);
    }
  }

  console.log(`Found ${toolFiles.length} potential tool files\n`);

  const output = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Claudesidian Tool Schemas',
    description: 'JSON Schema definitions for all Claudesidian MCP tools (auto-generated)',
    version: '2.0.0',
    generated: new Date().toISOString(),
    context: contextSchema,
    tools: {},
    agents: {}
  };

  const agentTools = {};

  for (const fullPath of toolFiles) {
    const agentName = getAgentName(fullPath);

    try {
      const tool = extractToolFromFile(fullPath);
      if (tool) {
        const key = `${agentName}_${tool.name}`;

        output.tools[key] = {
          $schema: 'http://json-schema.org/draft-07/schema#',
          title: key,
          description: tool.description,
          type: 'object',
          properties: tool.schema.properties,
          required: tool.schema.required,
          additionalProperties: false
        };

        if (!agentTools[agentName]) {
          agentTools[agentName] = [];
        }
        agentTools[agentName].push(tool.name);
      }
    } catch (e) {
      console.error(`Error processing ${relPath}: ${e.message}`);
    }
  }

  // Build agent summaries
  for (const [agent, tools] of Object.entries(agentTools)) {
    output.agents[agent] = {
      toolCount: tools.length,
      tools: tools.sort()
    };
  }

  // Write output
  const outputPath = path.join(__dirname, '..', 'tool-schemas.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  // Summary
  const toolCount = Object.keys(output.tools).length;
  const agentCount = Object.keys(output.agents).length;

  console.log(`Generated: ${outputPath}`);
  console.log(`\nTotal: ${agentCount} agents, ${toolCount} tools\n`);

  for (const [agent, info] of Object.entries(output.agents).sort()) {
    console.log(`  ${agent}: ${info.toolCount} tools`);
    console.log(`    ${info.tools.join(', ')}`);
  }
}

main().catch(console.error);
