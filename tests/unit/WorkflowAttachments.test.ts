import { normalizeWorkflowAttachments } from '../../src/services/workflows/workflowAttachments';

const workflow = { id: 'review', name: 'Review', when: 'Before publishing', steps: 'Check sources' };

describe('workflow attachments', () => {
  it('round-trips old workflows without inventing attachments or a selection', () => {
    expect(normalizeWorkflowAttachments([workflow])).toEqual([workflow]);
  });
  it('deduplicates qualified refs without confusing providers or delimiter-bearing names', () => {
    const refs = [{ provider: 'nexus', name: 'review' }, { provider: 'claude', name: 'review' }];
    const result = normalizeWorkflowAttachments([{ ...workflow, skills: [...refs, refs[0]], tools: ['content read', 'content   read'] }]);
    expect(result[0].skills).toEqual(refs);
    expect(result[0].tools).toEqual(['content read']);
  });
  it.each(['content read --path x', 'content read, storage archive', 'content; rm', '', '--help'])('rejects executable dependency %s', selector => {
    expect(() => normalizeWorkflowAttachments([{ ...workflow, tools: [selector] }])).toThrow('selectors');
  });
  it.each(['../escape', 'a/b', '.', '..', 'x\\y', 'x\u0000y', ' review'])('rejects unsafe package identity %s', name => {
    expect(() => normalizeWorkflowAttachments([{ ...workflow, skills: [{ provider: 'nexus', name }] }])).toThrow('safe provider');
  });
  it.each([{ tools: 'content read' }, { skills: ['review'] }, { skills: null }, { tools: [false] }])('rejects malformed runtime fields %p', attachments => {
    expect(() => normalizeWorkflowAttachments([{ ...workflow, ...attachments }])).toThrow();
  });
});
