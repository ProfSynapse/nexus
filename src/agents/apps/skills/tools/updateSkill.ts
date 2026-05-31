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
import { SkillValidator } from '../services/SkillValidator';
import { fnv1aHex } from '../services/skillHash';

interface UpdateSkillParams extends CommonParameters {
  name: string;
  source?: string;
  description?: string;
  body?: string;
  rename?: string;
}

/** Split a SKILL.md into its parsed frontmatter fields and trailing body. */
async function splitSkillMd(content: string): Promise<{ name: string; description: string; body: string }> {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    return { name: '', description: '', body: normalized.trim() };
  }

  let name = '';
  let description = '';
  try {
    const { parse } = await import('yaml');
    const parsed: unknown = parse(match[1]);
    if (parsed && typeof parsed === 'object') {
      const fields = parsed as Record<string, unknown>;
      name = typeof fields.name === 'string' ? fields.name : '';
      description = typeof fields.description === 'string' ? fields.description : '';
    }
  } catch {
    // Unparseable frontmatter → treat fields as empty; merge fills from params.
  }

  return { name, description, body: (match[2] ?? '').trim() };
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
    const current = await splitSkillMd(currentContent);

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

    // TODO(sync slice): syncedBackTo when origin_path is set.
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
