/**
 * SystemPromptBuilder - Constructs system prompts for chat conversations
 *
 * Responsibilities:
 * - Build multi-section XML system prompts
 * - Inject session/workspace context for tool calls
 * - Add enhancement data from suggesters (tools, prompts, notes)
 * - Include custom prompts and workspace context
 * - Delegate file content reading to FileContentService
 *
 * Follows Single Responsibility Principle - only handles prompt composition.
 */

import { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import { MessageEnhancement } from '../components/suggesters/base/SuggesterInterfaces';
import { CompactedContext } from '../../../services/chat/ContextCompactionService';
import { CompactionFrontierRecord } from '../../../services/chat/CompactionFrontierService';

/**
 * Vault structure for system prompt context
 */
export interface VaultStructure {
  rootFolders: string[];
  rootFiles: string[];
}

/**
 * Available workspace summary for system prompt
 */
export interface WorkspaceSummary {
  id: string;
  name: string;
  description?: string;
  rootFolder: string;
}

/**
 * Available prompt summary for system prompt (user-created prompts)
 */
export interface PromptSummary {
  id: string;
  name: string;
  description: string;
}

/**
 * Tool agent info for system prompt
 */
export interface ToolAgentInfo {
  name: string;
  description: string;
  tools: string[];
}

/**
 * Context status for token-limited models (e.g., Nexus 4K context)
 */
export interface ContextStatusInfo {
  usedTokens: number;
  maxTokens: number;
  percentUsed: number;
  status: 'ok' | 'warning' | 'critical';
  statusMessage: string;
}

export interface LoadedWorkspaceData {
  id?: string;
  name?: string;
  context?: {
    name?: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface SystemPromptOptions {
  sessionId?: string;
  workspaceId?: string;
  contextNotes?: string[];
  messageEnhancement?: MessageEnhancement | null;
  customPrompt?: string | null;
  workspaceContext?: WorkspaceContext | null;
  // Full comprehensive workspace data from LoadWorkspaceTool (when workspace selected in settings)
  loadedWorkspaceData?: LoadedWorkspaceData | null;
  // Skip the tools section for models that are pre-trained on the toolset (e.g., Nexus)
  skipToolsSection?: boolean;
  // Context status for token-limited models (enables context awareness)
  contextStatus?: ContextStatusInfo | null;
  // Active compaction frontier (bounded multi-record projection)
  compactionFrontier?: CompactionFrontierRecord[] | null;
  // Legacy single-record fallback for older callers while frontier migration completes.
  legacyCompactionRecord?: CompactedContext | null;
  // Legacy alias retained for compatibility with older tests/call sites.
  previousContext?: CompactedContext | null;
}

export class SystemPromptBuilder {
  constructor(
    private readNoteContent: (notePath: string) => Promise<string>,
    private loadWorkspace?: (workspaceId: string) => Promise<LoadedWorkspaceData | null>
  ) {}

  /**
   * Build complete system prompt with all sections
   */
  async build(options: SystemPromptOptions): Promise<string | null> {
    const sections: string[] = [];

    // 0. Context status (for token-limited models like Nexus)
    // This goes FIRST so the model is immediately aware of its constraints
    if (options.contextStatus) {
      const contextStatusSection = this.buildContextStatusSection(options.contextStatus);
      if (contextStatusSection) {
        sections.push(contextStatusSection);
      }
    }

    // 0.5. Compaction frontier (from compaction - truncated conversation summaries)
    // This comes right after status so the model knows what came before
    const legacyCompactionRecord = options.legacyCompactionRecord ?? options.previousContext;
    const compactionFrontier = options.compactionFrontier && options.compactionFrontier.length > 0
      ? options.compactionFrontier
      : (legacyCompactionRecord && legacyCompactionRecord.summary ? [legacyCompactionRecord] : []);
    if (compactionFrontier.length > 0) {
      const compactionFrontierSection = this.buildCompactionFrontierSection(compactionFrontier);
      if (compactionFrontierSection) {
        sections.push(compactionFrontierSection);
      }
    }

    // 1. Session context with tools overview (skip for pre-trained models like Nexus)
    if (!options.skipToolsSection) {
      const sessionSection = this.buildSessionContext(options.sessionId, options.workspaceId);
      if (sessionSection) {
        sections.push(sessionSection);
      }
    }

    // 2. Working strategy
    const workingStrategySection = this.buildWorkingStrategySection();
    if (workingStrategySection) {
      sections.push(workingStrategySection);
    }

    // 3. Context files section
    const filesSection = await this.buildFilesSection(
      options.contextNotes || [],
      options.messageEnhancement
    );
    if (filesSection) {
      sections.push(filesSection);
    }

    // 4. Tool hints from /suggester
    const toolHintsSection = this.buildToolHintsSection(options.messageEnhancement);
    if (toolHintsSection) {
      sections.push(toolHintsSection);
    }

    // 5. Custom prompts from @suggester
    const customPromptsSection = this.buildCustomPromptsSection(options.messageEnhancement);
    if (customPromptsSection) {
      sections.push(customPromptsSection);
    }

    // 6. Workspace references from #suggester
    const workspaceReferencesSection = await this.buildWorkspaceReferencesSection(options.messageEnhancement);
    if (workspaceReferencesSection) {
      sections.push(workspaceReferencesSection);
    }

    // 7. Custom prompt (if prompt selected)
    const customPromptSection = this.buildSelectedPromptSection(options.customPrompt);
    if (customPromptSection) {
      sections.push(customPromptSection);
    }

    // 8. Selected workspace context (full data from settings selection)
    const workspaceSection = this.buildSelectedWorkspaceSection(
      options.loadedWorkspaceData,
      options.workspaceContext
    );
    if (workspaceSection) {
      sections.push(workspaceSection);
    }

    return sections.length > 0 ? sections.join('\n') : null;
  }

  /**
   * Build session context section for tool calls
   * Includes tools overview and context parameter instructions
   */
  private buildSessionContext(sessionId?: string, workspaceId?: string): string | null {
    const effectiveSessionId = sessionId || `session_${Date.now()}`;
    const effectiveWorkspaceId = workspaceId || 'default';

    let prompt = '<tools_and_context>\n';

    prompt += `You have two meta-tools:
- getTools: discover the tools and schemas needed for the next step
- useTools: execute tool calls

Context (REQUIRED in every useTools call):
- workspaceId: "${effectiveWorkspaceId}"
- sessionId: "${effectiveSessionId}"
- memory: brief summary of the conversation so far
- goal: brief statement of the current objective
- constraints: (optional) any rules or limits

Calls array: [{ agent: "agentName", tool: "toolName", params: {...} }]

Use getTools narrowly. Do not assume schemas from memory. Use "params" for tool arguments.
Keep workspaceId and sessionId exactly as shown.
`;

    prompt += '</tools_and_context>';

    return prompt;
  }

  /**
   * Build the lean working strategy section
   */
  private buildWorkingStrategySection(): string {
    return `<working_strategy>
If a workspace is selected, use it as the primary context.

If no workspace is selected and the request looks like ongoing or multi-step work, consider whether an existing workspace should be loaded first. Ask before creating a new workspace.

For multi-step or ongoing work, suggest using TaskManager to track it. Ask before creating task/project structure unless the user clearly asked for it.

Before major structured action, check whether a useful custom prompt already exists. If the pattern seems reusable or recurring, suggest creating a custom prompt or workflow. Ask before creating either. If a workflow is created, consider attaching the right prompt or agent.

Gather context progressively:
1. list or search to narrow scope
2. read the most relevant files, notes, workspace data, prompts, or tasks
3. then write or edit once you have enough context

Prefer targeted context gathering over large dumps.
</working_strategy>`;
  }

  /**
   * Build files section with context notes and enhancement notes
   */
  private async buildFilesSection(
    contextNotes: string[],
    messageEnhancement?: MessageEnhancement | null
  ): Promise<string | null> {
    const hasContextNotes = contextNotes.length > 0;
    const hasEnhancementNotes = messageEnhancement && messageEnhancement.notes.length > 0;

    if (!hasContextNotes && !hasEnhancementNotes) {
      return null;
    }

    let prompt = '<files>\n';

    // Add context notes
    for (const notePath of contextNotes) {
      const xmlTag = this.normalizePathToXmlTag(notePath);
      const content = await this.readNoteContent(notePath);

      prompt += `<${xmlTag}>\n`;
      prompt += `${this.escapeXmlContent(notePath)}\n\n`;
      prompt += this.escapeXmlContent(content || '[File content unavailable]');
      prompt += `\n</${xmlTag}>\n`;
    }

    // Add enhancement notes from [[suggester]]
    if (hasEnhancementNotes) {
      for (const note of messageEnhancement?.notes || []) {
        const xmlTag = this.normalizePathToXmlTag(note.path);
        prompt += `<${xmlTag}>\n`;
        prompt += `${this.escapeXmlContent(note.path)}\n\n`;
        prompt += this.escapeXmlContent(note.content);
        prompt += `\n</${xmlTag}>\n`;
      }
    }

    prompt += '</files>';

    return prompt;
  }

  /**
   * Build tool hints section from /suggester
   */
  private buildToolHintsSection(messageEnhancement?: MessageEnhancement | null): string | null {
    if (!messageEnhancement || messageEnhancement.tools.length === 0) {
      return null;
    }

    let prompt = '<tool_hints>\n';
    prompt += 'The user has requested to use the following tools:\n\n';

    for (const tool of messageEnhancement.tools) {
      prompt += `Tool: ${this.escapeXmlContent(tool.name)}\n`;
      prompt += `Description: ${this.escapeXmlContent(tool.schema.description)}\n`;
      prompt += 'Please prioritize using this tool when applicable.\n\n';
    }

    prompt += '</tool_hints>';

    return prompt;
  }

  /**
   * Build custom prompts section from @suggester
   */
  private buildCustomPromptsSection(messageEnhancement?: MessageEnhancement | null): string | null {
    if (!messageEnhancement || messageEnhancement.prompts.length === 0) {
      return null;
    }

    let prompt = '<custom_prompts>\n';
    prompt += 'The user has mentioned the following custom prompts. Apply their instructions:\n\n';

    for (const customPrompt of messageEnhancement.prompts) {
      prompt += `<prompt name="${this.escapeXmlAttribute(customPrompt.name)}">\n`;
      prompt += this.escapeXmlContent(customPrompt.prompt);
      prompt += `\n</prompt>\n\n`;
    }

    prompt += '</custom_prompts>';

    return prompt;
  }

  /**
   * Build workspace references section from #suggester
   * This provides comprehensive workspace data similar to the loadWorkspace tool
   */
  private async buildWorkspaceReferencesSection(messageEnhancement?: MessageEnhancement | null): Promise<string | null> {
    if (!messageEnhancement || messageEnhancement.workspaces.length === 0) {
      return null;
    }

    if (!this.loadWorkspace) {
      // If workspace loader not provided, just include basic info
      let prompt = '<workspaces>\n';
      prompt += 'The user has referenced the following workspaces:\n\n';

      for (const workspace of messageEnhancement.workspaces) {
        prompt += `Workspace: ${this.escapeXmlContent(workspace.name)}\n`;
        if (workspace.description) {
          prompt += `Description: ${this.escapeXmlContent(workspace.description)}\n`;
        }
        prompt += `Root Folder: ${this.escapeXmlContent(workspace.rootFolder)}\n\n`;
      }

      prompt += '</workspaces>';
      return prompt;
    }

    // Load full workspace data for each reference
    let prompt = '<workspaces>\n';
    prompt += 'The user has referenced the following workspaces. Use their context for your responses:\n\n';

    for (const workspaceRef of messageEnhancement.workspaces) {
      try {
        const workspaceData = await this.loadWorkspace(workspaceRef.id);
        if (workspaceData) {
          // Check if this is comprehensive data from LoadWorkspaceTool or basic workspace object
          const isComprehensive = workspaceData.context && typeof workspaceData.context === 'object' && 'name' in workspaceData.context;

          if (isComprehensive) {
            // Comprehensive workspace data from LoadWorkspaceTool
            const workspaceName = workspaceData.context?.name || workspaceRef.name;
            prompt += `<workspace name="${this.escapeXmlAttribute(workspaceName)}" id="${this.escapeXmlAttribute(workspaceRef.id)}">\n`;

            prompt += this.escapeXmlContent(JSON.stringify(workspaceData, null, 2));

            prompt += `\n</workspace>\n\n`;
          } else {
            // Basic workspace object (fallback)
            prompt += `<workspace name="${this.escapeXmlAttribute(workspaceData.name || workspaceRef.name)}" id="${this.escapeXmlAttribute(workspaceRef.id)}">\n`;

            prompt += this.escapeXmlContent(JSON.stringify({
              name: workspaceData.name,
              description: workspaceData.description,
              rootFolder: workspaceData.rootFolder,
              context: workspaceData.context
            }, null, 2));

            prompt += `\n</workspace>\n\n`;
          }
        }
      } catch (error) {
        console.error(`Failed to load workspace ${workspaceRef.id}:`, error);
        // Continue with other workspaces
      }
    }

    prompt += '</workspaces>';
    return prompt;
  }

  /**
   * Build selected prompt section (if prompt selected)
   */
  private buildSelectedPromptSection(customPrompt?: string | null): string | null {
    if (!customPrompt) {
      return null;
    }

    return `<selected_prompt>\n${this.escapeXmlContent(customPrompt)}\n</selected_prompt>`;
  }

  /**
   * Build selected workspace section with comprehensive data
   * When a workspace is selected in chat settings, include the full workspace data
   * (same rich context as the #workspace suggester)
   */
  private buildSelectedWorkspaceSection(
    loadedWorkspaceData?: LoadedWorkspaceData | null,
    workspaceContext?: WorkspaceContext | null
  ): string | null {
    // If we have full workspace data, include the complete object
    if (loadedWorkspaceData) {
      const workspaceName = loadedWorkspaceData.context?.name ||
                           loadedWorkspaceData.name ||
                           'Selected Workspace';
      const workspaceId = loadedWorkspaceData.id || 'unknown';

      let prompt = `<selected_workspace name="${this.escapeXmlAttribute(workspaceName)}" id="${this.escapeXmlAttribute(workspaceId)}">\n`;
      prompt += 'This workspace is currently selected. Use it as the primary context.\n\n';
      prompt += this.escapeXmlContent(JSON.stringify(loadedWorkspaceData, null, 2));
      prompt += '\n</selected_workspace>';

      return prompt;
    }

    // Fallback to basic context if no comprehensive data
    if (!workspaceContext) {
      return null;
    }

    return `<selected_workspace>\n${this.escapeXmlContent(JSON.stringify(workspaceContext, null, 2))}\n</selected_workspace>`;
  }

  /**
   * Normalize file path to valid XML tag name
   * Example: "Notes/Style Guide.md" -> "Notes_Style_Guide"
   */
  private normalizePathToXmlTag(path: string): string {
    return path
      .replace(/\.md$/i, '')  // Remove .md extension
      .replace(/[^a-zA-Z0-9_]/g, '_')  // Replace non-alphanumeric with underscore
      .replace(/^_+|_+$/g, '')  // Remove leading/trailing underscores
      .replace(/_+/g, '_');  // Collapse multiple underscores
  }

  /**
   * Escape XML content (text nodes)
   */
  private escapeXmlContent(content: string): string {
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Escape XML attribute values
   */
  private escapeXmlAttribute(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Build context status section for token-limited models
   * Gives the model awareness of its context window usage
   */
  private buildContextStatusSection(contextStatus: ContextStatusInfo): string | null {
    let prompt = '<context_status>\n';
    prompt += `Tokens: ${contextStatus.usedTokens}/${contextStatus.maxTokens} (${contextStatus.percentUsed}% used)\n`;
    prompt += `Status: ${contextStatus.status.toUpperCase()}\n`;

    if (contextStatus.status === 'warning') {
      prompt += '\nIMPORTANT: Context is filling up. Consider:\n';
      prompt += '- Using saveState to preserve important context\n';
      prompt += '- Being concise in responses\n';
      prompt += '- Focusing on the current task\n';
    } else if (contextStatus.status === 'critical') {
      prompt += '\nCRITICAL: Context nearly full! Action required:\n';
      prompt += '- Use saveState NOW to preserve conversation before truncation\n';
      prompt += '- The system will auto-save state when threshold is reached\n';
    }

    prompt += '</context_status>';
    return prompt;
  }

  /**
   * Build deterministic bounded compaction frontier section from compacted conversation records.
   * Records are rendered oldest-to-newest so the active frontier reads chronologically.
   */
  private buildCompactionFrontierSection(frontier: CompactionFrontierRecord[]): string | null {
    if (frontier.length === 0) {
      return null;
    }

    let prompt = '<compaction_context>\n';
    prompt += '<status>active</status>\n';
    prompt += '<source>bounded_frontier</source>\n';
    prompt += `<frontier_records count="${frontier.length}">\n`;

    for (const [index, record] of frontier.entries()) {
      prompt += this.buildCompactionRecordSection(record, index);
    }

    prompt += '</frontier_records>\n';
    prompt += '<instruction>Treat this block as compressed prior conversation context. Use it to maintain continuity across older work, but rely on the live conversation for the most recent turns.</instruction>\n';
    prompt += '</compaction_context>';
    return prompt;
  }

  private buildCompactionRecordSection(record: CompactionFrontierRecord, index: number): string {
    const files = record.filesReferenced.slice(0, 5);
    const topics = record.topics.slice(0, 8);
    const ancestry = record.transcriptCoverageAncestry ?? (record.transcriptCoverage ? [record.transcriptCoverage] : []);
    const renderedAncestry = ancestry.slice(0, 3);

    let prompt = `  <record index="${index}" compacted_at="${record.compactedAt}" level="${record.level ?? 0}" merged_records="${record.mergedRecordCount ?? 1}">\n`;
    prompt += `    <summary>${this.escapeXmlContent(record.summary)}</summary>\n`;

    if (files.length > 0) {
      const remainingFiles = record.filesReferenced.length - files.length;
      const fileText = remainingFiles > 0
        ? `${files.join(', ')} (+${remainingFiles} more)`
        : files.join(', ');
      prompt += `    <files>${this.escapeXmlContent(fileText)}</files>\n`;
    }

    if (topics.length > 0) {
      const remainingTopics = record.topics.length - topics.length;
      const topicText = remainingTopics > 0
        ? `${topics.join('; ')} (+${remainingTopics} more)`
        : topics.join('; ');
      prompt += `    <topics>${this.escapeXmlContent(topicText)}</topics>\n`;
    }

    if (record.transcriptCoverage && (!record.level || record.level === 0)) {
      prompt += `    <coverage conversation_id="${this.escapeXmlContent(record.transcriptCoverage.conversationId)}" start_sequence_number="${record.transcriptCoverage.startSequenceNumber}" end_sequence_number="${record.transcriptCoverage.endSequenceNumber}" />\n`;
    }

    if (ancestry.length > 1 || ((record.level ?? 0) > 0 && ancestry.length > 0)) {
      const ancestryText = renderedAncestry
        .map(ref => `${ref.conversationId}:${ref.startSequenceNumber}-${ref.endSequenceNumber}`)
        .join(' | ');
      const remainingCount = ancestry.length - renderedAncestry.length;
      const boundedText = remainingCount > 0
        ? `${ancestryText} (+${remainingCount} more)`
        : ancestryText;
      prompt += `    <coverage_ancestry count="${ancestry.length}">${this.escapeXmlContent(boundedText)}</coverage_ancestry>\n`;
    }

    prompt += `    <stats messages_compacted="${record.messagesRemoved}" messages_retained="${record.messagesKept}" />\n`;
    prompt += '  </record>\n';
    return prompt;
  }
}
