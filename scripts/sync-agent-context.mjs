/**
 * Sync shared agent context blocks and mirror repo skills into other agent roots.
 *
 * Usage:
 *   node scripts/sync-agent-context.mjs
 *   node scripts/sync-agent-context.mjs --dry-run
 *   node scripts/sync-agent-context.mjs --check
 *   node scripts/sync-agent-context.mjs --docs-only
 *   node scripts/sync-agent-context.mjs --skills-only
 *   node scripts/sync-agent-context.mjs --skill-target .cursor/skills
 *
 * Environment:
 *   NEXUS_SYNC_SKILL_TARGETS=.cursor/skills,~/other/skills
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const configPath = path.join(projectRoot, '.agent-sync', 'config.json');
const args = process.argv.slice(2);

const options = {
  dryRun: args.includes('--dry-run'),
  check: args.includes('--check'),
  docsOnly: args.includes('--docs-only'),
  skillsOnly: args.includes('--skills-only'),
  prune: args.includes('--prune'),
  skillTargets: collectArgValues(args, '--skill-target')
};

if (options.docsOnly && options.skillsOnly) {
  fail('Use either --docs-only or --skills-only, not both.');
}

const shouldSyncDocs = !options.skillsOnly;
const shouldSyncSkills = !options.docsOnly;

const config = loadConfig();
const docsToSync = config.docs.map((docPath) => path.join(projectRoot, docPath));

const sharedBlocksDir = path.join(projectRoot, '.agent-sync', 'blocks');
const skillsSourceDir = path.join(projectRoot, config.skillSourceDir);

const skillTargets = normalizeSkillTargets(
  options.skillTargets.length > 0
    ? options.skillTargets
    : process.env.NEXUS_SYNC_SKILL_TARGETS
      ? process.env.NEXUS_SYNC_SKILL_TARGETS.split(',')
      : config.skillTargets
);

const summary = {
  changed: [],
  warnings: []
};

try {
  if (shouldSyncDocs) {
    syncDocs();
  }

  if (shouldSyncSkills) {
    syncSkills();
  }

  if (summary.warnings.length > 0) {
    console.warn('\nWarnings:');
    for (const warning of summary.warnings) {
      console.warn(`- ${warning}`);
    }
  }

  if (summary.changed.length === 0) {
    console.log('No changes needed.');
    process.exit(0);
  }

  const modeLabel = options.check ? 'Would change' : options.dryRun ? 'Would sync' : 'Changed';
  console.log(`\n${modeLabel}:`);
  for (const item of summary.changed) {
    console.log(`- ${item}`);
  }

  if (options.check) {
    process.exit(1);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function syncDocs() {
  const blockFiles = fs.existsSync(sharedBlocksDir)
    ? fs.readdirSync(sharedBlocksDir).filter((file) => file.endsWith('.md'))
    : [];

  for (const blockFile of blockFiles) {
    const blockName = path.basename(blockFile, '.md');
    const blockContent = fs.readFileSync(path.join(sharedBlocksDir, blockFile), 'utf8').trim();

    for (const docPath of docsToSync) {
      if (!fs.existsSync(docPath)) {
        summary.warnings.push(`Missing doc target: ${docPath}`);
        continue;
      }

      const original = fs.readFileSync(docPath, 'utf8');
      const updated = replaceMarkedBlock(original, blockName, blockContent, docPath);

      if (updated === original) {
        continue;
      }

      recordChange(relativeToProject(docPath));
      writeFileIfNeeded(docPath, updated);
    }
  }
}

function syncSkills() {
  if (!fs.existsSync(skillsSourceDir)) {
    summary.warnings.push(`Skill source directory not found: ${skillsSourceDir}`);
    return;
  }

  const sourceSkillDirs = fs.readdirSync(skillsSourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const targetRoot of skillTargets) {
    if (path.resolve(targetRoot) === path.resolve(skillsSourceDir)) {
      continue;
    }

    ensureDir(targetRoot);

    for (const skillName of sourceSkillDirs) {
      const sourceDir = path.join(skillsSourceDir, skillName);
      const targetDir = path.join(targetRoot, skillName);
      copyDirectory(sourceDir, targetDir);
    }

    if (options.prune) {
      pruneMissingSkillDirs(skillsSourceDir, targetRoot, new Set(sourceSkillDirs));
    }
  }
}

function replaceMarkedBlock(content, blockName, blockContent, docPath) {
  const startMarker = `<!-- sync:block:${blockName}:start -->`;
  const endMarker = `<!-- sync:block:${blockName}:end -->`;
  const pattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'm');

  if (!pattern.test(content)) {
    summary.warnings.push(`Missing sync markers for "${blockName}" in ${relativeToProject(docPath)}`);
    return content;
  }

  return content.replace(pattern, `${startMarker}\n${blockContent}\n${endMarker}`);
}

function copyDirectory(sourceDir, targetDir) {
  ensureDir(targetDir);

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }

    const sourceBuffer = fs.readFileSync(sourcePath);
    const targetBuffer = fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null;

    if (targetBuffer && Buffer.compare(sourceBuffer, targetBuffer) === 0) {
      continue;
    }

    recordChange(`${relativeToProject(sourceDir)} -> ${targetPath}`);
    writeBufferIfNeeded(targetPath, sourceBuffer);
  }
}

function pruneMissingSkillDirs(sourceRoot, targetRoot, sourceNames) {
  if (!fs.existsSync(targetRoot)) {
    return;
  }

  const targetEntries = fs.readdirSync(targetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  for (const entry of targetEntries) {
    if (sourceNames.has(entry.name)) {
      continue;
    }

    const targetPath = path.join(targetRoot, entry.name);
    recordChange(`prune ${targetPath}`);
    if (!options.check && !options.dryRun) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  }
}

function writeFileIfNeeded(filePath, content) {
  if (options.check || options.dryRun) {
    return;
  }

  fs.writeFileSync(filePath, `${content.trimEnd()}\n`, 'utf8');
}

function writeBufferIfNeeded(filePath, buffer) {
  if (options.check || options.dryRun) {
    return;
  }

  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, buffer);
}

function ensureDir(dirPath) {
  if (options.check || options.dryRun) {
    return;
  }

  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeSkillTargets(rawTargets) {
  return rawTargets
    .flatMap((value) => value.split(','))
    .map((value) => expandPath(value.trim()))
    .filter(Boolean);
}

function expandPath(value) {
  if (!value) {
    return '';
  }

  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  if (path.isAbsolute(value)) {
    return value;
  }

  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('.')) {
    return path.resolve(projectRoot, value);
  }

  return value;
}

function collectArgValues(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) {
      const nextValue = argv[index + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        fail(`Missing value for ${flag}`);
      }
      values.push(nextValue);
      index += 1;
    }
  }
  return values;
}

function relativeToProject(targetPath) {
  const relative = path.relative(projectRoot, targetPath);
  return relative && !relative.startsWith('..') ? relative : targetPath;
}

function recordChange(label) {
  if (!summary.changed.includes(label)) {
    summary.changed.push(label);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fail(message) {
  console.error(`[sync-agent-context] ${message}`);
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    return {
      docs: ['AGENTS.md', 'CLAUDE.md'],
      skillSourceDir: '.skills',
      skillTargets: ['.codex/skills', '.claude/skills', '.cline/skills']
    };
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const docs = Array.isArray(parsed.docs) ? parsed.docs : ['AGENTS.md', 'CLAUDE.md'];
  const skillSourceDir = typeof parsed.skillSourceDir === 'string' ? parsed.skillSourceDir : '.skills';
  const skillTargets = Array.isArray(parsed.skillTargets) ? parsed.skillTargets : ['.codex/skills', '.claude/skills', '.cline/skills'];

  return {
    docs,
    skillSourceDir,
    skillTargets
  };
}
