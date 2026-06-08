/**
 * SkillValidator — pure, dependency-free validation of SKILL.md formatting conventions.
 *
 * Uses Obsidian's YAML helper for frontmatter parsing so no production YAML
 * parser dependency is bundled.
 *
 * Validation rules (from docs/plans/skills-protocol-integration-plan.md §7):
 *   - `name` is required, non-empty, and lowercase-hyphenated.
 *   - `description` is required, non-empty, trimmed length within [1, 1024],
 *     and free of newlines/control characters.
 *   - `validateProvider` holds a provider/`source` id to the same name rule so a
 *     model-supplied source can never introduce path traversal.
 *   - `validateSkillMd` additionally requires a leading `--- ... ---` YAML
 *     frontmatter block from which `name`/`description` are extracted.
 *
 * All errors are collected (validation does not short-circuit at the first error).
 */

import { parseYaml } from 'obsidian';
import type { SkillValidationResult, SkillFrontmatterInput } from '../types';

// Re-exported so callers can import the result/input shapes alongside the validator.
export type { SkillValidationResult, SkillFrontmatterInput };

/** lowercase-hyphenated: one-or-more lowercase-alphanumeric groups joined by single hyphens. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DESCRIPTION_MAX_LENGTH = 1024;

/**
 * True when `value` contains any C0 control char (U+0000–U+001F, includes
 * \n/\r/\t) or DEL (U+007F). Implemented with a charCode scan rather than a
 * control-char regex literal so no raw control bytes live in this source file.
 */
function containsControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

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

    // description: required, non-empty (trimmed), within length bound, and free
    // of control characters / newlines. The control-char check is defense in
    // depth: `yaml.stringify` already quotes a value containing `---`/newlines so
    // it cannot break out of the frontmatter block, but a single-line description
    // is the contract — reject embedded newlines/control chars outright (§7).
    const trimmedDescription = description.trim();
    if (trimmedDescription.length === 0) {
      errors.push('Skill "description" is required and must not be empty');
    } else if (trimmedDescription.length > DESCRIPTION_MAX_LENGTH) {
      errors.push(
        `Skill "description" must be at most ${DESCRIPTION_MAX_LENGTH} characters; got ${trimmedDescription.length}`
      );
    } else if (containsControlChars(description)) {
      errors.push('Skill "description" must not contain newlines or control characters');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate a provider/source id (the first path segment of a skill folder).
   * Held to the SAME lowercase-hyphenated rule as `name` so a model-supplied
   * `source` can never introduce path traversal (`..`), separators, or other
   * unsafe segments. See docs/plans/skills-protocol-integration-plan.md §7.
   */
  validateProvider(provider: string): SkillValidationResult {
    const errors: string[] = [];
    const value = typeof provider === 'string' ? provider : '';
    if (value.trim().length === 0) {
      errors.push('Skill provider/"source" is required and must not be empty');
    } else if (!NAME_PATTERN.test(value)) {
      errors.push(
        `Skill provider/"source" must be lowercase-hyphenated (matching ${NAME_PATTERN.source}); got "${value}"`
      );
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Parse + validate a raw SKILL.md string.
   *
   * The content must begin with a YAML frontmatter block delimited by `---`
   * lines. The `name`/`description` are extracted from it and validated via the
   * same rules as {@link validate}.
   */
  validateSkillMd(content: string): SkillValidationResult {
    const errors: string[] = [];
    const raw = typeof content === 'string' ? content : '';

    const frontmatter = this.extractFrontmatter(raw);
    if (frontmatter === null) {
      errors.push('SKILL.md must begin with a YAML frontmatter block');
      return { valid: false, errors };
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(frontmatter);
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
