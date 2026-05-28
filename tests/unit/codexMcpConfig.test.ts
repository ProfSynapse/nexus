import {
  appendCodexMcpTomlSnippet,
  buildCodexMcpTomlSnippet,
  hasCodexMcpServerConfig
} from '../../src/utils/codexMcpConfig';

describe('codexMcpConfig', () => {
  it('builds a Codex MCP server TOML snippet', () => {
    expect(buildCodexMcpTomlSnippet(
      'nexus-test-vault',
      '/opt/homebrew/bin/node',
      ['/Users/test/Vault/.obsidian/plugins/nexus/connector.js']
    )).toBe([
      '[mcp_servers.nexus-test-vault]',
      'command = "/opt/homebrew/bin/node"',
      'args = ["/Users/test/Vault/.obsidian/plugins/nexus/connector.js"]'
    ].join('\n'));
  });

  it('quotes server keys that are not valid bare TOML keys', () => {
    expect(buildCodexMcpTomlSnippet(
      'nexus test',
      'C:\\Program Files\\nodejs\\node.exe',
      ['C:\\Vault "A"\\.obsidian\\plugins\\nexus\\connector.js']
    )).toBe([
      '[mcp_servers."nexus test"]',
      'command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
      'args = ["C:\\\\Vault \\"A\\"\\\\.obsidian\\\\plugins\\\\nexus\\\\connector.js"]'
    ].join('\n'));
  });

  it('detects existing bare and quoted Codex MCP server tables', () => {
    expect(hasCodexMcpServerConfig(
      '[mcp_servers.nexus-test-vault]\ncommand = "node"\n',
      'nexus-test-vault'
    )).toBe(true);

    expect(hasCodexMcpServerConfig(
      '[mcp_servers."nexus test"]\ncommand = "node"\n',
      'nexus test'
    )).toBe(true);
  });

  it('does not match tool sub-tables without the server table', () => {
    expect(hasCodexMcpServerConfig(
      '[mcp_servers.nexus-test-vault.tools.toolManager_getTools]\napproval_mode = "approve"\n',
      'nexus-test-vault'
    )).toBe(false);
  });

  it('appends a Codex MCP snippet without overwriting existing config', () => {
    expect(appendCodexMcpTomlSnippet(
      'model = "gpt-5.5"\n',
      '[mcp_servers.nexus]\ncommand = "node"\nargs = ["connector.js"]'
    )).toBe('model = "gpt-5.5"\n\n[mcp_servers.nexus]\ncommand = "node"\nargs = ["connector.js"]\n');
  });

  it('creates a snippet-only config for an empty file', () => {
    expect(appendCodexMcpTomlSnippet(
      '',
      '[mcp_servers.nexus]\ncommand = "node"\nargs = ["connector.js"]'
    )).toBe('[mcp_servers.nexus]\ncommand = "node"\nargs = ["connector.js"]\n');
  });
});
