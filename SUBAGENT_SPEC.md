# Subagent Architecture Specification

> **Principle**: Minimize reinvention. Leverage existing branching, streaming, and conversation patterns.

---

## Executive Summary

Subagents use a **unified branching model** where both human and subagent branches share the same storage mechanism (`message.branches[]`). The key difference is the `inheritContext` flag:

- **Human branch**: `inheritContext: true` → LLM sees parent context + branch messages
- **Subagent branch**: `inheritContext: false` → LLM sees only branch messages (fresh start)

**Key design decisions:**
- Unified branching for both human and subagent (same data structure)
- `inheritContext` flag controls LLM context building
- Branches live inside the conversation, not as separate conversations
- Tool result accordion UI for subagent results
- Internal chat only (hidden from Claude Desktop/MCP)
- Parent can continue a paused subagent by calling with `continueBranchId`

---

## Core Insight: Unified Branching Model

**Same mechanism, different context initialization:**

| Type | `inheritContext` | LLM Context | Storage |
|------|------------------|-------------|---------|
| Human branch | `true` | Parent messages 0-N + branch messages | `message.branches[]` |
| Subagent branch | `false` | Only branch messages (fresh start) | `message.branches[]` |

Both human and subagent branches use the **same data structure**. The only difference is the `inheritContext` flag which controls what context the LLM sees.

### Data Model

```typescript
// Extended ConversationMessage
interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  // ... existing fields ...

  // NEW: Full conversation branches from this message
  branches?: ConversationBranch[];
}

// NEW: Branch structure
interface ConversationBranch {
  id: string;
  type: 'human' | 'subagent';
  inheritContext: boolean;           // true = include parent context, false = fresh start
  messages: ConversationMessage[];   // Branch's own conversation history
  created: number;
  updated: number;
  metadata?: {
    // For subagent branches
    task?: string;
    subagentId?: string;
    state?: 'running' | 'complete' | 'cancelled' | 'abandoned' | 'max_iterations';
    iterations?: number;
  };
}
```

### Context Building

```typescript
function buildLLMContext(
  conversation: IndividualConversation,
  branchId?: string
): Message[] {
  if (!branchId) {
    // Main conversation - return all messages
    return conversation.messages;
  }

  // Find the branch and its parent message
  const { branch, parentMessage } = findBranch(conversation, branchId);

  if (branch.inheritContext) {
    // Human branch: parent context + branch messages
    const parentIndex = conversation.messages.findIndex(m => m.id === parentMessage.id);
    const parentContext = conversation.messages.slice(0, parentIndex + 1);
    return [...parentContext, ...branch.messages];
  } else {
    // Subagent branch: only branch messages (fresh context)
    return branch.messages;
  }
}
```

### Visual Model

```
Main Conversation
├── Message 0: User
├── Message 1: Assistant
├── Message 2: User
├── Message 3: Assistant  ←── BRANCH POINT
│   │
│   ├── branches[0]: Human Branch (inheritContext: true)
│   │   │ LLM sees: Messages 0-3 + branch messages
│   │   ├── Message 0: User "What about X?"
│   │   ├── Message 1: Assistant "About X..."
│   │   └── ...
│   │
│   └── branches[1]: Subagent Branch (inheritContext: false)
│       │ LLM sees: ONLY branch messages
│       ├── Message 0: System "You are a subagent..."
│       ├── Message 1: User "Analyze auth system"
│       ├── Message 2: Assistant + tool calls
│       └── ...
│
├── Message 4: User
└── Message 5: Assistant
```

### Benefits

- **Unified storage**: One branching mechanism for both types
- **Flexible context**: `inheritContext` flag controls LLM context
- **In-conversation**: Branches live inside the conversation, not separate entities
- **Navigable**: UI can show all branches from a message
- **Extensible**: Can add more branch types later

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      CONVERSATION                            │
│                   (single conversation)                      │
├─────────────────────────────────────────────────────────────┤
│ Message 0 - User: "Help me with the auth system"            │
│                                                             │
│ Message 1 - Assistant: "I'll spawn a subagent..."           │
│   └─ toolCalls: [{ name: "agentManager.subagent", ... }]   │
│   │                                                         │
│   └─ branches[0]: SUBAGENT BRANCH (inheritContext: false)  │
│       │                                                     │
│       │  ┌─────────────────────────────────────────────┐   │
│       │  │ 🔧 subagent                        ▼ [open] │   │
│       │  ├─────────────────────────────────────────────┤   │
│       │  │ Task: "Analyze auth system"                 │   │
│       │  │ Status: ✓ Complete (5 iterations)           │   │
│       │  │ Result: Found 3 auth patterns...            │   │
│       │  │ [View Branch]                               │   │
│       │  └─────────────────────────────────────────────┘   │
│       │                                                     │
│       ├── Msg 0: System "You are an autonomous subagent..."│
│       ├── Msg 1: User "Analyze the auth system"            │
│       ├── Msg 2: Assistant + toolCalls [search]            │
│       ├── Msg 3: Tool result [5 files]                     │
│       ├── Msg 4: Assistant + toolCalls [readContent]       │
│       ├── Msg 5: Tool result [contents]                    │
│       └── Msg 6: Assistant "Analysis complete: ..."        │
│           └─ no toolCalls = DONE → result queued to parent │
│                                                             │
│ Message 2 - Assistant: "Based on the subagent's analysis,   │
│            here are the key findings..."                    │
│                                                             │
│ Message 3 - User: "Can you also check the database?"        │
│   │                                                         │
│   └─ branches[0]: HUMAN BRANCH (inheritContext: true)      │
│       │ LLM context: Messages 0-3 + branch messages        │
│       ├── Msg 0: User "Actually focus on PostgreSQL"       │
│       ├── Msg 1: Assistant "Sure, for PostgreSQL..."       │
│       └── ...                                               │
│                                                             │
└─────────────────────────────────────────────────────────────┘

