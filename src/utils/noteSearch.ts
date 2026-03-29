import { App, TFile, prepareFuzzySearch } from 'obsidian';
import type { EmbeddingService } from '../services/embeddings/EmbeddingService';

/**
 * Search notes by semantic similarity (with fuzzy fallback).
 * Primary: EmbeddingService.semanticSearch if enabled.
 * Fallback: Obsidian prepareFuzzySearch on basename/path.
 * Empty query: returns most recently modified files.
 */
export async function searchNotes(
    app: App,
    query: string,
    embeddingService: EmbeddingService | null | undefined,
    limit = 10
): Promise<TFile[]> {
    const trimmed = query.trim();

    if (!trimmed) {
        return app.vault.getMarkdownFiles()
            .sort((a, b) => b.stat.mtime - a.stat.mtime)
            .slice(0, limit);
    }

    if (embeddingService?.isServiceEnabled()) {
        try {
            const results = await embeddingService.semanticSearch(trimmed, limit);
            const files = results
                .map(r => app.vault.getFileByPath(r.notePath))
                .filter((f): f is TFile => f !== null);
            if (files.length > 0) return files;
        } catch {
            // fall through to fuzzy
        }
    }

    const fuzzy = prepareFuzzySearch(trimmed.toLowerCase());
    const matches: Array<{ file: TFile; score: number }> = [];
    for (const file of app.vault.getMarkdownFiles()) {
        const nameMatch = fuzzy(file.basename);
        if (nameMatch) { matches.push({ file, score: nameMatch.score }); continue; }
        const pathMatch = fuzzy(file.path);
        if (pathMatch) { matches.push({ file, score: pathMatch.score * 0.8 }); }
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, limit).map(m => m.file);
}
