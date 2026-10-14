/**
 * Fit a subagent's inherited context into its context window.
 *
 * A subagent inherits the parent chat's workspace data and context notes, and
 * those go into its system prompt in full. With a subagent context window set
 * (Settings → Defaults → Subagents, or per chat), that inherited context must
 * not crowd out the task: whole items are dropped once the budget is spent and
 * the prompt says which ones, so the subagent knows to read them itself if it
 * needs them. Items are never cut in half. There is no mid-run compaction.
 */

export interface InheritedContextItem {
  /** Shown in the omitted line, e.g. a note path or "workspace context". */
  label: string;
  text: string;
}

export interface FittedInheritedContext {
  included: InheritedContextItem[];
  omitted: string[];
  budgetTokens: number;
}

/**
 * Share of the window kept free for the subagent's instructions, tool
 * schemas, its own tool results and the reply.
 */
const RESERVED_SHARE = 0.25;
const MIN_RESERVED_TOKENS = 4096;

/** Same estimate the context budget service uses: about four characters a token. */
export function estimateInheritedTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

/** Tokens the inherited context may use inside a window of `contextWindow`. */
export function inheritedContextBudget(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const reserved = Math.max(MIN_RESERVED_TOKENS, Math.floor(contextWindow * RESERVED_SHARE));
  return Math.max(0, Math.floor(contextWindow) - reserved);
}

/**
 * Keep items in order while they fit; skip any item that does not, and keep
 * trying the later (possibly smaller) ones. `contextWindow` undefined means
 * no budget, so everything is kept.
 */
export function fitInheritedContext(
  items: InheritedContextItem[],
  contextWindow: number | undefined
): FittedInheritedContext {
  if (contextWindow === undefined) {
    return { included: [...items], omitted: [], budgetTokens: Number.POSITIVE_INFINITY };
  }

  const budgetTokens = inheritedContextBudget(contextWindow);
  let remaining = budgetTokens;
  const included: InheritedContextItem[] = [];
  const omitted: string[] = [];
  for (const item of items) {
    const cost = estimateInheritedTokens(item.text);
    if (cost <= remaining) {
      included.push(item);
      remaining -= cost;
    } else {
      omitted.push(item.label);
    }
  }
  return { included, omitted, budgetTokens };
}

/** "32K", "200K", "1M" — the same short form the settings readout uses. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** The single line that tells the subagent what was left out. */
export function formatOmittedContextLine(omitted: string[], contextWindow: number): string {
  return `Omitted to fit this subagent's ${formatTokenCount(contextWindow)} context window: ${omitted.join(', ')}. Read them with tools if the task needs them.`;
}
