import { BaseAgent } from '../baseAgent';
import type { SkillService } from '../../services/skills/SkillService';
import type { ToolCatalogPort, ServiceResult } from '../../services/instructions/types';
import type { CliToolSchema } from '../toolManager/types';
import { ListSkillsTool } from './tools/listSkills';
import { LoadSkillTool } from './tools/loadSkill';
import { CreateSkillTool } from './tools/createSkill';
import { UpdateSkillTool } from './tools/updateSkill';
import { ArchiveSkillTool } from './tools/archiveSkill';
import { SyncSkillsTool } from './tools/syncSkills';

/** Always registered core agent; content readiness is handled per operation. */
export class SkillsAgent extends BaseAgent {
  private catalog?: ToolCatalogPort;
  constructor(readonly skillService: SkillService, private readonly attribution?: { addActiveSkill(sessionId: string, skillId: string): void }) {
    super('skills', 'Discover, load, edit, archive, and sync instruction packages.', '1.0.0');
    this.registerTool(new ListSkillsTool(this));
    this.registerTool(new LoadSkillTool(this));
    this.registerTool(new CreateSkillTool(this));
    this.registerTool(new UpdateSkillTool(this));
    this.registerTool(new ArchiveSkillTool(this));
    this.registerTool(new SyncSkillsTool(this));
  }
  setToolCatalog(catalog: ToolCatalogPort): void { this.catalog = catalog; }
  resolveTools(selectors: string[]): ServiceResult<CliToolSchema[]> {
    if (!selectors.length) return { ok: true, value: [] };
    return this.catalog?.resolve(selectors) ?? { ok: false, error: { code: 'initializing', message: 'Tool catalog is initializing' } };
  }
  recordActiveSkill(sessionId: string, skillId: string): void {
    try { this.attribution?.addActiveSkill(sessionId, skillId); } catch { /* Attribution cannot fail loading. */ }
  }
}
