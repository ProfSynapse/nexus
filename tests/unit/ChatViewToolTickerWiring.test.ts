/**
 * ChatView tool ticker wiring — source-level guard.
 *
 * The tool ticker regression this protects against: ToolEventCoordinator
 * unsubscribes from the state machine at every turn end (clearToolNameCache),
 * and its re-subscribe (ensureListening/beginTurn) once lived in a streaming
 * branch that no producer ever hits — so the ticker went dark from the second
 * turn on, while the coordinator's unit tests (which call the re-subscribe
 * manually) stayed green.
 *
 * ChatView cannot be instantiated under Jest (ItemView + full plugin wiring),
 * so this guard asserts the wiring at the source level: the turn brackets in
 * handleLoadingStateChanged — the only hook that provably fires for every
 * generation path — must own the coordinator's begin/end lifecycle.
 */

import * as fs from 'fs';
import * as path from 'path';

const CHAT_VIEW_PATH = path.join(__dirname, '../../src/ui/chat/ChatView.ts');

/** Extract a method body from the source by brace matching. */
function extractMethod(source: string, signature: RegExp): string {
  const match = signature.exec(source);
  if (!match) {
    throw new Error(`Method matching ${signature} not found in ChatView.ts`);
  }
  const start = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces after ${signature}`);
}

describe('ChatView — tool ticker turn brackets (source guard)', () => {
  const source = fs.readFileSync(CHAT_VIEW_PATH, 'utf8');
  const loadingHandler = extractMethod(
    source,
    /private handleLoadingStateChanged\s*\(/
  );

  it('re-arms the coordinator on loading start (beginTurn)', () => {
    // Both turn tickers arm together: the in-bubble gap ticker and the tool
    // status subscription. If beginTurn leaves this bracket, the tool ticker
    // dies after the first completed turn — see the pipeline integration test
    // "second turn — beginTurn() re-arms the pipeline".
    const loadingBranch = loadingHandler.split(/\belse\b/)[0];
    expect(loadingBranch).toContain('workingIndicatorController.begin()');
    expect(loadingBranch).toContain('toolEventCoordinator.beginTurn()');
  });

  it('tears the coordinator down on loading end (clearToolNameCache)', () => {
    // Loading-end fires from MessageManager's finally block — completion,
    // abort AND error — so teardown here cannot be skipped by errored turns.
    const elseBranch = loadingHandler.slice(loadingHandler.search(/\belse\b/));
    expect(elseBranch).toContain('toolEventCoordinator.clearToolNameCache()');
  });

  it('does not hang the re-subscribe off the unreachable streaming branch', () => {
    // No producer emits (isComplete=false, isIncremental=false); that branch
    // of handleStreamingUpdate must not be the ticker's lifeline again.
    const streamingHandler = extractMethod(
      source,
      /private handleStreamingUpdate\s*\(/
    );
    expect(streamingHandler).not.toContain('ensureListening');
  });
});
