---
title: "From Theory to Production"
series: "Bounded Context Packs"
part: 3
tags:
  - mcp
  - architecture
  - bounded-context-packs
  - tool-design
  - llm
created: 2024-12-12
---

# From Theory to Production

> [!quote]
> *"Architecture is frozen music—but code is frozen problem-solving."*

[[BCPs#The Tool Bloat Tipping Point|Article 1]] and [[BCPs#The Meta-Tool Pattern|Article 2]] established the problem and the pattern. Now let's open the hood.

This article walks through a production implementation of Bounded Context Packs: **Nexus**, an open-source Obsidian plugin that runs MCP tools through a meta-layer architecture. Every code example comes from running production code.

---

## The Entry Point: One Tool to Rule Them All

The entire BCP implementation pivots on a single function: `getRegisteredTools()`.

```typescript
// connector.ts:274-291

// ══════════════════════════════════════════════════════════════════════
// This creates the ONE tool that gets exposed to the AI model at startup.
// Instead of registering 51 tools, we register just this single "get_tools".
// ══════════════════════════════════════════════════════════════════════

const getToolsTool = {
    // The tool's name - this is what the AI will call
    name: 'get_tools',

    // THE KEY TRICK: The description contains the FULL LIST of available
    // agents and modes. The AI sees this menu just by seeing the tool.
    // No extra API call needed - the capability index IS the description.
    description: `Discover available tools on-demand...

Available agents and modes:
${agentModeList}   // <-- Dynamically-generated list!

To use tools, request their schemas using ONE of these formats:

1. GROUPED (recommended - saves tokens):
   get_tools({ tools: { "contentManager": ["readContent", "createContent"] } })

2. FLAT (also supported):
   get_tools({ tools: ["contentManager_readContent"] })

Then call the actual tool with required parameters.`,

    // Schema defines what parameters this tool accepts
    inputSchema: {
        type: 'object',
        properties: {
            tools: {
                // Accepts EITHER grouped object OR flat array
                oneOf: [
                    {
                        type: 'object',           // { "agent": ["mode1", "mode2"] }
                        additionalProperties: { type: 'array', items: { type: 'string' } }
                    },
                    {
                        type: 'array',            // ["agent_mode1", "agent_mode2"]
                        items: { type: 'string' }
                    }
                ]
            },
            ...contextSchema
        },
        required: ['tools', 'context']
    }
};

// Return array with just this ONE tool - not 51!
return [getToolsTool];
```

> [!tip] The Key Insight
> The schema description *is* the capability index. The model sees every available agent and mode just by seeing the tool definition. No discovery call needed. No round-trip. **The menu is baked into the schema itself.**

That `agentModeList` variable? **Dynamically generated** by iterating through registered agents:

```typescript
// connector.ts:255-265

// ══════════════════════════════════════════════════════════════════════
// This code DYNAMICALLY builds the list of all agents and their modes.
// No hardcoded list! If you add a new agent or mode, it auto-appears here.
// ══════════════════════════════════════════════════════════════════════

// Only run if the agent registry exists (it holds all registered agents)
if (this.agentRegistry) {

    // Get ALL registered agents as a Map (key = agent name, value = agent object)
    const registeredAgents = this.agentRegistry.getAllAgents();

    // We'll build up lines like "- contentManager: [readContent, createContent, ...]"
    const agentModeLines: string[] = [];

    // Loop through each agent in the registry
    for (const [agentName, agent] of registeredAgents) {

        // Ask the agent for all its modes (each mode = one capability/tool)
        const modes = (agent as any).getModes?.() || [];

        // Extract just the mode names (slugs) into a simple array
        const modeNames = modes.map((m: any) => m.slug || m.name || 'unknown');

        // Format as "- agentName: [mode1, mode2, mode3]" and add to our list
        agentModeLines.push(`- ${agentName}: [${modeNames.join(', ')}]`);
    }

    // Join all lines with newlines to create the final menu string
    agentModeList = agentModeLines.join('\n');
}
```

> [!tip] Self-Documenting Architecture
> No manual list to maintain. Add a new agent or mode, and it automatically appears in the `get_tools` schema. The capability index is always in sync with reality.

At runtime, this produces something like:

```
- contentManager: [readContent, createContent, appendContent, ...]
- vaultManager: [listDirectory, createFolder, editFolder, ...]
- vaultLibrarian: [search, searchDirectory, searchWorkspace, ...]
- memoryManager: [createSession, listSessions, editSession, ...]
- agentManager: [listPrompts, getPrompt, createPrompt, ...]
- commandManager: [listCommands, executeCommand]
```

> [!success] Result
> **51 capabilities. One schema. ~450 tokens at startup instead of ~12,750.**

---

## Schema Retrieval: Request What You Need

When `get_tools` is called, it first normalizes the input to support both formats:

```typescript
// connector.ts:311-332

// ══════════════════════════════════════════════════════════════════════
// NORMALIZER: Converts grouped format to flat array internally.
// This lets AI use the cleaner grouped format while the rest of the
// code continues to work with simple "agent_mode" strings.
// ══════════════════════════════════════════════════════════════════════

private normalizeToolRequest(tools: any): string[] {

    // If already an array like ["contentManager_readContent"], use as-is
    if (Array.isArray(tools)) {
        return tools;
    }

    // If grouped object like { "contentManager": ["readContent", "createContent"] }
    // Convert to flat array: ["contentManager_readContent", "contentManager_createContent"]
    if (tools && typeof tools === 'object') {
        const flatTools: string[] = [];

        // Loop through each agent in the object
        for (const [agentName, modes] of Object.entries(tools)) {
            if (Array.isArray(modes)) {
                // Combine agent name + each mode name
                for (const mode of modes) {
                    flatTools.push(`${agentName}_${mode}`);
                }
            }
        }
        return flatTools;
    }

    return [];  // Fallback for invalid input
}
```

Then it fetches only those specific schemas:

```typescript
// connector.ts:328-384

// ══════════════════════════════════════════════════════════════════════
// When the AI requests specific tools, this function fetches ONLY those
// schemas. If AI asks for 2 tools, it gets 2 schemas - not all 51.
// ══════════════════════════════════════════════════════════════════════

private getToolsForSpecificNames(toolNames: string[]): any[] {
    // Array to collect the schemas we'll return
    const tools: any[] = [];

    // Loop through each tool name the AI requested
    for (const toolName of toolNames) {

        // ─────────────────────────────────────────────────────────────
        // STEP 1: Parse the tool name to extract agent and mode
        // Tool names follow pattern: "agentName_modeName"
        // Example: "contentManager_createNote" splits into:
        //   - agent = "contentManager"
        //   - mode  = "createNote"
        // ─────────────────────────────────────────────────────────────
        const parts = toolName.split('_');
        const agentName = parts[0];                    // First part = agent
        const modeName = parts.slice(1).join('_');    // Rest = mode (rejoin in case mode has underscores)

        // ─────────────────────────────────────────────────────────────
        // STEP 2: Look up the actual agent and mode objects
        // ─────────────────────────────────────────────────────────────
        const agent = registeredAgents.get(agentName);
        const modeInstance = modes.find(m => m.slug === modeName);

        // ─────────────────────────────────────────────────────────────
        // STEP 3: Get the schema and STRIP common parameters
        // This is key - we remove redundant fields to save tokens
        // ─────────────────────────────────────────────────────────────
        const paramSchema = modeInstance.getParameterSchema();
        const cleanSchema = this.stripCommonParameters(paramSchema);

        // ─────────────────────────────────────────────────────────────
        // STEP 4: Package it up and add to our results
        // ─────────────────────────────────────────────────────────────
        tools.push({
            name: toolName,                      // e.g., "contentManager_createNote"
            description: modeInstance.description,  // Human-readable explanation
            inputSchema: cleanSchema             // The parameters this tool accepts
        });
    }

    // Return only the schemas that were requested
    return tools;
}
```

**The model asks for exactly what it needs. No more, no less.**

---

## The Token-Saving Trick: Schema Stripping

Every tool in Nexus shares common parameters that get merged into every schema:

- **`context`** - Rich object containing `sessionId`, `workspaceId`, `sessionDescription`, `sessionMemory`, `toolContext`, `primaryGoal`, `subgoal`
- **`workspaceContext`** - Optional object for workspace path and depth settings

> [!warning] The Problem
> If we returned these with every schema, we'd add **~200 tokens per tool**. For a 5-tool request, that's 1,000 tokens of redundant context definition.

The solution:

```typescript
// connector.ts:429-445

// ══════════════════════════════════════════════════════════════════════
// THE TOKEN-SAVING MAGIC: Strip out parameters that every tool shares.
// Instead of repeating "context" definition 51 times (200+ tokens each),
// we remove it and explain it ONCE in the instruction text.
// ══════════════════════════════════════════════════════════════════════

private stripCommonParameters(schema: any): any {
    // Safety check - if no schema or no properties, return as-is
    if (!schema || !schema.properties) {
        return schema;
    }

    // ─────────────────────────────────────────────────────────────
    // Destructure to REMOVE the common parameters from properties.
    // The "...cleanProperties" captures everything EXCEPT those named.
    //
    // Before: { context: {...}, workspaceContext: {...}, filePath: {...} }
    // After:  { filePath: {...} }  (context & workspaceContext removed)
    //
    // Note: sessionId lives INSIDE context, not as a standalone field
    // ─────────────────────────────────────────────────────────────
    const { context, workspaceContext, ...cleanProperties } = schema.properties;

    // Also remove these from the "required" array so AI doesn't see them as required
    const cleanRequired = (schema.required || []).filter(
        (field: string) => field !== 'context' && field !== 'workspaceContext'
    );

    // Return the cleaned-up schema
    return {
        ...schema,                          // Keep everything else (type, description, etc.)
        properties: cleanProperties,        // But with common params removed
        required: cleanRequired.length > 0 ? cleanRequired : undefined
    };
}
```

We strip common parameters from returned schemas and document them once in the instruction block:

```typescript
// ══════════════════════════════════════════════════════════════════════
// Instead of including context schema with EVERY tool (wasteful!),
// we explain it ONCE here. The AI reads this instruction and knows
// to add the context object to every tool call it makes.
// ══════════════════════════════════════════════════════════════════════

return {
    success: true,
    tools: tools,            // Array of cleaned schemas (without common params)

    // ONE explanation that covers ALL tools - massive token savings!
    instruction: `IMPORTANT: All ${tools.length} tools require a 'context' object with:
                  sessionId, workspaceId, sessionDescription, sessionMemory,
                  toolContext, primaryGoal, and subgoal.

                  The 'workspaceId' field is REQUIRED - use the workspace ID from
                  loadWorkspace or "default" if none has been loaded.`
};
```

**One explanation instead of 51 duplications.**

---

## Self-Registering Agents: Domain as Code

BCPs need clear domain boundaries. In Nexus, agents register themselves and their modes at construction time:

```typescript
// agents/contentManager/contentManager.ts

// ══════════════════════════════════════════════════════════════════════
// Each agent is a CLASS that manages a group of related capabilities.
// When the agent is created, it registers all its modes (tools) itself.
// No config file needed - the code IS the configuration.
// ══════════════════════════════════════════════════════════════════════

export class ContentManagerAgent extends BaseAgent {

    // Constructor runs when the agent is created at startup
    constructor(app: App, plugin?: NexusPlugin, ...) {

        // Call parent class with agent metadata
        super(
            ContentManagerConfig.name,         // "contentManager"
            ContentManagerConfig.description,  // "Content operations for Obsidian notes"
            ContentManagerConfig.version       // "1.0.0"
        );

        // ─────────────────────────────────────────────────────────────
        // SELF-REGISTRATION: Each mode gets registered automatically.
        // When get_tools builds its list, it asks this agent for modes,
        // and all of these will be returned. Add a new one here = done!
        // ─────────────────────────────────────────────────────────────
        this.registerMode(new ReadContentMode(app, this.memoryService));
        this.registerMode(new CreateContentMode(app));
        this.registerMode(new AppendContentMode(app));
        this.registerMode(new PrependContentMode(app));
        this.registerMode(new ReplaceContentMode(app));
        this.registerMode(new ReplaceByLineMode(app));
        this.registerMode(new DeleteContentMode(app));
        this.registerMode(new FindReplaceContentMode(app));
        this.registerMode(new BatchContentMode(app, this.memoryService));
    }
}
```

The `BaseAgent` class maintains a mode registry:

```typescript
// agents/baseAgent.ts

// ══════════════════════════════════════════════════════════════════════
// BaseAgent is the PARENT CLASS that all agents inherit from.
// It provides the mode storage and retrieval that makes discovery work.
// ══════════════════════════════════════════════════════════════════════

export abstract class BaseAgent implements IAgent {

    // A Map is like a dictionary: key = mode name, value = mode object
    // Example: { "readContent" -> ReadContentMode, "createContent" -> CreateContentMode }
    protected modes: Map<string, IMode> = new Map();

    // Called by get_tools to find out what modes this agent has
    getModes(): IMode[] {
        // Convert the Map values to an array and return them
        return Array.from(this.modes.values());
    }

    // Called by agent constructors to add modes to the registry
    registerMode(mode: IMode): void {
        // Store the mode using its slug (short name) as the key
        this.modes.set(mode.slug, mode);
    }
}
```

> [!tip] Zero Configuration Discovery
> When `get_tools` builds the capability index, it calls `agent.getModes()` on each registered agent. **Add a mode to any agent's constructor, and it automatically appears in discovery.** No config files to update. No lists to maintain.

The domain boundaries emerge from how agents are organized:

| Agent | Domain | Concern |
|-------|--------|---------|
| `contentManager` | Content Operations | What's *in* files |
| `vaultManager` | File System | Where files *are* |
| `vaultLibrarian` | Search & Retrieval | *Finding* things |
| `memoryManager` | Memory Management | *Remembering* context |
| `agentManager` | LLM Integration | *AI execution* |
| `commandManager` | System Commands | *Obsidian itself* |

Different agents, different concerns, different cognitive modes.

---

## Mode Implementation: The Tool Layer

Each mode is a self-contained operation with its own schema and execution logic:

```typescript
// agents/contentManager/modes/readContentMode.ts

// ══════════════════════════════════════════════════════════════════════
// A MODE is a single capability/tool. It defines:
//   1. Its identity (slug, name, description)
//   2. What parameters it accepts (schema)
//   3. What it actually does (execute function)
// ══════════════════════════════════════════════════════════════════════

export class ReadContentMode extends BaseMode {

    // ─────────────────────────────────────────────────────────────
    // IDENTITY: These define how the mode appears in discovery
    // ─────────────────────────────────────────────────────────────
    slug = 'readContent';                              // Used in tool name: "contentManager_readContent"
    name = 'Read Content';                             // Human-friendly name
    description = 'Read content from a file in the vault';  // Shown to AI

    // ─────────────────────────────────────────────────────────────
    // SCHEMA: Defines what parameters this tool accepts
    // This is what gets returned when AI requests this tool's schema
    // ─────────────────────────────────────────────────────────────
    getParameterSchema(): any {
        const modeSchema = {
            type: 'object',
            properties: {
                // Each property is a parameter the AI can pass
                filePath: {
                    type: 'string',
                    description: 'Path to the file to read'
                },
                limit: {
                    type: 'number',
                    description: 'Optional number of lines to read'
                },
                offset: {
                    type: 'number',
                    description: 'Line number to start reading from (1-based)'
                },
                includeLineNumbers: {
                    type: 'boolean',
                    description: 'Include line numbers in output',
                    default: false
                }
            },
            required: ['filePath']   // Only filePath is mandatory
        };

        // Merge with common schema (adds context, workspaceContext)
        // These get stripped later by stripCommonParameters!
        return this.getMergedSchema(modeSchema);
    }

    // ─────────────────────────────────────────────────────────────
    // EXECUTE: The actual code that runs when AI calls this tool
    // Receives the parameters AI passed, returns the result
    // ─────────────────────────────────────────────────────────────
    async execute(params: any): Promise<any> {

        // Destructure = extract named values from the params object
        const { filePath, limit, offset, includeLineNumbers } = params;

        // Look up the file in Obsidian's vault
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) {
            throw new Error(`File not found: ${filePath}`);
        }

        // Read the file's content
        let content = await this.app.vault.read(file);

        // Handle offset and limit (for reading portions of large files)
        if (offset || limit) {
            const lines = content.split('\n');           // Split into lines
            const startLine = offset ? offset - 1 : 0;   // Convert 1-based to 0-based
            const endLine = limit ? startLine + limit : lines.length;
            content = lines.slice(startLine, endLine).join('\n');  // Extract subset
        }

        // Add line numbers if requested
        if (includeLineNumbers) {
            const startNum = offset || 1;
            content = content.split('\n')
                .map((line, i) => `${startNum + i}: ${line}`)  // Prefix each line
                .join('\n');
        }

        // Return result to the AI
        return { success: true, content, filePath };
    }
}
```

> [!note] Separation of Concerns
> The mode knows nothing about BCP architecture. It just defines its schema and implements its logic. **The meta-layer handles everything else.**

---

## The Routing Layer: Dispatch Without Complexity

When a tool call comes in, the router parses the name and dispatches to the right agent/mode:

```typescript
// services/mcp/ToolCallRouter.ts

// ══════════════════════════════════════════════════════════════════════
// The ROUTER is the traffic cop. When AI calls a tool, the router:
//   1. Parses the tool name to extract agent + mode
//   2. Finds the right agent and mode
//   3. Executes it and returns the result
// ══════════════════════════════════════════════════════════════════════

export class ToolCallRouter {

    // Main entry point: execute a tool call from the AI
    async executeAgentMode(
        agent: string,                    // e.g., "contentManager"
        mode: string,                     // e.g., "readContent"
        params: Record<string, any>       // The parameters AI passed
    ): Promise<any> {
        try {
            // Hand off to the server which knows about all agents
            return await this.server.executeAgentMode(agent, mode, params);
        } catch (error) {
            // Wrap any errors in a standard MCP error format
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to execute ${agent}.${mode}`,
                error
            );
        }
    }

    // ─────────────────────────────────────────────────────────────
    // PARSING: Convert tool name into agent + mode
    // "contentManager_readContent" → { agent: "contentManager", mode: "readContent" }
    // ─────────────────────────────────────────────────────────────
    parseToolName(toolName: string): { agent: string; mode: string } {
        // Split on underscore: ["contentManager", "readContent"]
        const parts = toolName.split('_');

        // Must have at least 2 parts (agent + mode)
        if (parts.length < 2) {
            throw new Error(`Invalid tool name format: ${toolName}`);
        }

        return {
            agent: parts[0],                    // First part = agent name
            mode: parts.slice(1).join('_')      // Rest = mode (rejoined if mode has underscores)
        };
    }
}
```

The naming convention (`agent_mode`) makes routing trivial. No lookup tables. No complex dispatch logic. **Just string parsing.**

---

## A Complete Request Flow

Let's trace a real request through the system:

### Step 1: Model sees `get_tools` schema (startup)

```
Available agents and modes:
- contentManager: readContent, createContent, appendContent...
- vaultLibrarian: search, searchDirectory, searchMemory...
```

### Step 2: Model requests specific tools

```json
// ══════════════════════════════════════════════════════════════════════
// AI decides it needs to read a file and search. It calls get_tools
// to retrieve ONLY those schemas - not all 51!
//
// GROUPED FORMAT (recommended) - saves tokens by not repeating agent names:
// ══════════════════════════════════════════════════════════════════════
{
    "name": "get_tools",
    "arguments": {
        "tools": {
            // Agent name as key, array of modes as value
            // Much cleaner than repeating "contentManager_" for each mode!
            "contentManager": ["readContent", "createContent"],
            "vaultLibrarian": ["search"]
        },
        "context": {
            "sessionId": "research-session",
            "workspaceId": "default"
        }
    }
}

