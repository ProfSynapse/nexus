import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import { ReadBaseTool, WriteBaseTool, UpdateBaseTool, ListBaseTool } from './tools';

/**
 * Agent for Obsidian Bases — `.base` files, the saved database-style query over
 * the vault that renders as a table, cards, list or map.
 *
 * Tools (4 today; `analyze` lands in Phase 3):
 * - read:   parsed config of a base file
 * - write:  create a NEW base (validated first)
 * - update: modify an EXISTING base, replacing only the sections supplied
 * - list:   enumerate .base files with view/formula counts
 *
 * ## Naming: why `baseManager` and not `basesManager`
 *
 * The CLI name is not chosen, it is derived: `getAgentAlias` is
 * `toKebabCase(agentName)`, which strips a trailing `Manager`. `basesManager`
 * would advertise as `bases`, but the design plan and issue #330 specify the
 * command `base read` / `base list` / `base analyze` throughout — so the agent
 * is named `baseManager`, which is the only name that produces the documented
 * command. Verify with:
 *   python3 .claude/skills/nexus-agents/scripts/cli_name.py baseManager
 *
 * ## Availability
 *
 * This agent is registered ONLY when Bases is enabled in the vault. The probe
 * and the gate live in `AgentInitializationService.initializeBaseManager()` via
 * `ensureAnalyzeViewRegistered()`; see `services/basesAvailability.ts` for why
 * the registration doubles as the probe and what happens if Bases is toggled
 * at runtime.
 */
export class BaseManagerAgent extends BaseAgent {
  protected app: App;

  constructor(app: App) {
    super(
      'baseManager',
      'Obsidian Bases operations for .base files - the saved query that renders as a table, cards, list or map view. Read, create and modify bases with filters, formulas, properties, summaries and views. Configs are validated before they are written.',
      '1.0.0'
    );

    this.app = app;

    this.registerLazyTool({
      slug: 'read',
      name: 'Read Base',
      description: 'Read a base file (.base) and return its parsed config: filters, formulas, properties, summaries and views',
      version: '1.0.0',
      factory: () => new ReadBaseTool(app)
    });
    this.registerLazyTool({
      slug: 'write',
      name: 'Write Base',
      description: 'Create a NEW base file (.base). Fails if the base already exists - use baseManager.update to modify an existing one. The config is validated before anything is written; a rejection lists every problem with its path and code.',
      version: '1.0.0',
      factory: () => new WriteBaseTool(app)
    });
    this.registerLazyTool({
      slug: 'update',
      name: 'Update Base',
      description: 'Modify an EXISTING base file (.base). Replaces ONLY the top-level sections you supply (filters, formulas, properties, summaries, views) and keeps the rest - unlike canvasManager.update, which replaces whole arrays. Fails if the base does not exist - use baseManager.write to create one. The merged config is validated before anything is written.',
      version: '1.0.0',
      factory: () => new UpdateBaseTool(app)
    });
    this.registerLazyTool({
      slug: 'list',
      name: 'List Bases',
      description: 'List base files (.base) in the vault with view and formula counts',
      version: '1.0.0',
      factory: () => new ListBaseTool(app)
    });
  }
}
