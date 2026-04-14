import { SystemPromptBuilder } from '../../src/ui/chat/services/SystemPromptBuilder';

describe('SystemPromptBuilder compaction projection', () => {
  it('renders a deterministic bounded frontier block', async () => {
    const builder = new SystemPromptBuilder(async () => '');

    const prompt = await builder.build({
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      compactionFrontier: [
        {
          summary: 'Refined the task flow and fixed parser edge cases.',
          messagesRemoved: 12,
          messagesKept: 4,
          filesReferenced: [
            'A.md',
            'B.md',
            'C.md',
            'D.md',
            'E.md',
            'F.md'
          ],
          topics: [
            'transport hardening',
            'token usage normalization',
            'compaction rollout',
            'state persistence',
            'search memory',
            'prompt caching',
            'headless smoke test',
            'Gemini model validation',
            'future meta-compaction'
          ],
          compactedAt: 1_742_900_000_000,
          transcriptCoverage: {
            conversationId: 'conv_1',
            startSequenceNumber: 0,
            endSequenceNumber: 11
          }
        },
        {
          summary: 'Then validated the CLI transport fixes.',
          messagesRemoved: 6,
          messagesKept: 4,
          filesReferenced: ['Transport.md'],
          topics: ['cli transport', 'smoke tests'],
          compactedAt: 1_742_900_000_100,
          level: 1,
          mergedRecordCount: 2,
          transcriptCoverageAncestry: [
            {
              conversationId: 'conv_1',
              startSequenceNumber: 12,
              endSequenceNumber: 17
            },
            {
              conversationId: 'conv_1',
              startSequenceNumber: 18,
              endSequenceNumber: 25
            }
          ],
          transcriptCoverage: {
            conversationId: 'conv_1',
            startSequenceNumber: 12,
            endSequenceNumber: 17
          }
        }
      ]
    });

    expect(prompt).toContain('<compaction_context>');
    expect(prompt).toContain('<status>active</status>');
    expect(prompt).toContain('<source>bounded_frontier</source>');
    expect(prompt).toContain('<frontier_records count="2">');
    expect(prompt).toContain('<record index="0" compacted_at="1742900000000" level="0" merged_records="1">');
    expect(prompt).toContain('<summary>Refined the task flow and fixed parser edge cases.</summary>');
    expect(prompt).toContain('<files>A.md, B.md, C.md, D.md, E.md (+1 more)</files>');
    expect(prompt).toContain('<topics>transport hardening; token usage normalization; compaction rollout; state persistence; search memory; prompt caching; headless smoke test; Gemini model validation (+1 more)</topics>');
    expect(prompt).toContain('<coverage conversation_id="conv_1" start_sequence_number="0" end_sequence_number="11" />');
    expect(prompt).toContain('<stats messages_compacted="12" messages_retained="4" />');
    expect(prompt).toContain('<record index="1" compacted_at="1742900000100" level="1" merged_records="2">');
    expect(prompt).toContain('<summary>Then validated the CLI transport fixes.</summary>');
    expect(prompt).toContain('<coverage_ancestry count="2">conv_1:12-17 | conv_1:18-25</coverage_ancestry>');
    expect(prompt).toContain('<instruction>Treat this block as compressed prior conversation context.');
    expect(prompt).not.toContain('<previous_context>');
  });

  it('falls back to rendering a legacy single compaction record when no frontier is provided', async () => {
    const builder = new SystemPromptBuilder(async () => '');

    const prompt = await builder.build({
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      legacyCompactionRecord: {
        summary: 'Earlier work summary.',
        messagesRemoved: 2,
        messagesKept: 2,
        filesReferenced: [],
        topics: [],
        compactedAt: 123
      }
    });

    expect(prompt).toContain('<source>bounded_frontier</source>');
    expect(prompt).toContain('<frontier_records count="1">');
    expect(prompt).toContain('<record index="0" compacted_at="123" level="0" merged_records="1">');
  });

  it('keeps the legacy previousContext option working as a compatibility alias', async () => {
    const builder = new SystemPromptBuilder(async () => '');

    const prompt = await builder.build({
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      previousContext: {
        summary: 'Legacy alias summary.',
        messagesRemoved: 1,
        messagesKept: 1,
        filesReferenced: [],
        topics: [],
        compactedAt: 456
      }
    });

    expect(prompt).toContain('<frontier_records count="1">');
    expect(prompt).toContain('<record index="0" compacted_at="456" level="0" merged_records="1">');
  });

  it('places the compaction block before the tools/context section', async () => {
    const builder = new SystemPromptBuilder(async () => '');

    const prompt = await builder.build({
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      compactionFrontier: [{
        summary: 'Earlier work summary.',
        messagesRemoved: 2,
        messagesKept: 2,
        filesReferenced: [],
        topics: [],
        compactedAt: 123
      }]
    });

    expect(prompt).not.toBeNull();
    const promptText = prompt as string;
    const compactionIndex = promptText.indexOf('<compaction_context>');
    const toolsIndex = promptText.indexOf('<tools_and_context>');

    expect(compactionIndex).toBeGreaterThanOrEqual(0);
    expect(toolsIndex).toBeGreaterThan(compactionIndex);
  });
});

