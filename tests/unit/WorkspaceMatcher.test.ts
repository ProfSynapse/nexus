/**
 * Tests for WorkspaceMatcher - pure scoring for workspace search.
 */

import {
  matchWorkspaces,
  resolveWorkspaceIdentifier
} from '../../src/agents/memoryManager/services/WorkspaceMatcher';
import { WorkspaceMetadata } from '../../src/types/storage/StorageTypes';

function makeWorkspace(overrides: Partial<WorkspaceMetadata> & { id: string; name: string }): WorkspaceMetadata {
  return {
    rootFolder: 'Notes',
    created: 1000,
    lastAccessed: 1000,
    sessionCount: 0,
    traceCount: 0,
    ...overrides
  };
}

describe('matchWorkspaces', () => {
  it('returns nothing for an empty or whitespace query', () => {
    const workspaces = [makeWorkspace({ id: 'a', name: 'Research' })];

    expect(matchWorkspaces(workspaces, '')).toEqual([]);
    expect(matchWorkspaces(workspaces, '   ')).toEqual([]);
  });

  it('flags a case-insensitive whole-name hit as exact', () => {
    const workspaces = [makeWorkspace({ id: 'a', name: 'Research' })];

    const [match] = matchWorkspaces(workspaces, 'research');

    expect(match.isExact).toBe(true);
    expect(match.score).toBe(1);
    expect(match.matchedOn).toContain('name');
  });

  it('flags a whole-id hit as exact', () => {
    const workspaces = [makeWorkspace({ id: 'ws-123', name: 'Research' })];

    const [match] = matchWorkspaces(workspaces, 'WS-123');

    expect(match.isExact).toBe(true);
    expect(match.matchedOn).toContain('id');
  });

  it('ranks exact name above prefix above substring', () => {
    const workspaces = [
      makeWorkspace({ id: 'sub', name: 'My Research Notes' }),
      makeWorkspace({ id: 'prefix', name: 'Research Archive' }),
      makeWorkspace({ id: 'exact', name: 'Research' })
    ];

    const matches = matchWorkspaces(workspaces, 'research');

    expect(matches.map(m => m.workspace.id)).toEqual(['exact', 'prefix', 'sub']);
  });

  it('matches partial words against name tokens', () => {
    const workspaces = [makeWorkspace({ id: 'a', name: 'Deep Research Lab' })];

    const matches = matchWorkspaces(workspaces, 'resear');

    expect(matches).toHaveLength(1);
    expect(matches[0].isExact).toBe(false);
    expect(matches[0].score).toBeGreaterThan(0);
  });

  it('matches on description and reports the field', () => {
    const workspaces = [
      makeWorkspace({ id: 'a', name: 'Alpha', description: 'Quarterly revenue planning' })
    ];

    const [match] = matchWorkspaces(workspaces, 'revenue');

    expect(match.matchedOn).toContain('description');
    expect(match.matchedOn).not.toContain('name');
  });

  it('matches on rootFolder', () => {
    const workspaces = [makeWorkspace({ id: 'a', name: 'Alpha', rootFolder: 'Clients/Acme' })];

    const [match] = matchWorkspaces(workspaces, 'acme');

    expect(match.matchedOn).toContain('rootFolder');
  });

  it('scores a name hit above a description-only hit', () => {
    const workspaces = [
      makeWorkspace({ id: 'desc', name: 'Alpha', description: 'about research' }),
      makeWorkspace({ id: 'name', name: 'Research Notes' })
    ];

    const matches = matchWorkspaces(workspaces, 'research');

    expect(matches[0].workspace.id).toBe('name');
    expect(matches[1].workspace.id).toBe('desc');
  });

  it('drops workspaces that match nothing', () => {
    const workspaces = [
      makeWorkspace({ id: 'a', name: 'Research' }),
      makeWorkspace({ id: 'b', name: 'Cooking', description: 'recipes', rootFolder: 'Food' })
    ];

    const matches = matchWorkspaces(workspaces, 'research');

    expect(matches).toHaveLength(1);
    expect(matches[0].workspace.id).toBe('a');
  });

  it('excludes archived workspaces by default and includes them on request', () => {
    const workspaces = [
      makeWorkspace({ id: 'live', name: 'Research' }),
      makeWorkspace({ id: 'old', name: 'Research Archive', isArchived: true })
    ];

    expect(matchWorkspaces(workspaces, 'research').map(m => m.workspace.id)).toEqual(['live']);
    expect(
      matchWorkspaces(workspaces, 'research', { includeArchived: true }).map(m => m.workspace.id)
    ).toEqual(['live', 'old']);
  });

  it('breaks score ties by lastAccessed, most recent first', () => {
    const workspaces = [
      makeWorkspace({ id: 'stale', name: 'Research Alpha', lastAccessed: 100 }),
      makeWorkspace({ id: 'fresh', name: 'Research Beta', lastAccessed: 900 })
    ];

    const matches = matchWorkspaces(workspaces, 'research');

    expect(matches[0].score).toBe(matches[1].score);
    expect(matches.map(m => m.workspace.id)).toEqual(['fresh', 'stale']);
  });

  it('applies the limit after sorting', () => {
    const workspaces = [
      makeWorkspace({ id: 'sub', name: 'My Research Notes' }),
      makeWorkspace({ id: 'exact', name: 'Research' })
    ];

    const matches = matchWorkspaces(workspaces, 'research', { limit: 1 });

    expect(matches).toHaveLength(1);
    expect(matches[0].workspace.id).toBe('exact');
  });

  it('handles multi-token queries via token coverage', () => {
    const workspaces = [
      makeWorkspace({ id: 'both', name: 'Client Acme Research' }),
      makeWorkspace({ id: 'one', name: 'Acme Invoices' })
    ];

    const matches = matchWorkspaces(workspaces, 'acme research');

    expect(matches.map(m => m.workspace.id)).toEqual(['both', 'one']);
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });
});

