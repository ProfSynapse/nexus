import { App, AbstractInputSuggest, TFile, setIcon } from 'obsidian';
import type { EmbeddingService } from '../../services/embeddings/EmbeddingService';
import { searchNotes } from '../../utils/noteSearch';

export class NoteInputSuggester extends AbstractInputSuggest<TFile> {
    private embeddingService: EmbeddingService | null;
    private onSelectCallback: (file: TFile) => void;

    constructor(
        app: App,
        inputEl: HTMLInputElement,
        embeddingService: EmbeddingService | null,
        onSelect: (file: TFile) => void
    ) {
        super(app, inputEl);
        this.embeddingService = embeddingService;
        this.onSelectCallback = onSelect;
        this.limit = 10;
    }

    async getSuggestions(query: string): Promise<TFile[]> {
        return searchNotes(this.app, query, this.embeddingService, 10);
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.addClass('nexus-note-suggester-item');

        const icon = el.createDiv({ cls: 'nexus-note-suggester-icon' });
        setIcon(icon, 'file-text');

        const content = el.createDiv({ cls: 'nexus-note-suggester-content' });
        content.createDiv({ cls: 'nexus-note-suggester-name', text: file.basename });
        content.createDiv({ cls: 'nexus-note-suggester-path', text: file.path });
    }

    selectSuggestion(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
        this.setValue(file.path);
        this.onSelectCallback(file);
        this.close();
    }
}
