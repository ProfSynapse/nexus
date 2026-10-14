/**
 * Get started → Connect an external agent.
 *
 * Desktop only, and reached only through `await import()` behind the MCP bridge
 * check, so the Node-backed helpers it uses never load on mobile. Layout:
 * Node.js first, then one card of apps (Claude Desktop, Codex, Antigravity and
 * the expandable "Other agents" steps), then the command line.
 */
import { App, Component, Notice, Platform, Setting, setIcon } from 'obsidian';
import type { SettingsRouter } from '../SettingsRouter';
import { createSettingGroup } from '../../components/shared/settings/settingGroup';
import { getPrimaryServerKey } from '../../constants/branding';
import { desktopRequire } from '../../utils/desktopRequire';
import { NodeRuntime, resolveNodeRuntime } from '../../utils/nodeRuntime';
import {
  buildMcpConfigJson,
  buildMcpServerEntry,
  ensureConnectorFile,
  getConnectorPath,
  isConnectorCurrent,
  writeCodexServer,
  writeMcpJsonServer
} from '../../utils/mcpClientConfigs';
import { ExternalClientStatus, getExternalClientStatuses } from '../getStartedStatus';
import { CliInstallStatus, CliInstallTargets, CliPathFix, CliProviderId, LocalCliInstaller } from '../../services/cli/LocalCliInstaller';
import {
  AGENTS_PAGE,
  BACK_TO_GET_STARTED,
  CLAUDE_DESKTOP_DOWNLOAD_URL,
  MCP_SETUP_GUIDE_URL,
  NODE_DOWNLOAD_URL,
  buildAgentSetupPrompt
} from './copy';
import { addStatus, makeRowActivatable, renderPageHead, setIconName, setStepName } from './pageParts';

export interface ExternalAgentsPageContext {
  app: App;
  router: SettingsRouter;
  component: Component;
  /** Absolute path of this plugin's folder; connector.js lives there. */
  pluginPath: string;
}

interface ElectronShell {
  openPath(path: string): Promise<string> | string;
  showItemInFolder(path: string): void;
}

const CLI_TARGETS: Array<{ id: CliProviderId; label: string; path: string }> = [
  { id: 'claudeCode', label: 'Claude Code skills', path: '~/.claude/skills' },
  { id: 'cursor', label: 'Cursor skills', path: '~/.cursor/skills' },
  { id: 'codex', label: 'Codex AGENTS.md', path: '~/.codex/AGENTS.md' }
];

const OTHER_STEPS_ID = 'nexus-other-agents-steps';

