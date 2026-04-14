export interface ManagedGuideDefinition {
  path: string;
  content: string;
}

export const MANAGED_GUIDES_VERSION = '1';

export const MANAGED_GUIDES_MANIFEST_PATH = '_meta/manifest.json';

export const MANAGED_GUIDES: ManagedGuideDefinition[] = [
  {
    path: 'index.md',
    content: `# Assistant guides

This folder contains built-in guidance for how the assistant works inside this vault.

## Start here

- Read this file first when you need guidance about built-in capabilities or workflows.
- Load deeper guide files selectively instead of reading the whole folder.
- Treat \`../data/\` as storage, not documentation.

## Guide map

- [Capabilities](capabilities.md): what the assistant can help with and how to approach requests
- [Workspaces](workspaces.md): how workspace context is meant to be used
- [Troubleshooting](troubleshooting.md): common failure modes and what to verify
`
  },
  {
    path: 'capabilities.md',
    content: `# Capabilities

The assistant can help with:

- code changes and debugging
- Obsidian vault operations through the plugin tool layer
- workspace, state, and task context when those systems are enabled
- prompt-driven workflows and structured note operations

## Preferred behavior

- gather context before editing
- use narrow, relevant tools instead of broad dumps
- preserve user content unless a request explicitly changes it
- explain constraints and tradeoffs when a request touches system behavior
`
  },
  {
    path: 'workspaces.md',
    content: `# Workspaces

Workspaces provide focused context for ongoing work.

## Guidance

- use a selected workspace as the primary context for related work
- prefer loading a workspace before creating a new one when a relevant workspace already exists
- keep workspace context focused on purpose, key files, and operating preferences
- do not confuse the guides workspace with a user project workspace
`
  },
  {
    path: 'troubleshooting.md',
    content: `# Troubleshooting

When behavior looks wrong:

- verify the selected workspace and prompt
- confirm the relevant files or vault paths are actually present
- distinguish local cache issues from synced source-of-truth issues
- prefer reading a narrow set of files before making assumptions

## Storage note

- guides live under \`guides/\`
- synced assistant data lives under \`data/\`
- local-only cache artifacts should not be treated as the synced source of truth
`
  }
];