BRANCH VIEWING:
┌─────────────────────────────────────────────────────────────┐
│ [View Branch] opens branch in same chat view                │
│                                                             │
│ ◀ Back to Main │ Branch: Subagent "Analyze auth"           │
├─────────────────────────────────────────────────────────────┤
│ System: "You are an autonomous subagent..."                 │
│                                                             │
│ User: "Analyze the auth system"                             │
│                                                             │
│ Assistant: "I'll search for auth files..."                  │
│   └─ 🔧 vaultLibrarian.search: [5 files found]             │
│                                                             │
│ Assistant: "Found 5 files. Let me read them..."             │
│   └─ 🔧 contentManager.readContent: [contents]             │
│                                                             │
│ Assistant: "Analysis complete: [detailed findings]"         │
│                                                             │
│ [User can interact with branch if desired]                  │
└─────────────────────────────────────────────────────────────┘
```

---

## New Component: `BranchService`

Location: `/src/services/chat/BranchService.ts`

Unified service for managing both human and subagent branches.

```typescript
export class BranchService {
  constructor(
    private conversationService: ConversationService
  ) {}

  /**
   * Create a new branch on a message
   */
  async createBranch(
    conversationId: string,
    messageId: string,
    branch: ConversationBranch
  ): Promise<void> {
    const conversation = await this.conversationService.getConversation(conversationId);
    const message = conversation.messages.find(m => m.id === messageId);

    if (!message.branches) {
      message.branches = [];
    }
    message.branches.push(branch);

    await this.conversationService.updateConversation(conversationId, {
      messages: conversation.messages
    });
  }

  /**
   * Add a message to a branch
   */
  async addMessageToBranch(
    conversationId: string,
    parentMessageId: string,
    branchId: string,
    message: ConversationMessage
  ): Promise<void> {
    const conversation = await this.conversationService.getConversation(conversationId);
    const parentMessage = conversation.messages.find(m => m.id === parentMessageId);
    const branch = parentMessage.branches?.find(b => b.id === branchId);

    if (branch) {
      branch.messages.push(message);
      branch.updated = Date.now();

      await this.conversationService.updateConversation(conversationId, {
        messages: conversation.messages
      });
    }
  }

  /**
   * Build LLM context for a branch
   * This is the key method that handles inheritContext
   */
  buildLLMContext(
    conversation: IndividualConversation,
    parentMessageId: string,
    branchId: string
  ): ConversationMessage[] {
    const parentMessage = conversation.messages.find(m => m.id === parentMessageId);
    const branch = parentMessage?.branches?.find(b => b.id === branchId);

    if (!branch) return [];

    if (branch.inheritContext) {
      // Human branch: include parent context + branch messages
      const parentIndex = conversation.messages.findIndex(m => m.id === parentMessageId);
      const parentContext = conversation.messages.slice(0, parentIndex + 1);
      return [...parentContext, ...branch.messages];
    } else {
      // Subagent branch: only branch messages (fresh context)
      return branch.messages;
    }
  }

  /**
   * Get a branch by ID
   */
  async getBranch(
    conversationId: string,
    branchId: string
  ): Promise<{ branch: ConversationBranch; parentMessageId: string } | null> {
    const conversation = await this.conversationService.getConversation(conversationId);

    for (const message of conversation.messages) {
      if (message.branches) {
        const branch = message.branches.find(b => b.id === branchId);
        if (branch) {
          return { branch, parentMessageId: message.id };
        }
      }
    }
    return null;
  }

  /**
   * Update branch metadata
   */
  async updateBranchMetadata(
    conversationId: string,
    parentMessageId: string,
    branchId: string,
    metadata: Partial<ConversationBranch['metadata']>
  ): Promise<void> {
    const conversation = await this.conversationService.getConversation(conversationId);
    const parentMessage = conversation.messages.find(m => m.id === parentMessageId);
    const branch = parentMessage?.branches?.find(b => b.id === branchId);

    if (branch) {
      branch.metadata = { ...branch.metadata, ...metadata };
      branch.updated = Date.now();

      await this.conversationService.updateConversation(conversationId, {
        messages: conversation.messages
      });
    }
  }

  /**
   * Get all branches for a conversation
   */
  getAllBranches(conversation: IndividualConversation): Array<{
    branch: ConversationBranch;
    parentMessageId: string;
  }> {
    const results: Array<{ branch: ConversationBranch; parentMessageId: string }> = [];

    for (const message of conversation.messages) {
      if (message.branches) {
        for (const branch of message.branches) {
          results.push({ branch, parentMessageId: message.id });
        }
      }
    }
    return results;
  }