export class ExternalAgentsPage {
  private node: NodeRuntime | null;
  private otherOpen = false;
  private cliTargets: Partial<CliInstallTargets> | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly context: ExternalAgentsPageContext,
    /** Injected for tests; defaults to the real lookup. */
    private readonly findNode: () => NodeRuntime | null = resolveNodeRuntime
  ) {
    this.node = this.findNode();
    this.render();
  }

  render(): void {
    const { container, context } = this;
    container.empty();

    renderPageHead(container, {
      backLabel: BACK_TO_GET_STARTED,
      onBack: () => context.router.back(),
      title: AGENTS_PAGE.title
    }, context.component);
    container.createEl('p', { cls: 'nexus-page-lede', text: AGENTS_PAGE.lede });

    this.renderNodeGroup();
    this.renderAppsGroup();
    this.renderCommandLineGroup();
  }

  // ---- Node.js ----

  private renderNodeGroup(): void {
    const { itemsEl } = createSettingGroup(this.container);
    const row = new Setting(itemsEl).setName(AGENTS_PAGE.nodeName);
    const node = this.node;

    if (node) {
      const text = AGENTS_PAGE.nodeFound(node.version, node.path);
      const at = text.lastIndexOf(node.path);
      row.descEl.empty();
      row.descEl.appendText(text.slice(0, at));
      row.descEl.createEl('code', { text: node.path });
      row.descEl.appendText(text.slice(at + node.path.length));
      if (node.manager === 'nvm') {
        row.descEl.createDiv({ cls: 'nexus-node-warning', text: AGENTS_PAGE.nodeNvmWarning });
      }
      addStatus(row, AGENTS_PAGE.nodeFoundStatus, true);
      return;
    }

    row.setClass('nexus-node-missing');
    row.setDesc(AGENTS_PAGE.nodeMissing);
    row.addButton(button => button
      .setButtonText(AGENTS_PAGE.installNode)
      .setCta()
      .onClick(() => { window.open(NODE_DOWNLOAD_URL, '_blank'); }));
    row.addButton(button => button
      .setButtonText(AGENTS_PAGE.checkAgain)
      .onClick(() => {
        this.node = this.findNode();
        this.render();
      }));
  }

  // ---- Apps ----

  private renderAppsGroup(): void {
    const { itemsEl } = createSettingGroup(this.container, 'nexus-gs-apps');
    for (const client of getExternalClientStatuses(this.context.app)) {
      this.renderClientRow(itemsEl, client);
    }
    this.renderOtherAgents(itemsEl);
  }

  private renderClientRow(itemsEl: HTMLElement, client: ExternalClientStatus): void {
    const row = new Setting(itemsEl).setName(client.label);
    const { state, stale } = client.status;
    const configured = state === 'nexus-configured';

    if (!this.node) {
      addStatus(row, AGENTS_PAGE.needsNode);
      if (!configured) {
        row.addButton(button => button.setButtonText(AGENTS_PAGE.connect).setCta().setDisabled(true));
      }
      return;
    }

    if (configured && !stale) {
      addStatus(row, AGENTS_PAGE.connected, true);
      row.addButton(button => button
        .setButtonText(AGENTS_PAGE.openConfig)
        .onClick(() => this.openPath(client.statusPath)));
      return;
    }

    // No Claude folder means the app is not installed (or never opened). Writing
    // a config there would report a connection to an app that does not exist.
    if (client.id === 'claude-desktop' && state === 'no-config-dir') {
      addStatus(row, AGENTS_PAGE.notFound);
      row.addButton(button => button
        .setButtonText(AGENTS_PAGE.download)
        .onClick(() => { window.open(CLAUDE_DESKTOP_DOWNLOAD_URL, '_blank'); }));
      row.addButton(button => button
        .setButtonText(AGENTS_PAGE.checkAgain)
        .onClick(() => this.render()));
      return;
    }

    if (configured) {
      addStatus(row, AGENTS_PAGE.reconnect);
    } else if (state === 'invalid-config') {
      addStatus(row, AGENTS_PAGE.invalidConfig);
      row.addButton(button => button
        .setButtonText(AGENTS_PAGE.openConfig)
        .onClick(() => this.openPath(client.statusPath)));
    } else {
      addStatus(row, AGENTS_PAGE.ready);
    }
    row.addButton(button => button
      .setButtonText(AGENTS_PAGE.connect)
      .setCta()
      .onClick(() => this.connect(client)));
  }

  private connect(client: ExternalClientStatus): void {
    const node = this.node;
    if (!node) return;

    try {
      const connectorPath = ensureConnectorFile(this.context.pluginPath);
      const entry = buildMcpServerEntry(node.path, connectorPath);
      const serverKey = this.serverKey();
      const result = client.id === 'codex'
        ? writeCodexServer(serverKey, entry)
        : writeMcpJsonServer(client.configPath, serverKey, entry);
      const backup = result.replacedInvalid ? ' The old file was not valid JSON and was saved with a .bak extension.' : '';
      new Notice(`Nexus added to ${client.label}. Restart it to load Nexus.${backup}`);
    } catch (error) {
      console.error(`[ExternalAgentsPage] Could not connect ${client.label}:`, error);
      new Notice(`Could not connect ${client.label}: ${(error as Error).message}`);
    }
    this.render();
  }

  private renderOtherAgents(itemsEl: HTMLElement): void {
    const row = new Setting(itemsEl)
      .setName(AGENTS_PAGE.otherName)
      .setDesc(AGENTS_PAGE.otherDesc)
      .setClass('nexus-other-row');
    // The whole row is the one control. The chevron is decoration, not a second
    // tab stop, and the steps open in place so focus stays on the row.
    const chevron = row.controlEl.createDiv({ cls: 'setting-item-chevron', attr: { 'aria-hidden': 'true' } });
    const steps = itemsEl.createDiv({ cls: 'nexus-other-steps', attr: { id: OTHER_STEPS_ID } });
    row.settingEl.setAttribute('aria-controls', OTHER_STEPS_ID);
    const sync = (): void => {
      const open = this.otherOpen;
      setIcon(chevron, open ? 'chevron-up' : 'chevron-down');
      row.settingEl.setAttribute('aria-expanded', String(open));
      steps.hidden = !open;
    };
    sync();
    makeRowActivatable(row.settingEl, () => {
      this.otherOpen = !this.otherOpen;
      sync();
    }, this.context.component);

    const node = this.node;
    const connectorPath = this.connectorPath();
    const ready = Boolean(node && connectorPath);

    const create = new Setting(steps).setDesc(AGENTS_PAGE.step1Desc);
    setStepName(create, 1, AGENTS_PAGE.step1Name);
    if (isConnectorCurrent(this.context.pluginPath)) {
      addStatus(create, AGENTS_PAGE.created, true);
    } else {
      create.addButton(button => button
        .setButtonText(AGENTS_PAGE.create)
        .setCta()
        .setDisabled(!ready)
        .onClick(() => this.createConnector()));
    }

    const config = ready && node && connectorPath ? buildMcpConfigJson(this.serverKey(), node.path, connectorPath) : '';
    const copyConfig = new Setting(steps).setDesc(AGENTS_PAGE.step2Desc);
    setStepName(copyConfig, 2, AGENTS_PAGE.step2Name);
    copyConfig.descEl.createEl('pre', { cls: 'nexus-code', text: config || AGENTS_PAGE.step2NeedsNode });
    copyConfig.addButton(button => button
      .setButtonText(AGENTS_PAGE.copyConfig)
      .setDisabled(!config)
      .onClick(() => this.copy(config, 'Config copied.')));

    const prompt = ready && node && connectorPath ? buildAgentSetupPrompt(this.serverKey(), node.path, connectorPath) : '';
    const copyPrompt = new Setting(steps).setDesc(AGENTS_PAGE.step3Desc);
    setStepName(copyPrompt, 3, AGENTS_PAGE.step3Name);
    copyPrompt.descEl.createEl('pre', { cls: 'nexus-code nexus-prompt', text: prompt || AGENTS_PAGE.step3NeedsNode });
    copyPrompt.addButton(button => button
      .setButtonText(AGENTS_PAGE.copyPrompt)
      .setDisabled(!prompt)
      .onClick(() => this.copy(prompt, 'Prompt copied.')));

    const restart = new Setting(steps).setDesc(AGENTS_PAGE.step4Desc);
    setStepName(restart, 4, AGENTS_PAGE.step4Name);

    const guide = steps.createEl('p', { cls: 'nexus-other-guide' });
    guide.appendText(AGENTS_PAGE.guideLead);
    const link = guide.createEl('a', { text: AGENTS_PAGE.guideLink, href: MCP_SETUP_GUIDE_URL });
    this.context.component.registerDomEvent(link, 'click', (event: MouseEvent) => {
      event.preventDefault();
      window.open(MCP_SETUP_GUIDE_URL, '_blank');
    });
    guide.appendText(AGENTS_PAGE.guideTail);
  }

  private createConnector(): void {
    try {
      const connectorPath = ensureConnectorFile(this.context.pluginPath);
      new Notice(`Connector file created: ${connectorPath}`);
    } catch (error) {
      console.error('[ExternalAgentsPage] Could not create the connector file:', error);
      new Notice(`Could not create the connector file: ${(error as Error).message}`);
    }
    this.render();
  }

  // ---- Command line ----

  private renderCommandLineGroup(): void {
    const { itemsEl } = createSettingGroup(this.container, 'nexus-gs-cli');
    const row = new Setting(itemsEl).setDesc(AGENTS_PAGE.cliDesc);
    setIconName(row, 'terminal', AGENTS_PAGE.cliName);

    const installer = new LocalCliInstaller();
    if (!installer.isSupported()) {
      addStatus(row, AGENTS_PAGE.cliUnavailable);
      return;
    }

    let status: CliInstallStatus;
    try {
      // Keep an already-installed copy in sync with this plugin build.
      installer.reconcile();
      status = installer.status();
    } catch (error) {
      console.error('[ExternalAgentsPage] Could not read the command line status:', error);
      addStatus(row, AGENTS_PAGE.cliUnavailable);
      return;
    }

    addStatus(row, cliStatusText(status), status.installed && status.runtimeReady && status.onPath);

    if (!status.installed) {
      row.addButton(button => button
        .setButtonText(AGENTS_PAGE.install)
        .onClick(() => this.installCli(installer)));
    } else {
      if (Platform.isWin && !status.pathConfigured) {
        row.addButton(button => button
          .setButtonText(AGENTS_PAGE.addToPath)
          .setCta()
          .onClick(() => this.addCliToPath(installer)));
      }
      row.addExtraButton(button => button
        .setIcon('folder-open')
        .setTooltip(revealLabel())
        .onClick(() => this.reveal(status.paths.cliJsPath)));
      row.addButton(button => button
        .setButtonText(AGENTS_PAGE.uninstall)
        .onClick(() => this.uninstallCli(installer)));
    }

    // Before install the toggles pick targets; after install each one wires or unwires at once.
    const targets = this.cliTargets ?? (this.cliTargets = { ...status.detected });
    for (const target of CLI_TARGETS) {
      const linked = target.id === 'claudeCode' ? status.skillLinked
        : target.id === 'cursor' ? status.cursorLinked
          : status.codexLinked;
      new Setting(itemsEl)
        .setName(target.label)
        .setDesc(target.path)
        .setClass('nexus-child-row')
        .setClass('nexus-path-row')
        .addToggle(toggle => toggle
          .setValue(status.installed ? linked : Boolean(targets[target.id]))
          .onChange(value => {
            if (status.installed) {
              this.setCliProvider(installer, target.id, target.label, value);
            } else {
              targets[target.id] = value;
            }
          }));
    }

    // Installed but the shell can't find it: hand over the exact edit.
    if (status.installed && status.runtimeReady && !status.onPath && status.pathFix) {
      this.renderCliPathFix(itemsEl, status.pathFix, installer);
    }
  }

  private renderCliPathFix(itemsEl: HTMLElement, fix: CliPathFix, installer: LocalCliInstaller): void {
    const row = new Setting(itemsEl)
      .setName('Shell setup')
      .setDesc(`The nexus command is installed, but your ${fix.shell} shell can’t find it yet. Add this line to ${fix.profilePath}, then run ${fix.reloadCommand} or open a new terminal.`)
      .setClass('nexus-child-row');
    row.descEl.createEl('pre', { cls: 'nexus-code', text: fix.exportLine });
    row.addButton(button => button
      .setButtonText('Copy')
      .onClick(() => this.copy(fix.exportLine, 'Copied. Paste it into your shell profile.')));
    row.addButton(button => button
      .setButtonText('Check again')
      .onClick(() => {
        new Notice(installer.status().onPath
          ? 'The nexus command works in your shell now.'
          : 'Still not found. Make sure the line was saved, then open a new terminal.');
        this.render();
      }));
  }

  private installCli(installer: LocalCliInstaller): void {
    try {
      const result = installer.enable(this.cliTargets ?? undefined);
      for (const warning of result.warnings) console.warn('[ExternalAgentsPage] Local CLI:', warning);
      const hint = Platform.isWin ? 'Open a new terminal, then run `nexus vaults`.' : 'Try running `nexus vaults` in your terminal.';
      new Notice(result.warnings.length
        ? 'Nexus CLI installed, but some requested wiring was preserved or unavailable. See the developer console for details.'
        : `Nexus CLI installed. ${hint}`);
    } catch (error) {
      console.error('[ExternalAgentsPage] Could not install the local CLI:', error);
      new Notice(`Could not install the command line tool: ${(error as Error).message}`);
    }
    this.cliTargets = null;
    this.render();
  }

  private addCliToPath(installer: LocalCliInstaller): void {
    try {
      const result = installer.addToWindowsUserPath();
      for (const warning of result.warnings) console.warn('[ExternalAgentsPage] Local CLI:', warning);
      new Notice(result.warnings.length
        ? 'Could not add the command line tool to PATH. See the developer console for details.'
        : 'Added to your user PATH. Open a new terminal to use it.');
    } catch (error) {
      console.error('[ExternalAgentsPage] Could not add the local CLI to PATH:', error);
      new Notice(`Could not add the command line tool to PATH: ${(error as Error).message}`);
    }
    this.render();
  }

  private setCliProvider(installer: LocalCliInstaller, id: CliProviderId, label: string, enabled: boolean): void {
    try {
      const result = installer.setProvider(id, enabled);
      for (const warning of result.warnings) console.warn('[ExternalAgentsPage] Local CLI:', warning);
      new Notice(result.warnings.length
        ? `Could not update ${label}. See the developer console for details.`
        : enabled ? `Turned on ${label}.` : `Turned off ${label}.`);
    } catch (error) {
      console.error('[ExternalAgentsPage] Could not update a CLI provider:', error);
      new Notice(`Could not update ${label}: ${(error as Error).message}`);
    }
    this.render();
  }

  private uninstallCli(installer: LocalCliInstaller): void {
    try {
      const result = installer.uninstall();
      for (const warning of result.warnings) console.warn('[ExternalAgentsPage] Local CLI:', warning);
      new Notice(result.warnings.length
        ? 'Command line cleanup was incomplete. See the developer console for details.'
        : 'Nexus CLI uninstalled.');
    } catch (error) {
      console.error('[ExternalAgentsPage] Could not uninstall the local CLI:', error);
      new Notice(`Could not uninstall the command line tool: ${(error as Error).message}`);
    }
    this.cliTargets = null;
    this.render();
  }

  // ---- helpers ----

  private serverKey(): string {
    return getPrimaryServerKey(this.context.app.vault.getName());
  }

  private connectorPath(): string | null {
    try {
      return getConnectorPath(this.context.pluginPath);
    } catch {
      return null;
    }
  }

  private copy(text: string, done: string): void {
    if (!text) return;
    void navigator.clipboard.writeText(text)
      .then(() => { new Notice(done); })
      .catch(() => { new Notice('Could not copy. Select the text and copy it yourself.'); });
  }

  private shell(): ElectronShell | null {
    try {
      return desktopRequire<{ shell: ElectronShell }>('electron').shell;
    } catch {
      return null;
    }
  }

  private openPath(path: string): void {
    const shell = this.shell();
    if (!shell) {
      new Notice('Could not open the config file. Open it yourself.');
      return;
    }
    void Promise.resolve(shell.openPath(path)).catch((error: unknown) => {
      console.error('[ExternalAgentsPage] Could not open the config file:', error);
      new Notice('Could not open the config file. Open it yourself.');
    });
  }

  private reveal(path: string): void {
    const shell = this.shell();
    if (!shell) {
      new Notice('Could not show the file. Find it yourself.');
      return;
    }
    shell.showItemInFolder(path);
  }
}

function cliStatusText(status: CliInstallStatus): string {
  if (!status.installed) return AGENTS_PAGE.cliNotInstalled;
  if (!status.runtimeReady) return AGENTS_PAGE.needsNode;
  if (!status.onPath) return AGENTS_PAGE.cliNotOnPath;
  return AGENTS_PAGE.cliInstalled;
}

function revealLabel(): string {
  if (Platform.isWin) return 'Show in Explorer';
  if (Platform.isMacOS) return 'Show in Finder';
  return 'Show in file manager';
}