// Also supports flat format (backwards compatible):
// "tools": ["contentManager_readContent", "contentManager_createContent", "vaultLibrarian_search"]
```

### Step 3: System returns clean schemas

```json
// ══════════════════════════════════════════════════════════════════════
// System returns ONLY the 3 requested schemas. Notice:
//   - No "context" parameter in the schemas (stripped to save tokens!)
//   - Instruction tells AI to add context to every call
//   - Tool names are still in "agent_mode" format for calling
// ══════════════════════════════════════════════════════════════════════
{
    "success": true,
    "tools": [
        {
            "name": "contentManager_readContent",     // Full name for calling
            "description": "Read content from a file in the vault",
            "inputSchema": {
                "type": "object",
                "properties": {
                    // Only tool-specific params! context was stripped out
                    "filePath": { "type": "string" },
                    "limit": { "type": "number" },
                    "offset": { "type": "number" }
                },
                "required": ["filePath"]
            }
        },
        {
            "name": "contentManager_createContent",
            "description": "Create a new note with content",
            "inputSchema": { "..." }
        },
        {
            "name": "vaultLibrarian_search",
            "description": "Search vault content",
            "inputSchema": { "..." }
        }
    ],
    "toolCount": 3,
    // ONE instruction explains context for ALL tools - not repeated per-tool!
    "instruction": "All tools require a 'context' object with sessionId, workspaceId..."
}
```

### Step 4: Model calls the actual tool

```json
// ══════════════════════════════════════════════════════════════════════
// Now AI calls the actual tool. It adds the "context" object as
// instructed (even though it wasn't in the schema - it was stripped).
// ══════════════════════════════════════════════════════════════════════
{
    "name": "contentManager_readContent",    // The tool to execute
    "arguments": {
        "filePath": "notes/research.md",     // Tool-specific parameter

        // Context object - AI adds this based on the instruction it received
        "context": {
            "sessionId": "research-session",
            "workspaceId": "default",
            "sessionDescription": "Researching BCP architecture",
            "sessionMemory": "User asked to read research notes",
            "toolContext": "Reading file to review findings",
            "primaryGoal": "Understand BCP implementation",
            "subgoal": "Get contents of research notes"
        }
    }
}
```

### Step 5: Router dispatches to agent/mode

```typescript
// ══════════════════════════════════════════════════════════════════════
// Router parses "contentManager_readContent" and routes to the right place
// ══════════════════════════════════════════════════════════════════════

