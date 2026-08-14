#!/usr/bin/env python3
"""Turn eval report JSON into a grade, and hold the grade to an attribution.

Reads the machine-readable reports the harness writes next to the markdown ones
(`test-artifacts/eval-report-*.json`) and prints a per-model rollup plus every
failure, each tagged with a bucket derived from the harness's own error text.
The buckets are mechanical — they come from the strings assertions.ts and
EvalRunner.ts emit — so they say WHERE a scenario broke, never WHOSE fault it
was. That judgment is yours: make it with `references/harness-artifacts.md`,
write it into a labels file, and re-run with --labels to have it checked and
tallied.

Reports overlap on purpose: the harness writes one file per model AND a combined
file for the whole run. Records are deduplicated on (model, scenario), newest
run wins, so pointing this at a whole artifacts directory does not double-count.

Usage:
  python summarize_eval.py test-artifacts/                    # rollup + failures
  python summarize_eval.py test-artifacts/eval-report-openrouter-*.json
  python summarize_eval.py test-artifacts/ --labels labels.json

Labels file — a JSON array, one entry per failing (model, scenario):
  [{"model": "<short-model>", "scenario": "<name>",
    "verdict": "model-failure", "note": "never called getTools"}]

  verdict must be one of:
    model-failure    the model got the protocol wrong; counts against its grade
    harness-artifact the harness/fixture made this unwinnable; excluded
    fixture-bug      the scenario itself is wrong; excluded, and worth an issue
    provider-error   transport/auth/rate limit; excluded, re-run instead
    unverified       not yet read; --labels fails while any remain

Exit codes:
  0  summary printed (with --labels: every failure labelled with a valid verdict)
  1  --labels was given and the attribution is incomplete or invalid
  2  usage error, or no report JSON found
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

VERDICTS = ("model-failure", "harness-artifact", "fixture-bug", "provider-error", "unverified")
COUNTS_AGAINST_MODEL = "model-failure"

# Buckets keyed by the harness's own error vocabulary. Order matters: the first
# pattern that matches an error string wins.
BUCKETS: list[tuple[str, re.Pattern[str]]] = [
    ("provider-stream", re.compile(r"^Stream error:", re.I)),
    ("context-contract", re.compile(r"expected top-level|Context-contract:|deprecated args\.")),
    ("hallucinated-tool", re.compile(r"Hallucinated tool call")),
    ("selector-mismatch", re.compile(r"expected selectors")),
    ("command-mismatch", re.compile(r"expected command prefixes")),
    ("missing-tool", re.compile(r"was not called|not found\.|Expected \d+ tool call")),
    ("param-mismatch", re.compile(r'param "')),
]


def bucket_for(error: str) -> str:
    for name, pattern in BUCKETS:
        if pattern.search(error):
            return name
    return "other"


def load_records(paths: list[Path]) -> tuple[list[dict], int]:
    """Load report JSON, newest run per (model, scenario). Returns (records, collapsed)."""
    files: list[Path] = []
    for path in paths:
        if path.is_dir():
            files.extend(sorted(path.glob("eval-report-*.json")))
        elif path.is_file():
            files.append(path)

    best: dict[tuple[str, str], tuple[int, dict]] = {}
    collapsed = 0
    for file in files:
        try:
            payload = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as err:
            print(f"warn: skipping {file}: {err}", file=sys.stderr)
            continue
        started = int(payload.get("startTime") or 0)
        for result in payload.get("results", []):
            key = (str(result.get("model")), str(result.get("scenario")))
            if key in best:
                collapsed += 1
                if best[key][0] >= started:
                    continue
            best[key] = (started, result)
    return [record for _, record in best.values()], collapsed


def failure_lines(record: dict) -> list[str]:
    errors = [error for turn in record.get("turns", []) for error in turn.get("errors", [])]
    if not errors and record.get("error"):
        errors = [str(record["error"])]
    return errors or ["(no error text recorded)"]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Summarize eval report JSON into a per-model grade and bucketed failures.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("paths", nargs="+", help="report JSON files, or a directory containing them")
    parser.add_argument("--labels", help="JSON attribution file; validates and applies it")
    parser.add_argument("--max-error-chars", type=int, default=160, help="truncate each error line")
    args = parser.parse_args()

    records, collapsed = load_records([Path(p) for p in args.paths])
    if not records:
        print("error: no eval report JSON found (expected test-artifacts/eval-report-*.json)", file=sys.stderr)
        return 2

    labels: dict[tuple[str, str], dict] = {}
    if args.labels:
        try:
            raw = json.loads(Path(args.labels).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as err:
            print(f"error: cannot read labels file: {err}", file=sys.stderr)
            return 2
        if not isinstance(raw, list):
            print("error: labels file must be a JSON array", file=sys.stderr)
            return 2
        for entry in raw:
            if not isinstance(entry, dict):
                print(f"error: label entry is not an object: {entry!r}", file=sys.stderr)
                return 2
            labels[(str(entry.get("model")), str(entry.get("scenario")))] = entry

    by_model: dict[str, dict] = {}
    failures: list[dict] = []
    bucket_totals: dict[str, int] = {}

    for record in sorted(records, key=lambda r: (str(r.get("model")), str(r.get("scenario")))):
        model = str(record.get("model"))
        agg = by_model.setdefault(model, {"pass": 0, "fail": 0, "excluded": 0, "retries": 0, "attributed": 0})
        agg["retries"] += int(record.get("retryCount") or 0)
        if record.get("excludedFromBoard"):
            agg["excluded"] += 1
            continue
        if record.get("passed"):
            agg["pass"] += 1
            continue
        agg["fail"] += 1
        errors = failure_lines(record)
        buckets = sorted({bucket_for(error) for error in errors})
        for bucket in buckets:
            bucket_totals[bucket] = bucket_totals.get(bucket, 0) + 1
        failures.append({
            "model": model,
            "scenario": str(record.get("scenario")),
            "buckets": buckets,
            "errors": errors,
            "trace": record.get("tracePath"),
        })

    print("Model                                    Pass  Fail  Rate  Excl  Retries")
    for model, agg in sorted(by_model.items()):
        scored = agg["pass"] + agg["fail"]
        rate = f"{round(100 * agg['pass'] / scored)}%" if scored else "n/a"
        print(f"{model[:40]:<40} {agg['pass']:>5} {agg['fail']:>5} {rate:>5} {agg['excluded']:>5} {agg['retries']:>8}")
    print("\n  Rate excludes scenarios flagged excludeFromBoard (Excl). Retries > 0 means the")
    print("  harness re-ran a failing scenario and it eventually passed — an unstable pass.")
    if collapsed:
        print(f"  {collapsed} duplicate record(s) collapsed across overlapping report files.")

    if bucket_totals:
        print("\nFailures by bucket (where it broke, not whose fault):")
        for bucket, count in sorted(bucket_totals.items(), key=lambda kv: (-kv[1], kv[0])):
            print(f"  {bucket:<20} {count}")

    if failures:
        print("\nFailures:")
        for failure in failures:
            verdict = labels.get((failure["model"], failure["scenario"]), {}).get("verdict", "UNLABELLED")
            print(f"  [{verdict}] {failure['model']} :: {failure['scenario']}  ({', '.join(failure['buckets'])})")
            for error in failure["errors"]:
                flat = " ".join(error.split())
                if len(flat) > args.max_error_chars:
                    flat = flat[: args.max_error_chars] + "…"
                print(f"      {flat}")
            if failure["trace"]:
                print(f"      trace: {failure['trace']}")

    if not args.labels:
        if failures:
            print("\nNEXT: attribute every failure above with protocols/attribute-failures.md,")
            print("      then re-run with --labels to have the attribution checked.")
        return 0

    problems: list[str] = []
    failing_keys = {(f["model"], f["scenario"]) for f in failures}
    for key, entry in labels.items():
        verdict = entry.get("verdict")
        if verdict not in VERDICTS:
            problems.append(f"{key[0]} :: {key[1]}: verdict {verdict!r} is not one of {', '.join(VERDICTS)}")
        elif verdict == "unverified":
            problems.append(f"{key[0]} :: {key[1]}: still 'unverified' — read the calls and decide")
        if key not in failing_keys:
            problems.append(f"{key[0]} :: {key[1]}: labelled but did not fail in these reports")
    for key in sorted(failing_keys - set(labels)):
        problems.append(f"{key[0]} :: {key[1]}: failed but has no label")

    print("\nAttributed grade (only 'model-failure' counts against a model):")
    for model, agg in sorted(by_model.items()):
        charged = sum(
            1
            for failure in failures
            if failure["model"] == model
            and labels.get((model, failure["scenario"]), {}).get("verdict") == COUNTS_AGAINST_MODEL
        )
        scored = agg["pass"] + charged
        rate = f"{round(100 * agg['pass'] / scored)}%" if scored else "n/a"
        print(f"  {model[:40]:<40} {agg['pass']}/{scored} = {rate}  (raw fails {agg['fail']}, charged {charged})")

    if problems:
        print("\nAttribution incomplete:")
        for problem in problems:
            print(f"  {problem}")
        return 1
    print("\nAttribution complete: every failure carries a verdict.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
