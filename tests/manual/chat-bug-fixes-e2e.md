# Manual E2E Test Plan: Chat Stop/Retry/Branch Fixes

> **Date**: 2026-02-05
> **Scope**: 12 bug fixes across stop, retry, tool call display, and branch navigation
> **Prerequisites**: Obsidian with claudesidian-mcp plugin loaded, Claude Desktop configured

---

## Test Environment Setup

1. Open Obsidian with a vault containing at least 5 notes
2. Ensure Claude Desktop is connected (check Settings > MCP Integration)
3. Start a new conversation in the chat view
4. Confirm chat is functional with a simple message

---

## Test Scenarios

### T1: Stop Button Preserves Completed Tool Calls (Bug #1)

**Priority**: P0

**Steps**:
1. Send a message that triggers multiple tool calls (e.g., "Search my vault for notes about X and read the first result")
2. Wait for at least one tool call to complete (shows green checkmark in accordion)
3. Click the Stop button while another tool call is still in progress

**Expected**:
- The completed tool call accordion remains visible with its result
- The incomplete/pending tool call accordion is removed
- The partial text content is preserved
- The message shows "aborted" state (no loading spinner)

**Regression check**:
- Previously, ALL tool calls were removed on stop (toolCalls = undefined)

---

### T2: Retry Preserves Original Content (Bug #2)

**Priority**: P0

**Steps**:
1. Send a message that produces an AI response with tool calls
2. Wait for the response to complete fully
3. Click the Retry button on the AI message
4. While the retry is streaming, observe the UI

**Expected**:
- The original message content stays visible (with a loading overlay)
- The original tool call accordions remain visible underneath the overlay
- After retry completes, a branch navigator ("< 1/2 >") appears
- Switching back to alternative 1 shows the original content + tool calls intact

**Regression check**:
- Previously, retry cleared toolCalls = undefined at start, losing all data

---

### T3: Branch Navigator After Retry (Bug #4)

**Priority**: P0

**Steps**:
1. Generate an AI response
2. Click Retry
3. Wait for the retry to complete

**Expected**:
- A "< 1/2 >" branch navigator appears on the message
- Clicking "<" shows the original response
- Clicking ">" shows the alternative response
- The active alternative is correct (shows the new response)

**Regression check**:
- Previously, branch navigator was not created dynamically after retry

---

### T4: Concurrent Retry Guard (Bug #8)

**Priority**: P1

**Steps**:
1. Generate an AI response
2. Click Retry
3. Immediately click Retry again before the first attempt completes

**Expected**:
- The second click is ignored (no visible error)
- Only one retry stream is active
- After the first retry completes, retry can be clicked again

---

### T5: Stop Retry Mid-Stream (Bug #9)

**Priority**: P1

**Steps**:
1. Generate an AI response with tool calls
2. Click Retry
3. Click Stop while the retry is streaming

**Expected**:
- The loading overlay is removed
- The original content and tool calls reappear (they were never cleared)
- No error message is shown
- The message is back in its original state (no branch created)

---

### T6: Tool Call Persistence Across Reload (Bug #5)

**Priority**: P0

**Steps**:
1. Generate a response with tool calls
2. Click Retry, let it complete
3. Navigate to the branch alternative that has tool calls
4. Close and reopen Obsidian (or use Ctrl+R to reload)
5. Navigate back to the same conversation

**Expected**:
- All tool call accordions are visible with their full data (parameters, results, timing)
- The branch navigator shows the correct position
- Tool accordion expand/collapse still works

---

### T7: Incremental Render Preserves Accordions (Bug #7, #12)

**Priority**: P1

**Steps**:
1. Send a message that triggers multiple tool calls
2. While tool calls are executing (accordions actively updating), send another message or trigger a conversation update

**Expected**:
- In-progress tool accordions continue animating/updating smoothly
- No flash or flicker of the message area
- Completed accordion states are preserved

**Regression check**:
- Previously, any conversation update triggered full re-render, destroying live accordions

---

### T8: Branch Data After Navigation (Bug #10, #11)

**Priority**: P1

**Steps**:
1. Create a conversation with multiple alternatives (retry a message 2-3 times)
2. Navigate to a subagent branch if available
3. Navigate back to the main conversation
4. Switch between alternatives using the branch navigator

**Expected**:
- Each alternative shows the correct content
- Each alternative shows the correct tool calls
- No stale data from a previous alternative is shown
- The conversation does not show streaming/loading state when it should not

---

### T9: Navigator Cleanup on View Switch (Bug #6)

**Priority**: P2

**Steps**:
1. Create an AI response with branches
2. Switch to a different conversation
3. Switch back

**Expected**:
- No memory leak errors in developer console
- Branch navigator re-appears correctly
- No "Cannot read properties of null" errors

---

## Summary Checklist

| Test | Bug(s) | Priority | Pass? |
|------|--------|----------|-------|
| T1: Stop preserves tool calls | #1 | P0 | [ ] |
| T2: Retry preserves original | #2 | P0 | [ ] |
| T3: Branch nav after retry | #4 | P0 | [ ] |
| T4: Concurrent retry guard | #8 | P1 | [ ] |
| T5: Stop retry mid-stream | #9 | P1 | [ ] |
| T6: Tool call persistence | #5 | P0 | [ ] |
| T7: Incremental render | #7, #12 | P1 | [ ] |
| T8: Branch data navigation | #10, #11 | P1 | [ ] |
| T9: Navigator cleanup | #6 | P2 | [ ] |

---

## Notes

- Tests T1-T3 and T6 are P0 (must pass before merge)
- Tests T4-T5 and T7-T8 are P1 (should pass, minor issues acceptable)
- Test T9 is P2 (nice to verify, memory leak is hard to detect manually)
- For T6, use DevTools Application > Storage to verify JSONL contains tool call metadata
