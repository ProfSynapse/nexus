/**
 * SkillValidator — pure, dependency-free validation of SKILL.md formatting conventions.
 *
 * No Obsidian imports, no Node imports. Pure TypeScript so it is trivially
 * unit-testable and mobile-safe. The only external dependency (`yaml`) is loaded
 * via a DYNAMIC import inside the async path so module init stays mobile-safe.
 *
 * Validation rules (from docs/plans/skills-protocol-integration-plan.md §7):
 *   - `name` is required, non-empty, and lowercase-hyphenated.
 *   - `description` is required, non-empty, trimmed length within [1, 1024].
 *   - `validateSkillMd` additionally requires a leading `--- ... ---` YAML
 *     frontmatter block from which `name`/`description` are extracted.
 *
 * All errors are collected (validation does not short-circuit at the first error).
 */

import type { SkillValidationResult, SkillFrontmatterInput } from '../types';

// Re-exported so callers can import the result/input shapes alongside the validator.
export type { SkillValidationResult, SkillFrontmatterInput };

/** lowercase-hyphenated: one-or-more lowercase-alphanumeric groups joined by single hyphens. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DESCRIPTION_MAX_LENGTH = 1024;

export class SkillValidator {
  /**
   * Validate structured frontmatter input (used by createSkill/updateSkill).
   * Synchronous — no YAML parsing required.
   */
  validate(input: SkillFrontmatterInput): SkillValidationResult {
    const errors: string[] = [];

    const name = typeof input?.name === 'string' ? input.name : '';
    const description = typeof input?.description === 'string' ? input.description : '';

    // name: required, non-empty, lowercase-hyphenated
    if (name.trim().length === 0) {
      errors.push('Skill "name" is required and must not be empty');
    } else if (!NAME_PATTERN.test(name)) {
      errors.push(
        `Skill "name" must be lowercase-hyphenated (matching ${NAME_PATTERN.source}); got "${name}"`
      );
    }

    // description: required, non-empty (trimmed), within length bound
    const trimmedDescription = description.trim();
    if (trimmedDescription.length === 0) {
      errors.push('Skill "description" is required and must not be empty');
    } else if (trimmedDescription.length > DESCRIPTION_MAX_LENGTH) {
      errors.push(
        `Skill "description" must be at most ${DESCRIPTION_MAX_LENGTH} characters; got ${trimmedDescription.length}`
      );
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Parse + validate a raw SKILL.md string.
   *
   * The content must begin with a YAML frontmatter block delimited by `---`
   * lines. The `name`/`description` are extracted from it and validated via the
   * same rules as {@link validate}. Async because YAML is dynamically imported.
   */
  async validateSkillMd(content: string): Promise<SkillValidationResult> {
    const errors: string[] = [];
    const raw = typeof content === 'string' ? content : '';

    const frontmatter = this.extractFrontmatter(raw);
    if (frontmatter === null) {
      errors.push('SKILL.md must begin with a YAML frontmatter block');
      return { valid: false, errors };
    }

    let parsed: unknown;
    try {
      const { parse } = await import('yaml');
      parsed = parse(frontmatter);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`SKILL.md frontmatter is not valid YAML: ${message}`);
      return { valid: false, errors };
    }

    const fields = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>) : {};
    const name = typeof fields.name === 'string' ? fields.name : '';
    const description = typeof fields.description === 'string' ? fields.description : '';

    // Delegate to the structured validator so the rules stay in one place.
    const structured = this.validate({ name, description });
    errors.push(...structured.errors);

    return { valid: errors.length === 0, errors };
  }

  /**
   * Extract the inner text of a leading `--- ... ---` YAML frontmatter block.
   * Returns null when the content does not begin with such a block.
   */
  private extractFrontmatter(content: string): string | null {
    // Normalize CRLF so the line-based scan works cross-platform.
    const normalized = content.replace(/\r\n/g, '\n');

    // Must START with a `---` line (allowing leading blank lines/BOM whitespace
    // is intentionally NOT permitted — frontmatter must lead the file).
    const lines = normalized.split('\n');
    if (lines.length === 0 || lines[0].trim() !== '---') {
      return null;
    }

    // Find the closing `---` line.
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        return lines.slice(1, i).join('\n');
      }
    }

    // Opening fence with no closing fence — not a valid block.
    return null;
  }
}
