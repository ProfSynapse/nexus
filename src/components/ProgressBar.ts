import { type App, Component } from 'obsidian';

/**
 * Interface for progress update data
 */
export interface ProgressUpdateData {
    total: number;
    processed: number;
    remaining: number;
    operationId?: string;
}

/**
 * Interface for progress completion data
 */
export interface ProgressCompleteData {
    success: boolean;
    processed: number;
    failed: number;
    error?: string;
    operationId: string;
}

/**
 * Interface for progress cancellation data
 */
export interface ProgressCancelData {
    operationId: string;
}

/**
 * ProgressBar component for displaying progress
 * Uses custom event handling to show progress of operations like indexing
 */
export class ProgressBar {
    private container: HTMLElement;
    private progressBar: HTMLElement;
    private progressText: HTMLElement;
    private cancelButton: HTMLElement;
    private component?: Component;

    private progress = 0;
    private total = 0;
    private operationId = '';

    // Custom event handlers
    private onProgressHandler!: (data: ProgressUpdateData) => void;
    private onCompleteHandler!: (data: ProgressCompleteData) => void;

    /**
     * Create a new progress bar component
     *
     * @param containerEl Container element to append to
     * @param app Obsidian app instance for event handling
     * @param component Optional Component for registerDomEvent
     */
    constructor(containerEl: HTMLElement, _app: App, component?: Component) {
        // App parameter marked with underscore as it's not currently used
        this.component = component;
        
        // Create the container
        this.container = containerEl.createDiv({ cls: 'mcp-progress-container' });
        this.container.style.display = 'none';
        
        // Progress info
        const infoContainer = this.container.createDiv({ cls: 'mcp-progress-info' });
        this.progressText = infoContainer.createSpan({ cls: 'mcp-progress-text' });
        
        // Progress bar
        const barContainer = this.container.createDiv({ cls: 'mcp-progress-bar-container' });
        this.progressBar = barContainer.createDiv({ cls: 'mcp-progress-bar' });
        
        // Cancel button
        this.cancelButton = this.container.createDiv({
            cls: 'mcp-progress-cancel',
            text: 'Cancel'
        });

        const cancelHandler = () => {
            this.triggerCancel();
        };
        this.component!.registerDomEvent(this.cancelButton, 'click', cancelHandler);
        
        // Create event handlers
        this.setupEventHandlers();
        
        // Initialize with hidden state
        this.hide();
    }
    
    /**
     * Set up event handlers using a custom approach
     */
    private setupEventHandlers(): void {
        // Create progress update handler
        this.onProgressHandler = (data: ProgressUpdateData) => {
            // Progress update received
            
            // Update progress
            this.total = data.total;
            this.progress = data.processed;
            
            // Store operation ID for resume functionality
            if (data.operationId) {
                this.operationId = data.operationId;
            }
            
            // Update UI
            this.updateProgressBar();
            
            // Show the progress bar if not already visible
            this.show();
        };
        
        // Create completion handler
        this.onCompleteHandler = (data: ProgressCompleteData) => {
            // Progress completion received
            
            // Update the progress bar one last time to show completion
            if (data.processed > 0 && this.total > 0) {
                this.progress = data.processed;
                this.updateProgressBar();
            }
            
            // Hide the progress bar
            setTimeout(() => {
                this.hide();
            }, 2000); // Give user time to see completion
        };
        
        // Create cancellation handler
        const onCancelHandler = (data: ProgressCancelData) => {
            // Progress cancellation received
            
            // Only process if this is for our current operation
            if (data.operationId === this.operationId) {
                // Update text to show cancellation
                this.progressText.setText(`Indexing cancelled: ${this.progress} / ${this.total}`);
                
                // Hide the progress bar after a delay
                setTimeout(() => {
                    this.hide();
                }, 1000);
            }
        };
        
        // Expose handlers as global methods to be called from other components
        // @ts-ignore - Adding methods to window for inter-component communication
        window.mcpProgressHandlers = {
            updateProgress: this.onProgressHandler,
            completeProgress: this.onCompleteHandler,
            cancelProgress: onCancelHandler
        };
    }
    
    /**
     * Show the progress bar
     */
    show(): void {
        this.container.style.display = 'flex';
    }
    
    /**
     * Hide the progress bar
     */
    hide(): void {
        this.container.style.display = 'none';
    }
    
    /**
     * Update the progress bar UI
     */
    private updateProgressBar(): void {
        // Calculate percentage
        const percent = this.total > 0 ? Math.floor((this.progress / this.total) * 100) : 0;
        
        // Update bar width
        this.progressBar.style.width = `${percent}%`;
        
        // Update text
        this.progressText.setText(`Indexing: ${this.progress} / ${this.total} (${percent}%)`);
    }
    
    /**
     * Trigger cancel operation event
     */
    private triggerCancel(): void {
        // Call global cancel handler if available
        // @ts-ignore - Using global methods for inter-component communication
        if (window.mcpProgressHandlers && window.mcpProgressHandlers.cancelProgress) {
            // @ts-ignore
            window.mcpProgressHandlers.cancelProgress({
                operationId: this.operationId
            });
        }
        
        // Hide progress bar
        this.hide();
    }
}