  /**
   * Create human branch (with inherited context)
   */
  async createHumanBranch(
    conversationId: string,
    messageId: string
  ): Promise<string> {
    const branchId = `branch_human_${Date.now()}`;

    const branch: ConversationBranch = {
      id: branchId,
      type: 'human',
      inheritContext: true,  // Human = inherit parent context
      messages: [],
      created: Date.now(),
      updated: Date.now()
    };

    await this.createBranch(conversationId, messageId, branch);
    return branchId;
  }

  /**
   * Create subagent branch (fresh context)
   */
  async createSubagentBranch(
    conversationId: string,
    messageId: string,
    task: string,
    subagentId: string
  ): Promise<string> {
    const branchId = `branch_subagent_${Date.now()}`;

    const branch: ConversationBranch = {
      id: branchId,
      type: 'subagent',
      inheritContext: false,  // Subagent = fresh context
      messages: [],
      created: Date.now(),
      updated: Date.now(),
      metadata: {
        task,
        subagentId,
        state: 'running',
        iterations: 0
      }
    };

    await this.createBranch(conversationId, messageId, branch);
    return branchId;
  }
}
```

---

## Implementation: Following Existing Patterns

### Pattern Source: `MessageAlternativeService.createAlternativeResponse()`

Location: `/src/ui/chat/services/MessageAlternativeService.ts`

This is the exact pattern to follow. Key steps:

```typescript
// EXISTING PATTERN (simplified)
async createAlternativeResponse(conversation, aiMessageId, options) {
  // 1. VALIDATION
  const aiMessage = conversation.messages.find(msg => msg.id === aiMessageId);

  // 2. STORE ORIGINAL STATE (critical for restoration)
  const originalContent = aiMessage.content;
  const originalState = aiMessage.state;

  // 3. PREPARE FOR STREAMING
  this.events.onLoadingStateChanged(true);
  conversation.messages[index].content = '';
  conversation.messages[index].state = 'draft';

  // 4. CREATE ABORT CONTROLLER
  this.currentAbortController = new AbortController();

  // 5. STREAM RESPONSE
  const result = await this.streamHandler.streamResponse(...);

  // 6. RESTORE ORIGINAL (original stays, alternative is added)
  conversation.messages[index].content = originalContent;
  conversation.messages[index].state = originalState;

  // 7. CREATE ALTERNATIVE MESSAGE
  const alternativeResponse = { id: `alt_${Date.now()}`, content: result, ... };

  // 8. ADD VIA BRANCHMANAGER
  await this.branchManager.createMessageAlternative(conversation, aiMessageId, alternativeResponse);
}
```

---

## New Component: `SubagentExecutor`

Location: `/src/services/chat/SubagentExecutor.ts`

```typescript
import { ChatService } from './ChatService';
import { ConversationService } from '../ConversationService';
import { DirectToolExecutor } from './DirectToolExecutor';
import { BranchManager } from '../../ui/chat/services/BranchManager';

export interface SubagentExecutorEvents {
  onSubagentStarted: (subagentId: string, task: string) => void;
  onSubagentProgress: (subagentId: string, message: string, iteration: number) => void;
  onSubagentComplete: (subagentId: string, result: SubagentResult) => void;
  onSubagentError: (subagentId: string, error: string) => void;
  onStreamingUpdate: (messageId: string, content: string, isComplete: boolean) => void;
}

export interface SubagentParams {
  task: string;
  parentConversationId: string;
  parentMessageId: string;           // Message to attach branch to
  agent?: string;                    // Custom prompt/persona name
  // Pre-fetched tools - schemas included in subagent's initial context
  // Format: { agentName: [toolSlug1, toolSlug2] }
  tools?: Record<string, string[]>;
  contextFiles?: string[];           // Files to read for context
  context?: string;                  // Additional context string
  workspaceId?: string;
  sessionId?: string;
  maxIterations?: number;            // Default: 10
  continueBranchId?: string;         // Continue existing branch
}

export interface SubagentResult {
  success: boolean;
  content: string;
  branchId: string;                  // Branch ID within conversation
  conversationId: string;            // Parent conversation ID
  iterations: number;
  error?: string;
}

export class SubagentExecutor {
  private activeSubagents: Map<string, AbortController> = new Map();

  constructor(
    private chatService: ChatService,
    private conversationService: ConversationService,
    private directToolExecutor: DirectToolExecutor,
    private branchManager: BranchManager,
    private events: SubagentExecutorEvents
  ) {}

