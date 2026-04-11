import type { IAgent } from '../../../agents/interfaces/IAgent';
import type { ITool, ToolStatusTense } from '../../../agents/interfaces/ITool';

/**
 * Resolves a `technicalName` string (e.g. `"storageManager.move"`) into
 * the owning tool's `getStatusLabel()` override — the colocated source
 * of truth for tool status bar strings.
 *
 * The resolver is constructed with a lazy agent lookup so it can outlive
 * any particular plugin lifecycle phase. If agents are not yet registered
 * (or the plugin is shutting down), `resolve()` returns `undefined` and
 * callers fall back to a generic "Running {name}" label.
 *
 * This file is the bridge between the colocated tool status API and the
 * UI layer: ToolStatusBarController and toolDisplayFormatter delegate to
 * resolver → tool.getStatusLabel → parameterized display string, without
 * the UI layer needing to carry its own tool-name registry.
 */
export class ToolStatusLabelResolver {
  constructor(
    private readonly getAgent: (agentName: string) => IAgent | undefined
  ) {}

  resolve(
    technicalName: string | undefined,
    params: Record<string, unknown> | undefined,
    tense: ToolStatusTense
  ): string | undefined {
    if (!technicalName) return undefined;

    const normalized = technicalName.replace(/_/g, '.');
    const dotIndex = normalized.indexOf('.');
    if (dotIndex <= 0 || dotIndex === normalized.length - 1) {
      return undefined;
    }

    const agentName = normalized.slice(0, dotIndex);
    const toolSlug = normalized.slice(dotIndex + 1);

    let agent: IAgent | undefined;
    try {
      agent = this.getAgent(agentName);
    } catch {
      return undefined;
    }
    if (!agent) return undefined;

    let tool: ITool | undefined;
    try {
      tool = agent.getTool(toolSlug);
    } catch {
      return undefined;
    }
    if (!tool || typeof tool.getStatusLabel !== 'function') {
      return undefined;
    }

    try {
      return tool.getStatusLabel(params, tense);
    } catch {
      // Overrides must not throw — but if one does, don't blow up the UI.
      return undefined;
    }
  }
}
