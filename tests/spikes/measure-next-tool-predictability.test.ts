/**
 * SPIKE / MEASUREMENT (run locally against a REAL vault — not CI).
 *
 * Answers the one go/no-go question for the steering-nudge idea
 * (docs/plans/agent-steering-nudge-plan.md): on YOUR real tool-call history,
 * what fraction of next-tool transitions clear a high-confidence bar, and how
 * accurate are we there?
 *
 * It reads the JSONL trace store directly (no Obsidian / SQLite needed).
 *
 * RUN:
 *   NEXUS_TRACE_DIR="/abs/path/to/<vault>/Nexus/data" \
 *     npx jest tests/spikes/measure-next-tool-predictability.test.ts
 *
 * (Point NEXUS_TRACE_DIR at the folder that contains `workspaces/`. Without it,
 * the suite is skipped.)
 *
 * ── Corrected 2026-06-13 (after first-run gave a FALSE GREEN). Three fixes: ──
 *  1. WRONG LAYER: the real inner tool is NOT meta.tool (that's always the outer
 *     `toolManager_useTools` wrapper). It lives in `meta.input.arguments`.
 *  2. THREE SCHEMA GENERATIONS (the store spans ~150 days of schema drift):
 *       a) `arguments.calls[]`  — legacy nested {agent, tool, params}
 *       b) `arguments.tool`     — CLI string, v5.9.0+ (comma-separated batches)
 *       c) `batch.results[]`    — execution-result form
 *     Agent + command names are normalized across eras (memoryManager→memory,
 *     create-workspace/createWorkspace→createworkspace) so the same operation
 *     isn't split into two tokens.
 *  3. SELF-LOOP INFLATION: a batched useTools (calls:[read,read,read]) expands to
 *     identical consecutive steps. "next tool == the tool I'm mid-batch on" is
 *     trivially right and useless for prefetch (you already have the batch), so
 *     consecutive duplicate tokens are collapsed before modelling.
 *
 *  Real-data verdict (3 vaults, 2026-06-13): after these corrections exact-tool
 *  prediction is WEAK / workload-dependent — the steering predictor is shelved.
 *  See docs/plans/agent-steering-nudge-plan.md "Phase 0 real-data verdict".
 *
 * This is FREQUENCY-based predictability (the ceiling). It does NOT apply
 * success-weighting — that needs the reward signal and is a later step.
 */

import * as fs from 'fs';
import * as path from 'path';

const TRACE_DIR = process.env.NEXUS_TRACE_DIR;

interface Step { sessionId: string; ts: number; order: number; token: string; family: 'inspect' | 'explore' | 'exploit'; }

// Normalize agent aliases that drifted across schema eras to one token.
const AGENT_ALIAS: Record<string, string> = {
  memory: 'memory', memorymanager: 'memory', state: 'memory',
  search: 'search', searchmanager: 'search',
  content: 'content', contentmanager: 'content',
  storage: 'storage', storagemanager: 'storage',
  canvas: 'canvas', canvasmanager: 'canvas',
  task: 'task', taskmanager: 'task',
  prompt: 'prompt', promptmanager: 'prompt',
  web: 'web', webtools: 'web',
  ingest: 'ingest', ingestmanager: 'ingest',
  compose: 'compose', composer: 'compose',
};
const KNOWN_AGENTS = 'memory|search|content|storage|state|task|prompt|web|canvas|ingest|compose';

function classifyFamily(mode: string): Step['family'] {
  const m = mode.toLowerCase();
  if (/(create|write|replace|insert|update|move|copy|archive|delete|set|save|append|prepend|generate|compose|ingest)/.test(m)) return 'exploit';
  if (/(search|directory|find|list)/.test(m)) return 'explore';
  return 'inspect'; // read/get/load/query/open/…
}