  /**
   * Execute subagent - runs async, returns immediately
   * Result delivered via events + message alternative
   */
  async executeSubagent(params: SubagentParams): Promise<string> {
    const subagentId = `subagent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const abortController = new AbortController();
    this.activeSubagents.set(subagentId, abortController);

    // Fire and forget - don't await
    this.runSubagentLoop(subagentId, params, abortController.signal)
      .then(result => {
        this.activeSubagents.delete(subagentId);
        this.events.onSubagentComplete(subagentId, result);
      })
      .catch(error => {
        this.activeSubagents.delete(subagentId);
        this.events.onSubagentError(subagentId, error.message);
      });

    this.events.onSubagentStarted(subagentId, params.task);
    return subagentId;
  }

  /**
   * Cancel a running subagent
   */
  cancelSubagent(subagentId: string): boolean {
    const controller = this.activeSubagents.get(subagentId);
    if (controller) {
      controller.abort();
      this.activeSubagents.delete(subagentId);
      return true;
    }
    return false;
  }

  /**
   * Get all active subagent IDs
   */
  getActiveSubagents(): string[] {
    return Array.from(this.activeSubagents.keys());
  }

  /**
   * Check if a subagent is running
   */
  isSubagentRunning(subagentId: string): boolean {
    return this.activeSubagents.has(subagentId);
  }

  /**
   * Core execution loop - follows StreamingResponseService patterns
   */
  private async runSubagentLoop(
    subagentId: string,
    params: SubagentParams,
    abortSignal: AbortSignal
  ): Promise<SubagentResult> {
    const maxIterations = params.maxIterations ?? 10;

    // 1. CREATE BRANCH ON PARENT MESSAGE
    const branchId = `branch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const branch: ConversationBranch = {
      id: branchId,
      type: 'subagent',
      inheritContext: false,  // Subagent = fresh context
      messages: [],
      created: Date.now(),
      updated: Date.now(),
      metadata: {
        task: params.task,
        subagentId,
        state: 'running',
        iterations: 0
      }
    };

    // Add branch to parent message
    await this.branchService.createBranch(
      params.parentConversationId,
      params.parentMessageId,
      branch
    );

    // 2. BUILD SYSTEM PROMPT
    let systemPrompt = await this.buildSystemPrompt(params);

    // 3. READ CONTEXT FILES (if any)
    let contextContent = params.context || '';
    if (params.contextFiles?.length) {
      const fileContents = await this.readContextFiles(params.contextFiles);
      contextContent += '\n\n' + fileContents;
    }

    // 4. PRE-FETCH TOOL SCHEMAS (if parent specified tools)
    let toolSchemas: ToolSchema[] | undefined;
    if (params.tools && Object.keys(params.tools).length > 0) {
      toolSchemas = await this.prefetchToolSchemas(params.tools);
    }

    // 5. ADD INITIAL MESSAGES TO BRANCH
    const systemMessage: ConversationMessage = {
      id: `msg_${Date.now()}_system`,
      role: 'system',
      content: systemPrompt,
      timestamp: Date.now(),
      state: 'complete'
    };

    const initialMessage = this.buildInitialMessage(params.task, contextContent, toolSchemas);
    const userMessage: ConversationMessage = {
      id: `msg_${Date.now()}_user`,
      role: 'user',
      content: initialMessage,
      timestamp: Date.now(),
      state: 'complete'
    };

    await this.branchService.addMessageToBranch(
      params.parentConversationId,
      params.parentMessageId,
      branchId,
      systemMessage
    );
    await this.branchService.addMessageToBranch(
      params.parentConversationId,
      params.parentMessageId,
      branchId,
      userMessage
    );

    // 6. RUN CONVERSATION LOOP
    let iterations = 0;
    let lastContent = '';

    while (iterations < maxIterations) {
      // Check abort signal FIRST (pattern from StreamingResponseService)
      if (abortSignal.aborted) {
        await this.updateBranchState(params, branchId, 'cancelled', iterations);
        return {
          success: false,
          content: lastContent,
          branchId,
          conversationId: params.parentConversationId,
          iterations,
          error: 'Cancelled by user'
        };
      }

      // Generate response using branch context
      // branchService.buildLLMContext returns only branch messages (inheritContext: false)
      let responseContent = '';
      let toolCalls: any[] | undefined;

      for await (const chunk of this.chatService.generateResponseStreamingForBranch(
        params.parentConversationId,
        branchId,
        {
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          abortSignal,
          isSubagentBranch: true  // Context includes flag for tool filtering
        }
      )) {
        responseContent += chunk.chunk;
        toolCalls = chunk.toolCalls;

        // Emit progress for UI updates
        this.events.onSubagentProgress(subagentId, responseContent, iterations);
        this.events.onStreamingUpdate(params.parentMessageId, responseContent, chunk.complete);
      }

      lastContent = responseContent;
      iterations++;

      // Update iteration count in branch metadata
      await this.updateBranchState(params, branchId, 'running', iterations);

      // 7. CHECK COMPLETION: No tool calls = done
      // Pattern: Claude Code natural completion
      if (!toolCalls || toolCalls.length === 0) {
        // Subagent finished naturally
        await this.updateBranchState(params, branchId, 'complete', iterations);
        await this.queueResultToParent(params, {
          success: true,
          content: responseContent,
          branchId,
          conversationId: params.parentConversationId,
          iterations
        });

        return {
          success: true,
          content: responseContent,
          branchId,
          conversationId: params.parentConversationId,
          iterations
        };
      }

      // 8. EXECUTE TOOL CALLS
      // Tools are executed via DirectToolExecutor
      // Results are added to branch messages
    }

    // Max iterations reached
    await this.updateBranchState(params, branchId, 'max_iterations', iterations);
    await this.queueResultToParent(params, {
      success: false,
      content: lastContent,
      branchId,
      conversationId: params.parentConversationId,
      iterations,
      error: 'Max iterations reached'
    });

    return {
      success: false,
      content: lastContent,
      branchId,
      conversationId: params.parentConversationId,
      iterations,
      error: 'Max iterations reached'
    };
  }

