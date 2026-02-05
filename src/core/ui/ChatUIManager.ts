/**
 * Location: /src/core/ui/ChatUIManager.ts
 * 
 * Chat UI Manager - Handles ChatView registration, activation, and management
 * 
 * This service extracts ChatView-specific logic from PluginLifecycleManager,
 * providing a focused interface for chat UI operations.
 */

import { Notice } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import type { Settings } from '../../settings';
import type { ChatService } from '../../services/chat/ChatService';

/**
 * Plugin interface with optional getServiceIfReady method.
 * Avoids 'as any' cast on plugin when checking service availability.
 */
interface PluginWithServiceAccess extends Plugin {
    getServiceIfReady?<T>(name: string): T | null;
}

export interface ChatUIManagerConfig {
    plugin: PluginWithServiceAccess;
    app: App;
    settings: Settings;
    getService: <T>(name: string, timeoutMs?: number) => Promise<T | null>;
}

export class ChatUIManager {
    private config: ChatUIManagerConfig;
    private chatUIRegistered: boolean = false;
    private viewRegistered: boolean = false;

    constructor(config: ChatUIManagerConfig) {
        this.config = config;
    }

    /**
     * Register the ChatView early so Obsidian can restore it
     * This should be called during onload() BEFORE layout restoration
     * The view will show a loading state until chatService is ready
     */
    async registerViewEarly(): Promise<void> {
        if (this.viewRegistered) {
            return;
        }

        try {
            const { plugin } = this.config;

            const { ChatView, CHAT_VIEW_TYPE } = await import('../../ui/chat/ChatView');

            // Register ChatView with Obsidian - chatService may be null initially
            // ChatView handles the null case by showing a loading state
            // (its onOpen() checks this.chatService and polls if null)
            plugin.registerView(
                CHAT_VIEW_TYPE,
                (leaf) => {
                    // Try to get chatService, may be null if not ready yet
                    const chatService = this.getChatServiceSync();
                    return new ChatView(leaf, chatService as ChatService);
                }
            );

            this.viewRegistered = true;
        } catch (error) {
            console.error('Failed to register ChatView early:', error);
        }
    }

    /**
     * Synchronously get chatService if available (non-blocking)
     */
    private getChatServiceSync(): ChatService | null {
        // Access the service manager to check if chatService is ready
        // This uses the same pattern as getServiceIfReady
        const plugin = this.config.plugin;
        if (plugin.getServiceIfReady) {
            return plugin.getServiceIfReady<ChatService>('chatService');
        }
        return null;
    }

    /**
     * Register chat UI components (ribbon icon, command)
     * Call this after services are ready
     */
    async registerChatUI(): Promise<void> {
        try {
            const { plugin, app } = this.config;

            // Skip if already registered
            if (this.chatUIRegistered) {
                return;
            }

            // Ensure view is registered (may already be from registerViewEarly)
            await this.registerViewEarly();

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
        if (!leaf) return;

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