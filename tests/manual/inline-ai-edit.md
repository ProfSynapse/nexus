# Manual E2E Test Plan: Inline AI Editing

> **Version**: 1.0.0
> **Feature**: Inline AI Text Editing
> **Date**: 2026-02-05

## Overview

This document outlines manual end-to-end testing procedures for the Inline AI Editing feature. These tests verify the complete user workflow from text selection through AI-powered transformation to final application.

---

## Prerequisites

1. **Obsidian** is running with the Claudesidian plugin installed
2. **LLM provider** is configured (API key set, model selected)
3. A **test note** is open with sample text for editing

---

## Test Environment Setup

Create a test note with the following content:

```markdown
# Test Document

This is a sample paragraph that we will use for testing the inline AI editing feature. It contains some text that could be improved.

## Code Example

```javascript
function oldStyleFunction(x) {
    return x * 2;
}
```

## List Section

- First item needs improvement
- Second item is okay
- Third item could be more concise

> This blockquote has some **formatting** that should be preserved.

Special characters: "quotes" & 'apostrophes' and unicode: 中文 émoji 🚀
```

---

## Test Cases

### TC-001: Happy Path - Basic Text Transformation

**Priority**: P0
**Objective**: Verify basic select → instruct → generate → apply flow

**Steps**:
1. Open the test note
2. Select the sentence: "This is a sample paragraph..."
3. Trigger inline edit via:
   - **Option A**: Right-click → "Edit with AI"
   - **Option B**: Use hotkey (Cmd/Ctrl + Shift + E if configured)
4. In the modal, verify:
   - Selected text is displayed in the preview area
   - Instruction input is focused
   - Model dropdown shows available models
5. Enter instruction: "Make this more concise"
6. Click "Generate"
7. Observe:
   - Loading spinner appears
   - Streaming preview shows text being generated
8. When complete, verify:
   - Original text is shown (collapsed)
   - Edited text is shown in editable textarea
   - Retry, Cancel, Apply buttons are visible
9. Click "Apply"
10. Verify:
    - Modal closes
    - Selected text in editor is replaced with AI-generated text
    - Notice shows "Changes applied"

**Expected Result**: Text successfully transformed and replaced in editor

---

### TC-002: Cancel During Loading

**Priority**: P0
**Objective**: Verify cancellation stops generation and returns to input state

**Steps**:
1. Select any text
2. Open inline edit modal
3. Enter instruction: "Translate to French" (something that takes time)
4. Click "Generate"
5. **Immediately** click "Cancel" while loading spinner is visible
6. Verify:
   - Generation stops
   - Modal returns to INPUT state (instruction input visible)
   - No error message shown
   - Can enter new instruction and try again

**Expected Result**: Clean cancellation without errors

---

### TC-003: Retry from Result State

**Priority**: P1
**Objective**: Verify retry returns to input state and allows regeneration

**Steps**:
1. Complete a successful generation (TC-001 steps 1-8)
2. In RESULT state, click "Retry"
3. Verify:
   - Modal returns to INPUT state
   - Original selected text is preserved
   - Previous instruction may be preserved or cleared (document actual behavior)
4. Enter a different instruction
5. Click "Generate"
6. Verify new result is generated

**Expected Result**: Retry allows iterating on the transformation

---

### TC-004: Error - Empty Instruction

**Priority**: P0
**Objective**: Verify validation prevents empty instruction submission

**Steps**:
1. Select text and open inline edit modal
2. Leave instruction field empty
3. Click "Generate"
4. Verify:
   - Notice appears: "Please enter an instruction"
   - Instruction input is focused
   - Modal stays in INPUT state
   - No API call is made

**Expected Result**: Clear validation feedback, no wasted API calls

---

### TC-005: Context Menu Trigger

**Priority**: P1
**Objective**: Verify context menu entry appears only with selection

**Steps**:
1. Open test note
2. Right-click without selecting any text
3. Verify "Edit with AI" option is **NOT** in the menu
4. Select some text
5. Right-click on the selection
6. Verify "Edit with AI" option **IS** in the menu
7. Click "Edit with AI"
8. Verify modal opens with selected text

**Expected Result**: Context menu respects selection state

---

### TC-006: File Switch During Modal Open (HIGH RISK)

**Priority**: P0 (Flagged by Coder)
**Objective**: Verify error handling when active file changes during modal session

