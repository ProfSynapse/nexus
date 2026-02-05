/**
 * Inline Edit Test Fixtures
 *
 * Provides test data for InlineEditService tests including
 * selection fixtures, instruction fixtures, and response fixtures.
 */

import type { InlineEditRequest, SelectionContext, InlineEditState } from '../../src/ui/inline-edit/types';
import type { EditorPosition } from '../mocks/obsidian';

// ============================================================================
// Selection Fixtures
// ============================================================================

export const SELECTIONS = {
  /** Short plain text selection */
  short: 'Hello, world!',

  /** Medium paragraph */
  paragraph: `This is a sample paragraph that contains multiple sentences.
It demonstrates how the inline edit feature handles multi-line text.
The text should be preserved with its formatting intact.`,

  /** Long text (simulating ~5K chars) */
  long: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(100).trim(),

  /** Markdown formatted text */
  markdown: `# Heading

This is a paragraph with **bold** and *italic* text.

- Item 1
- Item 2
- Item 3

> A blockquote here

[A link](https://example.com)`,

  /** Code block */
  codeBlock: `\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export default greet;
\`\`\``,

  /** Inline code */
  inlineCode: 'Use the `console.log()` function to debug your code.',

  /** Text with special characters */
  specialChars: 'Special chars: <script>alert("xss")</script> & "quotes" \'apostrophes\' \u00e9\u00e8\u00ea \u4e2d\u6587 \ud83d\ude00',

  /** Unicode text */
  unicode: '\u4e2d\u6587\u6587\u672c Unicode: \u00e9\u00e0\u00fc\u00f1 Emojis: \ud83d\ude00\ud83d\ude80\ud83c\udf1f',

  /** Empty selection (edge case) */
  empty: '',

  /** Whitespace only */
  whitespace: '   \n\t  \n   ',

  /** Single character */
  singleChar: 'x',

  /** Multi-paragraph */
  multiParagraph: `First paragraph with some content.

Second paragraph continues the thought.

Third paragraph wraps it up.`
};

// ============================================================================
// Instruction Fixtures
// ============================================================================

export const INSTRUCTIONS = {
  /** Simple instruction */
  simple: 'Make this more concise',

  /** Grammar instruction */
  grammar: 'Fix grammar and spelling errors',

  /** Tone change */
  formal: 'Make this more formal and professional',

  /** Translation */
  translate: 'Translate this to French',

  /** Code instruction */
  refactor: 'Refactor this code to use async/await',

  /** Long instruction */
  long: 'Please rewrite this text to be more engaging and professional while maintaining the core message. ' +
        'Add appropriate transitions between sentences, vary the sentence structure, and ensure the tone is ' +
        'suitable for a business audience. Remove any redundant phrases and tighten the prose.',

  /** Instruction with special characters */
  specialChars: 'Change "Hello" to \'Goodbye\' and add <emphasis>',

  /** Empty instruction (edge case) */
  empty: '',

  /** Whitespace only instruction (edge case) */
  whitespace: '   ',

  /** Instruction with newlines */
  multiline: `Do the following:
1. Fix spelling
2. Improve grammar
3. Make more concise`
};

// ============================================================================
// Position Fixtures
// ============================================================================

export function createPosition(line: number, ch: number): EditorPosition {
  return { line, ch };
}

export const POSITIONS = {
  start: createPosition(0, 0),
  middleOfLine: createPosition(0, 10),
  endOfLine: createPosition(0, 50),
  multiLine: {
    from: createPosition(2, 5),
    to: createPosition(5, 20)
  }
};

// ============================================================================
// Request Fixtures
// ============================================================================

export function createRequest(overrides: Partial<InlineEditRequest> = {}): InlineEditRequest {
  return {
    selectedText: SELECTIONS.short,
    instruction: INSTRUCTIONS.simple,
    context: {
      fileName: 'test.md',
      cursorPosition: POSITIONS.start
    },
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4'
    },
    ...overrides
  };
}

