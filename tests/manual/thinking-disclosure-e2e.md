# Thinking disclosure verification

The automated real-app lane is `tests/debug/thinking-disclosure-live-smoke.test.ts`. Use a disposable Obsidian vault, a separate application profile and runtime directory, and the current bundle. Never aim the synthetic provider override at a working vault. Put a `.nexus-thinking-test` marker in the disposable vault. Every evaluation checks the explicit vault identity.

```sh
RUN_THINKING_SMOKE=1 \
THINKING_SMOKE_VAULT='Nexus Thinking Test' \
THINKING_SMOKE_OBSIDIAN=/tmp/nexus-thinking-obsidian \
pnpm exec jest tests/debug/thinking-disclosure-live-smoke.test.ts --runInBand --no-coverage
```

The CLI wrapper above is machine-local and selects the isolated profile's `XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR`. Create an equivalent wrapper on other machines. Follow the repository's headless-Obsidian testing protocol for setup. This lane uses real services, rendering and storage, with an in-process synthetic provider stream; it restores the provider methods and closes the fixture leaf in `finally`.

## Automated acceptance

1. The first reasoning event creates one collapsed accordion with the silver sweep active.
2. Focus the native summary and send Enter. The panel opens and follows to the bottom. CDP `keyDown` includes `text: '\r'` to invoke native keyboard activation.
3. Scroll upward, append reasoning and reconcile the conversation. The panel stays open, keeps its reading position, shows the circular catch-up button and holds outer following.
4. Press catch-up. The panel returns to within eight pixels of the bottom.
5. Complete the response. The header becomes **Reasoning**, with a brain icon and no animation; expansion and bottom position survive; the outer reading hold clears.
6. Read the saved conversation. The final answer, reasoning and segment remain present and the message is complete.

Run provider-free unit tests for the other lifecycle branches: implicit tool/answer boundaries, aborted/failed turns, generation identity, save retry, missing targets, failed prerequisite writes and manual scrolling back to the bottom.

## Additional manual checks

- Check light/dark themes, reduced-motion preference, narrow width and detached windows. Active text must remain readable; reduced motion removes sweep and pulse. The catch-up button has a 44-pixel hit target.
- With outer transcript following already paused, open/catch up the inner panel and verify that it does not resume the outer transcript's independent follow intent.
- Switch conversations and return during generation; verify runtime hydration and no duplicate panel. Inspect tool status across tool rounds and the settled header when reasoning resumes later.
- In the disposable vault only, run **Nexus: Rebuild cache**, wait for completion, then read the fixture through the lower `ConversationService` rather than the runtime-overlay read. Verify the persisted answer and reasoning survive replay.
- Inspect `dev:errors` and console output. Report unrelated errors separately rather than treating all console output as success.

## Recorded run: 2026-10-13

The automated lane passed after clean reload of the isolated Obsidian instance. Cache rebuild preserved the answer, 2,480 characters of reasoning and its segment. The full unit suite and production build also passed; see [implementation notes](../../docs/plans/thinking-disclosure-implementation-notes.md) for counts, evidence paths and limitations. Physical mobile hardware and every additional manual scenario above were not verified in this implementation run.
