/**
 * UpdateSkillTool — CRUA update tool for the Skills app.
 *
 * Located at: src/agents/apps/skills/tools/updateSkill.ts
 * Updates an existing skill's frontmatter/body (all but name optional), archives
 * the prior version into the skill's own _archive/<ts>/ before overwriting (§3),
 * and renames the folder (carrying resources over) when --rename is given.
 * Validated (§7). Sync-back to the origin dotfolder is a LATER slice.
 * See: docs/plans/skills-protocol-integration-plan.md §12.
 */

import { normalizePath } from 'obsidian';
import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';
import { resolveSkillsRuntime, resolveSkillByName } from '../services/SkillsContext';
import { SkillWriteService } from '../services/SkillWriteService';
import { SkillSyncService } from '../services/SkillSyncService';
import { SkillValidator } from '../services/SkillValidator';
import { fnv1aHex } from '../services/skillHash';
import { parseSkillFrontmatter } from '../services/skillFrontmatter';

interface UpdateSkillParams extends CommonParameters {
  name: string;
  source?: string;
  description?: string;
  body?: string;
  rename?: string;
}

export class UpdateSkillTool extends BaseTool<UpdateSkillParams, CommonResult> {
  private agent: SkillsAgent;

  constructor(agent: SkillsAgent) {
    super(
      'updateSkill',
      'Update Skill',
      'Update an existing skill\'s description and/or body, optionally renaming it. ' +
      'Validated before writing; archives the prior version and syncs back to the origin if provider-sourced.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: UpdateSkillParams): Promise<CommonResult> {
    const r = resolveSkillsRuntime(this.agent);
    if (!r.ok) {
      return this.prepareResult(false, undefined, r.error);
    }

    // Resolve the target skill (source/ambiguity handling shared with archiveSkill).
    const resolved = await resolveSkillByName(r.rt.index, params.name, params.source);
    if (!resolved.ok) {
      return this.prepareResult(false, undefined, resolved.error);
    }
    const existing = resolved.record;
    const provider = existing.provider;

    const write = new SkillWriteService(r.rt.vaultAdapter);

    // Read the current SKILL.md to source any fields the caller did not override.
    const currentContent = await write.readSkillMd(existing.vaultPath);
    if (currentContent === null) {
      return this.prepareResult(false, undefined,
        `Could not read SKILL.md for skill "${existing.name}" (${provider}) at ${existing.vaultPath}/SKILL.md`);
    }
    const current = await parseSkillFrontmatter(currentContent);

    // Merge: caller values win, else fall back to the current on-disk values.
    const newName = params.rename ?? existing.name;
    const newDescription = params.description ?? (current.description || existing.description);
    const newBody = params.body ?? current.body;

    // Validate the merged frontmatter (§7) before any write.
    const validation = new SkillValidator().validate({ name: newName, description: newDescription });
    if (!validation.valid) {
      return this.prepareResult(false, { validationErrors: validation.errors }, 'Skill validation failed');
    }

    const oldFolder = normalizePath(existing.vaultPath);
    const isRename = newName !== existing.name;
    const newFolder = isRename
      ? normalizePath(`${r.rt.skillsRoot}/${provider}/${newName}`)
      : oldFolder;

    if (isRename && (await write.exists(newFolder))) {
      return this.prepareResult(false, undefined, `Skill already exists: ${provider}/${newName}`);
    }

    const skillMd = await write.composeSkillMd(newName, newDescription, newBody);

    let archivedVersion: string | null;
    if (isRename) {
      // Rename: carry the old folder's resources into the new folder, snapshot
      // the prior version co-located in the NEW folder's _archive/, write the
      // freshly-composed SKILL.md, then drop the old folder. The snapshot must
      // live under newFolder because oldFolder is removed below.
      await write.copyTree(oldFolder, newFolder); // non-SKILL.md resources (skips _/. children)
      archivedVersion = await write.archiveThenReplace(newFolder, async () => {
        await write.writeSkill(newFolder, skillMd);
      });
      await write.removeTree(oldFolder);

      await r.rt.index.renameRow(provider, existing.name, newName, newFolder);
    } else {
      // In-place update: snapshot then overwrite SKILL.md in the same folder.
      archivedVersion = await write.archiveThenReplace(oldFolder, async () => {
        await write.writeSkill(oldFolder, skillMd);
      });
    }

    // Refresh the index row (hash/description/vaultPath) via the owned-state-
    // preserving UPSERT.
    await r.rt.index.upsertOne({
      provider,
      name: newName,
      description: newDescription,
      vaultPath: newFolder,
      originPath: existing.originPath,
      contentHash: fnv1aHex(skillMd),
    });

    const result: Record<string, unknown> = {
      skill: {
        name: newName,
        provider,
        vaultPath: newFolder,
        description: newDescription,
      },
    };
    if (archivedVersion !== null) {
      result.archivedVersion = archivedVersion;
    }

    // Sync-back: if this skill originated from a provider dotfolder, push the
    // updated mirror copy back to its origin. A sync-back failure must NOT fail
    // the update — wrap defensively and swallow (no logger wired in this app).
    if (existing.originPath) {
      try {
        const updated = await r.rt.index.getOne(provider, newName);
        if (updated) {
          const sync = new SkillSyncService(r.rt.vaultAdapter, r.rt.skillsRoot, r.rt.index);
          const syncedBackTo = await sync.syncBackOne(updated);
          if (syncedBackTo !== null) {
            result.syncedBackTo = syncedBackTo;
          }
        }
      } catch {
        // Sync-back is best-effort — never fail the update on it.
      }
    }

    return this.prepareResult(true, result);
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the skill to update.',
        },
        source: {
          type: 'string',
          description: 'Optional provider id to disambiguate when the name exists across providers.',
        },
        description: {
          type: 'string',
          description: 'Optional new description. Validated for non-empty and sane length.',
        },
        body: {
          type: 'string',
          description: 'Optional new SKILL.md body.',
        },
        rename: {
          type: 'string',
          description: 'Optional new name — lowercase-hyphenated. Renames the skill folder.',
        },
      },
      required: ['name'],
    });
  }
}
