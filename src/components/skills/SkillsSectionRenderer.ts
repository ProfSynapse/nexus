/**
 * SkillsSectionRenderer — Renders the Skills management section inside the
 * Skills app's config modal (Settings → Apps → Skills → edit). Modeled on
 * StatesSectionRenderer (the v5.9.6/#216 states-management UI).
 *
 * UI surface:
 * - List discovered skills (recency-ordered, with a Show-archived toggle)
 * - Sync skills (import provider dotfolders + sync-back edited mirror copies)
 * - New skill (create a vault-native skill via the edit modal)
 * - Per-row: Edit (frontmatter + body), Archive/Restore (soft, reversible),
 *   Delete (UI-only hard delete: removeTree + index.hardDelete)
 *
 * The renderer owns an Obsidian Component for registerDomEvent lifecycle.
 * Data + disk I/O is delegated to the Skills services resolved off the agent's
 * runtime (resolveSkillsRuntime), so this file stays free of storage-adapter
 * coupling.
 *
 * NOTE: shares the SkillWriteService+index sequence with createSkill/updateSkill;
 * a SkillManager facade could unify them later. The 6 tools are NOT refactored
 * here — for this slice the UI calls the same services directly.
 */

import { App, ButtonComponent, Component, Modal, Notice, TextAreaComponent, TextComponent, ToggleComponent, normalizePath, setIcon } from 'obsidian';
import { ConfirmModal } from '../../settings/components/ConfirmModal';
import { resolveSkillsRuntime } from '../../agents/apps/skills/services/SkillsContext';
import { SkillWriteService } from '../../agents/apps/skills/services/SkillWriteService';
import { SkillSyncService } from '../../agents/apps/skills/services/SkillSyncService';
import { SkillValidator } from '../../agents/apps/skills/services/SkillValidator';
import { SkillIndexService } from '../../agents/apps/skills/services/SkillIndexService';
import { parseSkillFrontmatter } from '../../agents/apps/skills/services/skillFrontmatter';
import { fnv1aHex } from '../../agents/apps/skills/services/skillHash';
import type { SkillRecord } from '../../agents/apps/skills/types';
import type { SkillsAgent } from '../../agents/apps/skills/SkillsAgent';

/** The resolved-and-wired services + roots the renderer operates over. */
interface SkillsRuntimeBundle {
    index: SkillIndexService;
    write: SkillWriteService;
    sync: SkillSyncService;
    skillsRoot: string;
}

export class SkillsSectionRenderer {
    private readonly component: Component;
    private listContainer?: HTMLElement;
    private includeArchived = false;
    private cachedSkills: SkillRecord[] = [];
    private isLoading = false;
    private loadError: string | null = null;
    private bundle: SkillsRuntimeBundle | null = null;

    constructor(
        private app: App,
        private container: HTMLElement,
        private agent: SkillsAgent
    ) {
        this.component = new Component();
        this.component.load();
    }

    /**
     * Render the Skills section into the container. Resolves the runtime, then
     * builds the header + list. If the runtime is not ready, shows a friendly
     * notice and returns.
     */
    async render(): Promise<void> {
        this.container.empty();

        const resolved = resolveSkillsRuntime(this.agent);
        if (!resolved.ok) {
            this.container.createEl('p', {
                text: resolved.error || 'Storage is still initializing — try again in a moment.',
                cls: 'nexus-form-hint skills-error'
            });
            return;
        }

        const { index, vaultAdapter, skillsRoot } = resolved.rt;
        this.bundle = {
            index,
            write: new SkillWriteService(vaultAdapter),
            sync: new SkillSyncService(vaultAdapter, skillsRoot, index),
            skillsRoot
        };

        // Header row: Sync skills + New skill buttons + Show archived toggle.
        const header = this.container.createDiv('skills-header');

        const toggleWrap = header.createDiv('skills-archived-toggle');
        toggleWrap.createSpan({ text: 'Show archived', cls: 'skills-toolbar-label' });
        new ToggleComponent(toggleWrap)
            .setValue(this.includeArchived)
            .onChange((value) => {
                this.includeArchived = value;
                void this.loadAndRender();
            });

        const actions = header.createDiv('skills-header-actions');
        new ButtonComponent(actions)
            .setButtonText('Sync skills')
            .onClick(() => { void this.syncSkills(); });
        new ButtonComponent(actions)
            .setButtonText('New skill')
            .setCta()
            .onClick(() => this.openEditModal(null));

        this.container.createEl('p', {
            text: 'Skills are reusable playbooks discovered from provider folders and mirrored into your vault. Create, edit, archive, or delete them here.',
            cls: 'nexus-form-hint'
        });

        this.listContainer = this.container.createDiv('skills-list');

        await this.loadAndRender();
    }