  private async updateBranchState(
    params: SubagentParams,
    branchId: string,
    state: string,
    iterations: number
  ): Promise<void> {
    await this.branchService.updateBranchMetadata(
      params.parentConversationId,
      params.parentMessageId,
      branchId,
      { state, iterations }
    );
  }

  /**
   * Build system prompt - use custom agent if specified
   * Pattern: ExecutePromptsTool from agentManager
   */
  private async buildSystemPrompt(params: SubagentParams): Promise<string> {
    let basePrompt = `You are an autonomous subagent working on a specific task.

Your task: ${params.task}

Instructions:
- Work independently to complete this task
- Use available tools as needed via getTools and useTool
- When you have completed the task, respond with your findings WITHOUT calling any tools
- Be thorough but efficient

`;

    // If custom agent specified, load and prepend its prompt
    if (params.agent) {
      const customPrompt = await this.loadCustomAgentPrompt(params.agent);
      if (customPrompt) {
        basePrompt = customPrompt + '\n\n' + basePrompt;
      }
    }

    return basePrompt;
  }

  /**
   * Queue result back to parent as tool result
   * Result appears in tool accordion UI, triggers parent LLM response
   */
  private async queueResultToParent(
    params: SubagentParams,
    result: SubagentResult
  ): Promise<void> {
    // Queue as tool result - parent LLM will respond to it
    this.messageQueue.enqueue({
      id: `subagent_result_${Date.now()}`,
      type: 'subagent_result',
      content: JSON.stringify({
        success: result.success,
        subagentId: params.subagentId,
        branchId: result.branchId,
        conversationId: result.conversationId,
        task: params.task,
        status: result.success ? 'complete' : (result.error === 'Max iterations reached' ? 'max_iterations' : 'error'),
        iterations: result.iterations,
        result: result.content,
        error: result.error
      }),
      metadata: {
        subagentId: params.subagentId,
        subagentTask: params.task,
        branchId: result.branchId,
        conversationId: result.conversationId,
        parentMessageId: params.parentMessageId
      },
      queuedAt: Date.now()
    });
  }

  /**
   * Continue an existing subagent branch
   * Called when parent uses continueBranchId param
   */
  private async continueExistingBranch(
    subagentId: string,
    params: SubagentParams,
    abortSignal: AbortSignal
  ): Promise<SubagentResult> {
    const branchId = params.continueBranchId!;

    // Load existing branch conversation
    const branchConv = await this.conversationService.getConversation(branchId);
    if (!branchConv) {
      return {
        success: false,
        content: '',
        branchConversationId: branchId,
        iterations: 0,
        error: 'Branch conversation not found'
      };
    }

    // Add continuation message
    await this.conversationService.addMessage({
      conversationId: branchId,
      role: 'user',
      content: params.task || 'Continue your previous work.'
    });

    // Update state to running
    await this.conversationService.updateConversation(branchId, {
      metadata: { ...branchConv.metadata, state: 'running' }
    });

    // Get system prompt from original metadata
    const systemPrompt = await this.buildSystemPrompt({
      ...params,
      task: branchConv.metadata?.task || params.task
    });

    // Continue the loop (iterations continue from where we left off)
    const previousIterations = branchConv.metadata?.iterations || 0;
    const maxIterations = (params.maxIterations ?? 10) + previousIterations;

    return this.runSubagentLoopInternal(
      subagentId,
      branchId,
      params,
      systemPrompt,
      previousIterations,
      maxIterations,
      abortSignal
    );
  }

  private buildInitialMessage(
    task: string,
    context: string,
    toolSchemas?: ToolSchema[]
  ): string {
    let message = task;

    if (context) {
      message += `\n\nContext:\n${context}`;
    }

    if (toolSchemas?.length) {
      message += `\n\n## Pre-loaded Tool Schemas\n\nThese tools are available for immediate use:\n\n`;
      message += toolSchemas.map(schema =>
        `### ${schema.agent}.${schema.slug}\n${schema.description}\n\nParameters:\n\`\`\`json\n${JSON.stringify(schema.parameters, null, 2)}\n\`\`\``
      ).join('\n\n');
      message += `\n\nYou can also use getTools to discover additional tools if needed.`;
    }

    return message;
  }

  /**
   * Pre-fetch tool schemas based on parent's tools param
   * Format: { agentName: [toolSlug1, toolSlug2] }
   */
  private async prefetchToolSchemas(
    tools: Record<string, string[]>
  ): Promise<ToolSchema[]> {
    const schemas: ToolSchema[] = [];

    for (const [agentName, toolSlugs] of Object.entries(tools)) {
      for (const slug of toolSlugs) {
        try {
          const result = await this.directToolExecutor.executeTool(
            'toolManager.getTools',
            { agent: agentName, tool: slug }
          );
          if (result.data?.tools?.length) {
            schemas.push(...result.data.tools);
          }
        } catch {
          // Tool not found - skip silently
        }
      }
    }

    return schemas;
  }

  private async readContextFiles(files: string[]): Promise<string> {
    // Use contentManager.readContent pattern
    const contents: string[] = [];
    for (const file of files) {
      try {
        const result = await this.directToolExecutor.executeTool(
          'contentManager.readContent',
          { filePath: file }
        );
        contents.push(`--- ${file} ---\n${result.data?.content || ''}`);
      } catch {
        contents.push(`--- ${file} --- (failed to read)`);
      }
    }
    return contents.join('\n\n');
  }

