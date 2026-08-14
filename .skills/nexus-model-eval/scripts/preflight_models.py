#!/usr/bin/env python3
"""Check that every model slug you are about to grade actually exists.

A grading run costs one live API call per scenario per model, and a typo in a
slug does not fail fast — it fails as a wall of stream errors after the matrix
has already spent money on the models that were spelled right. This checks the
slugs first, against OpenRouter's public catalog, which needs no API key.

Only OpenRouter has a keyless public catalog. Targets for other providers are
reported as unverified rather than guessed at — see `nexus-model-updates` for
provider model definitions, and note that a provider's own catalog endpoint
needs its key.

Usage:
  python preflight_models.py openrouter=vendor/model-a openrouter=vendor/model-b
  python preflight_models.py vendor/model-a            # bare slug = openrouter
  python preflight_models.py --catalog cached.json openrouter=vendor/model-a

Exit codes:
  0  every checkable slug was found in the catalog
  1  at least one slug was not found
  2  usage error
  3  the catalog could not be fetched, or nothing was checkable (no verdict)
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

OPENROUTER_CATALOG = "https://openrouter.ai/api/v1/models"


def parse_target(raw: str) -> tuple[str, str]:
    provider, sep, model = raw.partition("=")
    if not sep:
        return "openrouter", raw.strip()
    return provider.strip(), model.strip()


def fetch_catalog(url: str, timeout: float) -> list[dict]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    data = payload.get("data") if isinstance(payload, dict) else payload
    return data if isinstance(data, list) else []


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify model slugs resolve before spending a grading run.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("targets", nargs="+", help="provider=model, or a bare OpenRouter slug")
    parser.add_argument("--catalog", help="read the catalog from a local JSON file instead of the network")
    parser.add_argument("--timeout", type=float, default=20.0, help="network timeout in seconds")
    args = parser.parse_args()

    targets = [parse_target(raw) for raw in args.targets]
    checkable = [model for provider, model in targets if provider == "openrouter"]
    unverified = [(provider, model) for provider, model in targets if provider != "openrouter"]

    for provider, model in unverified:
        print(f"UNVERIFIED  {provider}={model} — no keyless catalog for this provider")

    if not checkable:
        print("\nNothing checkable: no OpenRouter targets given.")
        return 3

    try:
        if args.catalog:
            payload = json.loads(open(args.catalog, encoding="utf-8").read())
            entries = payload.get("data") if isinstance(payload, dict) else payload
            entries = entries if isinstance(entries, list) else []
        else:
            entries = fetch_catalog(OPENROUTER_CATALOG, args.timeout)
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as err:
        print(f"\nCANNOT VERIFY: catalog unavailable ({err}).", file=sys.stderr)
        print("Re-run when the network is reachable, or pass --catalog with a saved copy.", file=sys.stderr)
        return 3

    known = {str(entry.get("id")) for entry in entries if isinstance(entry, dict)}
    if not known:
        print("\nCANNOT VERIFY: catalog parsed but contained no model ids.", file=sys.stderr)
        return 3

    missing = []
    for model in checkable:
        if model in known:
            print(f"FOUND       openrouter={model}")
        else:
            missing.append(model)
            near = sorted(m for m in known if model.split("/")[-1].split(":")[0][:8] in m)[:3]
            hint = f"  did you mean: {', '.join(near)}" if near else ""
            print(f"MISSING     openrouter={model}{hint}")

    print(f"\n{len(checkable) - len(missing)}/{len(checkable)} checkable slug(s) found "
          f"in a catalog of {len(known)}.")
    if missing:
        print("Fix the slug before running the matrix — a bad slug burns the whole run.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
