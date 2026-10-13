import { assertToolCalls } from '../eval/assertions';

// This grades raw model args in Nexus chat, where DirectToolExecutor supplies IDs.
// It does not grade the stateful binding of a fresh external MCP session.
describe('eval chat context assertions', () => {
  it.each(['getTools', 'useTools'])('accepts optional IDs for %s while retaining model-authored context', name => {
    const args = { memory: 'I am reading the requested note.', goal: 'Show note contents.',
      tool: name === 'getTools' ? 'content read' : 'content read notes/a.md 1' };
    expect(assertToolCalls([{ name }], [{ id: 'one', name, args }])).toEqual({ passed: true, errors: [] });
    expect(assertToolCalls([{ name }], [{ id: 'one', name, args: { ...args, workspaceId: 42 } }]).passed).toBe(false);
    expect(assertToolCalls([{ name }], [{ id: 'one', name, args: { ...args, sessionId: {} } }]).passed).toBe(false);
  });

  it.each(['memory', 'goal', 'tool'])('still rejects missing %s', key => {
    const args: Record<string, unknown> = { memory: 'Read requested note.', goal: 'Show note contents.', tool: 'content read' };
    delete args[key];
    expect(assertToolCalls([{ name: 'getTools' }], [{ id: 'one', name: 'getTools', args }]).passed).toBe(false);
  });

  it('still rejects deprecated nested context', () => {
    expect(assertToolCalls([{ name: 'useTools' }], [{ id: 'one', name: 'useTools', args: {
      memory: 'Read requested note.', goal: 'Show note contents.', tool: 'content read notes/a.md 1',
      context: { workspaceId: 'w', sessionId: 's' },
    } }]).passed).toBe(false);
  });
});
