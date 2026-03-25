import { SystemPromptBuilder } from '../../src/ui/chat/services/SystemPromptBuilder';

describe('SystemPromptBuilder', () => {
  it('builds the lean prompt and escapes dynamic XML content', async () => {
    const builder = new SystemPromptBuilder(async () => 'alpha <beta>');

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
