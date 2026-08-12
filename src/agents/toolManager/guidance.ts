/**
 * Canonical, model-facing statements of the useTools CLI string contract.
 *
 * Single source for every surface that teaches the contract:
 * - UseToolTool description + parameter schemas (MCP clients)
 * - SystemPromptBuilder (native chat — and the eval harness, which imports
 *   the real builder via tests/eval/fixtures/system-prompt.ts)
 * - guide/native-chat-system-prompt.md embeds them verbatim, pinned by
 *   tests/unit/cliGuidanceDrift.test.ts
 *
 * Editing a rule here updates MCP, native chat, and eval in one place; the
 * drift test fails if the guide mirror is not updated to match.
 *
 * Keep these plain prose — no markdown backticks and no `${` sequences — so
 * each surface can embed them verbatim regardless of medium (MCP description
 * strings, template-literal system prompts, markdown docs).
 */

/** How multiple commands batch inside one tool string. */
export const CLI_BATCHING_RULE =
  'Separate multiple commands with a top-level comma outside quotes ("cmd1, cmd2"); commas inside quoted values stay literal and never split commands.';

/** How multiline content is expressed inline in the tool string. */
export const CLI_MULTILINE_RULE =
  'For multiline content, wrap the value in quotes — literal newlines and escaped ones like "# Title\\n\\nBody" both work, and any double quote inside the value must be escaped as \\". Never flatten multiline content to one line; quoting is enough.';

/** A copy-pasteable inline multiline example. */
export const CLI_MULTILINE_EXAMPLE =
  'content write --path note.md --content "# Title\\n\\nAlpha, beta, gamma"';

/** The verbatim values side-channel for escaping-hostile content. */
export const CLI_VALUES_RULE =
  'For content heavy on backslashes, quotes, or length (code, Windows paths, LaTeX, regex), skip CLI escaping entirely: put the text in the optional top-level "values" map and reference it from the tool string as @key (unquoted). Values are substituted after parsing with no escape processing, so the content arrives exactly as written. Quote the token ("@key") to pass literal text instead, and reference every declared key.';

/** A copy-pasteable values example (shown as the raw JSON payload). */
export const CLI_VALUES_EXAMPLE =
  '{"tool": "content write --path snippet.md --content @body", "values": {"body": "const re = /\\\\d+/;"}}';
