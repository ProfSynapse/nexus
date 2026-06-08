/**
 * skillFrontmatter — shared SKILL.md frontmatter parser for the Skills app.
 *
 * Located at: src/agents/apps/skills/services/skillFrontmatter.ts
 * Extracted so the scanner, the CRUA tools, and the SkillSyncService share ONE
 * implementation of "split a SKILL.md into its leading `---` YAML block + body".
 */
import { parseYaml } from 'obsidian';

/**
 * Parse a SKILL.md: leading `---\nYAML\n---` block + trailing body.
 *
 * Returns the parsed `name`/`description` (when present + string) and the
 * trimmed `body`. When there is no frontmatter (or it is unparseable) `name`
 * and `description` are undefined and the whole content becomes the body.
 *
 * NOTE: callers that want to fall back to the folder name when `name` is absent
 * (e.g. the scanner) must do so themselves — this util reports only what the
 * frontmatter actually contains.
 */
export function parseSkillFrontmatter(
  content: string
): { name?: string; description?: string; body: string } {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    return { body: normalized.trim() };
  }

  let name: string | undefined;
  let description: string | undefined;
  try {
    const parsed: unknown = parseYaml(match[1]);
    if (parsed && typeof parsed === 'object') {
      const fields = parsed as Record<string, unknown>;
      if (typeof fields.name === 'string') {
        name = fields.name;
      }
      if (typeof fields.description === 'string') {
        description = fields.description;
      }
    }
  } catch {
    // Unparseable frontmatter → leave name/description undefined.
  }

  return { name, description, body: (match[2] ?? '').trim() };
}
