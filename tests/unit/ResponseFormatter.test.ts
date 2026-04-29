/**
 * ResponseFormatter — coverage of the user-visible "Session name changed"
 * prose surfaced when a friendly session handle had to be suffixed to
 * keep it unique within a workspace (B4 of review/workspace-memory-batch).
 *
 * The string is embedded in the MCP response body and is the only
 * channel through which the user discovers the renamed handle, so a
 * regression that drops the prose, renders `undefined`, or stops
 * gating it behind the right flag is user-visible immediately.
 */

import { ResponseFormatter } from '../../src/handlers/services/ResponseFormatter';
import type { SessionInfo, ToolExecutionResult } from '../../src/handlers/interfaces/IRequestHandlerServices';

function getResponseText(response: { content: Array<{ text: string }> }): string {
  return response.content.map((c) => c.text).join('');
}

describe('ResponseFormatter — Session name changed prose', () => {
  let formatter: ResponseFormatter;

  beforeEach(() => {
    formatter = new ResponseFormatter();
  });

  describe('success path (formatWithSessionInstructions)', () => {
    it('emits the prose when isNonStandardId is true and a displaySessionId differs from originalSessionId', () => {
      const result: ToolExecutionResult = { success: true, data: { value: 1 } };
      const sessionInfo: SessionInfo = {
        sessionId: 's-internal-1',
        isNewSession: false,
        isNonStandardId: true,
        originalSessionId: 'planning chat',
        displaySessionId: 'planning chat-2',
        displaySessionIdChanged: true
      };

      const response = formatter.formatToolExecutionResponse(result, sessionInfo);
      const text = getResponseText(response);

      expect(text).toContain('Session name changed');
      expect(text).toContain('"planning chat"');
      expect(text).toContain('"planning chat-2"');
      expect(text).toContain('already exists');
    });

    it('does NOT emit the prose when isNonStandardId is false (handle was unique)', () => {
      const result: ToolExecutionResult = { success: true, data: { value: 1 } };
      const sessionInfo: SessionInfo = {
        sessionId: 's-internal-1',
        isNewSession: false,
        isNonStandardId: false,
        displaySessionId: 'planning chat',
        displaySessionIdChanged: false
      };

      const response = formatter.formatToolExecutionResponse(result, sessionInfo);
      const text = getResponseText(response);

      expect(text).not.toContain('Session name changed');
    });

    it('falls back to originalSessionId when displaySessionId is missing rather than rendering undefined', () => {
      const result: ToolExecutionResult = { success: true, data: {} };
      const sessionInfo: SessionInfo = {
        sessionId: 's-internal-1',
        isNewSession: true,
        isNonStandardId: true,
        originalSessionId: 'orphan handle',
        displaySessionIdChanged: true
      };

      const response = formatter.formatToolExecutionResponse(result, sessionInfo);
      const text = getResponseText(response);

      expect(text).toContain('Session name changed');
      expect(text).toContain('"orphan handle"');
      expect(text).not.toContain('undefined');
    });

    it('omits the prose when there is no sessionInfo at all', () => {
      const result: ToolExecutionResult = { success: true, data: {} };
      const response = formatter.formatToolExecutionResponse(result);
      const text = getResponseText(response);

      expect(text).not.toContain('Session name changed');
    });
  });

  describe('error path (formatDetailedError)', () => {
    it('prepends the prose to the error body when isNonStandardId + originalSessionId are set', () => {
      const result: ToolExecutionResult = {
        success: false,
        error: 'Tool execution failed: invalid path'
      };
      const sessionInfo: SessionInfo = {
        sessionId: 's-internal-2',
        isNewSession: false,
        isNonStandardId: true,
        originalSessionId: 'debug chat',
        displaySessionId: 'debug chat-3',
        displaySessionIdChanged: true
      };

      const response = formatter.formatToolExecutionResponse(result, sessionInfo);
      const text = getResponseText(response);

      const noticeIndex = text.indexOf('Session name changed');
      const errorIndex = text.indexOf('Tool execution failed');
      expect(noticeIndex).toBeGreaterThanOrEqual(0);
      expect(errorIndex).toBeGreaterThan(noticeIndex);
      expect(text).toContain('"debug chat"');
      expect(text).toContain('"debug chat-3"');
    });

    it('omits the prose on errors when originalSessionId is absent', () => {
      const result: ToolExecutionResult = { success: false, error: 'boom' };
      const sessionInfo: SessionInfo = {
        sessionId: 's-internal-3',
        isNewSession: false,
        isNonStandardId: true
      };

      const response = formatter.formatToolExecutionResponse(result, sessionInfo);
      const text = getResponseText(response);

      expect(text).not.toContain('Session name changed');
      expect(text).toContain('boom');
    });
  });
});
