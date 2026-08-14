#!/usr/bin/env python3
"""Check that the Nexus repo is in a releasable state before a tag is pushed.

ERRORS reproduce, locally and for free, the exact `Validate version metadata`
guard in .github/workflows/release.yml:

  1. package.json version is a bare X.Y.Z
  2. manifest.json version equals it
  3. versions.json has an entry keyed by it
  4. with --tag: the tag equals it and is itself a bare X.Y.Z (the workflow's
     tag filter has no `v` prefix, and a non-matching tag fires nothing at all)

A non-zero exit here is a release that would have failed after the tag existed.

WARNINGS are drift the workflow tolerates but that still ships wrong: a stale
lockfile version, a versions.json entry whose minAppVersion disagrees with the
manifest, a missing changelog entry, hand-reformatted version files, and a
workflow trigger that no longer matches what this check assumes.

Stdlib only. Does not need node_modules, does not run git, changes nothing.

Usage:
  python3 check_release_ready.py                 # check the working tree as-is
  python3 check_release_ready.py --tag 5.9.1     # also check the tag you will push
  python3 check_release_ready.py --repo /path/to/nexus --strict

Exit 0 when clean, 1 when an error is found (or --strict and any warning),
2 on usage error.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
WORKFLOW = Path(".github") / "workflows" / "release.yml"


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, where: str, message: str) -> None:
        self.errors.append(f"{where}: {message}")

    def warn(self, where: str, message: str) -> None:
        self.warnings.append(f"{where}: {message}")


def find_repo_root(start: Path) -> Path | None:
    """Nearest ancestor holding both package.json and manifest.json."""
    for candidate in [start, *start.parents]:
        if (candidate / "package.json").is_file() and (candidate / "manifest.json").is_file():
            return candidate
    return None


def locate(path: Path, needle: str) -> str:
    """Return 'file:line' for the first line containing needle, else 'file'."""
    rel = path.name
    try:
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if needle in line:
                return f"{rel}:{i}"
    except OSError:
        pass
    return rel


def load_json(path: Path, report: Report) -> dict | None:
    if not path.is_file():
        report.error(path.name, "file is missing")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        report.error(path.name, f"cannot be parsed: {exc}")
        return None


def check_versions(root: Path, tag: str | None, report: Report) -> str | None:
    pkg = load_json(root / "package.json", report)
    manifest = load_json(root / "manifest.json", report)
    versions = load_json(root / "versions.json", report)
    if pkg is None or manifest is None or versions is None:
        return None

    version = str(pkg.get("version", ""))
    where_pkg = locate(root / "package.json", '"version"')
    if not SEMVER.match(version):
        report.error(where_pkg, f"version {version!r} is not a bare X.Y.Z")
        return None

    manifest_version = str(manifest.get("version", ""))
    if manifest_version != version:
        report.error(
            locate(root / "manifest.json", '"version"'),
            f"version {manifest_version!r} != package.json {version!r} "
            "-- the workflow guard rejects this",
        )

    if version not in versions:
        report.error(
            "versions.json",
            f"no entry for {version!r} -- the workflow guard rejects this. "
            "Bump with `npm version <bump> --no-git-tag-version`, which runs "
            "version-bump.mjs and writes the entry",
        )
    else:
        min_app = str(manifest.get("minAppVersion", ""))
        recorded = str(versions[version])
        if min_app and recorded != min_app:
            report.warn(
                locate(root / "versions.json", f'"{version}"'),
                f"maps to {recorded!r} but manifest.json minAppVersion is "
                f"{min_app!r}; the workflow does not check this",
            )

    if tag is not None:
        if not SEMVER.match(tag):
            report.error(
                "tag",
                f"{tag!r} is not a bare X.Y.Z -- the workflow's tag filter will "
                "not match it and nothing will run, silently",
            )
        elif tag != version:
            report.error("tag", f"{tag!r} != package.json version {version!r}")

    return version


def check_lockfile(root: Path, version: str, report: Report) -> None:
    lock_path = root / "package-lock.json"
    if not lock_path.is_file():
        report.warn("package-lock.json", "missing; the workflow runs `npm ci`, which requires it")
        return
    lock = load_json(lock_path, report)
    if lock is None:
        return
    root_pkg = lock.get("packages", {}).get("", {})
    stale = {str(lock.get("version", "")), str(root_pkg.get("version", ""))} - {version}
    if stale:
        report.warn(
            locate(lock_path, '"version"'),
            f"records {', '.join(sorted(repr(s) for s in stale))} but package.json "
            f"is {version!r}; `npm ci` tolerates this, but it is the signature of a "
            "hand-edited bump -- `npm version` keeps them together",
        )


def check_changelog(root: Path, version: str, report: Report) -> None:
    changelog = root / "docs" / "changelog.md"
    if not changelog.is_file():
        report.warn("docs/changelog.md", "not found; skipping the changelog check")
        return
    text = changelog.read_text(encoding="utf-8")
    if f"**v{version}**" not in text and version not in text:
        report.warn(
            "docs/changelog.md",
            f"no entry mentioning {version}; the release ships without a curated "
            "changelog entry",
        )


def check_formatting(root: Path, report: Report) -> None:
    """versions.json is written tab-indented by version-bump.mjs. Space
    indentation there means someone edited it by hand.

    manifest.json is deliberately NOT checked: version-bump.mjs rewrites it with
    2-space indentation regardless of what it had, so its indentation says
    nothing about how the bump was done."""
    path = root / "versions.json"
    if not path.is_file():
        return
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines()[1:] if ln.strip()]
    indented = [ln for ln in lines if ln[:1] in (" ", "\t")]
    if indented and not any(ln.startswith("\t") for ln in indented):
        report.warn(
            "versions.json",
            "is not tab-indented; version-bump.mjs writes tabs, so this file was "
            "probably hand-edited",
        )


def check_workflow(root: Path, report: Report) -> None:
    """Confirm this script's core assumption still holds: the release trigger is
    a bare version tag. If the workflow changes, this warns instead of quietly
    validating against a rule that no longer exists."""
    path = root / WORKFLOW
    if not path.is_file():
        report.warn(str(WORKFLOW), "not found; cannot confirm the release trigger")
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    patterns: list[str] = []
    in_tags = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("tags:"):
            in_tags = True
            continue
        if in_tags:
            if stripped.startswith("- "):
                patterns.append(stripped[2:].strip().strip("'\""))
                continue
            if stripped:
                break
    if not patterns:
        report.warn(str(WORKFLOW), "no `tags:` trigger patterns found; the release may not be tag-driven any more")
        return
    if all(p.startswith("v") for p in patterns):
        report.warn(
            str(WORKFLOW),
            f"trigger patterns {patterns} all expect a `v` prefix -- this skill "
            "assumes bare X.Y.Z tags and is out of date",
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--repo",
        default=".",
        help="path inside the Nexus repo (default: cwd); the root is found by walking up",
    )
    parser.add_argument("--tag", help="the tag you intend to push, e.g. 5.9.1")
    parser.add_argument(
        "--strict", action="store_true", help="treat warnings as errors"
    )
    args = parser.parse_args()

    start = Path(args.repo).resolve()
    if not start.is_dir():
        print(f"error: not a directory: {start}", file=sys.stderr)
        return 2
    root = find_repo_root(start)
    if root is None:
        print(
            f"error: no repo root above {start} (looked for package.json + manifest.json)",
            file=sys.stderr,
        )
        return 2

    report = Report()
    version = check_versions(root, args.tag, report)
    if version:
        check_lockfile(root, version, report)
        check_changelog(root, version, report)
    check_formatting(root, report)
    check_workflow(root, report)

    for w in report.warnings:
        print(f"WARN  {w}")
    for e in report.errors:
        print(f"ERROR {e}")

    failed = bool(report.errors) or (args.strict and bool(report.warnings))
    summary = f"{len(report.errors)} error(s), {len(report.warnings)} warning(s)"
    if failed:
        print(f"\nNOT READY: {summary}")
        print("Fix these before tagging. Recovery after a bad tag: protocols/recover.md")
        return 1

    print(f"\nREADY: {summary}" + (f" -- tag {args.tag} will pass the workflow guard" if args.tag else ""))
    print(
        "\nNEXT: a clean check is not a release. Commit and push main, then push "
        "the bare tag:\n"
        f"  git tag {args.tag or 'X.Y.Z'} && git push origin {args.tag or 'X.Y.Z'}\n"
        "Then verify the run and the published assets: protocols/cut-release.md step 12"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