describe('SystemPromptBuilder', () => {
  it('builds the lean prompt and escapes dynamic XML content', async () => {
    const builder = new SystemPromptBuilder(
      async () => 'alpha <beta>',
      undefined,
      async () => ({
        id: '__system_guides__',
        name: 'Assistant guides',
        description: 'Built-in docs',
        rootFolder: 'Assistant data/guides',
        entrypoint: 'Assistant data/guides/index.md'
      })
    );

    const prompt = await builder.build({
      sessionId: 'session-123',
      workspaceId: 'workspace-456',
      contextNotes: ['Notes/Test <File>.md'],
      customPrompt: 'Use <structured> mode',
      loadedWorkspaceData: {
        id: 'ws-1',
        context: { name: 'Workspace <One>' },
        taskSummary: { tasks: { open: 2 } },
        extraField: 'kept'
      }
    });

    expect(prompt).toContain('<tools_and_context>');
    expect(prompt).toContain('<working_strategy>');
    expect(prompt).toContain('If a workspace is selected, use it as the primary context.');
    expect(prompt).toContain('Ask before creating a new workspace.');
    expect(prompt).toContain('<built_in_docs_workspace>');
    expect(prompt).toContain('workspaceId: "__system_guides__"');
    expect(prompt).toContain('entrypoint: "Assistant data/guides/index.md"');
    expect(prompt).not.toContain('# Assistant guides');

    expect(prompt).toContain('Notes/Test &lt;File&gt;.md');
    expect(prompt).toContain('alpha &lt;beta&gt;');
    expect(prompt).toContain('Use &lt;structured&gt; mode');
    expect(prompt).toContain('<selected_workspace name="Workspace &lt;One&gt;" id="ws-1">');
    expect(prompt).toContain('"taskSummary"');
    expect(prompt).toContain('"extraField": "kept"');
  });

  it('escapes suggester-driven note, tool, prompt, and workspace insertions', async () => {
    const builder = new SystemPromptBuilder(
      async () => '[unused]',
      async () => ({
        id: 'ws-ref-1',
        context: { name: 'Workspace <Ref>' },
        taskSummary: { tasks: { open: 1 } }
      })
    );

    const prompt = await builder.build({
      sessionId: 'session-abc',
      workspaceId: 'workspace-def',
      messageEnhancement: {
        originalMessage: 'test',
        cleanedMessage: 'test',
        totalTokens: 10,
        tools: [
          {
            name: 'search<tool>',
            schema: {
              name: 'search<tool>',
              description: 'Find <things>',
              inputSchema: {}
            }
          }
        ],
        prompts: [
          {
            id: 'prompt-1',
            name: 'Prompt <One>',
            prompt: 'Use <xml>-safe prompt',
            tokens: 5
          }
        ],
        notes: [
          {
            path: 'Notes/Ref <One>.md',
            name: 'Ref One',
            content: 'Referenced <content>',
            tokens: 5
          }
        ],
        workspaces: [
          {
            id: 'ws-ref-1',
            name: 'Workspace <Ref>',
            description: 'Desc <here>',
            rootFolder: 'Projects/<Ref>'
          }
        ]
      }
    });

    expect(prompt).toContain('Tool: search&lt;tool&gt;');
    expect(prompt).toContain('Description: Find &lt;things&gt;');
    expect(prompt).toContain('<prompt name="Prompt &lt;One&gt;">');
    expect(prompt).toContain('Use &lt;xml&gt;-safe prompt');
    expect(prompt).toContain('Notes/Ref &lt;One&gt;.md');
    expect(prompt).toContain('Referenced &lt;content&gt;');
    expect(prompt).toContain('<workspace name="Workspace &lt;Ref&gt;" id="ws-ref-1">');
    expect(prompt).toContain('"name": "Workspace &lt;Ref&gt;"');
    expect(prompt).toContain('"taskSummary"');
  });
});
