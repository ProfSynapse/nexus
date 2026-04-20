/**
 * Script to list all agents and their modes
 * Run with: node scripts/list-agent-modes.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Find all agent directories
const agentsDir = join(projectRoot, 'src', 'agents');
const agentDirs = readdirSync(agentsDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .filter(d => !['interfaces'].includes(d.name))
  .map(d => d.name);

console.log('='.repeat(60));
console.log('AGENT AND MODE LISTING');
console.log('='.repeat(60));
console.log('');

const allAgents = [];

for (const agentName of agentDirs) {
  const agentDir = join(agentsDir, agentName);
  const modesDir = join(agentDir, 'modes');

  // Skip if no modes directory
  if (!existsSync(modesDir)) {
    continue;
  }

  // Get agent description from main agent file
  const agentFile = join(agentDir, `${agentName}.ts`);
  let description = '';

  if (existsSync(agentFile)) {
    const content = readFileSync(agentFile, 'utf-8');
    // Try to extract description from super() call
    const superMatch = content.match(/super\s*\(\s*['"`][^'"`]+['"`]\s*,\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]+)['"`]/);
    if (superMatch) {
      description = superMatch[1];
    }
  }

  // Find all mode files
  const modes = [];

  // Check direct mode files in modes/
  const modeFiles = readdirSync(modesDir, { withFileTypes: true });

  for (const file of modeFiles) {
    if (file.isFile() && file.name.endsWith('Mode.ts') && !file.name.startsWith('base')) {
      const slug = extractModeSlug(join(modesDir, file.name));
      if (slug) modes.push(slug);
    } else if (file.isDirectory()) {
      // Check subdirectories (e.g., sessions/, states/, workspaces/)
      const subDir = join(modesDir, file.name);
      const subFiles = readdirSync(subDir, { withFileTypes: true });

      for (const subFile of subFiles) {
        if (subFile.isFile() && subFile.name.endsWith('Mode.ts')) {
          const slug = extractModeSlug(join(subDir, subFile.name));
          if (slug) modes.push(slug);
        }
      }
    }
  }

  if (modes.length > 0) {
    allAgents.push({
      name: agentName,
      description: description || 'No description',
      modes: modes.sort()
    });
  }
}

// Print results
for (const agent of allAgents.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`- ${agent.name}: ${agent.description}`);
  console.log(`  Modes: ${agent.modes.join(', ')}`);
  console.log('');
}

console.log('='.repeat(60));
console.log('SUMMARY');
console.log('='.repeat(60));
console.log(`Total agents: ${allAgents.length}`);
console.log(`Total modes: ${allAgents.reduce((sum, a) => sum + a.modes.length, 0)}`);
console.log('');

// Also output as the system prompt would format it
console.log('='.repeat(60));
console.log('SYSTEM PROMPT FORMAT');
console.log('='.repeat(60));
console.log('');

for (const agent of allAgents.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`- ${agent.name}: ${agent.description}`);
  console.log(`  Modes: ${agent.modes.join(', ')}`);
  console.log('');
}

function extractModeSlug(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');

    // Look for super() call with slug as first argument
    // Pattern: super('slugName', ...
    const superMatch = content.match(/super\s*\(\s*['"`]([a-zA-Z]+)['"`]/);
    if (superMatch) {
      return superMatch[1];
    }

    // Fallback: derive from filename
    const fileName = filePath.split('/').pop();
    const match = fileName.match(/^([a-zA-Z]+)Mode\.ts$/);
    if (match) {
      // Convert PascalCase to camelCase
      const name = match[1];
      return name.charAt(0).toLowerCase() + name.slice(1);
    }

    return null;
  } catch (error) {
    return null;
  }
}
