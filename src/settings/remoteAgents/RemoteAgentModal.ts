import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from 'obsidian';
import { isRemoteAgentReady, type RemoteAgentConnection, type RemoteAgentConnectorKind } from '../../services/remoteAgents/types';
import { RemoteAgentConnectionCheck, RemoteAgentEditSession } from './RemoteAgentEditSession';

export interface RemoteAgentModalOptions {
  save: (connection: RemoteAgentConnection) => Promise<void>;
  normalizeUrl: (url: string, connector: RemoteAgentConnectorKind) => string;
  check: (connection: RemoteAgentConnection) => Promise<RemoteAgentConnectionCheck>;
}

/** Standard settings editor for a remote agent; never runs a task to test a connection. */
export class RemoteAgentModal extends Modal {
  private readonly editor: RemoteAgentEditSession;
  private dirty = false;
  private version = 0;
  private timer: number | null = null;
  private opened = false;
  private closing = false;
  private status!: HTMLElement;
  private feedback!: HTMLElement;
  private urlSetting!: Setting;
  private urlInput!: TextComponent;

  constructor(app: App, connection: RemoteAgentConnection, options: RemoteAgentModalOptions) {
    super(app);
    this.editor = new RemoteAgentEditSession(connection, options.save, options.normalizeUrl, options.check);
  }

  onOpen(): void {
    this.opened = true;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('nexus-remote-agent-modal');
    contentEl.createEl('h1', { text: this.editor.draft.displayName ? `Configure ${this.editor.draft.displayName}` : 'Add remote agent' });
    contentEl.createEl('p', { cls: 'setting-item-description', text: 'This agent uses its own tools. Connecting it does not grant access to your vault.' });
    new Setting(contentEl).setName('Agent type').addDropdown(dropdown => {
      dropdown.addOption('hermes', 'Hermes').addOption('openclaw', 'OpenClaw').setValue(this.editor.draft.connector).onChange(value => {
        if (value !== 'hermes' && value !== 'openclaw') return;
        this.changed({ connector: value });
        this.updateUrlField();
        this.feedback.setText('Agent type changed. Check the address and test the connection again.');
      });
    });
    new Setting(contentEl).setName('Name').setDesc('How Nexus identifies this agent.').addText(text => {
      text.setPlaceholder('My agent').setValue(this.editor.draft.displayName).onChange(value => this.changed({ displayName: value }));
    });
    this.urlSetting = new Setting(contentEl).addText(text => {
      this.urlInput = text;
      text.inputEl.type = 'url';
      text.inputEl.addClass('nexus-remote-agent-url');
      text.setValue(this.editor.draft.baseUrl).onChange(value => {
        this.changed({ baseUrl: value });
        this.feedback.setText('Connection changed. Test the connection again.');
      });
    });
    this.updateUrlField();
    new Setting(contentEl).setName('API key').setDesc('Optional. Leave blank if your server does not require a key.').addText(text => {
      text.inputEl.type = 'password';
      text.inputEl.autocomplete = 'off';
      text.setPlaceholder('Enter API key').setValue(this.editor.draft.apiKey ?? '').onChange(value => {
        this.changed({ apiKey: value });
        this.feedback.setText('Credentials changed. Test the connection again.');
      });
    });
    new Setting(contentEl).setName('Description').setDesc('Optional. Help Nexus decide when to use this agent. Leave blank for general-purpose help.').addTextArea(text => {
      text.inputEl.addClass('nexus-remote-agent-description');
      text.setPlaceholder('General-purpose assistant').setValue(this.editor.draft.description ?? '').onChange(value => this.changed({ description: value }));
    });
    new Setting(contentEl).setName('Enabled').setDesc('Make this connection available to Nexus.').addToggle(toggle => {
      toggle.setValue(this.editor.draft.enabled).onChange(value => this.changed({ enabled: value }));
    });
    new Setting(contentEl).setDesc('Check this server’s connection.').addButton(button => {
      button.setButtonText('Test connection').setCta().onClick(async () => {
        button.setDisabled(true).setButtonText('Testing…');
        try {
          if (!await this.flush()) return;
          this.feedback.setText('Checking the server…');
          const result = await this.editor.testConnection();
          if (!result || !this.opened) return;
          this.feedback.setText(connectionCheckMessage(result));
        } catch (error) {
          if (this.opened) this.feedback.setText(error instanceof Error ? error.message : 'Could not connect. Check the server URL and API key.');
        } finally {
          button.setDisabled(false).setButtonText('Test connection');
        }
      });
    });
    this.feedback = contentEl.createDiv({ cls: 'setting-item-description nexus-remote-agent-feedback', text: 'Not tested yet.' });
    this.feedback.setAttribute('role', 'status');
    const footer = contentEl.createDiv('nexus-remote-agent-footer');
    this.status = footer.createDiv({ cls: 'save-status', text: 'Ready' });
    this.status.setAttribute('role', 'status');
    new ButtonComponent(footer).setButtonText('Close').setCta().onClick(() => this.close());
  }

