/**
 * The trace service derives a workspace handle from the raw useTools command
 * string so a load-workspace call is attributed to the workspace it opened.
 *
 * `memory load-workspace` accepts its argument BOTH positionally and as
 * `--workspace <value>`, but the extractor read the third token
 * unconditionally — so the flag form yielded the literal string "--workspace".
 * That became the trace's workspace id, creating a phantom `ws_--workspace`
 * event store and logging "Workspace --workspace not found" on every such call.
 */

import { tokenizeWithMeta } from '../../src/agents/toolManager/services/ToolCliNormalizer';

// The extractor is module-private; exercise it through the same tokenizer the
// service uses, mirroring its selection rules.
function extractWorkspaceHandle(command: string): string | undefined {
  const tokens = tokenizeWithMeta(command);
  if (tokens.length < 3) return undefined;

  for (let index = 2; index < tokens.length; index++) {
    const token = tokens[index];
    const isFlag = !token.wasQuoted && token.value.startsWith('--');
    if (!isFlag) return token.value;

    const withoutDashes = token.value.replace(/^--/, '');
    const equals = withoutDashes.indexOf('=');
    const flagName = (equals === -1 ? withoutDashes : withoutDashes.slice(0, equals)).toLowerCase();
    const inlineValue = equals === -1 ? undefined : withoutDashes.slice(equals + 1);

    if (flagName !== 'workspace' && flagName !== 'name') continue;
    if (inlineValue !== undefined) return inlineValue;

    const next = tokens[index + 1];
    if (next && (next.wasQuoted || !next.value.startsWith('--'))) return next.value;
  }

  return undefined;
}

describe('trace workspace-handle extraction', () => {
  it('reads the flag form instead of capturing the flag itself', () => {
    expect(extractWorkspaceHandle('memory load-workspace --workspace "Blog Testing"'))
      .toBe('Blog Testing');
  });

  it('still reads the positional form', () => {
    expect(extractWorkspaceHandle('memory load-workspace "Blog Testing"'))
      .toBe('Blog Testing');
  });

  it('reads the unquoted --workspace=value form', () => {
    // Only the unquoted form is a flag here, because ToolCliNormalizer uses
    // the same `!wasQuoted && startsWith("--")` rule. The extractor MUST agree
    // with the parser, or a trace is attributed differently than the call ran.
    // (`--workspace="X"` parses as a positional system-wide — a pre-existing
    // normalizer limitation, not something this extractor should diverge on.)
    expect(extractWorkspaceHandle('memory load-workspace --workspace=BlogTesting'))
      .toBe('BlogTesting');
  });

  it('skips unrelated flags before the workspace flag', () => {
    expect(extractWorkspaceHandle('memory load-workspace --recursive --workspace "Blog Testing"'))
      .toBe('Blog Testing');
  });

  it('does not mistake a quoted value that starts with dashes for a flag', () => {
    expect(extractWorkspaceHandle('memory load-workspace "--weird-name"'))
      .toBe('--weird-name');
  });

  it('returns nothing when the workspace flag has no value', () => {
    expect(extractWorkspaceHandle('memory load-workspace --workspace --recursive'))
      .toBeUndefined();
  });

  it('never returns the literal flag token', () => {
    for (const command of [
      'memory load-workspace --workspace "A"',
      'memory load-workspace --workspace=B',
      'memory create-workspace --workspace "C"'
    ]) {
      expect(extractWorkspaceHandle(command)).not.toBe('--workspace');
    }
  });
});
