/**
 * Initialize suggesters for a contenteditable element
 */

import { App, Plugin, Component } from 'obsidian';
import { TextAreaNoteSuggester } from './TextAreaNoteSuggester';
import { TextAreaToolSuggester } from './TextAreaToolSuggester';
import { TextAreaPromptSuggester } from './TextAreaPromptSuggester';
import { TextAreaWorkspaceSuggester } from './TextAreaWorkspaceSuggester';
import { MessageEnhancer } from '../../services/MessageEnhancer';
import { CustomPromptStorageService } from '../../../../agents/promptManager/services/CustomPromptStorageService';
import { WorkspaceService } from '../../../../services/WorkspaceService';
import { getNexusPlugin } from '../../../../utils/pluginLocator';
import type { Settings } from '../../../../settings';

/**
 * Interface for NexusPlugin with settings and services
 */
interface NexusPluginWithServices extends Plugin {
  settings?: Settings;
  services?: Record<string, unknown>;
  workspaceService?: WorkspaceService;
}

export interface SuggesterInstances {
  noteSuggester: TextAreaNoteSuggester;
  toolSuggester: TextAreaToolSuggester;
  promptSuggester?: TextAreaPromptSuggester;
  workspaceSuggester?: TextAreaWorkspaceSuggester;
  messageEnhancer: MessageEnhancer;
  cleanup: () => void;
}

export function initializeSuggesters(
  app: App,
  element: HTMLElement,
  component?: Component
): SuggesterInstances {
  const messageEnhancer = new MessageEnhancer();

  // Create suggesters
  const noteSuggester = new TextAreaNoteSuggester(app, element, messageEnhancer, component);
  const toolSuggester = new TextAreaToolSuggester(app, element, messageEnhancer, component);

  // Try to get CustomPromptStorageService for prompt suggester
  let promptSuggester: TextAreaPromptSuggester | undefined;
  let workspaceSuggester: TextAreaWorkspaceSuggester | undefined;
  try {
    const plugin = getNexusPlugin<NexusPluginWithServices>(app);
    if (plugin?.settings) {
      // Pass null for db - suggester doesn't have access to database
      const promptStorage = new CustomPromptStorageService(null, plugin.settings);
      promptSuggester = new TextAreaPromptSuggester(app, element, messageEnhancer, promptStorage, component);
    }

    // Initialize workspace suggester
    if (plugin) {
      const workspaceService = plugin.workspaceService ||
        (plugin.services?.workspaceService as WorkspaceService | undefined);
      if (workspaceService) {
        workspaceSuggester = new TextAreaWorkspaceSuggester(app, element, messageEnhancer, workspaceService, component);
      }
    }
  } catch (error) {
    // Prompt/workspace suggester initialization failed - will be undefined
  }

  return {
    noteSuggester,
    toolSuggester,
    promptSuggester,
    workspaceSuggester,
    messageEnhancer,
    cleanup: () => {
      noteSuggester.destroy();
      toolSuggester.destroy();
      promptSuggester?.destroy();
      workspaceSuggester?.destroy();
      messageEnhancer.clearEnhancements();
    }
  };
}