  private async loadCustomAgentPrompt(agentName: string): Promise<string | null> {
    try {
      const result = await this.directToolExecutor.executeTool(
        'agentManager.getAgent',
        { name: agentName }
      );
      return result.data?.prompt || null;
    } catch {
      return null;
    }
  }
}
```

---

## Internal Chat Only - MCP Scoping

The subagent tool is **only available in the internal chat UI**, not to Claude Desktop or other MCP clients.

**Implementation:**

```typescript
// src/config/toolVisibility.ts
export const INTERNAL_ONLY_TOOLS = ['subagent'];

// src/agents/toolManager/tools/getTools.ts
// Filter tools based on execution context
getAvailableTools(context: ToolContext): ToolSchema[] {
  let tools = this.getAllTools();

  // Hide internal-only tools from MCP clients
  if (context.source === 'mcp') {
    tools = tools.filter(t => !INTERNAL_ONLY_TOOLS.includes(t.slug));
  }

  return tools;
}

// src/agents/agentManager/tools/subagent.ts
// Block execution if somehow called from MCP
async execute(params: SubagentToolParams): Promise<SubagentToolResult> {
  const context = this.getParentContext();

  if (context.source === 'mcp') {
    return {
      success: false,
      error: 'Subagent tool is only available in the internal chat UI'
    };
  }

  // ... rest of execution
}
```

---

## New Component: `SubagentTool`

Location: `/src/agents/agentManager/tools/subagent.ts`

```typescript
import { BaseTool } from '../../baseTool';
import { SubagentExecutor, SubagentParams } from '../../../services/chat/SubagentExecutor';
import { MessageQueueService } from '../../../services/chat/MessageQueueService';

export interface SubagentToolParams {
  task: string;
  agent?: string;

  // Pre-fetched tools - schemas included in subagent's initial context
  // Format: { agentName: [toolSlug1, toolSlug2] }
  // e.g., { contentManager: ['readContent', 'createContent'], vaultLibrarian: ['search'] }
  // Subagent can still call getTools for additional tools if needed
  tools?: Record<string, string[]>;

  contextFiles?: string[];
  context?: string;
  maxIterations?: number;

  // Continue an existing subagent branch instead of creating new
  continueBranchId?: string;
}

export interface SubagentToolResult {
  success: boolean;
  subagentId: string;
  branchId: string;              // For continue functionality
  status: 'started' | 'complete' | 'max_iterations' | 'cancelled' | 'error';
  message: string;
  result?: string;               // Final content if complete
  iterations?: number;
  error?: string;
}

export class SubagentTool extends BaseTool<SubagentToolParams, SubagentToolResult> {
  constructor(
    private subagentExecutor: SubagentExecutor,
    private messageQueue: MessageQueueService
  ) {
    super(
      'subagent',
      'Spawn Subagent',
      `Spawn an autonomous subagent to work on a task in the background.
       The subagent runs independently, using tools as needed, until it completes.
       Results appear as a tool result with [View Full Branch] link.

       Use for:
       - Deep research tasks requiring multiple searches
       - Analysis tasks that need file reading and processing
       - Complex operations you want to run in parallel

       The subagent has access to all tools via getTools (except spawning more subagents).

       To continue a subagent that hit max iterations, call with continueBranchId.`,
      '1.0.0'
    );
  }

  async execute(params: SubagentToolParams): Promise<SubagentToolResult> {
    const parentContext = this.getParentContext();

    // Block MCP clients
    if (parentContext.source === 'mcp') {
      return {
        success: false,
        subagentId: '',
        branchId: '',
        status: 'error',
        message: 'Subagent tool is only available in internal chat',
        error: 'MCP_NOT_SUPPORTED'
      };
    }

    // Block subagents from spawning subagents
    if (parentContext.isSubagentBranch) {
      return {
        success: false,
        subagentId: '',
        branchId: '',
        status: 'error',
        message: 'Subagents cannot spawn other subagents. Ask the parent agent to spawn additional subagents.',
        error: 'NESTED_SUBAGENT_NOT_ALLOWED'
      };
    }

    const subagentParams: SubagentParams = {
      task: params.task,
      parentConversationId: parentContext.conversationId,
      parentMessageId: parentContext.messageId,
      agent: params.agent,
      tools: params.tools,  // Pre-fetched tool schemas
      contextFiles: params.contextFiles,
      context: params.context,
      workspaceId: parentContext.workspaceId,
      sessionId: parentContext.sessionId,
      maxIterations: params.maxIterations,
      continueBranchId: params.continueBranchId
    };

    // Execute async - returns immediately with subagentId
    // Result will be queued when complete
    const { subagentId, branchId } = await this.subagentExecutor.executeSubagent(subagentParams);

    return {
      success: true,
      subagentId,
      branchId,
      status: 'started',
      message: params.continueBranchId
        ? `Continuing subagent. Branch: ${branchId}`
        : `Subagent started. Working on: "${params.task}". Results will appear when complete.`
    };
  }