  private updateUrlField(): void {
    const gateway = this.editor.draft.connector === 'openclaw';
    this.urlSetting.setName(gateway ? 'Gateway URL' : 'Server URL').setDesc(gateway
      ? 'Your gateway address. Use wss:// for a remote server or ws:// for localhost. HTTPS addresses also work.'
      : 'The API base address of your server, including /v1.');
    this.urlInput.setPlaceholder(gateway ? 'wss://openclaw.example.com' : 'https://hermes.example.com/v1');
  }

  close(): void {
    if (this.closing) return;
    if (this.editor.validationError()) {
      super.close();
      return;
    }
    this.closing = true;
    void this.flush().then(saved => {
      this.closing = false;
      if (saved) super.close();
    });
  }

  onClose(): void {
    this.opened = false;
    this.clearTimer();
    if (this.dirty) {
      const error = this.editor.validationError();
      if (error) new Notice(`Remote agent changes not saved: ${error}`);
      else void this.editor.save().catch(() => new Notice('Failed to save remote agent settings.'));
    }
    this.editor.close();
    this.contentEl.empty();
  }

  private changed(patch: Partial<Omit<RemoteAgentConnection, 'id'>>): void {
    this.editor.update(patch);
    this.dirty = true;
    this.version++;
    this.clearTimer();
    this.status.setText('Unsaved changes');
    this.timer = window.setTimeout(() => { this.timer = null; void this.flush(); }, 400);
  }

  private clearTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private async flush(): Promise<boolean> {
    this.clearTimer();
    if (!this.dirty) return true;
    const error = this.editor.validationError();
    if (error) {
      this.status.setText(error);
      return false;
    }
    const version = this.version;
    this.status.setText('Saving…');
    try {
      await this.editor.save();
      if (version !== this.version) return this.flush();
      this.dirty = false;
      if (this.opened) this.status.setText('Saved');
      return true;
    } catch {
      if (this.opened) this.status.setText('Save failed. Change a field or close to retry.');
      return false;
    }
  }
}

export function connectionCheckMessage(result: RemoteAgentConnectionCheck): string {
  if (!result.connected) return result.error || 'Could not connect. Check the server URL and API key.';
  if (!isRemoteAgentReady(result)) {
    return result.error || 'Server reached, but resumable remote tasks are unavailable. Check the server setup.';
  }
  return 'Connection ready. This server supports remote tasks.';
}

export function connectionAvailabilityLabel(enabled: boolean, health?: RemoteAgentConnectionCheck, checking = false): string {
  if (!enabled) return 'Disabled';
  if (checking) return 'Checking connection…';
  if (!health) return 'Not checked';
  if (!health.connected) return 'Connection unavailable';
  if (!isRemoteAgentReady(health)) return 'Remote tasks unavailable';
  return 'Available';
}