describe('resolveWorkspaceIdentifier', () => {
  it('reports none when nothing matches at all', () => {
    const workspaces = [makeWorkspace({ id: 'a', name: 'Research' })];

    expect(resolveWorkspaceIdentifier(workspaces, 'Quarterly Budget')).toEqual({ kind: 'none' });
  });

  it('reports none for an empty workspace list', () => {
    expect(resolveWorkspaceIdentifier([], 'Research')).toEqual({ kind: 'none' });
  });

  it('auto-resolves a lone confident near-miss', () => {
    const workspaces = [
      makeWorkspace({ id: 'research', name: 'Research' }),
      makeWorkspace({ id: 'budget', name: 'Budget' })
    ];

    const resolution = resolveWorkspaceIdentifier(workspaces, 'Research Notes');

    expect(resolution.kind).toBe('auto');
    if (resolution.kind === 'auto') {
      expect(resolution.match.workspace.id).toBe('research');
    }
  });

  it('auto-resolves a longer invented name against the real shorter one', () => {
    // The shape agents actually produce: extra words the real name lacks.
    const workspaces = [makeWorkspace({ id: 'research', name: 'Research' })];

    const resolution = resolveWorkspaceIdentifier(workspaces, 'Research Notes Workspace');

    expect(resolution.kind).toBe('auto');
  });

  it('ignores the filler word "workspace" in the requested name', () => {
    const workspaces = [makeWorkspace({ id: 'research', name: 'Research' })];

    const resolution = resolveWorkspaceIdentifier(workspaces, 'Research Workspace');

    expect(resolution.kind).toBe('auto');
    if (resolution.kind === 'auto') {
      // Stripped down to "Research", so this reads as an exact name hit.
      expect(resolution.match.isExact).toBe(true);
    }
  });

  it('still resolves a workspace actually named "Workspace"', () => {
    const workspaces = [makeWorkspace({ id: 'w', name: 'Workspace', description: 'catch-all' })];

    // Stripping would empty the query, so the original is used instead.
    const resolution = resolveWorkspaceIdentifier(workspaces, 'workspace');

    expect(resolution.kind).toBe('auto');
  });

  it('does not auto-resolve a lone description-only match', () => {
    // Nothing about the name resembles the request, so this is not evidence
    // the caller meant this workspace.
    const workspaces = [
      makeWorkspace({ id: 'a', name: 'Research', description: 'Long term planning notes' })
    ];

    const resolution = resolveWorkspaceIdentifier(workspaces, 'planning');

    expect(resolution.kind).toBe('candidates');
    if (resolution.kind === 'candidates') {
      expect(resolution.candidates.map(c => c.workspace.id)).toEqual(['a']);
    }
  });

  it('does not auto-resolve a lone rootFolder-only match', () => {
    const workspaces = [
      makeWorkspace({ id: 'a', name: 'Alpha', rootFolder: 'Clients/Acme' })
    ];

    expect(resolveWorkspaceIdentifier(workspaces, 'acme').kind).toBe('candidates');
  });

  it('does not auto-resolve when barely any of the query matches the name', () => {
    const workspaces = [makeWorkspace({ id: 'a', name: 'Research' })];

    // One of five tokens hits — too thin to redirect on.
    const resolution = resolveWorkspaceIdentifier(
      workspaces,
      'quarterly client research budget review'
    );

    expect(resolution.kind).toBe('candidates');
  });

  it('returns a ranked shortlist rather than picking between two plausible matches', () => {
    const workspaces = [
      makeWorkspace({ id: 'hub', name: 'Research Hub' }),
      makeWorkspace({ id: 'ai', name: 'AI Research' })
    ];

    const resolution = resolveWorkspaceIdentifier(workspaces, 'research');

    expect(resolution.kind).toBe('candidates');
    if (resolution.kind === 'candidates') {
      expect(resolution.candidates.map(c => c.workspace.id)).toEqual(['hub', 'ai']);
    }
  });

  it('caps the shortlist at five candidates', () => {
    const workspaces = Array.from({ length: 8 }, (_, index) =>
      makeWorkspace({ id: `ws-${index}`, name: `Research ${index}` })
    );

    const resolution = resolveWorkspaceIdentifier(workspaces, 'research');

    expect(resolution.kind).toBe('candidates');
    if (resolution.kind === 'candidates') {
      expect(resolution.candidates).toHaveLength(5);
    }
  });

  it('ignores archived workspaces unless asked for them', () => {
    const workspaces = [makeWorkspace({ id: 'old', name: 'Research', isArchived: true })];

    expect(resolveWorkspaceIdentifier(workspaces, 'Research Notes')).toEqual({ kind: 'none' });
    expect(resolveWorkspaceIdentifier(workspaces, 'Research Notes', { includeArchived: true }).kind)
      .toBe('auto');
  });
});
