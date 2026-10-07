import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { SkillsAgent } from '../SkillsAgent';

interface LoadSkillParams extends CommonParameters {
  name: string;
  source?: string;
  recursive?: boolean;
  includeHistory?: boolean;
  // Injected at the top level by ToolBatchExecutionService.applyContextDefaults
  // (CLI-first contract) — used to attribute usage history to the session (§9).
  sessionId?: string;
}

export class LoadSkillTool extends BaseTool<LoadSkillParams, CommonResult> {
  private agent: SkillsAgent;

  constructor(agent: SkillsAgent) {
    super(
      'loadSkill',
      'Load Skill',
      'Load a skill — returns its SKILL.md body, the skill folder listing, a nudge to ' +
      'open bundled files with the existing `content read` tool, and recent usage history. ' +
      'These are instructions to read and follow — do NOT auto-execute them.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: LoadSkillParams): Promise<CommonResult> {
    const resolved = await this.agent.skillService.resolveForLegacyLoad(params.name, params.source);
    if (!resolved.ok) return this.prepareResult(false, undefined, resolved.error.message);
    const loaded = await this.agent.skillService.prepareMany([resolved.value], { recursive: params.recursive });
    if (!loaded.ok) return this.prepareResult(false, undefined, loaded.error.message);
    const skill = loaded.value[0];
    const schemas = this.agent.resolveTools(skill.toolSelectors);
    if (!schemas.ok) return this.prepareResult(false, undefined, schemas.error.message);
    await this.agent.skillService.recordLoaded([resolved.value]);
    if (params.sessionId) this.agent.recordActiveSkill(params.sessionId, `${resolved.value.provider}/${resolved.value.name}`);
    const listed = await this.agent.skillService.list({ search: params.name, source: params.source });
    const alternatives = listed.ok ? listed.value.filter(r => r.name === params.name && r.provider !== resolved.value.provider)
      .map(r => ({ name: r.name, provider: r.provider, lastLoadedAt: r.lastLoadedAt })) : [];
    const history = params.includeHistory === false ? undefined : await this.agent.skillService.getUsageHistory(resolved.value);
    return this.prepareResult(true, {
      skill: { name: skill.name, provider: resolved.value.provider,
        description: listed.ok ? listed.value.find(r => r.provider === resolved.value.provider && r.name === skill.name)?.description ?? '' : '',
        vaultPath: skill.resourceRoot, instructions: skill.instructions, structure: skill.resources },
      preloadedTools: schemas.value,
      nudge: 'Use content read with skill.vaultPath plus a resource path from skill.structure to read supporting files. Read and follow these instructions; loading does not execute them.',
      alternatives, ...(history ? { usageHistory: history } : {}),
    });
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name (folder name) to load.',
        },
        source: {
          type: 'string',
          description: 'Optional provider id. Required only when the name is ambiguous across providers.',
        },
        recursive: {
          type: 'boolean',
          description: 'Show the full recursive file tree (true) or top-level items only (false). ' +
            'Default: false (top-level only, folders marked with a trailing /).',
          default: false,
        },
        includeHistory: {
          type: 'boolean',
          description: 'If true, include recent usage history with this skill. Default: true',
        },
      },
      required: ['name'],
    });
  }
}