  getParameterSchema() {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Clear description of what the subagent should accomplish'
        },
        agent: {
          type: 'string',
          description: 'Optional custom agent/persona name to use (from agentManager)'
        },
        tools: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: { type: 'string' }
          },
          description: 'Pre-fetched tools by agent name. Format: { agentName: [toolSlug1, toolSlug2] }. Schemas are included in initial context. Subagent can still call getTools for more.'
        },
        contextFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to read and include as context'
        },
        context: {
          type: 'string',
          description: 'Additional context to provide to the subagent'
        },
        maxIterations: {
          type: 'number',
          description: 'Maximum iterations before pausing (default: 10)'
        },
        continueBranchId: {
          type: 'string',
          description: 'Branch ID of existing subagent to continue (from previous max_iterations result)'
        }
      },
      required: ['task']
    });
  }
}
```

---

## New Component: `MessageQueueService`

Location: `/src/services/chat/MessageQueueService.ts`

```typescript
import { EventEmitter } from 'events';

export interface QueuedMessage {
  id: string;
  type: 'user' | 'subagent_result' | 'system';
  content: string;
  metadata?: {
    subagentId?: string;
    subagentTask?: string;
    branchConversationId?: string;
    error?: boolean;
  };
  queuedAt: number;
}

export interface MessageQueueEvents {
  'message:queued': (data: { count: number; message: QueuedMessage }) => void;
  'message:processing': (data: { message: QueuedMessage }) => void;
  'queue:empty': () => void;
}

export class MessageQueueService extends EventEmitter {
  private queue: QueuedMessage[] = [];
  private isGenerating: boolean = false;
  private processMessageFn: ((message: QueuedMessage) => Promise<void>) | null = null;

  /**
   * Set the message processor function
   */
  setMessageProcessor(fn: (message: QueuedMessage) => Promise<void>): void {
    this.processMessageFn = fn;
  }

  /**
   * Enqueue a message (user messages get priority)
   */
  async enqueue(message: QueuedMessage): Promise<void> {
    if (this.isGenerating) {
      if (message.type === 'user') {
        // User messages go to front (after other user messages)
        const lastUserIndex = this.queue.reduce((acc, m, i) => m.type === 'user' ? i : acc, -1);
        this.queue.splice(lastUserIndex + 1, 0, message);
      } else {
        // Subagent results and system messages go to back
        this.queue.push(message);
      }
      this.emit('message:queued', { count: this.queue.length, message });
    } else {
      await this.processMessage(message);
    }
  }

  /**
   * Called when generation starts
   */
  onGenerationStart(): void {
    this.isGenerating = true;
  }

  /**
   * Called when generation completes - processes queue
   */
  async onGenerationComplete(): Promise<void> {
    this.isGenerating = false;
    await this.processQueue();
  }

  /**
   * Get current queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Get queued messages (for UI display)
   */
  getQueuedMessages(): QueuedMessage[] {
    return [...this.queue];
  }

  /**
   * Clear the queue
   */
  clearQueue(): void {
    this.queue = [];
    this.emit('queue:empty');
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 && !this.isGenerating) {
      const next = this.queue.shift()!;
      await this.processMessage(next);
    }
    if (this.queue.length === 0) {
      this.emit('queue:empty');
    }
  }

  private async processMessage(message: QueuedMessage): Promise<void> {
    if (!this.processMessageFn) {
      console.error('[MessageQueueService] No message processor set');
      return;
    }

    this.emit('message:processing', { message });
    await this.processMessageFn(message);
  }
}
```

---

## Integration: Wiring It Together

### 1. Register SubagentTool in AgentManager

Location: `/src/agents/agentManager/agentManager.ts`

```typescript
// In constructor, add:
this.registerTool(new SubagentTool(
  this.getSubagentExecutor(),
  this.getMessageQueueService()
));
```

### 2. Hook MessageQueueService into StreamingResponseService

Location: `/src/services/chat/StreamingResponseService.ts`

```typescript
// Add to constructor:
this.messageQueue = dependencies.messageQueue;

// In generateResponse():
async* generateResponse(...) {
  this.messageQueue?.onGenerationStart();  // ADD THIS

  try {
    // ... existing streaming logic ...
  } finally {
    this.messageQueue?.onGenerationComplete();  // ADD THIS
  }
}
```

### 3. Update ChatView for Subagent UI

Location: `/src/ui/chat/ChatView.ts`

```typescript
// Add subagent status indicator
private renderSubagentIndicator(): void {
  const activeSubagents = this.subagentExecutor.getActiveSubagents();

  if (activeSubagents.length > 0) {
    // Show indicator with [View] [Cancel] buttons
    // Use existing UI patterns from tool result accordion
  }
}

