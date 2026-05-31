/**
 * SkillsAgent — Skills app agent.
 *
 * Located at: src/agents/apps/skills/SkillsAgent.ts
 * Discover, load, edit, and sync agent skills (SKILL.md folders) sourced from
 * provider dotfolders at the vault root and mirrored under <root>/skills/.
 * A skill is a playbook (a prompt the agent reads back and follows), not code
 * that runs. Cross-platform, no credentials — everything via vault.adapter.
 *
 * Registered in: AppManager.getBuiltInAppRegistry()
 * Modeled on: src/agents/apps/composer/ComposerAgent.ts
 * See: docs/plans/skills-protocol-integration-plan.md §6 / §12.
 */

import { BaseAppAgent } from '../BaseAppAgent';
import { AppManifest } from '../../../types/apps/AppTypes';
import { ListSkillsTool } from './tools/listSkills';
import { LoadSkillTool } from './tools/loadSkill';
import { CreateSkillTool } from './tools/createSkill';
import { UpdateSkillTool } from './tools/updateSkill';
import { ArchiveSkillTool } from './tools/archiveSkill';
import { SyncSkillsTool } from './tools/syncSkills';

const SKILLS_MANIFEST: AppManifest = {
  id: 'skills',
  agentName: 'skills',
  name: 'Skills',
  author: 'Nexus',
  version: '1.0.0',
  description: 'Discover, load, edit, and sync agent skills (SKILL.md folders) across providers.',
  credentials: [],
  validation: {
    mode: 'none',
  },
  tools: [
    { slug: 'listSkills', description: 'List discovered skills, recency-ordered, with name/provider/description' },
    { slug: 'loadSkill', description: 'Load a skill — returns its SKILL.md body, folder listing, and recent usage history' },
    { slug: 'createSkill', description: 'Create a new vault-native skill from name/description/body (validated)' },
    { slug: 'updateSkill', description: 'Update an existing skill\'s frontmatter/body (validated; archives prior version)' },
    { slug: 'archiveSkill', description: 'Soft-delete (archive) or restore a skill — the model\'s only "delete"' },
    { slug: 'syncSkills', description: 'Import provider skills and sync edited skills back to their origin dotfolders' },
  ],
};

export class SkillsAgent extends BaseAppAgent {
  constructor() {
    super(SKILLS_MANIFEST);
    this.registerTool(new ListSkillsTool(this));
    this.registerTool(new LoadSkillTool(this));
    this.registerTool(new CreateSkillTool(this));
    this.registerTool(new UpdateSkillTool(this));
    this.registerTool(new ArchiveSkillTool(this));
    this.registerTool(new SyncSkillsTool(this));
  }
}