// Tool name gets parsed: "contentManager_readContent"
//   → agent = "contentManager"
//   → mode  = "readContent"

const result = await router.executeAgentMode(
    "contentManager",    // Which agent handles this
    "readContent",       // Which mode (capability) to run
    params               // All the parameters AI passed
);
```

### Step 6: Mode executes and returns

```json
// ══════════════════════════════════════════════════════════════════════
// The mode runs its execute() function and returns the result to AI
// ══════════════════════════════════════════════════════════════════════
{
    "success": true,
    "content": "# Research Notes\n\nFindings from today...",
    "filePath": "notes/research.md"
}
```

> [!success] Total tool schemas loaded: 3 (not 51)

---

## What This Enables

The architecture decisions compound:

| Benefit | Explanation |
|---------|-------------|
| **Local model compatibility** | 51 tools × ~250 tokens = 12,750 tokens. An 8K context model is immediately overwhelmed. With BCPs: 450 tokens at startup + ~150 tokens per tool. A 5-tool task fits easily. |
| **Cost efficiency** | Claude charges per token. Every request that loads all 51 tools pays for 51 tools. With BCPs, you pay for what you use. |
| **Cognitive clarity** | The model isn't choosing between 51 options. It's choosing between 6 domains, then specific operations within the relevant domain. Decision quality improves. |
| **Extension without bloat** | Adding new agents or modes doesn't increase startup cost. The meta-layer absorbs new capabilities without growing the initial context. |

---

## The Trade-off

> [!warning] Nothing is Free
> BCPs add:
> - **One extra round-trip** for schema discovery (mitigated by baking the menu into `get_tools` description)
> - **Routing complexity** (mitigated by simple naming conventions)
> - **Mental model shift** for developers (agents and modes vs. flat tools)

In production, the benefits have overwhelmingly outweighed these costs. But the pattern isn't universally optimal. **If you have 5 tools, just register 5 tools.** BCPs solve scale problems.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HOW IT ALL FITS TOGETHER                       │
└─────────────────────────────────────────────────────────────────────────────┘

                         ┌─────────────────────┐
                         │    MCPConnector     │  ← Main entry point
                         │   (connector.ts)    │
                         └──────────┬──────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
    ┌───────────────┐      ┌───────────────┐      ┌─────────────────┐
    │   get_tools   │      │ ToolCallRouter│      │AgentRegistration│
    │  (Meta-Tool)  │      │  (Dispatcher) │      │    Service      │
    │               │      │               │      │                 │
    │ • Lists all   │      │ • Parses tool │      │ • Creates agents│
    │   agents in   │      │   names       │      │ • Registers them│
    │   description │      │ • Routes to   │      │   at startup    │
    │ • Returns     │      │   right agent │      │                 │
    │   schemas on  │      │               │      │                 │
    │   demand      │      │               │      │                 │
    └───────────────┘      └───────┬───────┘      └────────┬────────┘
                                   │                       │
                                   │               ┌───────┴───────┐
                                   │               │ Agent Registry│
                                   │               ├───────────────┤
                                   │               │contentManager │
                                   │               │vaultLibrarian │
                                   │               │vaultManager   │
                                   │               │memoryManager  │
                                   │               │agentManager   │
                                   │               │commandManager │
                                   │               └───────────────┘
                                   │
                                   ▼
                          ┌───────────────┐
                          │   MCPServer   │  ← Executes agent.mode calls
                          └───────┬───────┘
                                  │
                                  ▼
                          ┌───────────────┐
                          │   BaseAgent   │  ← Parent class for all agents
                          │               │
                          │ • Stores modes│
                          │ • getModes()  │
                          └───────┬───────┘
                                  │
                                  ▼
                          ┌───────────────┐
                          │   51 Modes    │  ← Individual capabilities
                          │               │
                          │ Each mode has:│
                          │ • slug        │
                          │ • schema      │
                          │ • execute()   │
                          └───────────────┘
```