export const REQUESTS = {
  /** Basic valid request */
  basic: createRequest(),

  /** Request with markdown content */
  markdown: createRequest({
    selectedText: SELECTIONS.markdown,
    instruction: INSTRUCTIONS.formal
  }),

  /** Request with code */
  code: createRequest({
    selectedText: SELECTIONS.codeBlock,
    instruction: INSTRUCTIONS.refactor
  }),

  /** Request with special characters */
  specialChars: createRequest({
    selectedText: SELECTIONS.specialChars,
    instruction: INSTRUCTIONS.specialChars
  }),

  /** Request with empty instruction (should fail validation) */
  emptyInstruction: createRequest({
    instruction: INSTRUCTIONS.empty
  }),

  /** Request with whitespace-only instruction (should fail validation) */
  whitespaceInstruction: createRequest({
    instruction: INSTRUCTIONS.whitespace
  }),

  /** Request with long text */
  longText: createRequest({
    selectedText: SELECTIONS.long,
    instruction: INSTRUCTIONS.simple
  })
};

// ============================================================================
// Response/Result Fixtures
// ============================================================================

export const RESPONSES = {
  /** Successful simple transformation */
  success: {
    editedText: 'Hello!',
    tokenUsage: { input: 100, output: 50 }
  },

  /** Successful markdown preservation */
  markdownSuccess: {
    editedText: `# Professional Heading

This paragraph demonstrates **bold** and *italic* formatting.

- First item
- Second item
- Third item

> An important quote

[Visit our site](https://example.com)`,
    tokenUsage: { input: 200, output: 150 }
  },

  /** Empty response */
  empty: {
    editedText: '',
    tokenUsage: { input: 100, output: 0 }
  },

  /** Response preserving special characters */
  specialChars: {
    editedText: 'Escaped chars: &lt;script&gt; & "quotes" \'apostrophes\' \u00e9\u00e8\u00ea \u4e2d\u6587 \ud83d\ude00',
    tokenUsage: { input: 150, output: 80 }
  }
};

// ============================================================================
// State Fixtures
// ============================================================================

export const STATES: Record<string, InlineEditState> = {
  input: {
    phase: 'input',
    selectedText: SELECTIONS.short
  },

  loading: {
    phase: 'loading',
    progress: 'Generating...',
    streamedText: 'Partial'
  },

  loadingInitial: {
    phase: 'loading',
    progress: 'Connecting...',
    streamedText: ''
  },

  result: {
    phase: 'result',
    original: SELECTIONS.short,
    edited: 'Modified text'
  },

  error: {
    phase: 'error',
    message: 'Network error occurred',
    lastInstruction: INSTRUCTIONS.simple
  },

  errorNoInstruction: {
    phase: 'error',
    message: 'Please enter an instruction for how to edit the text.'
  }
};

// ============================================================================
// Error Message Fixtures
// ============================================================================

export const ERROR_MESSAGES = {
  /** Empty instruction validation error */
  emptyInstruction: 'Please enter an instruction for how to edit the text.',

  /** Concurrent request error */
  concurrent: 'A generation is already in progress. Please wait or cancel first.',

  /** Network error */
  network: 'Network request failed',

  /** API error */
  api: 'API rate limit exceeded',

  /** Timeout error */
  timeout: 'Request timeout',

  /** Cancelled by user */
  cancelled: 'Cancelled by user',

  /** Unknown error */
  unknown: 'Unknown error occurred'
};

// ============================================================================
// Streaming Chunk Fixtures
// ============================================================================

export const STREAMING_CHUNKS = {
  /** Simple streaming sequence */
  simple: ['Modified', ' ', 'text'],

  /** Word-by-word streaming */
  wordByWord: ['This ', 'is ', 'the ', 'edited ', 'version.'],

  /** Character streaming (simulating slow connection) */
  characterByCharacter: 'Hello'.split(''),

  /** Multi-line streaming */
  multiLine: ['First line\n', 'Second line\n', 'Third line']
};
