import {
  appendCodexMcpTomlSnippet,
  buildCodexMcpTomlSnippet,
  hasCodexMcpServerConfig,
  readCodexMcpServerConfig,
  replaceCodexMcpServerConfig
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

  // Reconnect after an nvm switch: the saved command must be readable (to show
  // "Reconnect") and replaceable without duplicating the table or touching others.
  it('reads back the command and args it wrote, including Windows paths', () => {
    const snippet = buildCodexMcpTomlSnippet('nexus test', 'C:\\Program Files\\nodejs\\node.exe', ['C:\\Vault "A"\\connector.js']);
    const content = `model = "o4"\n\n${snippet}\n\n[mcp_servers.other]\ncommand = "python"\nargs = []\n`;
    expect(readCodexMcpServerConfig(content, 'nexus test')).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Vault "A"\\connector.js']
    });
    expect(readCodexMcpServerConfig(content, 'nexus-missing')).toBeNull();
  });

  it('replaces only the Nexus table and keeps every other setting', () => {
    const old = buildCodexMcpTomlSnippet('nexus-vault', '/old/node', ['/vault/connector.js']);
    const content = `model = "o4"\n\n${old}\nenv = { A = "1" }\n\n[mcp_servers.other]\ncommand = "python"\n`;
    const fresh = buildCodexMcpTomlSnippet('nexus-vault', '/new/node', ['/vault/connector.js']);
    const updated = replaceCodexMcpServerConfig(content, 'nexus-vault', fresh);

    expect(updated.match(/\[mcp_servers\.nexus-vault\]/g)).toHaveLength(1);
    expect(readCodexMcpServerConfig(updated, 'nexus-vault')?.command).toBe('/new/node');
    expect(updated).not.toContain('/old/node');
    expect(updated).toContain('model = "o4"');
    expect(updated).toContain('[mcp_servers.other]\ncommand = "python"');
  });

  it('appends when there is no Nexus table to replace', () => {
    const fresh = buildCodexMcpTomlSnippet('nexus-vault', '/new/node', []);
    expect(replaceCodexMcpServerConfig('model = "o4"\n', 'nexus-vault', fresh)).toBe(`model = "o4"\n\n${fresh}\n`);
  });
});
