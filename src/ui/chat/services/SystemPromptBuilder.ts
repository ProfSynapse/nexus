/**
 * SystemPromptBuilder - Constructs system prompts for chat conversations
 *
 * Responsibilities:
 * - Build multi-section XML system prompts
 * - Inject session/workspace context for tool calls
 * - Add enhancement data from suggesters (tools, agents, notes)
 * - Include agent prompts and workspace context
 * - Delegate file content reading to FileContentService
 *
 * Follows Single Responsibility Principle - only handles prompt composition.
 */

import { WorkspaceContext } from '../../../database/types/workspace/WorkspaceTypes';
import { MessageEnhancement } from '../components/suggesters/base/SuggesterInterfaces';
import { formatWorkspaceDataForPrompt, extractWorkspaceData } from '../../../utils/WorkspaceDataFormatter';

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
 * Available agent summary for system prompt
 */
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
}

/**
 * Tool agent with modes for system prompt
 */
export interface ToolAgentInfo {
  name: string;
  description: string;
  modes: string[];
}

export interface SystemPromptOptions {
  sessionId?: string;
  workspaceId?: string;
  contextNotes?: string[];
  messageEnhancement?: MessageEnhancement | null;
  agentPrompt?: string | null;
  workspaceContext?: WorkspaceContext | null;
  // Full comprehensive workspace data from LoadWorkspaceTool (when workspace selected in settings)
  loadedWorkspaceData?: any | null;
  // Dynamic context (always loaded fresh)
  vaultStructure?: VaultStructure | null;
  availableWorkspaces?: WorkspaceSummary[];
  availableAgents?: AgentSummary[];
  // Tool agents with their tools (dynamically loaded from agent registry)
  toolAgents?: ToolAgentInfo[];
}

export class SystemPromptBuilder {
  constructor(
    private readNoteContent: (notePath: string) => Promise<string>,
    private loadWorkspace?: (workspaceId: string) => Promise<any>
  ) {}