/** agent+command → canonical token, normalized across naming eras. null if unrecognized. */
function toToken(agent: string | undefined, cmd: string | undefined): { token: string; family: Step['family'] } | null {
  const a = AGENT_ALIAS[String(agent ?? '').toLowerCase()];
  const c = String(cmd ?? '').toLowerCase().replace(/[^a-z]/g, ''); // create-workspace == createWorkspace
  if (!a || !c) return null;
  return { token: `${a}_${c}`, family: classifyFamily(c) };
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? v as Record<string, unknown> : {};
}
function str(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }

/** Split a CLI `tool` string into commands on whitespace-gated commas before a known agent. */
function parseCliTool(toolStr: string): Array<{ agent: string; cmd: string }> {
  const out: Array<{ agent: string; cmd: string }> = [];
  const parts = toolStr.split(new RegExp(`,\\s+(?=(?:${KNOWN_AGENTS})\\b)`));
  for (const part of parts) {
    const toks = part.trim().split(/\s+/);
    if (toks[0] && toks[1]) out.push({ agent: toks[0], cmd: toks[1] });
  }
  return out;
}

/** Extract ordered REAL inner tool steps from all trace_added events under the dir. */
function loadSteps(dir: string): Step[] {
  const steps: Step[] = [];
  for (const file of walkJsonl(dir)) {
    let lines: string[];
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt: Record<string, unknown>;
      try { evt = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (evt.type !== 'trace_added') continue;

      const data = rec(evt.data);
      const metaRaw = str(data.metadataJson) ?? str(evt.metadataJson);
      if (!metaRaw) continue;
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(metaRaw) as Record<string, unknown>; } catch { continue; }

      const ctx = rec(meta.context);
      const sessionId = str(ctx.sessionId) ?? str(evt.sessionId) ?? str(data.sessionId);
      const ts = typeof evt.timestamp === 'number' ? evt.timestamp : 0;
      if (!sessionId) continue;

      const push = (agent: string | undefined, cmd: string | undefined, order: number) => {
        const t = toToken(agent, cmd);
        if (t) steps.push({ sessionId, ts, order, token: t.token, family: t.family });
      };

      const args = rec(meta.input).arguments ? rec(rec(meta.input).arguments) : undefined;
      const batch = rec(meta.batch);

      // Schema (a): legacy nested calls[]
      if (args && Array.isArray(args.calls)) {
        args.calls.forEach((c, i) => { const cc = rec(c); push(str(cc.agent), str(cc.tool) ?? str(cc.mode), i); });
      // Schema (c): execution-result batch
      } else if (Array.isArray(batch.results)) {
        batch.results.forEach((r, i) => { const rr = rec(r); push(str(rr.agent), str(rr.tool) ?? str(rr.mode), i); });
      // Schema (b): CLI string (may itself be a comma-batched list)
      } else if (args && str(args.tool)) {
        parseCliTool(str(args.tool)!).forEach((c, i) => push(c.agent, c.cmd, i));
      }
      // else: only the outer toolManager_useTools wrapper — no inner tool to score.
    }
  }
  return steps;
}

function sequences(steps: Step[], key: (s: Step) => string): { id: string; seq: string[]; firstTs: number }[] {
  const bySession = new Map<string, Step[]>();
  for (const s of steps) {
    const list = bySession.get(s.sessionId) ?? [];
    list.push(s);
    bySession.set(s.sessionId, list);
  }
  const out: { id: string; seq: string[]; firstTs: number }[] = [];
  for (const [id, list] of bySession) {
    list.sort((a, b) => a.ts - b.ts || a.order - b.order);
    // Collapse self-loops: intra-batch repetition isn't a prediction worth making.
    const seq = list.map(key).filter((v, i, arr) => i === 0 || v !== arr[i - 1]);
    out.push({ id, seq, firstTs: list[0]?.ts ?? 0 });
  }
  return out;
}

