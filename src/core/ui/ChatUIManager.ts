/**
 * Location: /src/core/ui/ChatUIManager.ts
 * 
 * Chat UI Manager - Handles ChatView registration, activation, and management
 * 
 * This service extracts ChatView-specific logic from PluginLifecycleManager,
 * providing a focused interface for chat UI operations.
 */

import { Notice } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { Settings } from '../../settings';

export interface ChatUIManagerConfig {
    plugin: Plugin;
    app: any;
    settings: Settings;
    getService: <T>(name: string, timeoutMs?: number) => Promise<T | null>;
}

export class ChatUIManager {
    private config: ChatUIManagerConfig;
    private chatUIRegistered: boolean = false;

    constructor(config: ChatUIManagerConfig) {
        this.config = config;
    }

    /**
     * Register chat UI components
     */
    async registerChatUI(): Promise<void> {
        try {
            const { plugin, app } = this.config;

            // Skip if already registered
            if (this.chatUIRegistered) {
                return;
            }
            
            // Get ChatService
            const chatService = await this.config.getService<any>('chatService', 5000);
            if (!chatService) {
                return;
            }
            
            // Import ChatView
            const { ChatView, CHAT_VIEW_TYPE } = await import('../../ui/chat/ChatView');
            
            // Register ChatView with Obsidian
            plugin.registerView(
                CHAT_VIEW_TYPE,
                (leaf) => new ChatView(leaf, chatService)
            );
            
            // Add ribbon icon for chat
            plugin.addRibbonIcon('message-square', 'Nexus Chat', () => {
                this.activateChatView();
            });
            
            // Add command to open chat
            plugin.addCommand({
                id: 'open-chat',
                name: 'Open Nexus Chat',
                callback: () => {
                    this.activateChatView();
                }
            });


            // Mark as registered
            this.chatUIRegistered = true;

        } catch (error) {
            console.error('Failed to register chat UI:', error);
        }
    }

    /**
     * Activate chat view in sidebar
     */
    async activateChatView(): Promise<void> {
        const { app } = this.config;

        const { CHAT_VIEW_TYPE } = await import('../../ui/chat/ChatView');
        
        // Check if chat view already exists
        const existingLeaf = app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
        if (existingLeaf) {
            app.workspace.revealLeaf(existingLeaf);
            return;
        }
        
        // Create new chat view in right sidebar
        const leaf = app.workspace.getRightLeaf(false);
        await leaf.setViewState({
            type: CHAT_VIEW_TYPE,
            active: true
        });
        
        app.workspace.revealLeaf(leaf);
    }

    /**
     * Check if chat UI is registered
     */
    isChatUIRegistered(): boolean {
        return this.chatUIRegistered;
    }

    /**
     * Reset registration state (useful for testing or reinitialization)
     */
    resetRegistrationState(): void {
        this.chatUIRegistered = false;
    }
}