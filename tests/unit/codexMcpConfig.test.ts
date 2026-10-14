import {
  appendCodexMcpTomlSnippet,
  buildCodexMcpTomlSnippet,
  hasCodexMcpServerConfig,
  readCodexMcpServerConfig,
  upsertCodexMcpServerConfig
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

  it('updates only command and args, keeping the table\'s other keys and every other table', () => {
    const old = buildCodexMcpTomlSnippet('nexus-vault', '/old/node', ['/vault/connector.js']);
    const content = `model = "o4"\n\n${old}\nenv = { NODE_OPTIONS = "--max-old-space-size=4096" }\nstartup_timeout_sec = 60\n# the next table is mine\n\n[mcp_servers.other]\ncommand = "python"\n`;
    const updated = upsertCodexMcpServerConfig(content, 'nexus-vault', '/new/node', ['/vault/connector.js']);

    expect(updated.match(/\[mcp_servers\.nexus-vault\]/g)).toHaveLength(1);
    expect(readCodexMcpServerConfig(updated, 'nexus-vault')).toEqual({ command: '/new/node', args: ['/vault/connector.js'] });
    expect(updated).not.toContain('/old/node');
    expect(updated).toBe(content.replace('/old/node', '/new/node'));
  });

  it('replaces a multi-line args array and keeps trailing comments', () => {
    const content = [
      '[mcp_servers.nexus-vault]',
      'command = "/old/node" # pinned',
      'args = [',
      '  "/old/connector.js", # was here',
      '  "--flag]"',
      ']',
      'enabled = true',
      ''
    ].join('\n');
    const updated = upsertCodexMcpServerConfig(content, 'nexus-vault', '/new/node', ['/new/connector.js']);
    expect(updated).toBe([
      '[mcp_servers.nexus-vault]',
      'command = "/new/node" # pinned',
      'args = ["/new/connector.js"]',
      'enabled = true',
      ''
    ].join('\n'));
  });

  it('adds command and args to a table that lacks them', () => {
    const content = '[mcp_servers.nexus-vault]\nenabled = true\n';
    const updated = upsertCodexMcpServerConfig(content, 'nexus-vault', '/new/node', ['/c.js']);
    expect(updated).toBe('[mcp_servers.nexus-vault]\ncommand = "/new/node"\nargs = ["/c.js"]\nenabled = true\n');
  });

  it('appends when there is no Nexus table to update', () => {
    const fresh = buildCodexMcpTomlSnippet('nexus-vault', '/new/node', []);
    expect(upsertCodexMcpServerConfig('model = "o4"\n', 'nexus-vault', '/new/node', [])).toBe(`model = "o4"\n\n${fresh}\n`);
  });
});
