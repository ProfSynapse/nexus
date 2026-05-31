import { WorkspaceContextBuilder } from '../../src/agents/memoryManager/services/WorkspaceContextBuilder';

describe('WorkspaceContextBuilder', () => {
  it('expands useTools traces into recent tool and file activity', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Used tool',
            metadata: {
              tool: {
                agent: 'toolManager',
                mode: 'useTools'
              },
              input: {
                arguments: {
                  tool: 'search search-content "workspace state", content read "Projects/A.md", content replace "Projects/A.md" "old" "new"'
                }
              }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      {
        id: 'workspace-uuid',
        name: 'Workspace',
        rootFolder: '/',
        context: {}
      } as never,
      memoryService as never,
      5
    );

    expect(memoryService.getMemoryTraces).toHaveBeenCalledWith('workspace-uuid');
    expect(result.recentActivity).toEqual([
      {
        activities: [
          'Updated Projects/A.md',
          'Read Projects/A.md',
          'Searched for "workspace state"'
        ]
      }
    ]);
  });

  it('surfaces memory, storage, and task manager actions from useTools traces', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Used tool',
            metadata: {
              tool: {
                agent: 'toolManager',
                mode: 'useTools'
              },
              input: {
                arguments: {
                  tool: 'memory create-state "checkpoint" "context" "task" --active-files "Projects/A.md" --next-steps "Continue", memory load-workspace "Product Workspace", storage move "Projects/A.md" "Archive/A.md", task create-task "proj-1" "Write tests"'
                }
              }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      {
        id: 'workspace-uuid',
        name: 'Workspace',
        rootFolder: '/',
        context: {}
      } as never,
      memoryService as never,
      10
    );

    expect(result.recentActivity).toEqual([
      {
        activities: [
          'Created task Write tests',
          'Moved Projects/A.md to Archive/A.md',
          'Loaded workspace Product Workspace',
          'Saved state checkpoint'
        ]
      }
    ]);
  });

  it('uses executed batch results for serial and parallel useTools activity', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Used tool',
            metadata: {
              tool: {
                agent: 'toolManager',
                mode: 'useTools'
              },
              input: {
                arguments: {
                  strategy: 'serial',
                  tool: 'content write "Projects/A.md" "new content", content read "Projects/A.md"'
                }
              },
              legacy: {
                result: {
                  success: true,
                  data: {
                    results: [
                      { agent: 'contentManager', tool: 'write', success: true },
                      { agent: 'contentManager', tool: 'read', success: true }
                    ]
                  }
                }
              }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      {
        id: 'workspace-uuid',
        name: 'Workspace',
        rootFolder: '/',
        context: {}
      } as never,
      memoryService as never,
      10
    );

    expect(result.recentActivity).toEqual([
      {
        activities: [
          'Read Projects/A.md',
          'Wrote Projects/A.md'
        ]
      }
    ]);
  });

  it('orders newer traces and newer batch operations before older activity', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 100,
            content: 'Updated Projects/old.md'
          },
          {
            timestamp: 300,
            content: 'Used tool',
            metadata: {
              tool: {
                agent: 'toolManager',
                mode: 'useTools'
              },
              input: {
                arguments: {
                  tool: 'storage create-folder "Projects/probes", content write "Projects/probes/new-file.md" "body", content replace "Projects/activity-probe.md" "old" "new", memory create-state "E2E Activity Probe State 2" "context" "task" --active-files "Projects/activity-probe.md" --next-steps "Continue"'
                }
              },
              legacy: {
                result: {
                  success: true,
                  data: {
                    results: [
                      { agent: 'storageManager', tool: 'createFolder', success: true },
                      { agent: 'contentManager', tool: 'write', success: true },
                      { agent: 'contentManager', tool: 'replace', success: true },
                      { agent: 'memoryManager', tool: 'createState', success: true }
                    ]
                  }
                }
              }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      {
        id: 'workspace-uuid',
        name: 'Workspace',
        rootFolder: '/',
        context: {}
      } as never,
      memoryService as never,
      5
    );

    expect(result.recentActivity).toEqual([
      {
        activities: [
          'Saved state E2E Activity Probe State 2',
          'Updated Projects/activity-probe.md',
          'Wrote Projects/probes/new-file.md',
          'Created folder Projects/probes',
          'Updated Projects/old.md'
        ]
      }
    ]);
  });

  it('does not show unexecuted later commands when a serial batch stops early', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Tool execution failed',
            metadata: {
              tool: {
                agent: 'toolManager',
                mode: 'useTools'
              },
              input: {
                arguments: {
                  strategy: 'serial',
                  tool: 'content write "Projects/A.md" "new content", content read "Projects/A.md"'
                }
              },
              legacy: {
                result: {
                  success: false,
                  data: {
                    results: [
                      { agent: 'contentManager', tool: 'write', success: false }
                    ]
                  }
                }
              }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      {
        id: 'workspace-uuid',
        name: 'Workspace',
        rootFolder: '/',
        context: {}
      } as never,
      memoryService as never,
      10
    );

    expect(result.recentActivity).toEqual([
      {
        activities: [
          'Failed: Wrote Projects/A.md'
        ]
      }
    ]);
  });

  it('couches activity in its captured context, grouped by session', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Used tool',
            sessionId: 'session-b',
            metadata: {
              tool: { agent: 'toolManager', mode: 'useTools' },
              context: {
                workspaceId: 'workspace-uuid',
                sessionId: 'session-b',
                sessionName: 'Drafting',
                memory: 'Working on the release notes draft.',
                goal: 'Finish the v6 release notes.',
                constraints: 'Keep it under 300 words.'
              },
              input: { arguments: { tool: 'content read "Notes/release.md"' } }
            }
          },
          {
            timestamp: 200,
            content: 'Used tool',
            sessionId: 'session-a',
            metadata: {
              tool: { agent: 'toolManager', mode: 'useTools' },
              context: {
                workspaceId: 'workspace-uuid',
                sessionId: 'session-a',
                memory: 'Researching prior art.',
                goal: 'Survey the landscape.'
              },
              input: { arguments: { tool: 'search search-content "prior art"' } }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      { id: 'workspace-uuid', name: 'Workspace', rootFolder: '/', context: {} } as never,
      memoryService as never,
      10
    );

    expect(result.recentActivity).toEqual([
      {
        sessionId: 'session-b',
        sessionName: 'Drafting',
        memory: 'Working on the release notes draft.',
        goal: 'Finish the v6 release notes.',
        constraints: 'Keep it under 300 words.',
        activities: ['Read Notes/release.md']
      },
      {
        sessionId: 'session-a',
        memory: 'Researching prior art.',
        goal: 'Survey the landscape.',
        activities: ['Searched for "prior art"']
      }
    ]);
  });

  it('backfills missing context fields from older traces in the same session (latest non-empty wins)', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Used tool',
            sessionId: 'session-a',
            metadata: {
              tool: { agent: 'toolManager', mode: 'useTools' },
              context: {
                workspaceId: 'workspace-uuid',
                sessionId: 'session-a',
                goal: 'Ship the fix.'
                // memory/constraints absent on the newest trace
              },
              input: { arguments: { tool: 'content write "Notes/fix.md" "body"' } }
            }
          },
          {
            timestamp: 200,
            content: 'Used tool',
            sessionId: 'session-a',
            metadata: {
              tool: { agent: 'toolManager', mode: 'useTools' },
              context: {
                workspaceId: 'workspace-uuid',
                sessionId: 'session-a',
                memory: 'Earlier we reproduced the bug.',
                goal: 'Reproduce the bug.',
                constraints: 'No new dependencies.'
              },
              input: { arguments: { tool: 'content read "Notes/fix.md"' } }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      { id: 'workspace-uuid', name: 'Workspace', rootFolder: '/', context: {} } as never,
      memoryService as never,
      10
    );

    expect(result.recentActivity).toEqual([
      {
        sessionId: 'session-a',
        // goal comes from the newest trace; memory/constraints backfilled from the older one
        goal: 'Ship the fix.',
        memory: 'Earlier we reproduced the bug.',
        constraints: 'No new dependencies.',
        activities: ['Wrote Notes/fix.md', 'Read Notes/fix.md']
      }
    ]);
  });

  it('supports legacy context fields (sessionMemory/primaryGoal)', async () => {
    const builder = new WorkspaceContextBuilder();
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            timestamp: 300,
            content: 'Used tool',
            sessionId: 'legacy-session',
            metadata: {
              tool: { agent: 'toolManager', mode: 'useTools' },
              context: {
                workspaceId: 'workspace-uuid',
                sessionId: 'legacy-session',
                sessionDescription: 'Legacy work',
                sessionMemory: 'Legacy memory blob.',
                primaryGoal: 'Legacy goal.'
              },
              input: { arguments: { tool: 'content read "Notes/legacy.md"' } }
            }
          }
        ]
      })
    };

    const result = await builder.buildContextBriefing(
      { id: 'workspace-uuid', name: 'Workspace', rootFolder: '/', context: {} } as never,
      memoryService as never,
      10
    );

    expect(result.recentActivity).toEqual([
      {
        sessionId: 'legacy-session',
        sessionName: 'Legacy work',
        memory: 'Legacy memory blob.',
        goal: 'Legacy goal.',
        activities: ['Read Notes/legacy.md']
      }
    ]);
  });
});