// Add queue indicator
private renderQueueIndicator(): void {
  const queueLength = this.messageQueue.getQueueLength();

  if (queueLength > 0) {
    // Show "📨 N messages queued" indicator
  }
}
```

---

## User Interactions

### View Subagent Branch In Progress

```typescript
// User clicks [View Branch] on subagent alternative
async viewSubagentBranch(parentMessageId: string, alternativeIndex: number): Promise<void> {
  const message = this.getMessageById(parentMessageId);
  const alternative = message.alternatives[alternativeIndex - 1];
  const branchConvId = alternative.metadata?.subagentBranchConversationId;

  if (branchConvId) {
    // Open branch conversation in new pane or modal
    await this.openConversation(branchConvId);
  }
}
```

### Cancel Running Subagent

```typescript
// User clicks [Cancel] on running subagent
async cancelSubagent(subagentId: string): Promise<void> {
  const cancelled = this.subagentExecutor.cancelSubagent(subagentId);

  if (cancelled) {
    // Update UI to show cancelled state
    // Result will be marked as error with "Cancelled by user"
  }
}
```

### Switch Between Original and Subagent Result

```typescript
// User clicks ◀ ▶ navigation on message with alternatives
// Pattern: Existing BranchManager.switchToMessageAlternative()
async switchAlternative(messageId: string, index: number): Promise<void> {
  await this.branchManager.switchToMessageAlternative(
    this.conversation,
    messageId,
    index
  );
  this.refreshMessageDisplay(messageId);
}
```

---

## Files to Create

| Path | Purpose |
|------|---------|
| `src/services/chat/SubagentExecutor.ts` | Core subagent execution loop |
| `src/services/chat/MessageQueueService.ts` | Async message queue |
| `src/services/chat/BranchService.ts` | Unified branch management (human + subagent) |
| `src/agents/agentManager/tools/subagent.ts` | Tool definition |
| `src/types/branch/BranchTypes.ts` | Branch type definitions |

## Files to Modify

| Path | Changes |
|------|---------|
| `src/types/chat/ChatTypes.ts` | Add `branches[]` to ConversationMessage |
| `src/agents/agentManager/agentManager.ts` | Register SubagentTool |
| `src/services/chat/ChatService.ts` | Add `generateResponseStreamingForBranch()` |
| `src/services/chat/StreamingResponseService.ts` | Branch context building, queue hooks |
| `src/services/ConversationService.ts` | Branch CRUD operations |
| `src/ui/chat/services/MessageManager.ts` | Route through queue |
| `src/ui/chat/services/BranchManager.ts` | Extend for unified branching |
| `src/ui/chat/ChatView.ts` | Branch navigation, subagent indicators |
| `src/ui/chat/components/ToolResultDisplay.ts` | [View Branch] link for subagent results |
| `src/config/toolVisibility.ts` | Add `INTERNAL_ONLY_TOOLS` |
| `src/agents/toolManager/tools/getTools.ts` | Filter internal-only tools for MCP |
| `src/database/schema/schema.ts` | Add branches to message schema (if using SQLite) |

---

## Key Patterns Followed

| Pattern | Source | Applied To |
|---------|--------|------------|
| Abort signal checking FIRST | `StreamingResponseService:166` | `SubagentExecutor.runSubagentLoop()` |
| Unified branching | New `BranchService` | Both human and subagent branches |
| `inheritContext` flag | New | Controls LLM context building |
| Tool result format | `DirectToolExecutor` | Subagent results in accordion UI |
| Message queue | Custom `MessageQueueService` | Async result delivery |
| Fire and forget async | Tool execution pattern | `executeSubagent()` |
| Event emission | `MessageAlternativeService` | Progress updates |
| Internal-only tool filtering | `toolVisibility.ts` | MCP scoping |

---

## Completion Detection

**Natural completion (like Claude Code):**

```typescript
// In runSubagentLoop():
if (!toolCalls || toolCalls.length === 0) {
  // No tool calls = subagent is done
  return { success: true, content: responseContent, ... };
}
```

The subagent runs until it responds without calling any tools. That response becomes the result.

---

## Queue Priority

```typescript
// User messages jump ahead of subagent results
if (message.type === 'user') {
  // Insert after last user message, before subagent results
  const lastUserIndex = queue.findLastIndex(m => m.type === 'user');
  queue.splice(lastUserIndex + 1, 0, message);
} else {
  // Subagent results go to back
  queue.push(message);
}
```

---

## Safety Limits

| Limit | Default | Configurable |
|-------|---------|--------------|
| `maxIterations` | 10 | Yes, per subagent |
| `maxTokens` | (inherit from LLM) | Via LLM settings |
| `timeout` | None (uses abort) | User can cancel |
| `maxDepth` | 1 (no nested) | Future |

---

## Subagent Result as Trigger

When subagent completes, queue a message that triggers parent LLM response:

```typescript
// In SubagentExecutor completion handler:
this.messageQueue.enqueue({
  type: 'subagent_result',
  content: `Subagent completed task: "${task}"\n\nResult:\n${result.content}`,
  metadata: {
    subagentId,
    subagentTask: task,
    branchConversationId: result.branchConversationId
  }
});

// MessageQueueService processor:
if (message.type === 'subagent_result') {
  // Add as tool result in accordion format
  await this.addToolResult(message);

  // Trigger parent LLM to respond (like user message)
  await this.chatService.generateResponse(message.content);
}
```

---

## Implementation Phases

### Phase 1: Core MVP
- [x] Design complete
- [ ] `SubagentExecutor.ts` - execution loop
- [ ] `MessageQueueService.ts` - async queue
- [ ] `subagent.ts` tool - registration
- [ ] Basic integration test

### Phase 2: UI Integration
- [ ] Subagent indicator in ChatView
- [ ] Queue indicator
- [ ] [View Branch] link on alternatives
- [ ] [Cancel] button

### Phase 3: Polish
- [ ] Progress streaming to UI
- [ ] Cost tracking per subagent
- [ ] Error recovery
- [ ] Timeout handling

### Phase 4: Future
- [ ] Nested subagents
- [ ] Parallel subagents
- [ ] Specialized profiles

---

*Document reflects existing codebase patterns. All pseudocode follows actual implementation structure.*