type Model = Map<string, Map<string, number>>;
function buildModel(seqs: string[][], order: 1 | 2): Model {
  const m: Model = new Map();
  for (const seq of seqs) {
    for (let i = order; i < seq.length; i++) {
      const ctx = order === 1 ? seq[i - 1] : `${seq[i - 2]}${seq[i - 1]}`;
      const next = seq[i];
      if (!m.has(ctx)) m.set(ctx, new Map());
      const row = m.get(ctx)!;
      row.set(next, (row.get(next) ?? 0) + 1);
    }
  }
  return m;
}
function topAndConf(row: Map<string, number> | undefined): { pred: string | null; conf: number } {
  if (!row) return { pred: null, conf: 0 };
  let tot = 0, top = 0, pred: string | null = null;
  for (const [k, v] of row) { tot += v; if (v > top) { top = v; pred = k; } }
  return { pred, conf: tot ? top / tot : 0 };
}

function evaluate(model: Model, testSeqs: string[][], order: 1 | 2) {
  const pairs: Array<{ conf: number; correct: boolean }> = [];
  for (const seq of testSeqs) {
    for (let i = order; i < seq.length; i++) {
      const ctx = order === 1 ? seq[i - 1] : `${seq[i - 2]}${seq[i - 1]}`;
      const { pred, conf } = topAndConf(model.get(ctx));
      if (pred === null) continue; // unseen context: we'd stay silent, so don't score it
      pairs.push({ conf, correct: pred === seq[i] });
    }
  }
  const at = (thr: number) => {
    const sel = pairs.filter(p => p.conf >= thr);
    return { coverage: +(sel.length / Math.max(1, pairs.length)).toFixed(3), accuracy: sel.length ? +(sel.filter(p => p.correct).length / sel.length).toFixed(3) : 0, n: sel.length };
  };
  const overall = pairs.length ? pairs.filter(p => p.correct).length / pairs.length : 0;
  return { scored: pairs.length, overall: +overall.toFixed(3), gated: { '0.6': at(0.6), '0.7': at(0.7), '0.8': at(0.8), '0.9': at(0.9) } };
}

(TRACE_DIR ? describe : describe.skip)('MEASURE: next-tool predictability on real traces', () => {
  it('reports confidence-vs-coverage for tool-level and family-level prediction', () => {
    const steps = loadSteps(TRACE_DIR!);
    const toolSeqs = sequences(steps, s => s.token);
    const famSeqs = sequences(steps, s => s.family);

    // Time-ordered split by session start: predict newer from older.
    const split = <T extends { firstTs: number }>(rows: T[]) => {
      const sorted = [...rows].sort((a, b) => a.firstTs - b.firstTs);
      const cut = Math.floor(sorted.length * 0.7);
      return { train: sorted.slice(0, cut).map(r => (r as unknown as { seq: string[] }).seq), test: sorted.slice(cut).map(r => (r as unknown as { seq: string[] }).seq) };
    };

    const tool = split(toolSeqs);
    const fam = split(famSeqs);
    const vocab = new Set(steps.map(s => s.token)).size;

    const report = {
      _methodology: '3 input schemas parsed (calls[]/tool-CLI/batch.results); agent+command normalized across eras; intra-batch self-loops collapsed',
      sessions: toolSeqs.length,
      totalSteps: steps.length,
      toolVocab: vocab,
      avgSessionLen: +(steps.length / Math.max(1, toolSeqs.length)).toFixed(1),
      TOOL_LEVEL: {
        bigram: evaluate(buildModel(tool.train, 1), tool.test, 1),
        trigram: evaluate(buildModel(tool.train, 2), tool.test, 2)
      },
      FAMILY_LEVEL_inspect_explore_exploit: {
        bigram: evaluate(buildModel(fam.train, 1), fam.test, 1)
      }
    };

    // eslint-disable-next-line no-console
    console.log('\n=== NEXT-TOOL PREDICTABILITY (real traces) ===\n' + JSON.stringify(report, null, 2) + '\n');

    if (steps.length < 200) {
      // eslint-disable-next-line no-console
      console.warn(`\n[!] Only ${steps.length} trace steps found — results are noisy. Need a few hundred+ for a real read.\n`);
    }

    expect(steps.length).toBeGreaterThan(0); // sanity: we actually found traces
  });
});
