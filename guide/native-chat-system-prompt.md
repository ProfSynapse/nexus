# Native Chat System Prompt

This guide explains the lean system prompt used by native chat, what dynamic context gets injected into it, and why the prompt is intentionally small.

## Goals

The native chat system prompt is designed to do a few things well:

- Preserve the `getTools` -> `useTools` workflow
- Keep persistent structure user-driven
- Use a selected workspace as primary context when one exists
- Encourage progressive context gathering: list/search, then read, then write/edit
- Avoid bloating every turn with large tool catalogs or workspace indexes

The prompt is policy-first. Rich context should come from a selected workspace or explicit user references, not from large default prompt dumps.

## Current Prompt Shape

The core prompt has two always-on sections:

1. `tools_and_context`
2. `working_strategy`

If present, these dynamic sections may also be added:

- `context_status`
- `previous_context`
- `files`
- `tool_hints`
- `custom_prompts`
- `workspaces`
- `selected_prompt`
- `selected_workspace`

The default prompt no longer injects vault structure, all available workspaces, all available prompts, or a full tool-agent catalog on every turn.

## Core Prompt

```xml
<tools_and_context>
You have two meta-tools:
- getTools: discover the tools and schemas needed for the next step
- useTools: execute tool calls

Context (REQUIRED in every useTools call):
- workspaceId: "{{workspaceId}}"
- sessionId: "{{sessionId}}"
- memory: brief summary of the conversation so far
- goal: brief statement of the current objective
- constraints: (optional) any rules or limits

Calls array: [{ agent: "agentName", tool: "toolName", params: {...} }]

Use getTools narrowly. Do not assume schemas from memory. Use "params" for tool arguments.
Keep workspaceId and sessionId exactly as shown.
</tools_and_context>

<working_strategy>
If a workspace is selected, use it as the primary context.

If no workspace is selected and the request looks like ongoing or multi-step work, consider whether an existing workspace should be loaded first. Ask before creating a new workspace.

For multi-step or ongoing work, suggest using TaskManager to track it. Ask before creating task/project structure unless the user clearly asked for it.

Before major structured action, check whether a useful custom prompt already exists. If the pattern seems reusable or recurring, suggest creating a custom prompt or workflow. Ask before creating either. If a workflow is created, consider attaching the right prompt or agent.

Gather context progressively:
1. list or search to narrow scope
2. read the most relevant files, notes, workspace data, prompts, or tasks
3. then write or edit once you have enough context

Prefer targeted context gathering over large dumps.
</working_strategy>
```

## Dynamic Blocks

### `selected_workspace`

If the user has selected a workspace in chat settings, the full loaded workspace object is injected as `selected_workspace`.

This is the main source of rich default context. It includes the complete loaded workspace payload rather than a reduced summary.

### `selected_prompt`

If a prompt is explicitly selected in chat settings, it is injected as `selected_prompt`.

### `files`

This section is used for:

- context notes added to chat
- explicit note references from the note suggester

The model gets the note path and note content.

### `tool_hints`

This comes from explicit tool references in chat. It is a light hint that the user wants a specific tool used.

### `custom_prompts`

This comes from explicit prompt references in chat. It injects the referenced prompt content.

### `workspaces`

This comes from explicit workspace references in chat. When possible, the referenced workspace is loaded and injected with its workspace data.

## Escaping Rules

The system prompt uses XML-like sections, so dynamic text must be escaped before insertion.

Escaping is required for:

- note paths
- note contents
- tool names and descriptions
- prompt contents
- workspace names and descriptions
- selected prompt text
- selected workspace JSON
- previous context summary text

Text node escaping converts:

- `&` -> `&amp;`
- `<` -> `&lt;`
- `>` -> `&gt;`

Attribute escaping also converts:

- `"` -> `&quot;`
- `'` -> `&apos;`

If dynamic content is inserted raw, XML-like sections can be broken by note text, prompt text, or workspace JSON containing angle brackets.

## Why This Prompt Is Lean

This prompt intentionally does not preload everything.

It avoids:

- full tool schemas
- full workspace indexes
- full prompt indexes
- root vault structure on every turn

That keeps prompt size down and preserves the intended behavior:

- discover tools only when needed
- load workspace context only when needed
- let the user drive durable structure like workspaces, tasks, prompts, and workflows

## Testing

System prompt behavior is covered by:

- `tests/unit/SystemPromptBuilder.test.ts`

The tests verify:

- the lean prompt structure is present
- selected workspace data is included
- dynamic insertions are XML-escaped
- suggester-driven blocks are XML-escaped
