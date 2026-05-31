/**
 * Skills App — shared types.
 *
 * Located at: src/agents/apps/skills/types.ts
 * Defines the SQLite-index record shape, the parsed-folder shape produced by
 * the scanner, validation result, and the frontmatter input used by the CRUA
 * tools. See docs/plans/skills-protocol-integration-plan.md §4 / §12.
 */

/**
 * A row in the `skills` SQLite index — a derived cache of the on-disk skill
 * folder. Source of truth is the folder; most columns are rebuildable by a
 * re-scan. `isArchived` + `lastLoadedAt` are owned state a re-scan preserves.
 */
export interface SkillRecord {
  id: string;
  provider: string;
  name: string;
  description: string;
  /** <root>/skills/<provider>/<name> — for lazy body/resource reads */
  vaultPath: string;
  /** <vault>/.<provider>/skills/<name> for sync-back; undefined for vault-native */
  originPath?: string;
  /** Skip identical writes + change detection (§3) */
  contentHash: string;
  isArchived: boolean;
  /** Updated on loadSkill — drives recency ordering in listSkills */
  lastLoadedAt?: number;
  created: number;
  updated: number;
}

/**
 * The shape produced by the scanner when parsing a skill folder's SKILL.md
 * frontmatter + structure. Upserted into a SkillRecord by the storage layer.
 */
export interface ParsedSkillFolder {
  provider: string;
  name: string;
  description: string;
  vaultPath: string;
  originPath?: string;
  contentHash: string;
}

/**
 * Result of validating a skill write through the SkillValidator (§7).
 */
export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Frontmatter + body input used by the create/update CRUA tools.
 */
export interface SkillFrontmatterInput {
  name: string;
  description: string;
  body?: string;
}
