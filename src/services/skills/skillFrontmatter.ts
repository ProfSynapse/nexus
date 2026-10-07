import { parseYaml } from 'obsidian';

export interface ParsedSkillDocument {
  name?: string;
  description?: string;
  body: string;
  frontmatter: Record<string, unknown>;
  error?: string;
}

/** Split an entry point without throwing away provider or Nexus metadata. */
export function parseSkillFrontmatter(content: string): ParsedSkillDocument {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { body: normalized.trim(), frontmatter: {} };
  try {
    const parsed: unknown = parseYaml(match[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body: match[2].trim(), frontmatter: {}, error: 'Skill frontmatter must be a mapping' };
    }
    const frontmatter = parsed as Record<string, unknown>;
    return {
      name: typeof frontmatter.name === 'string' ? frontmatter.name : undefined,
      description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined,
      body: match[2].trim(), frontmatter,
    };
  } catch {
    return { body: match[2].trim(), frontmatter: {}, error: 'Skill frontmatter is invalid YAML' };
  }
}

export function readNexusMetadata(frontmatter: Record<string, unknown>): {
  tools: string[]; categories: string[]; error?: string;
} {
  const metadata = frontmatter.metadata;
  if (metadata === undefined) return { tools: [], categories: [] };
  if (!isMapping(metadata)) return { tools: [], categories: [], error: 'Skill metadata must be a mapping' };
  const nexus = metadata.nexus;
  if (nexus === undefined) return { tools: [], categories: [] };
  if (!isMapping(nexus)) return { tools: [], categories: [], error: 'metadata.nexus must be a mapping' };
  for (const key of ['tools', 'categories']) {
    const value = nexus[key];
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()))) {
      return { tools: [], categories: [], error: `metadata.nexus.${key} must be an array of nonempty strings` };
    }
  }
  return {
    tools: (nexus.tools as string[] | undefined) ?? [],
    categories: (nexus.categories as string[] | undefined) ?? [],
  };
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function mergeSkillFrontmatter(base: Record<string, unknown>, patch: Record<string, unknown> = {}, tools?: string[]): Record<string, unknown> {
  const merged = { ...base, ...patch };
  if (isMapping(base.metadata) && isMapping(patch.metadata)) {
    merged.metadata = { ...base.metadata, ...patch.metadata };
    if (isMapping(base.metadata.nexus) && isMapping(patch.metadata.nexus)) {
      (merged.metadata as Record<string, unknown>).nexus = { ...base.metadata.nexus, ...patch.metadata.nexus };
    }
  }
  if (tools !== undefined) {
    const metadata = isMapping(merged.metadata) ? merged.metadata : {};
    const nexus = isMapping(metadata.nexus) ? metadata.nexus : {};
    merged.metadata = { ...metadata, nexus: { ...nexus, tools } };
  }
  return merged;
}