    /** Dispose the renderer's Component (unregisters DOM events). */
    destroy(): void {
        this.component.unload();
    }

    /**
     * Refresh data: scan the mirror → sync the index → list (recency-ordered),
     * then re-render the list area. Errors surface inline (no Notice spam).
     */
    private async loadAndRender(): Promise<void> {
        if (!this.listContainer || !this.bundle) return;
        const resolved = resolveSkillsRuntime(this.agent);
        if (!resolved.ok) {
            this.loadError = resolved.error;
            this.renderList();
            return;
        }

        this.isLoading = true;
        this.loadError = null;
        this.renderList();

        try {
            const parsed = await resolved.rt.scanner.scan();
            await this.bundle.index.syncFromScan(parsed);
            this.cachedSkills = await this.bundle.index.list({ includeArchived: this.includeArchived });
        } catch (error) {
            console.error('[SkillsSectionRenderer] Failed to load skills:', error);
            this.loadError = 'Failed to load skills.';
            this.cachedSkills = [];
        } finally {
            this.isLoading = false;
            this.renderList();
        }
    }

    private renderList(): void {
        const list = this.listContainer;
        if (!list) return;
        list.empty();

        if (this.isLoading) {
            list.createEl('p', { text: 'Loading skills...', cls: 'nexus-loading-message' });
            return;
        }

        if (this.loadError) {
            list.createEl('p', { text: this.loadError, cls: 'nexus-form-hint skills-error' });
            return;
        }

        if (this.cachedSkills.length === 0) {
            list.createEl('p', {
                text: this.includeArchived
                    ? 'No skills yet. Use "Sync skills" to import provider skills, or "New skill" to create one.'
                    : 'No active skills. Toggle "Show archived" to see archived skills.',
                cls: 'nexus-form-hint'
            });
            return;
        }

        // The index already returns recency-ordered rows — render as-is.
        for (const skill of this.cachedSkills) {
            this.renderSkillRow(list, skill);
        }
    }

    private renderSkillRow(container: HTMLElement, skill: SkillRecord): void {
        const row = container.createDiv('skills-row');
        if (skill.isArchived) {
            row.addClass('skills-row--archived');
        }

        const main = row.createDiv('skills-row-main');
        const titleEl = main.createDiv('skills-row-title');
        titleEl.createSpan({ text: `${skill.provider}/${skill.name}`, cls: 'skills-row-name' });
        if (skill.isArchived) {
            titleEl.createSpan({ text: 'Archived', cls: 'skills-archived-badge' });
        }

        const meta = main.createDiv('skills-row-meta');
        meta.setText(this.formatMeta(skill));

        if (skill.description) {
            const desc = main.createDiv('skills-row-description');
            desc.setText(skill.description);
        }

        const rowActions = row.createDiv('skills-row-actions');

        // Edit
        const editBtn = rowActions.createEl('button', {
            cls: 'clickable-icon skills-action-btn',
            attr: { 'aria-label': 'Edit skill' }
        });
        setIcon(editBtn, 'edit');
        this.component.registerDomEvent(editBtn, 'click', () => this.openEditModal(skill));

        // Archive / Restore
        const archiveBtn = rowActions.createEl('button', {
            cls: 'clickable-icon skills-action-btn',
            attr: { 'aria-label': skill.isArchived ? 'Restore skill' : 'Archive skill' }
        });
        setIcon(archiveBtn, skill.isArchived ? 'archive-restore' : 'archive');
        this.component.registerDomEvent(archiveBtn, 'click', () => { void this.toggleArchive(skill, archiveBtn); });

        // Delete (UI-only hard delete)
        const deleteBtn = rowActions.createEl('button', {
            cls: 'clickable-icon skills-action-btn skills-delete-btn',
            attr: { 'aria-label': 'Delete skill' }
        });
        setIcon(deleteBtn, 'trash');
        this.component.registerDomEvent(deleteBtn, 'click', () => { void this.confirmAndDelete(skill, deleteBtn); });
    }

    private formatMeta(skill: SkillRecord): string {
        const parts: string[] = [];
        parts.push(skill.lastLoadedAt ? `Last loaded ${this.relativeTime(skill.lastLoadedAt)}` : 'Never loaded');
        if (skill.originPath) {
            parts.push('synced');
        }
        return parts.join(' • ');
    }

    /** Compact relative time (e.g. "2d ago", "just now"). */
    private relativeTime(timestamp: number): string {
        const diffMs = Date.now() - timestamp;
        if (diffMs < 0) return 'just now';
        const sec = Math.floor(diffMs / 1000);
        if (sec < 60) return 'just now';
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        const day = Math.floor(hr / 24);
        if (day < 30) return `${day}d ago`;
        const month = Math.floor(day / 30);
        if (month < 12) return `${month}mo ago`;
        return `${Math.floor(month / 12)}y ago`;
    }

