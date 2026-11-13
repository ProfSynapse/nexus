import { App, ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import type { LLMProviderConfig } from '../../types/llm/ProviderTypes';
import { generateUUID } from '../../utils/uuid';
import { resolveOpenAICompatibleContextWindow } from '../../services/llm/adapters/openai-compatible/OpenAICompatibleConfig';
import type { OpenAICompatibleContextCheckResult } from '../../services/llm/adapters/openai-compatible/OpenAICompatibleContextCheck';
import type { OpenAICompatibleModelDefinition } from '../../types/llm/ProviderTypes';
import {
  describeThinkingCapability,
  type CompatibleThinkingProbeResult,
} from '../../services/llm/adapters/shared/CompatibleThinkingProbe';
import {
  CompatibleEndpointConfig,
  copyEndpoint,
  isCompatibleEndpoint,
  OpenAICompatibleEditSession,
} from './OpenAICompatibleEditSession';

interface ContextNote {
  text: string;
  warning: boolean;
  /** A size the server named or revealed, offered as a one-click replacement. */
  suggestion?: number;
}

const tokens = (value: number): string => value.toLocaleString();

export function describeContextWindow(definition: OpenAICompatibleModelDefinition | undefined): string {
  const { contextWindow, source } = resolveOpenAICompatibleContextWindow(definition);
  if (source === 'server') return `Context window: ${tokens(contextWindow)} tokens, reported by your server.`;
  if (source === 'default') {
    return `Context window: ${tokens(contextWindow)} tokens. Your server did not report one, so this is the default. Enter your model's real size to raise it.`;
  }
  const reported = definition?.reportedContextWindow;
  return `Context window: ${tokens(contextWindow)} tokens, set by you.`
    + (reported && reported !== contextWindow ? ` Your server reports ${tokens(reported)}.` : '');
}

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

export interface OpenAICompatibleModalOptions {
  getProviders: () => Record<string, LLMProviderConfig>;
  save: (id: string, config: CompatibleEndpointConfig) => Promise<void>;
}

/** The provider card manages named connections; each editor uses ordinary Settings rows. */
export class OpenAICompatibleModal extends Modal {
  private editor: OpenAICompatibleEditSession | null = null;
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

  constructor(app: App, private readonly options: OpenAICompatibleModalOptions) {
    super(app);
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
    this.shell('Configure OpenAI-compatible');
    this.body.createEl('p', { cls: 'setting-item-description', text: 'Connect a local or hosted OpenAI-compatible endpoint to Nexus.' });
    new Setting(this.body).setName('Your endpoints').addButton(button => {
      button.setButtonText('Add endpoint').setCta().onClick(() => this.renderEditor(
        `openai-compatible-${generateUUID()}`,
        { apiKey: '', enabled: false, driverKind: 'openai-compatible', models: {}, openaiCompatible: { schemaVersion: 1, displayName: '', baseUrl: '', models: {} } },
      ));
    });
    const endpoints = Object.entries(this.options.getProviders()).filter(([, config]) => isCompatibleEndpoint(config));
    if (!endpoints.length) this.body.createEl('p', { cls: 'setting-item-description', text: 'No endpoints configured. Add an endpoint to get started.' });
    for (const [id, config] of endpoints) {
      if (!isCompatibleEndpoint(config)) continue;
      const card = this.body.createDiv('agent-management-card nexus-compatible-endpoint');
      const count = Object.keys(config.openaiCompatible.models).filter(model => config.models?.[model]?.enabled !== false).length;
      new Setting(card)
        .setName(config.openaiCompatible.displayName)
        .setDesc(`${count} ${count === 1 ? 'model' : 'models'} enabled`)
        .addToggle(toggle => toggle.setValue(config.enabled).onChange(async enabled => {
          toggle.setDisabled(true);
          const updated = copyEndpoint(config);
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
        .addExtraButton(button => button.setIcon('edit').setTooltip(`Configure ${config.openaiCompatible.displayName}`).onClick(async () => {
          await this.saveQueue.catch(() => undefined);
          if (!this.opened) return;
          const latest = this.options.getProviders()[id];
          if (latest && isCompatibleEndpoint(latest)) this.renderEditor(id, latest);
        }));
      card.createDiv({ cls: 'setting-item-description nexus-compatible-address', text: config.openaiCompatible.baseUrl });
    }
  }

  private renderEditor(id: string, config: CompatibleEndpointConfig): void {
    this.abortChecks();
    this.editor?.close();
    const editor = new OpenAICompatibleEditSession(id, config, (endpointId, snapshot) => this.persist(endpointId, snapshot));
    this.editor = editor;
    this.dirty = false;
    this.shell(config.openaiCompatible.displayName ? `Configure ${config.openaiCompatible.displayName}` : 'Add endpoint');
    new ButtonComponent(this.body).setButtonText('All endpoints').onClick(() => {
      void this.flush().then(saved => { if (saved && this.opened) this.renderList(); });
    });
    new Setting(this.body).setName('Name').setDesc('Shown in the model picker.').addText(text => {
      text.setPlaceholder('My endpoint').setValue(editor.draft.openaiCompatible.displayName).onChange(value => {
        editor.setName(value);
        this.changed();
      });
    });
    new Setting(this.body).setName('API base URL').setDesc('Use the full base address, including any path such as /v1.').addText(text => {
      text.inputEl.type = 'url';
      text.inputEl.addClass('nexus-compatible-url-input');
      text.setPlaceholder('https://my-server.example/v1').setValue(editor.draft.openaiCompatible.baseUrl).onChange(value => {
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
    const models = Object.keys(editor.draft.openaiCompatible.models);
    if (!models.length) return;
    this.models.createEl('h2', { text: 'Available models' });
    this.models.createEl('p', {
      cls: 'setting-item-description',
      text: 'Each model uses the context window your server reports. If it reports none, enter the size your server runs the model with. Check sends one prompt of that size to confirm the server accepts it.',
    });
    for (const model of models) this.renderModel(editor, model);
  }

  private renderModel(editor: OpenAICompatibleEditSession, model: string): void {
    const setting = new Setting(this.models).setName(model);
    setting.settingEl.addClass('nexus-compatible-model');
    let note: ContextNote | null = null;
    let input: HTMLInputElement | null = null;
    const describe = (): void => {
      setting.descEl.empty();
      setting.descEl.createDiv({ text: describeContextWindow(editor.draft.openaiCompatible.models[model]) });
      const thinkingSummary = describeThinkingCapability(editor.draft.openaiCompatible.models[model]);
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
      const definition = editor.draft.openaiCompatible.models[model];
      text.setPlaceholder(String(resolveOpenAICompatibleContextWindow({ ...definition, contextWindow: undefined }).contextWindow))
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
          const size = resolveOpenAICompatibleContextWindow(editor.draft.openaiCompatible.models[model]).contextWindow;
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
      if (!editor.draft.openaiCompatible.displayName && !editor.draft.openaiCompatible.baseUrl && !editor.draft.apiKey) return true;
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

  private persist(id: string, config: CompatibleEndpointConfig): Promise<void> {
    const pending = this.saveQueue.catch(() => undefined).then(() => this.options.save(id, config));
    this.saveQueue = pending;
    return pending;
  }
}
