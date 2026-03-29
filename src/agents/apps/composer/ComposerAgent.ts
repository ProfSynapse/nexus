/**
 * ComposerAgent — File composition app agent.
 *
 * Located at: src/agents/apps/composer/ComposerAgent.ts
 * Merges multiple vault files of the same type into a single output.
 * Supports markdown concatenation, PDF merging, and audio composition
 * (concat + multi-track mixing). No external API keys required.
 *
 * Registered in: AppManager.getBuiltInAppRegistry()
 * Exported from: src/agents/apps/index.ts
 */

import { BaseAppAgent } from '../BaseAppAgent';
import { AppManifest } from '../../../types/apps/AppTypes';
import { ComposeTool } from './tools/compose';
import { ListFormatsTool } from './tools/listFormats';

const COMPOSER_MANIFEST: AppManifest = {
  id: 'composer',
  name: 'Composer',
  description: 'Compose vault files — merge markdown, PDF, and audio into single output files',
  version: '1.0.0',
  author: 'Nexus',
  credentials: [],
  tools: [
    { slug: 'compose', description: 'Merge multiple files of the same type into one output' },
    { slug: 'listFormats', description: 'List supported composition formats and their extensions' },
  ],
};

export class ComposerAgent extends BaseAppAgent {
  constructor() {
    super(COMPOSER_MANIFEST);
    this.registerTool(new ComposeTool(this));
    this.registerTool(new ListFormatsTool(this));
  }
}
