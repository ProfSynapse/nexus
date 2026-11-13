import { App, ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import type {
  AnthropicCompatibleAuthMode,
  AntigravityCompatibleAuthMode,
  AntigravityCompatibleWireProtocol,
  LLMProviderConfig,
  ResponsesCompatibleAuthMode,
  ResponsesCompatibleStateMode,
} from '../../types/llm/ProviderTypes';
import { generateUUID } from '../../utils/uuid';
import type { OpenAICompatibleContextCheckResult } from '../../services/llm/adapters/openai-compatible/OpenAICompatibleContextCheck';
import {
  describeThinkingCapability,
  type CompatibleThinkingProbeResult,
} from '../../services/llm/adapters/shared/CompatibleThinkingProbe';
import { CustomCompatibleEndpointConfig, CustomCompatibleEditSession, CustomCompatibleKind, copyCustomEndpoint, isCustomEndpoint } from './CustomCompatibleEditSession';

interface ContextNote {
  text: string;
  warning: boolean;
  /** A size the server named or revealed, offered as a one-click replacement. */
  suggestion?: number;
}

const tokens = (value: number): string => value.toLocaleString();

export function describeContextCheck(result: OpenAICompatibleContextCheckResult): ContextNote {
  switch (result.kind) {
    case 'fits':
      return { text: `Checked: the server read ${tokens(result.promptTokens)} tokens without trouble.`, warning: false };
    case 'fits-unmeasured':
      return { text: 'The server accepted a prompt of this size, but it does not report token counts, so Nexus cannot confirm it read the whole prompt.', warning: false };
    case 'truncated':
      // No "Use" button: servers that shorten prompts may keep less than they
      // hold. Ollama keeps about half its context, so this count understates it.
      return {
        text: `The server read only ${tokens(result.promptTokens)} tokens of the prompt. It shortens long prompts instead of refusing them, so its context is smaller than this size. Servers such as Ollama keep less than their full context when they shorten a prompt, so enter the size your server runs the model with.`,
        warning: true,
      };
    case 'too-large':
      return result.serverLimit
        ? { text: `Too large: the server says its limit is ${tokens(result.serverLimit)} tokens.`, warning: true, suggestion: result.serverLimit }
        : { text: `Too large: the server refused a prompt of this size. It said: ${result.message}`, warning: true };
    case 'failed':
      return { text: `Check failed. ${result.message}`, warning: true };
  }
}

export function describeThinkingProbe(result: CompatibleThinkingProbeResult): ContextNote {
  switch (result.kind) {
    case 'supported':
      return result.efforts.length > 0
        ? { text: `Thinking tiers unlocked: ${result.efforts.join(', ')}.`, warning: false }
        : { text: 'Thinking is supported by this model.', warning: false };
    case 'unsupported':
      return { text: 'Thinking is not supported by this model.', warning: false };
    case 'failed':
      return { text: `Thinking probe failed. ${result.message}`, warning: true };
  }
}

export interface CustomCompatibleModalOptions {
  kind: CustomCompatibleKind;
  getProviders: () => Record<string, LLMProviderConfig>;
  remove?: (id: string) => Promise<void>;
  save: (id: string, config: CustomCompatibleEndpointConfig) => Promise<void>;
}

/** The provider card manages named connections; each editor uses ordinary Settings rows. */
export class CustomCompatibleModal extends Modal {
  private editor: CustomCompatibleEditSession | null = null;
  private body!: HTMLElement;
  private status!: HTMLElement;
  private models!: HTMLElement;
  private feedback!: HTMLElement;
  private saveTimer: number | null = null;
  private dirty = false;
  private opened = false;
  private saveVersion = 0;
  private saveQueue: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly checks = new Set<AbortController>();

  constructor(app: App, private readonly options: CustomCompatibleModalOptions) {
    super(app);
  }

  private get label(): string {
    switch (this.options.kind) {
      case 'responses-compatible':
        return 'Responses-compatible';
      case 'anthropic-compatible':
        return 'Anthropic-compatible';
      case 'antigravity-compatible':
        return 'Antigravity-compatible';
    }
  }

  private endpointOf(config: CustomCompatibleEndpointConfig) {
    switch (config.driverKind) {
      case 'responses-compatible':
        return config.responsesCompatible;
      case 'anthropic-compatible':
        return config.anthropicCompatible;
      case 'antigravity-compatible':
        return config.antigravityCompatible;
    }
  }

  private newEndpoint(): CustomCompatibleEndpointConfig {
    const endpoint = { schemaVersion: 1 as const, displayName: '', baseUrl: '', models: {} };
    switch (this.options.kind) {
      case 'responses-compatible':
        return { apiKey: '', enabled: false, driverKind: 'responses-compatible', models: {}, responsesCompatible: endpoint };
      case 'anthropic-compatible':
        return { apiKey: '', enabled: false, driverKind: 'anthropic-compatible', models: {}, anthropicCompatible: endpoint };
      case 'antigravity-compatible':
        return { apiKey: '', enabled: false, driverKind: 'antigravity-compatible', models: {}, antigravityCompatible: endpoint };
    }
  }

  private describeContextWindow(editor: CustomCompatibleEditSession, model: string): string {
    const { contextWindow, source } = editor.resolveContextWindow(model);
    if (source === 'server') return `Context window: ${tokens(contextWindow)} tokens, reported by your server.`;
    if (source === 'default') return `Context window: ${tokens(contextWindow)} tokens. Enter your model's real size if different.`;
    const reported = editor.endpoint.models[model]?.reportedContextWindow;
    return `Context window: ${tokens(contextWindow)} tokens, set by you.`
      + (reported && reported !== contextWindow ? ` Your server reports ${tokens(reported)}.` : '');
  }

  onOpen(): void {
    this.opened = true;
    this.contentEl.addClass('llm-provider-modal', 'nexus-compatible-modal');
    this.renderList();
  }

  onClose(): void {
    this.opened = false;
    this.clearSaveTimer();
    this.abortChecks();
    // Escape and the native X also flush the latest valid draft. The save queue
    // outlives the DOM; closing cannot drop a debounced change or resurrect a key.
    if (this.editor && this.dirty) {
      const error = this.editor.validationError();
      if (error) new Notice(`Endpoint changes not saved: ${error}`);
      else void this.editor.save().catch(() => new Notice('Failed to save endpoint settings. Reopen providers to retry.'));
    }
    this.editor?.close();
    this.contentEl.empty();
  }

  close(): void {
    if (this.closing) return;
    // Invalid drafts cannot replace the last valid settings. Native dismiss
    // still lets users abandon them; onClose explains that they were not saved.
    if (this.editor?.validationError()) {
      super.close();
      return;
    }
    this.closing = true;
    void this.flush().then(saved => {
      this.closing = false;
      if (saved) super.close();
    });
  }

  private shell(title: string): void {
    this.contentEl.empty();
    this.contentEl.createEl('h1', { text: title });
    this.body = this.contentEl.createDiv('provider-modal-content');
    const footer = this.contentEl.createDiv('modal-status-container llm-provider-status-container');
    this.status = footer.createDiv({ cls: 'save-status', text: 'Ready' });
    this.status.setAttribute('role', 'status');
    new ButtonComponent(footer).setButtonText('Close').setCta().onClick(() => this.close());
  }

  private renderList(): void {
    this.abortChecks();
    this.editor?.close();
    this.editor = null;
    this.dirty = false;
    this.shell(`Configure ${this.label}`);
    this.body.createEl('p', { cls: 'setting-item-description', text: 'Connect a local or hosted compatible endpoint to Nexus.' });
    new Setting(this.body).setName('Your endpoints').addButton(button => {
      button.setButtonText('Add endpoint').setCta().onClick(() => this.renderEditor(
        `${this.options.kind}-${generateUUID()}`,
        this.newEndpoint(),
      ));
    });
    const endpoints = Object.entries(this.options.getProviders()).filter(([, config]) => isCustomEndpoint(config, this.options.kind));
    if (!endpoints.length) this.body.createEl('p', { cls: 'setting-item-description', text: 'No endpoints configured. Add an endpoint to get started.' });
    for (const [id, config] of endpoints) {
      if (!isCustomEndpoint(config, this.options.kind)) continue;
      const card = this.body.createDiv('agent-management-card nexus-compatible-endpoint');
      const count = Object.keys(this.endpointOf(config).models).filter(model => config.models?.[model]?.enabled !== false).length;
      const setting = new Setting(card)
        .setName(this.endpointOf(config).displayName)
        .setDesc(`${count} ${count === 1 ? 'model' : 'models'} enabled`)
        .addToggle(toggle => toggle.setValue(config.enabled).onChange(async enabled => {
          toggle.setDisabled(true);
          const updated = copyCustomEndpoint(config);
          updated.enabled = enabled;
          try {
            await this.persist(id, updated);
            config.enabled = enabled;
          } catch {
            toggle.setValue(config.enabled);
            new Notice('Failed to save endpoint settings. Please try again.');
          } finally {
            toggle.setDisabled(false);
          }
        }))
        .addExtraButton(button => button.setIcon('edit').setTooltip(`Configure ${this.endpointOf(config).displayName}`).onClick(async () => {
          await this.saveQueue.catch(() => undefined);
          if (!this.opened) return;
          const latest = this.options.getProviders()[id];
          if (latest && isCustomEndpoint(latest, this.options.kind)) this.renderEditor(id, latest);
        }));
      if (this.options.remove) setting.addExtraButton(button => button.setIcon('trash').setTooltip(`Delete ${this.endpointOf(config).displayName}`).onClick(async () => {
        button.setDisabled(true);
        try {
          const pending = this.saveQueue.catch(() => undefined).then(() => this.options.remove!(id));
          this.saveQueue = pending;
          await pending;
          if (this.opened) this.renderList();
        } catch {
          new Notice('Failed to delete endpoint. Please try again.');
          button.setDisabled(false);
        }
      }));
      card.createDiv({ cls: 'setting-item-description nexus-compatible-address', text: this.endpointOf(config).baseUrl });
    }
  }

  private renderEditor(id: string, config: CustomCompatibleEndpointConfig): void {
    this.abortChecks();
    this.editor?.close();
    const editor = new CustomCompatibleEditSession(id, config, (endpointId, snapshot) => this.persist(endpointId, snapshot));
    this.editor = editor;
    this.dirty = false;
    this.shell(this.endpointOf(config).displayName ? `Configure ${this.endpointOf(config).displayName}` : 'Add endpoint');
    new ButtonComponent(this.body).setButtonText('All endpoints').onClick(() => {
      void this.flush().then(saved => { if (saved && this.opened) this.renderList(); });
    });
    new Setting(this.body).setName('Name').setDesc('Shown in the model picker.').addText(text => {
      text.setPlaceholder('My endpoint').setValue(editor.endpoint.displayName).onChange(value => {
        editor.setName(value);
        this.changed();
      });
    });
    new Setting(this.body).setName('API base URL').setDesc('Use the full base address, including any path such as /v1.').addText(text => {
      text.inputEl.type = 'url';
      text.inputEl.addClass('nexus-compatible-url-input');
      const baseUrlPlaceholder = this.options.kind === 'responses-compatible'
        ? 'https://api.example.com/v1'
        : this.options.kind === 'anthropic-compatible'
          ? 'https://api.example.com'
          : 'https://gateway.example.com/antigravity';
      text.setPlaceholder(baseUrlPlaceholder).setValue(editor.endpoint.baseUrl).onChange(value => {
        editor.setBaseUrl(value);
        this.feedback.setText('Connection changed. Connect to discover models.');
        this.renderModels();
        this.changed();
      });
    });
    new Setting(this.body).setName('API key').setDesc('Optional. Leave blank if your server does not require a key.').addText(text => {
      text.inputEl.type = 'password';
      text.inputEl.autocomplete = 'off';
      text.setPlaceholder('Enter API key').setValue(editor.draft.apiKey).onChange(value => {
        editor.setApiKey(value);
        this.feedback.setText('Connection changed. Connect to check your credentials.');
        this.changed();
      });
    });
    if (editor.draft.driverKind === 'responses-compatible') {
      const responsesEndpoint = editor.draft.responsesCompatible;
      new Setting(this.body).setName('Continuation mode').addDropdown(dropdown => dropdown
        .addOption('stateless', 'Stateless (full input replay)')
        .addOption('stateful', 'Stateful (previous response ID)')
        .setValue(responsesEndpoint.stateMode ?? 'stateless')
        .onChange(value => { editor.setResponsesStateMode(value as ResponsesCompatibleStateMode); this.changed(); }));
    }
    if (editor.draft.driverKind === 'antigravity-compatible') {
      new Setting(this.body).setName('Protocol mode').addDropdown(dropdown => dropdown
        .addOption('auto', 'Auto (Gemini v1beta + Claude messages)')
        .addOption('v1beta', 'Gemini v1beta only')
        .addOption('messages', 'Anthropic messages only')
        .setValue(editor.draft.driverKind === 'antigravity-compatible' ? editor.draft.antigravityCompatible.wireProtocol ?? 'auto' : 'auto')
        .onChange(value => { editor.setAntigravityWireProtocol(value as AntigravityCompatibleWireProtocol); this.changed(); }));
    }
    new Setting(this.body).setName('Auth header').addDropdown(dropdown => {
      if (editor.draft.driverKind === 'responses-compatible') {
        dropdown.addOption('bearer', 'Authorization: Bearer').addOption('x-api-key', 'API key header').addOption('both', 'Both headers')
          .setValue(editor.draft.responsesCompatible.authMode ?? 'bearer')
          .onChange(value => { editor.setResponsesAuthMode(value as ResponsesCompatibleAuthMode); this.changed(); });
      } else if (editor.draft.driverKind === 'anthropic-compatible') {
        dropdown.addOption('x-api-key', 'API key header').addOption('bearer', 'Authorization: Bearer').addOption('both', 'Both headers')
          .setValue(editor.draft.anthropicCompatible.authMode ?? 'x-api-key')
          .onChange(value => { editor.setAnthropicAuthMode(value as AnthropicCompatibleAuthMode); this.changed(); });
      } else {
        dropdown.addOption('both', 'Both headers').addOption('bearer', 'Authorization: Bearer').addOption('header-key', 'API key header')
          .setValue(editor.draft.antigravityCompatible.authMode ?? 'both')
          .onChange(value => { editor.setAntigravityAuthMode(value as AntigravityCompatibleAuthMode); this.changed(); });
      }
    });
    new Setting(this.body).setDesc('Discover the models your server offers.').addButton(button => {
      button.setButtonText('Connect').setCta().onClick(async () => {
        this.clearSaveTimer();
        this.dirty = true;
        this.saveVersion++;
        const version = this.saveVersion;
        button.setDisabled(true).setButtonText('Connecting…');
        this.feedback.setText('Connecting…');
        try {
          const result = await editor.connect();
          if (!this.opened || this.editor !== editor || result === 'stale') return;
          if (version === this.saveVersion) this.dirty = false;
          this.feedback.setText(result === 'empty' ? 'No models returned. Add a model ID below.' : 'Model list received. Choose the models to show in your model picker.');
          if (version === this.saveVersion) this.status.setText('Saved');
          this.renderModels();
        } catch (error) {
          if (this.opened && this.editor === editor) {
            this.feedback.setText(error instanceof Error ? error.message : 'Model discovery failed. Check the address and API key, or add a model manually.');
          }
        } finally {
          button.setDisabled(false).setButtonText('Connect');
        }
      });
    });
    this.feedback = this.body.createDiv('setting-item-description nexus-compatible-feedback');
    this.feedback.setAttribute('role', 'status');
    this.models = this.body.createDiv();
    this.renderModels();
    const manual = this.body.createEl('details', { cls: 'nexus-compatible-manual' });
    manual.createEl('summary', { text: 'Add a model manually' });
    let modelId = '';
    new Setting(manual).setName('Model ID').setDesc('Enter the exact ID expected by your server.').addText(text => {
      text.setPlaceholder('Model ID').onChange(value => { modelId = value; });
    }).addButton(button => button.setButtonText('Add').onClick(async () => {
      try {
        editor.addModel(modelId);
        this.changed();
        this.renderModels();
        await this.flush();
      } catch (error) {
        this.feedback.setText(error instanceof Error ? error.message : 'Could not add this model.');
      }
    }));
  }

  private renderModels(): void {
    this.models.empty();
    const editor = this.editor;
    if (!editor) return;
    const models = Object.keys(editor.endpoint.models);
    if (!models.length) return;
    this.models.createEl('h2', { text: 'Available models' });
    this.models.createEl('p', {
      cls: 'setting-item-description',
      text: 'Each model uses the context window your server reports. If it reports none, enter the size your server runs the model with. Check sends one prompt of that size to confirm the server accepts it.',
    });
    for (const model of models) this.renderModel(editor, model);
  }

  private renderModel(editor: CustomCompatibleEditSession, model: string): void {
    const setting = new Setting(this.models).setName(model);
    setting.settingEl.addClass('nexus-compatible-model');
    let note: ContextNote | null = null;
    let input: HTMLInputElement | null = null;
    const describe = (): void => {
      setting.descEl.empty();
      setting.descEl.createDiv({ text: this.describeContextWindow(editor, model) });
      const thinkingSummary = describeThinkingCapability(editor.endpoint.models[model]);
      if (thinkingSummary) {
        setting.descEl.createDiv({ text: thinkingSummary });
      }
      if (!note) return;
      const line = setting.descEl.createDiv({ cls: note.warning ? 'nexus-compatible-check mod-warning' : 'nexus-compatible-check', text: note.text });
      line.setAttribute('role', 'status');
      const suggestion = note.suggestion;
      if (suggestion === undefined) return;
      new ButtonComponent(line).setButtonText(`Use ${tokens(suggestion)}`).setClass('nexus-compatible-use-limit').onClick(() => {
        if (this.editor !== editor) return;
        const shown = editor.useContextWindow(model, suggestion);
        if (input) input.value = shown;
        note = null;
        this.changed();
        describe();
      });
    };
    setting.addText(text => {
      input = text.inputEl;
      text.inputEl.type = 'number';
      text.inputEl.setAttr('min', '256');
      text.inputEl.setAttr('step', '1');
      text.inputEl.setAttr('aria-label', `Context window for ${model}, in tokens`);
      text.inputEl.addClass('nexus-compatible-context-input');
      const definition = editor.endpoint.models[model];
      text.setPlaceholder(String(editor.resolveContextWindow(model, true).contextWindow))
        .setValue(definition?.contextWindow ? String(definition.contextWindow) : '')
        .onChange(value => {
          const trimmed = value.trim();
          try {
            editor.setContextWindow(model, trimmed === '' ? undefined : Number(trimmed));
            note = null;
            this.changed();
          } catch (error) {
            note = { text: error instanceof Error ? error.message : 'Enter a whole number of tokens.', warning: true };
          }
          describe();
        });
    });
    setting.addButton(button => {
      button.setButtonText('Check')
        .setTooltip('Sends one prompt of this size to your server. Large sizes can take minutes on local hardware, and hosted endpoints bill the input tokens.')
        .onClick(async () => {
          const size = editor.resolveContextWindow(model).contextWindow;
          const controller = new AbortController();
          this.checks.add(controller);
          button.setDisabled(true).setButtonText('Checking…');
          note = { text: `Sending a prompt of about ${tokens(size)} tokens…`, warning: false };
          describe();
          try {
            const result = await editor.checkContextWindow(model, controller.signal);
            if (controller.signal.aborted || this.editor !== editor) return;
            note = describeContextCheck(result);
          } catch (error) {
            if (controller.signal.aborted || this.editor !== editor) return;
            note = { text: `Check failed. ${error instanceof Error ? error.message : 'The server could not be reached.'}`, warning: true };
          } finally {
            this.checks.delete(controller);
            button.setDisabled(false).setButtonText('Check');
          }
          describe();
        });
    });
    setting.addButton(button => {
      button.setButtonText('Probe')
        .setTooltip('Sends minimal requests to detect which thinking effort tiers your server accepts for this model.')
        .onClick(async () => {
          const controller = new AbortController();
          this.checks.add(controller);
          button.setDisabled(true).setButtonText('Probing…');
          note = { text: 'Probing thinking tiers…', warning: false };
          describe();
          try {
            const result = await editor.probeThinking(model, controller.signal);
            if (controller.signal.aborted || this.editor !== editor) return;
            if (result.kind !== 'failed') {
              this.changed();
            }
            note = describeThinkingProbe(result);
          } catch (error) {
            if (controller.signal.aborted || this.editor !== editor) return;
            note = { text: `Thinking probe failed. ${error instanceof Error ? error.message : 'The server could not be reached.'}`, warning: true };
          } finally {
            this.checks.delete(controller);
            button.setDisabled(false).setButtonText('Probe');
          }
          describe();
        });
    });
    setting.addToggle(toggle => {
      toggle.setValue(editor.draft.models?.[model]?.enabled !== false).onChange(enabled => {
        editor.setModelEnabled(model, enabled);
        this.changed();
      });
    });
    describe();
  }

  private abortChecks(): void {
    for (const controller of this.checks) controller.abort();
    this.checks.clear();
  }

  private changed(): void {
    this.dirty = true;
    this.saveVersion++;
    this.clearSaveTimer();
    this.status.setText('Unsaved changes');
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.flush(); }, 400);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private async flush(): Promise<boolean> {
    this.clearSaveTimer();
    const editor = this.editor;
    if (!editor || !this.dirty) return true;
    const error = editor.validationError();
    if (error) {
      // A pristine new endpoint can be dismissed without saving an empty row.
      if (!editor.endpoint.displayName && !editor.endpoint.baseUrl && !editor.draft.apiKey) return true;
      this.status.setText(error);
      return false;
    }
    const version = this.saveVersion;
    this.status.setText('Saving…');
    try {
      await editor.save();
      if (this.editor === editor && version === this.saveVersion) {
        this.dirty = false;
        if (this.opened) this.status.setText('Saved');
      }
      if (this.editor === editor && version !== this.saveVersion) return this.flush();
      return true;
    } catch {
      if (this.opened) this.status.setText('Save failed. Change a field or close to retry.');
      return false;
    }
  }

  private persist(id: string, config: CustomCompatibleEndpointConfig): Promise<void> {
    const pending = this.saveQueue.catch(() => undefined).then(() => this.options.save(id, config));
    this.saveQueue = pending;
    return pending;
  }
}
