# Protocol: write a test that can actually fail

Context: the default outcome of writing a Nexus test is a test that passes
forever. Jest maps `obsidian` to `tests/mocks/obsidian/`, most suites supply
their own fakes on top of that, and the assertion then measures the fixtures.
Three search-ranking defects (#309, #313, #314) shipped past a fully green
suite; every one was found by searching a real vault. This protocol is the
procedure that stops that recurring.

## Steps

1. **State the failure you are buying.** Write one sentence: "if <the real
   dependency> behaved like <the bug>, this test goes red." If you cannot write
   that sentence, you are not writing a test yet — go back to the change.

2. **Answer the load-bearing question before choosing a file:** *what is the
   mock deciding?* Read `../references/mock-honesty.md` and apply it. If the
   mock supplies the values the assertion depends on, the test proves the mock
   is self-consistent and nothing else. That answer, not convenience, picks the
   lane.

3. **Place the test.** `../references/lanes.md` gives the three rungs of
   fidelity (mocked Jest → headless real-agent stack → live) and the commands
   that show what exists today. Climb only as far as step 2 requires; a live
   lane you did not need is a lane nobody runs.

4. **If enumeration order could masquerade as ranking, make ties impossible.**
   Route every assertion through a helper that runs the input twice — forward
   and reversed — and fails when the two orders disagree.
   `tests/unit/SearchContentTool.test.ts` is the reference implementation: its
   `rank()` helper is the *only* way its tests obtain results, so a new case
   cannot bypass the guarantee, and a self-test at the bottom asserts the helper
   genuinely rejects a tie. Copy that structure. You MUST NOT rely on
   remembering to reverse by hand.

5. **Write the test, then run only it.**

   ```bash
   npx jest <path/to/the.test.ts> --no-coverage
   ```

6. **Prove it fails.** Break the production code the test is meant to protect,
   re-run, confirm red, restore. A test that has never been red has not been
   shown to work. Do this before you look at the whole suite.

7. **If step 2 said the mock decides the outcome, escalate rather than settle.**
   In order of cost: build the case on the headless agent stack
   (`../references/lanes.md`), add a gated live lane
   (`run-gated-lanes.md`), or verify in the running plugin
   (`live-loop.md`). Escalating is the point of this protocol — a mocked test
   kept because it was easier is the exact shape of the defects that shipped.

8. **Run the full suite and this skill's checks.**

   ```bash
   npm run test
   python3 .claude/skills/nexus-testing/scripts/check_live_lane_gates.py
   ```

   Jest is configured with `roots: ['<rootDir>/tests']` and
   `testMatch: ['**/*.test.ts']`, so `npm run test` collects **every** lane
   including the live and eval ones. Staying out of CI is a property each file
   asserts about itself, never something the runner does for you.

## Guidelines

- Pattern: name the real-world defect in the test's header comment. The next
  person needs to know what the test is buying, not what it calls.
- Pattern: when a mock must stand in for a real scorer, reproduce the *shape*
  of the real behaviour including the part that caused the bug — see the
  bounded-penalty entry in `../references/troubleshooting.md`.
- Anti-pattern: asserting on numeric scores. Assert ordinally ("A outranks B");
  numbers pin the implementation and go vacuous on the next tuning pass.
- Anti-pattern: adding a file to `collectCoverageFrom` in jest.config.js without
  a matching per-file threshold. `npm run test:coverage` applies a global 80
  and the new file drags the whole run red.

## Next

If step 7 escalated, continue at `run-gated-lanes.md` (a gated Jest lane) or
`live-loop.md` (the running plugin). Otherwise this protocol is complete; end
the session at `self-refine.md`.