**Steps**:
1. Open test note A
2. Select text and open inline edit modal
3. Complete generation (get to RESULT state)
4. **Without closing the modal**, click on a different note (Note B) in the file explorer
5. Click "Apply" in the modal
6. Verify:
   - Error notice appears (e.g., "The editor has changed. Please try again in the active editor.")
   - Text in Note B is **NOT** modified
   - Text in Note A is **NOT** modified (since it's no longer active)
   - Modal remains open OR closes gracefully

**Expected Result**: Safe failure - no unintended edits to wrong file

---

### TC-007: Rapid Generate/Cancel Sequences (HIGH RISK)

**Priority**: P0 (Flagged by Coder)
**Objective**: Verify stability with rapid user interactions

**Steps**:
1. Select text and open modal
2. Enter instruction
3. Perform rapid sequence:
   - Click "Generate"
   - Immediately click "Cancel"
   - Immediately click "Generate" again
   - Wait for result
4. Verify:
   - No errors or crashes
   - Final state is consistent (either INPUT or RESULT)
   - Modal is responsive

**Variations to test**:
- Generate → Cancel → Generate → Cancel → Generate
- Generate → (wait 1 second) → Cancel → Generate

**Expected Result**: System handles rapid interactions gracefully

---

### TC-008: Model Dropdown Edge Case (MEDIUM RISK)

**Priority**: P1 (Flagged by Coder)
**Objective**: Verify behavior when no models are available

**Steps**:
1. Temporarily disable all LLM providers in settings (remove API keys)
2. Restart Obsidian or reload plugin
3. Select text and attempt to open inline edit modal
4. Verify:
   - Modal opens (or shows helpful error)
   - If modal opens, dropdown shows meaningful state (empty or "No models available")
   - Generate button is disabled OR clicking it shows helpful error

**Expected Result**: Graceful handling of no-models scenario

---

### TC-009: Markdown Preservation

**Priority**: P1
**Objective**: Verify markdown formatting is preserved through transformation

**Steps**:
1. Select the blockquote text: `> This blockquote has some **formatting**...`
2. Open inline edit modal
3. Enter instruction: "Make this more enthusiastic"
4. Generate and Apply
5. Verify:
   - Blockquote syntax (`>`) is preserved
   - Bold formatting (`**...**`) is preserved
   - Result renders correctly in preview mode

**Expected Result**: Markdown formatting survives round-trip

---

### TC-010: Special Characters Preservation

**Priority**: P1
**Objective**: Verify special characters are not corrupted

**Steps**:
1. Select the special characters line: `Special characters: "quotes" & 'apostrophes'...`
2. Open inline edit modal
3. Enter instruction: "Keep this exactly the same but add a period at the end"
4. Generate and Apply
5. Verify:
   - Quotes, ampersand, apostrophes are preserved
   - Unicode Chinese characters (中文) are preserved
   - Emoji (🚀) is preserved

**Expected Result**: No character corruption or encoding issues

---

### TC-011: Undo After Apply (Ctrl/Cmd + Z)

**Priority**: P1
**Objective**: Verify editor undo works after applying AI changes

**Steps**:
1. Note the exact original text
2. Complete a full transformation (TC-001)
3. With cursor in the editor, press Ctrl+Z (Windows/Linux) or Cmd+Z (Mac)
4. Verify:
   - Original text is restored
   - No additional undo steps required

**Expected Result**: Single undo restores original text

---

### TC-012: Code Block Transformation

**Priority**: P1
**Objective**: Verify code blocks can be transformed

**Steps**:
1. Select the code block content (inside the fences)
2. Open inline edit modal
3. Enter instruction: "Convert to arrow function syntax"
4. Generate and Apply
5. Verify:
   - Code is transformed appropriately
   - Syntax highlighting still works
   - No extra escaping introduced

**Expected Result**: Code transformation works correctly

---

### TC-013: Long Text Selection

**Priority**: P2
**Objective**: Verify handling of large text selections

**Steps**:
1. Create or find a note with a very long section (1000+ words)
2. Select the entire long section
3. Open inline edit modal
4. Verify:
   - Selected text preview is truncated appropriately (with "...")
   - Full text is sent to LLM
5. Enter instruction: "Summarize this"
6. Generate and Apply
7. Verify transformation completes without timeout

**Expected Result**: Long text handled within reasonable time

---

### TC-014: Mobile Testing (Hotkey Only)

**Priority**: P2
**Objective**: Verify hotkey access works on mobile (no context menu)

**Steps** (on mobile device or tablet):
1. Open Obsidian mobile app
2. Open a note and select text
3. Use command palette to find "Edit selection with AI"
4. Trigger the command
5. Verify modal opens and workflow functions

**Note**: Context menu is not available on mobile - this is expected behavior per design decision.

**Expected Result**: Feature accessible via command palette on mobile

---

## Test Results Template

| Test ID | Date | Tester | Result | Notes |
|---------|------|--------|--------|-------|
| TC-001 | | | PASS/FAIL | |
| TC-002 | | | PASS/FAIL | |
| TC-003 | | | PASS/FAIL | |
| TC-004 | | | PASS/FAIL | |
| TC-005 | | | PASS/FAIL | |
| TC-006 | | | PASS/FAIL | |
| TC-007 | | | PASS/FAIL | |
| TC-008 | | | PASS/FAIL | |
| TC-009 | | | PASS/FAIL | |
| TC-010 | | | PASS/FAIL | |
| TC-011 | | | PASS/FAIL | |
| TC-012 | | | PASS/FAIL | |
| TC-013 | | | PASS/FAIL | |
| TC-014 | | | PASS/FAIL | |

---

## Known Issues / Limitations

Document any discovered issues here during testing:

1. _[Issue description]_
2. _[Issue description]_

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-02-05 | PACT Test Engineer | Initial test plan |
