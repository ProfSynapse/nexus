# Mock honesty: the two habits

Nexus has already paid for both of these. Three search-ranking defects (#309,
#313, #314) shipped past a fully green suite, and every one was caught only by
searching a real vault. The suite could prove the ranking tiers were ordered
consistently *with a mocked scorer*; it had no way to know whether real vault
data looks like its fixtures, or whether Obsidian's real
`prepareFuzzySearch` scores the way the mock does.

## Habit 1 — ask what the mock is deciding

Before writing the assertion, ask: **if the real dependency behaved differently,
would this test notice?**

If the mock supplies the values the assertion depends on, the answer is no. The
test proves the mock is self-consistent and stops there. Three ways out, in
order of cost:

1. Make the mock reproduce the *shape* of the real behaviour — specifically
   including the part that caused the bug. A mock that is merely plausible
   licenses the same defect again.
2. Move the case to the headless real-agent stack, where the agent code is real
   even though Obsidian is not (`lanes.md`, rung 2).
3. Move it to a live lane or the in-app loop, where the real dependency answers.

The question also runs backwards, and it is the more useful direction: when a
test passes on the first run, find the mock that made that inevitable.

## Habit 2 — prove the ordering is not accidental

Anywhere enumeration order could masquerade as ranking — search results, tool
discovery, any sorted output — a passing assertion may only be reporting the
order the fixtures were declared in.

The fix is structural, not disciplinary. Route every ranking assertion through a
helper that runs the same input **twice, once reversed**, and fails when the two
results disagree. `tests/unit/SearchContentTool.test.ts` is the reference: its
`rank()` helper is the only way any test in the file obtains results, so a new
case cannot skip the check, and a self-test at the bottom asserts the helper
really does reject a tie. Copying that structure is strictly better than
remembering to reverse by hand, because the guarantee survives the next author.

Assert **ordinally** — "A outranks B" — never on numeric scores. Numeric
assertions pin the current tuning and go vacuous the moment it changes.

## Where the ranking mock's honesty actually lives

Two properties of `tests/mocks/obsidian/core.ts` are load-bearing rather than
incidental, and changing either makes the ranking suite vacuous without making
it red. Both are written up as symptoms in `troubleshooting.md`: the **bounded**
per-discontiguity fuzzy penalty, and the fact that the scoring ladder in
`src/agents/searchManager/tools/searchContent.ts` is a **single scale**. Read
those before touching either file.
