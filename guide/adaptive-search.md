# Adaptive Search (Search That Learns)

Semantic search that gets better the more you use it. Nexus quietly learns from which notes you actually open after a search and tunes future results to your vault — entirely on your machine, with nothing leaving your device.

This builds on [Semantic search](semantic-search.md); set it up first.

---

## How It Works

- **Desktop only** — it rides on the local embedding model from [Semantic search](semantic-search.md).
- **Learns from your behavior, not labels** — when you search and then open one of the results, Nexus notes that as a tiny signal of "this was the useful one."
- **Tunes the query, not your notes** — it learns a small adjustment to how your *searches* are interpreted. Your notes are never re-indexed, so it stays fast and cheap.
- **Identity by default** — until it has actually learned something, search behaves exactly as it does today. Zero change on day one.
- **Private and local** — training runs on-device against your own usage. No behavior, queries, or notes are ever sent anywhere.

---

## "Dreaming"

Every so often, while Nexus is idle, it runs a short consolidation pass — think of it as the system *dreaming* over the day's searches:

1. **Mines** your recent search-then-open history into examples of what was useful.
2. **Trains** a few candidate tunings on that history.
3. **Tests** each one on held-out searches it didn't train on.
4. **Keeps the winner only if it measurably beats what you have now** — otherwise it changes nothing.

Because step 4 is a real test, **your search can never get worse from this** — a tuning is adopted only when it provably helps, and it's always reversible.

When an improvement is adopted, you'll see a brief notice naming what was learned. You can also trigger a pass yourself anytime with the command **"Consolidate retrieval memory (dream now)."**

---

## Best Wins the Round

Rather than betting on one learning method, each dream trains several in parallel and lets the best one win that round — judged on your own data. So the approach that works for *your* vault is chosen by results, not by a guess. Different vaults can end up with different winners.

---

## Keeping Surprises

Learning from your habits risks a filter bubble — only ever showing you what you already click. Nexus guards against that on purpose:

- It learns from the searches where it was **wrong** (you had to dig), not the ones it already got right.
- A tuning is rejected if it makes results narrower, even if it looks more "accurate."
- Occasional wildcard results keep genuinely new connections surfacing.

The goal is search that fits you *and* still surprises you.

---

## Controls

| What | How |
|------|-----|
| Run a consolidation now | Command palette → **Consolidate retrieval memory (dream now)** |
| Reset to baseline | Delete `<vault>/<storage-root>/data/embeddings/adapter.json` (default storage root is `Nexus`) |
| Turn it off | Set `embeddings.retrievalLearning` to `false` in plugin settings |

It runs automatically in the background, so most people never need to touch anything.

---

For the full technical design — the learning objective, the anti-gaming safeguards, the bake-off, and the supporting research — see the plan in [`docs/plans/local-embedding-adapter-plan.md`](../docs/plans/local-embedding-adapter-plan.md).