---

## Key Implementation Files

> [!abstract] Core Files
> - `src/connector.ts` - MCPConnector with get_tools handler
> - `src/services/mcp/ToolCallRouter.ts` - Routing & validation
> - `src/services/mcp/MCPConnectionManager.ts` - Server lifecycle
> - `src/utils/schemaUtils.ts` - Schema utilities
> - `src/agents/baseAgent.ts` - Agent base class
> - `src/agents/baseMode.ts` - Mode base class
> - `src/config/agents.ts` - Agent registry

> [!abstract] Agent Implementations
> - `src/agents/contentManager/contentManager.ts`
> - `src/agents/vaultLibrarian/vaultLibrarian.ts`
> - `src/agents/vaultManager/vaultManager.ts`
> - `src/agents/memoryManager/memoryManager.ts`
> - `src/agents/agentManager/agentManager.ts`

---

## What's Next

This article showed the implementation. [[BCPs#Patterns They Didn't Cover|Article 4]] covers what emerged from production use:

- **Batch operations**: When single-tool calls aren't enough
- **Session context**: How memory flows through the system
- **Cross-domain routing**: When a task spans multiple agents
- **The patterns that only appear under load**

The theory worked. The implementation runs. Now let's talk about what happens when real users push the system.

---

**Series**: Bounded Context Packs
**Previous**: [[BCPs#The Meta-Tool Pattern|The Meta-Tool Pattern]]
**Next**: [[BCPs#Patterns They Didn't Cover|Patterns They Didn't Cover]]
**Word Count**: ~1,800 words
