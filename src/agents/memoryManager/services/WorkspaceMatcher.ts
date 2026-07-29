/**
 * Location: src/agents/memoryManager/services/WorkspaceMatcher.ts
 *
 * Purpose: Pure scoring for workspace name/description/folder matching.
 *
 * Kept free of Obsidian and service dependencies so it can be unit tested in
 * isolation and so search behaves identically on every storage backend. The
 * SQLite FTS path (WorkspaceService.searchWorkspaces) is exact-phrase only and
 * returns nothing on a cold cache, so tool-facing search scores locally over
 * the lightweight workspace index instead.
 *
 * Used by: SearchWorkspacesTool
 */

import { WorkspaceMetadata } from '../../../types/storage/StorageTypes';

export type WorkspaceMatchField = 'id' | 'name' | 'description' | 'rootFolder';

export interface WorkspaceMatch {
  workspace: WorkspaceMetadata;
  score: number;
  matchedOn: WorkspaceMatchField[];
  /** Case-insensitive whole-value hit on id or name. */
  isExact: boolean;
}

export interface MatchWorkspacesOptions {
  includeArchived?: boolean;
  limit?: number;
}

/**
 * Split a string into lowercase word tokens. Punctuation and separators used in
 * workspace names and folder paths all act as boundaries.
 */
function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(token => token.length > 0);
}

/**
 * Fraction of query tokens present as a substring of any target token.
 * Substring rather than equality so "resear" matches "research".
 */
function tokenCoverage(queryTokens: string[], targetTokens: string[]): number {
  if (queryTokens.length === 0 || targetTokens.length === 0) {
    return 0;
  }

  const hits = queryTokens.filter(queryToken =>
    targetTokens.some(targetToken => targetToken.includes(queryToken))
  ).length;

  return hits / queryTokens.length;
}

/**
 * Score a single workspace against a normalized query.
 * Signals accumulate across fields; the caller drops zero-score entries.
 */
function scoreWorkspace(
  workspace: WorkspaceMetadata,
  normalizedQuery: string,
  queryTokens: string[]
): { score: number; matchedOn: WorkspaceMatchField[]; isExact: boolean } {
  const matchedOn: WorkspaceMatchField[] = [];
  let score = 0;
  let isExact = false;

  const id = (workspace.id || '').toLowerCase();
  const name = (workspace.name || '').toLowerCase();
  const description = (workspace.description || '').toLowerCase();
  const rootFolder = (workspace.rootFolder || '').toLowerCase();

  if (id && id === normalizedQuery) {
    score += 1;
    isExact = true;
    matchedOn.push('id');
  }

  if (name) {
    if (name === normalizedQuery) {
      score += 1;
      isExact = true;
      matchedOn.push('name');
    } else if (name.startsWith(normalizedQuery)) {
      score += 0.8;
      matchedOn.push('name');
    } else if (name.includes(normalizedQuery)) {
      score += 0.6;
      matchedOn.push('name');
    } else {
      const coverage = tokenCoverage(queryTokens, tokenize(name));
      if (coverage === 1) {
        score += 0.5;
        matchedOn.push('name');
      } else if (coverage > 0) {
        score += 0.25 * coverage;
        matchedOn.push('name');
      }
    }
  }

  if (description) {
    if (description.includes(normalizedQuery)) {
      score += 0.3;
      matchedOn.push('description');
    } else {
      const coverage = tokenCoverage(queryTokens, tokenize(description));
      if (coverage > 0) {
        score += 0.15 * coverage;
        matchedOn.push('description');
      }
    }
  }

  if (rootFolder && rootFolder.includes(normalizedQuery)) {
    score += 0.2;
    matchedOn.push('rootFolder');
  }

  return { score, matchedOn, isExact };
}

/**
 * Rank workspaces against a free-text query.
 *
 * @param workspaces Lightweight workspace index rows
 * @param query Free-text query (name fragment, folder fragment, or workspace id)
 * @param options includeArchived (default false), limit (default unlimited)
 * @returns Matches sorted by score desc, then lastAccessed desc. Zero-score entries dropped.
 */
export function matchWorkspaces(
  workspaces: WorkspaceMetadata[],
  query: string,
  options?: MatchWorkspacesOptions
): WorkspaceMatch[] {
  const normalizedQuery = (query || '').trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const includeArchived = options?.includeArchived ?? false;
  const queryTokens = tokenize(normalizedQuery);

  const matches: WorkspaceMatch[] = [];
  for (const workspace of workspaces) {
    if (!includeArchived && workspace.isArchived) {
      continue;
    }

    const { score, matchedOn, isExact } = scoreWorkspace(workspace, normalizedQuery, queryTokens);
    if (score <= 0) {
      continue;
    }

    matches.push({ workspace, score, matchedOn, isExact });
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (b.workspace.lastAccessed ?? 0) - (a.workspace.lastAccessed ?? 0);
  });

  const limit = options?.limit;
  return typeof limit === 'number' && limit > 0 ? matches.slice(0, limit) : matches;
}