  /**
   * Build complete system prompt with all sections
   */
  async build(options: SystemPromptOptions): Promise<string | null> {
    const sections: string[] = [];

    // 1. Session context (CRITICAL - must be first!)
    const sessionSection = this.buildSessionContext(options.sessionId, options.workspaceId, options.toolAgents);
    if (sessionSection) {
      sections.push(sessionSection);
    }

    // 2. Vault structure (dynamic - always fresh)
    const vaultStructureSection = this.buildVaultStructureSection(options.vaultStructure);
    if (vaultStructureSection) {
      sections.push(vaultStructureSection);
    }

    // 3. Available workspaces (dynamic - always fresh)
    const availableWorkspacesSection = this.buildAvailableWorkspacesSection(options.availableWorkspaces);
    if (availableWorkspacesSection) {
      sections.push(availableWorkspacesSection);
    }

    // 4. Available agents (dynamic - always fresh)
    const availableAgentsSection = this.buildAvailableAgentsSection(options.availableAgents);
    if (availableAgentsSection) {
      sections.push(availableAgentsSection);
    }

    // 5. Context files section
    const filesSection = await this.buildFilesSection(
      options.contextNotes || [],
      options.messageEnhancement
    );
    if (filesSection) {
      sections.push(filesSection);
    }

    // 6. Tool hints from /suggester
    const toolHintsSection = this.buildToolHintsSection(options.messageEnhancement);
    if (toolHintsSection) {
      sections.push(toolHintsSection);
    }

    // 7. Custom agents from @suggester
    const customAgentsSection = this.buildCustomAgentsSection(options.messageEnhancement);
    if (customAgentsSection) {
      sections.push(customAgentsSection);
    }

    // 8. Workspace references from #suggester
    const workspaceReferencesSection = await this.buildWorkspaceReferencesSection(options.messageEnhancement);
    if (workspaceReferencesSection) {
      sections.push(workspaceReferencesSection);
    }

    // 9. Agent prompt (if agent selected)
    const agentSection = this.buildAgentSection(options.agentPrompt);
    if (agentSection) {
      sections.push(agentSection);
    }

    // 10. Selected workspace context (comprehensive data from settings selection)
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
  private buildSessionContext(sessionId?: string, workspaceId?: string, toolAgents?: ToolAgentInfo[]): string | null {
    const effectiveSessionId = sessionId || `session_${Date.now()}`;
    const effectiveWorkspaceId = workspaceId || 'default';

    let prompt = '<tools_and_context>\n';

    // Tools overview - dynamically built from registered agents
    prompt += `AVAILABLE TOOLS:
You have access to the following agents via the get_tools function:

`;

    if (toolAgents && toolAgents.length > 0) {
      // Dynamic list from agent registry
      for (const agent of toolAgents) {
        prompt += `- ${agent.name}: ${agent.description}\n`;
        prompt += `  Modes: ${agent.modes.join(', ')}\n\n`;
      }
    } else {
      // Fallback to static list if agents not available
      prompt += `- agentManager: Custom AI agents and prompts
  Modes: batchExecutePrompt, createAgent, deleteAgent, executePrompt, generateImage, getAgent, listAgents, listModels, toggleAgent, updateAgent

- commandManager: Execute Obsidian commands
  Modes: executeCommand, listCommands

- contentManager: Read, create, edit, and manage note content
  Modes: appendContent, batchContent, createContent, deleteContent, findReplaceContent, prependContent, readContent, replaceByLine, replaceContent

- memoryManager: Workspace and session management
  Modes: createSession, createState, createWorkspace, listSessions, listStates, listWorkspaces, loadSession, loadState, loadWorkspace, updateSession, updateState, updateWorkspace

- vaultLibrarian: Advanced search capabilities
  Modes: batch, searchContent, searchDirectory, searchMemory

- vaultManager: File and folder operations
  Modes: createFolder, deleteFolder, deleteNote, duplicateNote, editFolder, listDirectory, moveFolder, moveNote, openNote

`;
    }

    prompt += `TO USE A TOOL: Call get_tools({ tools: ["agentName"] }) to get the full schema, then call the agent with mode and parameters.

`;

    // Context parameters
    prompt += `REQUIRED CONTEXT FOR ALL TOOL CALLS:
When calling any tool, include this context object:
{
  "mode": "the_mode_name",
  "context": {
    "sessionId": "${effectiveSessionId}",
    "workspaceId": "${effectiveWorkspaceId}",
    "sessionDescription": "Brief description of current task",
    "sessionMemory": "Summary of conversation progress"
  },
  ... other parameters ...
}

Keep sessionId and workspaceId EXACTLY as shown above for the entire conversation.
`;

    prompt += '</tools_and_context>';

    return prompt;
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
      prompt += `${notePath}\n\n`;
      prompt += content || '[File content unavailable]';
      prompt += `\n</${xmlTag}>\n`;
    }

    // Add enhancement notes from [[suggester]]
    if (hasEnhancementNotes) {
      for (const note of messageEnhancement!.notes) {
        const xmlTag = this.normalizePathToXmlTag(note.path);
        prompt += `<${xmlTag}>\n`;
        prompt += `${note.path}\n\n`;
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
      prompt += `Tool: ${tool.name}\n`;
      prompt += `Description: ${tool.schema.description}\n`;
      prompt += 'Please prioritize using this tool when applicable.\n\n';
    }

    prompt += '</tool_hints>';

    return prompt;
  }

  /**
   * Build custom agents section from @suggester
   */
  private buildCustomAgentsSection(messageEnhancement?: MessageEnhancement | null): string | null {
    if (!messageEnhancement || messageEnhancement.agents.length === 0) {
      return null;
    }

    let prompt = '<custom_agents>\n';
    prompt += 'The user has mentioned the following custom agents. Apply their personalities and instructions:\n\n';

    for (const agent of messageEnhancement.agents) {
      prompt += `<agent name="${this.escapeXmlAttribute(agent.name)}">\n`;
      prompt += this.escapeXmlContent(agent.prompt);
      prompt += `\n</agent>\n\n`;
    }

    prompt += '</custom_agents>';

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
        prompt += `Workspace: ${workspace.name}\n`;
        if (workspace.description) {
          prompt += `Description: ${workspace.description}\n`;
        }
        prompt += `Root Folder: ${workspace.rootFolder}\n\n`;
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

            // Use shared utility for formatting
            prompt += this.escapeXmlContent(formatWorkspaceDataForPrompt(workspaceData));

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
   * Build agent section (if agent selected)
   */
  private buildAgentSection(agentPrompt?: string | null): string | null {
    if (!agentPrompt) {
      return null;
    }

    return `<agent>\n${agentPrompt}\n</agent>`;
  }

  /**
   * Build selected workspace section with comprehensive data
   * When a workspace is selected in chat settings, include the full workspace data
   * (same rich context as the #workspace suggester)
   */
  private buildSelectedWorkspaceSection(
    loadedWorkspaceData?: any | null,
    workspaceContext?: WorkspaceContext | null
  ): string | null {
    // If we have full comprehensive data, use that
    if (loadedWorkspaceData) {
      const workspaceName = loadedWorkspaceData.context?.name ||
                           loadedWorkspaceData.name ||
                           'Selected Workspace';
      const workspaceId = loadedWorkspaceData.id || 'unknown';

      let prompt = `<selected_workspace name="${this.escapeXmlAttribute(workspaceName)}" id="${this.escapeXmlAttribute(workspaceId)}">\n`;
      prompt += 'This workspace is currently selected. Use its context for your responses:\n\n';

      // Use shared utility for formatting
      prompt += this.escapeXmlContent(formatWorkspaceDataForPrompt(loadedWorkspaceData));
      prompt += '\n</selected_workspace>';

      return prompt;
    }

    // Fallback to basic context if no comprehensive data
    if (!workspaceContext) {
      return null;
    }

    return `<selected_workspace>\n${JSON.stringify(workspaceContext, null, 2)}\n</selected_workspace>`;
  }

  /**
   * Build vault structure section (dynamic - shows root folders and files)
   * Provides the LLM with awareness of the vault's organization
   */
  private buildVaultStructureSection(vaultStructure?: VaultStructure | null): string | null {
    if (!vaultStructure) {
      return null;
    }

    const { rootFolders, rootFiles } = vaultStructure;

    // Don't include section if vault is empty
    if (rootFolders.length === 0 && rootFiles.length === 0) {
      return null;
    }

    let prompt = '<vault_structure>\n';
    prompt += 'The following is the root-level structure of the Obsidian vault:\n\n';

    if (rootFolders.length > 0) {
      prompt += 'Folders:\n';
      for (const folder of rootFolders) {
        prompt += `  - ${folder}/\n`;
      }
      prompt += '\n';
    }

    if (rootFiles.length > 0) {
      prompt += 'Files:\n';
      for (const file of rootFiles) {
        prompt += `  - ${file}\n`;
      }
    }

    prompt += '\nUse vaultManager or vaultLibrarian tools to explore subfolders or search for specific content.\n';
    prompt += '</vault_structure>';

    return prompt;
  }

  /**
   * Build available workspaces section (dynamic - lists all workspaces)
   * Helps the LLM understand what workspaces exist and can be loaded
   */
  private buildAvailableWorkspacesSection(workspaces?: WorkspaceSummary[]): string | null {
    if (!workspaces || workspaces.length === 0) {
      return null;
    }

    let prompt = '<available_workspaces>\n';
    prompt += 'The following workspaces are available in this vault:\n\n';

    for (const workspace of workspaces) {
      prompt += `- ${this.escapeXmlContent(workspace.name)} (id: "${workspace.id}")\n`;
      if (workspace.description) {
        prompt += `  Description: ${this.escapeXmlContent(workspace.description)}\n`;
      }
      prompt += `  Root folder: ${workspace.rootFolder}\n`;
      prompt += '\n';
    }

    prompt += 'Use memoryManager with loadWorkspace mode to get full workspace context.\n';
    prompt += '</available_workspaces>';

    return prompt;
  }

  /**
   * Build available agents section (dynamic - lists custom agents)
   * Informs the LLM about custom agents that can be used
   */
  private buildAvailableAgentsSection(agents?: AgentSummary[]): string | null {
    if (!agents || agents.length === 0) {
      return null;
    }

    let prompt = '<available_agents>\n';
    prompt += 'The following custom agents are available in this workspace:\n\n';

    for (const agent of agents) {
      prompt += `- ${this.escapeXmlContent(agent.name)} (id: "${agent.id}")\n`;
      prompt += `  ${this.escapeXmlContent(agent.description)}\n\n`;
    }

    prompt += 'Note: These are custom prompt agents created by the user. ';
    prompt += 'Built-in agents (ContentManager, VaultLibrarian, MemoryManager, etc.) are always available via MCP tools.\n';
    prompt += '</available_agents>';

    return prompt;
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
}