    private async syncSkills(): Promise<void> {
        if (!this.bundle) return;
        try {
            const providers = await this.bundle.sync.discoverProviders();
            const imported = await this.bundle.sync.import();
            const syncedBack = await this.bundle.sync.syncBack();
            new Notice(
                `Synced skills: ${imported.imported.length} imported, ${syncedBack.syncedBack.length} synced back ` +
                `(${providers.length} provider${providers.length === 1 ? '' : 's'}).`
            );
            await this.loadAndRender();
        } catch (error) {
            console.error('[SkillsSectionRenderer] Sync failed:', error);
            new Notice('Failed to sync skills');
        }
    }

    private async toggleArchive(skill: SkillRecord, btn: HTMLButtonElement): Promise<void> {
        if (!this.bundle) return;
        const restore = skill.isArchived;

        if (!restore) {
            const confirmed = await ConfirmModal.confirm(this.app, {
                variant: 'archive',
                title: 'Archive skill?',
                body: `Archive skill "${skill.provider}/${skill.name}"? You can restore it later from this list.`
            });
            if (!confirmed) return;
        }

        this.setBusy(btn, true);
        try {
            await this.bundle.index.setArchived(skill.provider, skill.name, !restore);
            new Notice(restore ? 'Skill restored' : 'Skill archived');
            await this.loadAndRender();
        } catch (error) {
            console.error('[SkillsSectionRenderer] Archive failed:', error);
            new Notice('Failed to archive skill');
        } finally {
            this.setBusy(btn, false);
        }
    }

    private async confirmAndDelete(skill: SkillRecord, btn: HTMLButtonElement): Promise<void> {
        if (!this.bundle) return;
        const confirmed = await ConfirmModal.confirm(this.app, {
            variant: 'delete',
            title: 'Delete skill?',
            body: `Permanently delete skill "${skill.provider}/${skill.name}" and its files? This cannot be undone.`
        });
        if (!confirmed) return;

        this.setBusy(btn, true);
        try {
            await this.bundle.write.removeTree(skill.vaultPath);
            await this.bundle.index.hardDelete(skill.provider, skill.name);
            new Notice('Skill deleted');
            await this.loadAndRender();
        } catch (error) {
            console.error('[SkillsSectionRenderer] Delete failed:', error);
            new Notice('Failed to delete skill');
        } finally {
            this.setBusy(btn, false);
        }
    }

    /**
     * Open the create/edit modal. `skill === null` → create mode (provider
     * `nexus`); otherwise edit the existing record (name read-only for v1).
     */
    private openEditModal(skill: SkillRecord | null): void {
        if (!this.bundle) return;
        const bundle = this.bundle;

        if (skill === null) {
            const modal = new SkillEditModal(this.app, { mode: 'create' }, async ({ name, description, body }) => {
                const folder = normalizePath(`${bundle.skillsRoot}/nexus/${name}`);
                if (await bundle.write.exists(folder)) {
                    new Notice(`A skill named "${name}" already exists for provider "nexus".`);
                    return false;
                }
                const skillMd = await bundle.write.composeSkillMd(name, description, body);
                await bundle.write.writeSkill(folder, skillMd);
                await bundle.index.upsertOne({
                    provider: 'nexus',
                    name,
                    description,
                    vaultPath: folder,
                    contentHash: fnv1aHex(skillMd)
                });
                new Notice('Skill created');
                await this.loadAndRender();
                return true;
            });
            modal.open();
            return;
        }

        // Edit mode — prefill from the current SKILL.md.
        void (async () => {
            const raw = await bundle.write.readSkillMd(skill.vaultPath);
            const parsed = raw ? await parseSkillFrontmatter(raw) : { body: '' };
            const modal = new SkillEditModal(
                this.app,
                {
                    mode: 'edit',
                    name: skill.name,
                    description: parsed.description ?? skill.description,
                    body: parsed.body
                },
                async ({ description, body }) => {
                    const skillMd = await bundle.write.composeSkillMd(skill.name, description, body);
                    // Reuse the same archive-then-replace path as updateSkill.
                    await bundle.write.archiveThenReplace(
                        skill.vaultPath,
                        () => bundle.write.writeSkill(skill.vaultPath, skillMd)
                    );
                    await bundle.index.upsertOne({
                        provider: skill.provider,
                        name: skill.name,
                        description,
                        vaultPath: skill.vaultPath,
                        originPath: skill.originPath,
                        contentHash: fnv1aHex(skillMd)
                    });
                    new Notice('Skill updated');
                    await this.loadAndRender();
                    return true;
                }
            );
            modal.open();
        })();
    }

