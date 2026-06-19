/**
 * tests/unit/ToolManagerContextContract.test.ts — pins the required context
 * contract for useTools execution. memory + goal are hard-required (steer on
 * empty/placeholder); workspaceId + sessionId default silently and only steer
 * when present-but-junk; getTools (discovery) is exempt.
 *
 * These helpers are SHARED with the eval harness recovery grading, so the
 * steering behavior must stay stable.
 */
import {
  ToolCliNormalizer,
  collectContextContractViolations,
  formatContextContractError,
} from '../../src/agents/toolManager/services/ToolCliNormalizer';
import type { IAgent } from '../../src/agents/interfaces/IAgent';

const FILLED = {
  workspaceId: 'default',
  sessionId: 'my-session',
  memory: 'Summarized the conversation so far.',
  goal: 'Create a note.',
};

describe('useTools context contract', () => {
  const normalizer = new ToolCliNormalizer(new Map<string, IAgent>());

  describe('collectContextContractViolations', () => {
    it('passes a fully-filled context block', () => {
      expect(collectContextContractViolations(FILLED)).toEqual([]);
    });

    it('flags empty memory', () => {
      const v = collectContextContractViolations({ ...FILLED, memory: '' });
      expect(v.map((x) => x.field)).toEqual(['memory']);
      expect(v[0].message).toMatch(/memory/i);
    });

    it('flags empty goal', () => {
      const v = collectContextContractViolations({ ...FILLED, goal: '   ' });
      expect(v.map((x) => x.field)).toEqual(['goal']);
    });

    it('flags placeholder memory/goal values', () => {
      const v = collectContextContractViolations({ ...FILLED, memory: 'string', goal: 'TODO' });
      expect(v.map((x) => x.field).sort()).toEqual(['goal', 'memory']);
    });

    it('flags dismissive memory fillers (N/A, N/A (First turn), None yet, TBD)', () => {
      for (const filler of ['N/A', 'N/A (First turn)', 'None yet', 'TBD', 'n/a', 'nothing yet', 'not applicable']) {
        const v = collectContextContractViolations({ ...FILLED, memory: filler });
        expect(v.map((x) => x.field)).toEqual(['memory']);
      }
    });

    it('does NOT flag real summaries that merely contain such words', () => {
      const real = [
        'The user wants to create a note at ideas/feature-requests.md with a heading.',
        'Searched for the roadmap; none of the results matched, so trying a broader query.',
        'Read notes/today.md and summarized the three action items.',
      ];
      for (const memory of real) {
        expect(collectContextContractViolations({ ...FILLED, memory })).toEqual([]);
      }
    });

    it('treats "default" workspaceId and a normal sessionId as valid (not dismissive)', () => {
      expect(
        collectContextContractViolations({ memory: 'm summary', goal: 'g objective', workspaceId: 'default', sessionId: 'note-cleanup' })
      ).toEqual([]);
    });

    it('reports both missing reasoning fields at once', () => {
      const v = collectContextContractViolations({ ...FILLED, memory: '', goal: '' });
      expect(v.map((x) => x.field).sort()).toEqual(['goal', 'memory']);
    });

    it('does NOT flag absent/empty workspaceId or sessionId (silent defaults)', () => {
      expect(collectContextContractViolations({ memory: 'm', goal: 'g' })).toEqual([]);
      expect(
        collectContextContractViolations({ memory: 'm', goal: 'g', workspaceId: '', sessionId: '' })
      ).toEqual([]);
    });

    it('accepts "default" workspaceId as a real value', () => {
      expect(collectContextContractViolations({ ...FILLED, workspaceId: 'default' })).toEqual([]);
    });

    it('flags present-but-junk workspaceId / sessionId', () => {
      const v = collectContextContractViolations({
        ...FILLED,
        workspaceId: 'placeholder',
        sessionId: 'string',
      });
      expect(v.map((x) => x.field).sort()).toEqual(['sessionId', 'workspaceId']);
    });
  });

  describe('formatContextContractError', () => {
    it('returns empty string for no violations', () => {
      expect(formatContextContractError([])).toBe('');
    });

    it('renders a single violation inline', () => {
      const msg = formatContextContractError(collectContextContractViolations({ ...FILLED, memory: '' }));
      expect(msg).toMatch(/^Context incomplete — /);
      expect(msg).toMatch(/memory/i);
    });

    it('renders multiple violations as a bulleted list', () => {
      const msg = formatContextContractError(
        collectContextContractViolations({ ...FILLED, memory: '', goal: '' })
      );
      expect(msg).toMatch(/Fix the following/);
      expect(msg.split('\n- ').length).toBe(3); // header + 2 bullets
    });
  });

  describe('ToolCliNormalizer.validateExecutionContext', () => {
    it('throws a recoverable steering error when memory is empty', () => {
      expect(() => normalizer.validateExecutionContext({ ...FILLED, memory: '', tool: 'content read --path a.md' }))
        .toThrow(/memory/i);
    });

    it('does not throw for a filled context block', () => {
      expect(() => normalizer.validateExecutionContext({ ...FILLED, tool: 'content read --path a.md' }))
        .not.toThrow();
    });
  });
});
