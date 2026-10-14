/**
 * User-facing copy for the Get started row and its pages, lifted from the
 * blessed mockup (docs/mockups/defaults-settings-essentials.*). Tests import
 * these constants instead of repeating the strings.
 */

export const GET_STARTED_ROW = {
  name: 'Get started',
  desc: 'Set up chat in Obsidian, or connect Claude Desktop, Codex and other agents.'
} as const;

export const BACK_TO_SETTINGS = 'Settings';
export const BACK_TO_GET_STARTED = 'Get started';

export const GET_STARTED_PAGE = {
  title: 'Get started',
  lede: 'Nexus is an assistant that lives in your vault. It reads and writes your notes, searches them, and remembers context between conversations. Your data stays in your vault.',
  capabilities: [
    { icon: 'pencil-line', text: 'Read, create and edit notes' },
    { icon: 'search', text: 'Search by keyword or by meaning' },
    { icon: 'layers', text: 'Remember context with workspaces' },
    { icon: 'folder', text: 'Organize files and folders' },
    { icon: 'bot', text: 'Run saved prompts and subagents' },
    { icon: 'wifi-off', text: 'Work offline with local models' }
  ],
  setupHeading: 'Choose your setup',
  setupDesc: 'Pick one, or use both.',
  chatName: 'Chat inside Obsidian',
  chatDesc: 'Connect a model provider and chat in a side panel.',
  chatReady: 'Ready',
  chatNotSetUp: 'Not set up',
  agentsName: 'Connect an external agent',
  agentsDesc: 'Claude Desktop, Codex, Cursor and more use your vault.',
  connectedCount: (count: number): string => `${count} connected`
} as const;

export const CHAT_PAGE = {
  title: 'Chat inside Obsidian',
  providerName: 'Connect a model provider',
  providerDesc: 'An API key, a sign-in, or a local model such as Ollama.',
  connected: 'Connected',
  openProviders: 'Open providers',
  openChatName: 'Open the chat',
  openChatDesc: 'From the ribbon icon or the “Nexus: Open chat” command.',
  openChat: 'Open chat',
  startName: 'Start chatting',
  startDesc: 'Ask about your notes. Nexus can read, search and edit them.'
} as const;

export const AGENTS_PAGE = {
  title: 'Connect an external agent',
  lede: 'Let apps outside Obsidian use your vault through Nexus.',
  nodeName: 'Node.js',
  nodeFound: (version: string, path: string): string =>
    version ? `Runs the connector. Found ${version} at ${path}.` : `Runs the connector. Found at ${path}.`,
  nodeFoundStatus: 'Found',
  nodeNvmWarning: 'This path changes when you switch Node versions with nvm. Reconnect your apps after switching, or install Node.js from nodejs.org for a stable path.',
  nodeMissing: 'Every agent connection runs through Node.js, and it isn’t installed or Nexus can’t find it. Install it, then check again.',
  installNode: 'Install Node.js',
  checkAgain: 'Check again',
  needsNode: 'Needs Node.js',
  connected: 'Connected',
  ready: 'Ready',
  notFound: 'Not found',
  download: 'Download',
  invalidConfig: 'Invalid config',
  reconnect: 'Reconnect',
  connect: 'Connect',
  openConfig: 'Open config',
  otherName: 'Other agents',
  otherDesc: 'Cursor, Cline, Copilot, Windsurf and others. Four steps.',
  step1Name: 'Create the connector file',
  step1Desc: 'connector.js lets the app talk to this vault. It goes in the Nexus plugin folder.',
  create: 'Create',
  created: 'Created',
  step2Name: 'Copy the config',
  step2Desc: 'The Nexus entry for the app’s MCP settings, with this computer’s paths.',
  copyConfig: 'Copy config',
  step2NeedsNode: 'Install Node.js first. The config needs its location.',
  step3Name: 'Add it to your app',
  step3Desc: 'Paste it into the app’s MCP settings yourself, or paste this prompt into the agent and let it make the change.',
  copyPrompt: 'Copy prompt',
  step3NeedsNode: 'Install Node.js first.',
  step4Name: 'Restart the app',
  step4Desc: 'Quit and reopen it so it loads Nexus. Then ask it to list your vault’s folders to check.',
  guideLead: 'Exact config locations for each app are in the ',
  guideLink: 'MCP setup guide',
  guideTail: '.',
  cliName: 'Command line',
  cliDesc: 'Lets Claude Code, Cursor and Codex use Nexus without MCP.',
  cliInstalled: 'Installed',
  cliNotInstalled: 'Not installed',
  cliNotOnPath: 'Not on your PATH',
  cliUnavailable: 'Not available',
  install: 'Install',
  uninstall: 'Uninstall',
  addToPath: 'Add to path'
} as const;

/** Claude Desktop's download page, offered when the app is not found. */
export const CLAUDE_DESKTOP_DOWNLOAD_URL = 'https://claude.ai/download';

/** Install page for Node.js, opened by the "Install Node.js" button. */
export const NODE_DOWNLOAD_URL = 'https://nodejs.org/';

/** The MCP setup guide, linked under the Other agents steps. */
export const MCP_SETUP_GUIDE_URL = 'https://github.com/ProfSynapse/nexus/blob/main/guide/mcp-setup.md';

/** The prompt an agent can follow to add the Nexus server to its own config. */
export function buildAgentSetupPrompt(serverKey: string, nodePath: string, connectorPath: string): string {
  // The connector path sits inside a JSON array, so it is JSON-escaped; this
  // keeps Windows backslashes intact when the agent copies it.
  return `Add an MCP server to your configuration. Name: ${serverKey}. Command: ${nodePath}. Args: [${JSON.stringify(connectorPath)}]. Use these paths exactly. Merge it into the existing mcpServers and keep any servers already there. Then tell me where you saved it.`;
}
