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
 * Used by: SearchWorkspacesTool, LoadWorkspaceTool (miss recovery)
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

/**
 * Minimum score a lone match must reach before it is auto-resolved on behalf of
 * the caller.
 *
 * Deliberately low, because the invented names this recovers from are usually
 * LONGER than the real one ("Research Notes" for "Research"), and scoreWorkspace
 * charges for query tokens the target lacks — that pair scores 0.125, not 0.8.
 * At 0.1 the floor means "at least ~40% of the query's tokens appear in the
 * name"; the real guard against a wild match is the name/id requirement in
 * resolveWorkspaceIdentifier, not this number.
 */
export const AUTO_RESOLVE_MIN_SCORE = 0.1;

/** Candidates surfaced when a miss cannot be auto-resolved. */
export const MAX_SUGGESTED_CANDIDATES = 5;

/**
 * Words agents append to an invented workspace name that carry no signal here —
 * everything in this list is a workspace, so "Research Workspace" and
 * "Research" are the same request. Left out of matchWorkspaces on purpose: this
 * only applies to recovering a failed lookup, not to what the user typed into
 * an explicit search.
 */
const FILLER_TOKENS = new Set(['workspace', 'workspaces']);

/**
 * Drop filler words from a failed identifier. Returns the original when
 * stripping would leave nothing to match on (a workspace really named
 * "Workspace").
 */
function stripFillerTokens(identifier: string): string {
  const kept = identifier
    .trim()
    .split(/\s+/)
    .filter(word => !FILLER_TOKENS.has(word.toLowerCase().replace(/[^a-z0-9]/gi, '')));

  return kept.length > 0 ? kept.join(' ') : identifier;
}

export type WorkspaceResolution =
  /** Exactly one confident match — safe to load without asking. */
  | { kind: 'auto'; match: WorkspaceMatch }
  /** Something matched, but not confidently enough to pick for the caller. */
  | { kind: 'candidates'; candidates: WorkspaceMatch[] }
  /** Nothing matched at all. */
  | { kind: 'none' };

/**
 * Decide what to do with a workspace identifier that failed exact lookup.
 *
 * Exact name/id lookup happens upstream (WorkspaceService.getWorkspaceByNameOrId),
 * so this only ever sees genuine misses — typically a name an agent invented
 * from the user's phrasing instead of one it actually saw. Rather than dead-end
 * the call (which is what makes agents retry-loop on guessed names), it either
 * resolves the obvious single candidate or hands back a ranked shortlist.
 *
 * Auto-resolution requires a single match that hit on name or id, matching the
 * `searchWorkspaces --load` contract's strictness. Two plausible workspaces is
 * a decision for the caller, not a coin flip; and a workspace that matched only
 * because a query word brushed its description or folder path is not evidence
 * the caller meant it.
 *
 * @param workspaces Lightweight workspace index rows
 * @param identifier The identifier that failed exact lookup
 * @param options includeArchived (default false)
 */
export function resolveWorkspaceIdentifier(
  workspaces: WorkspaceMetadata[],
  identifier: string,
  options?: { includeArchived?: boolean }
): WorkspaceResolution {
  const matches = matchWorkspaces(workspaces, stripFillerTokens(identifier), {
    includeArchived: options?.includeArchived ?? false
  });

  if (matches.length === 0) {
    return { kind: 'none' };
  }

  const only = matches.length === 1 ? matches[0] : null;
  const matchedIdentity = only
    ? only.matchedOn.includes('name') || only.matchedOn.includes('id')
    : false;

  if (only && matchedIdentity && only.score >= AUTO_RESOLVE_MIN_SCORE) {
    return { kind: 'auto', match: only };
  }

  return { kind: 'candidates', candidates: matches.slice(0, MAX_SUGGESTED_CANDIDATES) };
}