    /** Disable/enable a row action button around an async op (double-fire guard). */
    private setBusy(btn: HTMLButtonElement, busy: boolean): void {
        btn.toggleClass('is-busy', busy);
        if (busy) {
            btn.setAttribute('disabled', 'true');
        } else {
            btn.removeAttribute('disabled');
        }
    }
}

/** Input prefill / mode for the SkillEditModal. */
interface SkillEditModalInit {
    mode: 'create' | 'edit';
    name?: string;
    description?: string;
    body?: string;
}

/** Fields the SkillEditModal hands back on Save. */
interface SkillEditModalValues {
    name: string;
    description: string;
    body: string;
}

/**
 * Modal for creating or editing a skill's frontmatter (name/description) + body.
 * Live validation via SkillValidator: Save is disabled while invalid and inline
 * errors are shown. In edit mode the name is read-only (rename is out of scope
 * for v1 — it is a separate concern handled by updateSkill --rename).
 *
 * onSave returns a Promise<boolean>: true closes the modal, false keeps it open
 * (e.g., create-mode duplicate-name rejection).
 */
class SkillEditModal extends Modal {
    private readonly validator = new SkillValidator();
    private nameValue: string;
    private descriptionValue: string;
    private bodyValue: string;
    private saving = false;
    private saveBtn?: ButtonComponent;
    private errorsEl?: HTMLElement;

    constructor(
        app: App,
        private readonly init: SkillEditModalInit,
        private readonly onSave: (values: SkillEditModalValues) => Promise<boolean>
    ) {
        super(app);
        this.nameValue = init.name ?? '';
        this.descriptionValue = init.description ?? '';
        this.bodyValue = init.body ?? '';
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('skills-edit-modal');

        contentEl.createEl('h2', { text: this.init.mode === 'create' ? 'New skill' : 'Edit skill' });

        // Name
        contentEl.createEl('label', { text: 'Name', cls: 'skills-edit-label' });
        const nameInput = new TextComponent(contentEl);
        nameInput.setPlaceholder('Lowercase-hyphenated');
        nameInput.setValue(this.nameValue);
        nameInput.inputEl.addClass('skills-edit-input');
        if (this.init.mode === 'edit') {
            nameInput.inputEl.setAttribute('disabled', 'true');
            nameInput.inputEl.addClass('skills-edit-input--readonly');
        } else {
            nameInput.onChange((value) => {
                this.nameValue = value;
                this.revalidate();
            });
        }

        // Description
        contentEl.createEl('label', { text: 'Description', cls: 'skills-edit-label' });
        const descInput = new TextComponent(contentEl);
        descInput.setValue(this.descriptionValue);
        descInput.inputEl.addClass('skills-edit-input');
        descInput.onChange((value) => {
            this.descriptionValue = value;
            this.revalidate();
        });

        // Body
        contentEl.createEl('label', { text: 'Instructions (SKILL.md body)', cls: 'skills-edit-label' });
        const bodyInput = new TextAreaComponent(contentEl);
        bodyInput.setValue(this.bodyValue);
        bodyInput.inputEl.addClass('skills-edit-textarea');
        bodyInput.onChange((value) => {
            this.bodyValue = value;
        });

        // Inline validation errors
        this.errorsEl = contentEl.createDiv('skills-edit-errors');

        const buttonRow = contentEl.createDiv('modal-button-container');
        new ButtonComponent(buttonRow)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        this.saveBtn = new ButtonComponent(buttonRow)
            .setButtonText('Save')
            .setCta()
            .onClick(() => { void this.handleSave(); });

        this.revalidate();
    }

    /** Re-run validation, render errors inline, and gate the Save button. */
    private revalidate(): void {
        const result = this.validator.validate({
            name: this.nameValue,
            description: this.descriptionValue
        });

        if (this.errorsEl) {
            this.errorsEl.empty();
            if (!result.valid) {
                for (const err of result.errors) {
                    this.errorsEl.createEl('p', { text: err, cls: 'skills-edit-error' });
                }
            }
        }

        this.saveBtn?.setDisabled(!result.valid || this.saving);
    }

    private async handleSave(): Promise<void> {
        if (this.saving) return;
        const result = this.validator.validate({
            name: this.nameValue,
            description: this.descriptionValue
        });
        if (!result.valid) {
            this.revalidate();
            return;
        }

        this.saving = true;
        this.saveBtn?.setDisabled(true);
        try {
            const closed = await this.onSave({
                name: this.nameValue.trim(),
                description: this.descriptionValue.trim(),
                body: this.bodyValue
            });
            if (closed) {
                this.close();
            }
        } catch (error) {
            console.error('[SkillEditModal] Save failed:', error);
            new Notice('Failed to save skill');
        } finally {
            this.saving = false;
            this.saveBtn?.setDisabled(false);
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
