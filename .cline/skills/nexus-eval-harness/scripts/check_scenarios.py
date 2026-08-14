#!/usr/bin/env python3
"""Structural check for Nexus eval scenario fixtures.

Reads every `*.eval.yaml` under the scenarios directory and reports the
mistakes that make a scenario silently useless rather than red:

  1. A scenario the loader SKIPS (missing `name` or `turns`) — it never runs,
     and nothing in the run output says so.
  2. A field the harness does not know, a wrong type, or a bad `toolSet`.
     The field list and the ToolSetType union are read from tests/eval/types.ts
     at run time, so this check cannot drift from the harness.
  3. An expected tool or a mock-response key that no tool in
     tests/eval/fixtures/tools.ts can ever produce — the assertion is then
     unsatisfiable no matter how well the model behaves.
  4. A CLI selector/command in `params.tool` that resolves to no known agent
     or tool (e.g. `search search-content` when the slug is `search content`).
  5. The forever-loop trap: an exchange whose scripted `getTools` response does
     not expose an agent that same exchange needs. A scripted getTools mock is
     selector-insensitive, so the model asks again, gets the same incomplete
     blob, and loops until the timeout.

Everything it checks is mechanical and derived from the tree. Judgment calls —
is this scenario worth running, is the assertion fair — stay with the author.

Usage:
  python3 check_scenarios.py                     # from the repo root
  python3 check_scenarios.py --root /path/to/nexus
  python3 check_scenarios.py --scenarios tests/eval/scenarios/two-tool-flow.eval.yaml

Exit 0 when clean, 1 when an ERROR is found, 2 on usage error.
Warnings never fail the run.
"""

from __future__ import annotations

import argparse
import os
import re
import sys

# ---------------------------------------------------------------------------
# Minimal YAML subset parser (stdlib only, keeps line numbers)
# ---------------------------------------------------------------------------


class YamlError(Exception):
    def __init__(self, line: int, message: str) -> None:
        super().__init__(message)
        self.line = line
        self.message = message


class Map(dict):
    """Mapping node that remembers the line each key was declared on."""

    def __init__(self) -> None:
        super().__init__()
        self.lines: dict = {}
        self.line = 0


class Seq(list):
    """Sequence node that remembers the line each item started on."""

    def __init__(self) -> None:
        super().__init__()
        self.item_lines: list = []
        self.line = 0


def _strip_comment(text: str) -> str:
    quote = None
    escaped = False
    for i, char in enumerate(text):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
            continue
        if char == "#" and (i == 0 or text[i - 1] in " \t"):
            return text[:i]
    return text


def _looks_like_mapping(text: str) -> bool:
    """True when a sequence item opens a mapping rather than holding a scalar."""
    quote = None
    escaped = False
    for i, char in enumerate(text):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
            continue
        if char == ":" and (i + 1 == len(text) or text[i + 1] in " \t"):
            return True
    return False


def _scalar(raw: str, line: int):
    text = raw.strip()
    if text in ("[]",):
        empty_seq = Seq()
        empty_seq.line = line
        return empty_seq
    if text in ("{}",):
        empty_map = Map()
        empty_map.line = line
        return empty_map
    if text and text[0] in "[{":
        raise YamlError(line, "flow collections with content are not supported by this checker")
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    if text in ("true", "True"):
        return True
    if text in ("false", "False"):
        return False
    if text in ("null", "~", ""):
        return None
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?\d+\.\d+", text):
        return float(text)
    return text


class Parser:
    def __init__(self, text: str) -> None:
        self.raw = text.splitlines()
        self.pos = 0

    def _indent(self, index: int) -> int:
        line = self.raw[index]
        return len(line) - len(line.lstrip(" "))

    def _skip_blank(self) -> None:
        while self.pos < len(self.raw):
            body = _strip_comment(self.raw[self.pos]).strip()
            if body:
                return
            self.pos += 1

    def parse_document(self):
        self._skip_blank()
        if self.pos >= len(self.raw):
            return None
        return self.parse_node(self._indent(self.pos))

    def parse_node(self, indent: int):
        self._skip_blank()
        if self.pos >= len(self.raw):
            return None
        body = _strip_comment(self.raw[self.pos]).strip()
        if body.startswith("- "):
            return self.parse_seq(indent)
        return self.parse_map(indent)

    def parse_seq(self, indent: int) -> Seq:
        seq = Seq()
        seq.line = self.pos + 1
        while True:
            self._skip_blank()
            if self.pos >= len(self.raw):
                break
            if self._indent(self.pos) != indent:
                break
            body = _strip_comment(self.raw[self.pos]).strip()
            if not body.startswith("-"):
                break
            item_line = self.pos + 1
            rest = body[1:].lstrip()
            offset = self.raw[self.pos].index("-") + 1
            if rest and not _looks_like_mapping(rest):
                # Plain scalar item, e.g. `- 'content read "path" 1'`.
                value = _scalar(rest, item_line)
                self.pos += 1
            elif rest:
                # Inline mapping — rewrite the line so the item body parses as a
                # node at the column where its content starts.
                lead = len(self.raw[self.pos]) - len(self.raw[self.pos].lstrip(" "))
                content_col = self.raw[self.pos].index(rest[0], lead + 1)
                self.raw[self.pos] = " " * content_col + rest
                value = self.parse_node(content_col)
            else:
                self.pos += 1
                self._skip_blank()
                if self.pos < len(self.raw) and self._indent(self.pos) > indent:
                    value = self.parse_node(self._indent(self.pos))
                else:
                    value = None
                    _ = offset
            seq.append(value)
            seq.item_lines.append(item_line)
        return seq

    def parse_map(self, indent: int) -> Map:
        node = Map()
        node.line = self.pos + 1
        while True:
            self._skip_blank()
            if self.pos >= len(self.raw):
                break
            if self._indent(self.pos) != indent:
                break
            body = _strip_comment(self.raw[self.pos]).rstrip()
            stripped = body.strip()
            if stripped.startswith("- "):
                break
            match = re.match(r"^(\"[^\"]+\"|'[^']+'|[^:]+):(.*)$", stripped)
            if not match:
                raise YamlError(self.pos + 1, f"cannot parse line: {stripped!r}")
            key = match.group(1).strip().strip("\"'")
            value_text = match.group(2).strip()
            key_line = self.pos + 1

            if value_text in ("|", "|-", "|+", ">", ">-", ">+"):
                self.pos += 1
                chunk = []
                while self.pos < len(self.raw):
                    line = self.raw[self.pos]
                    if not line.strip():
                        chunk.append("")
                        self.pos += 1
                        continue
                    if self._indent(self.pos) <= indent:
                        break
                    chunk.append(line.strip())
                    self.pos += 1
                value = "\n".join(chunk)
            elif value_text:
                value = _scalar(value_text, key_line)
                self.pos += 1
            else:
                self.pos += 1
                self._skip_blank()
                if self.pos < len(self.raw) and self._indent(self.pos) > indent:
                    value = self.parse_node(self._indent(self.pos))
                elif (
                    self.pos < len(self.raw)
                    and self._indent(self.pos) == indent
                    and _strip_comment(self.raw[self.pos]).strip().startswith("- ")
                ):
                    value = self.parse_seq(indent)
                else:
                    value = None

            node[key] = value
            node.lines[key] = key_line
        return node


def parse_yaml(path: str):
    with open(path, "r", encoding="utf-8") as handle:
        return Parser(handle.read()).parse_document()


# ---------------------------------------------------------------------------
# Reading the harness's own contracts out of the tree
# ---------------------------------------------------------------------------


def to_kebab(value: str) -> str:
    """Mirror of toKebabCase in tests/eval/EvalToolExecutor.ts."""
    value = re.sub(r"Manager$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"Agent$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", value)
    value = re.sub(r"[_\s]+", "-", value)
    value = re.sub(r"--+", "-", value)
    return value.lower()


def read_interface_fields(source: str, name: str) -> dict:
    """Return {field: (ts_type, required)} for an exported TS interface."""
    match = re.search(r"export interface %s \{(.*?)\n\}" % re.escape(name), source, re.S)
    if not match:
        return {}
    fields = {}
    for line in match.group(1).splitlines():
        text = line.strip()
        if text.startswith("*") or text.startswith("/") or not text:
            continue
        field = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)(\?)?:\s*(.+?);", text)
        if field:
            fields[field.group(1)] = (field.group(3).strip(), field.group(2) is None)
    return fields


def read_union(source: str, name: str) -> list:
    match = re.search(r"export type %s\s*=\s*([^;]+);" % re.escape(name), source, re.S)
    if not match:
        return []
    return re.findall(r"'([^']+)'", match.group(1))


def read_tool_names(source: str, const: str) -> list:
    match = re.search(r"export const %s: Tool\[\] = \[(.*?)\n\];" % re.escape(const), source, re.S)
    if not match:
        return []
    return re.findall(r"^\s*name: '([A-Za-z0-9_]+)',", match.group(1), re.M)


def python_type_ok(value, ts_type: str, enums: dict) -> bool:
    ts_type = ts_type.strip()
    if ts_type in enums:
        return isinstance(value, str) and value in enums[ts_type]
    if ts_type == "boolean":
        return isinstance(value, bool)
    if ts_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if ts_type == "string":
        return isinstance(value, str)
    if ts_type.endswith("[]"):
        return isinstance(value, list)
    if ts_type.startswith("Record<"):
        return isinstance(value, dict)
    return True


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


class Report:
    def __init__(self) -> None:
        self.errors = 0
        self.warnings = 0

    def error(self, path: str, line, message: str) -> None:
        self.errors += 1
        print(f"{path}:{line or 0}: ERROR {message}")

    def warn(self, path: str, line, message: str) -> None:
        self.warnings += 1
        print(f"{path}:{line or 0}: WARN  {message}")


def split_segments(value: str) -> list:
    segments, current, quote, escaped = [], "", None, False
    for char in value:
        if escaped:
            current += char
            escaped = False
            continue
        if char == "\\":
            current += char
            escaped = True
            continue
        if char in "\"'" and (quote is None or quote == char):
            quote = None if quote == char else char
            current += char
            continue
        if char == "," and not quote:
            if current.strip():
                segments.append(current.strip())
            current = ""
            continue
        current += char
    if current.strip():
        segments.append(current.strip())
    return segments


def tokenize(value: str) -> list:
    return [token.strip("\"'") for token in value.split() if token.strip()]


def exchanges_of(turns: list) -> list:
    """Group turns the way EvalRunner.groupTurnsIntoExchanges does."""
    grouped, current = [], None
    for turn in turns:
        if isinstance(turn, dict) and turn.get("userMessage"):
            current = [turn]
            grouped.append(current)
        elif current is not None:
            current.append(turn)
        else:
            current = [turn]
            grouped.append(current)
    return grouped


def agents_exposed(response) -> set:
    """Agent aliases a scripted getTools payload actually advertises."""
    exposed = set()
    if not isinstance(response, dict):
        return exposed
    result = response.get("result")
    tools = result.get("tools") if isinstance(result, dict) else None
    if not isinstance(tools, list):
        return exposed
    for entry in tools:
        if not isinstance(entry, dict):
            continue
        agent = entry.get("agent")
        if isinstance(agent, str) and agent:
            exposed.add(to_kebab(agent))
            continue
        command = entry.get("command")
        if isinstance(command, str) and command.strip():
            exposed.add(to_kebab(tokenize(command)[0]))
    return exposed


def check_file(path: str, rel: str, contracts: dict, report: Report, seen_names: dict, counter: dict) -> None:
    try:
        document = parse_yaml(path)
    except YamlError as err:
        report.error(rel, err.line, f"unparsable: {err.message}")
        return

    if not isinstance(document, list):
        report.error(rel, 1, "top level is not a list of scenarios — ScenarioLoader skips this whole file")
        return

    scenario_fields = contracts["scenario_fields"]
    turn_fields = contracts["turn_fields"]
    expected_fields = contracts["expected_fields"]
    enums = contracts["enums"]
    tool_names = contracts["tool_names"]
    domain_index = contracts["domain_index"]

    for index, scenario in enumerate(document):
        counter["entries"] = counter.get("entries", 0) + 1
        line = document.item_lines[index] if isinstance(document, Seq) else 0
        if not isinstance(scenario, dict):
            report.error(rel, line, "scenario entry is not a mapping")
            continue

        name = scenario.get("name")
        if not isinstance(name, str) or not name.strip():
            report.error(rel, line, "missing `name` — ScenarioLoader silently skips this scenario")
            continue
        turns = scenario.get("turns")
        if not isinstance(turns, list) or not turns:
            report.error(rel, scenario.lines.get("turns", line), f"`{name}`: missing or empty `turns` — ScenarioLoader silently skips this scenario")
            continue

        if name in seen_names:
            report.error(rel, scenario.lines.get("name", line), f"duplicate scenario name `{name}` (also in {seen_names[name]}) — EVAL_SCENARIO_NAMES and the report tables cannot tell them apart")
        else:
            seen_names[name] = rel

        for field, (ts_type, required) in scenario_fields.items():
            if required and field not in scenario:
                report.error(rel, line, f"`{name}`: missing required field `{field}` (tests/eval/types.ts EvalScenario)")
        for field, value in scenario.items():
            if field not in scenario_fields:
                report.warn(rel, scenario.lines.get(field, line), f"`{name}`: unknown field `{field}` — not in EvalScenario (tests/eval/types.ts); the harness ignores it")
                continue
            if not python_type_ok(value, scenario_fields[field][0], enums):
                report.error(rel, scenario.lines.get(field, line), f"`{name}`: field `{field}` should be {scenario_fields[field][0]}, got {type(value).__name__} {value!r}")

        sequential = scenario.get("sequentialMockResponses") is True

        for turn in turns:
            if not isinstance(turn, dict):
                report.error(rel, line, f"`{name}`: a turn is not a mapping")
                continue
            turn_line = turn.line if isinstance(turn, Map) else line
            for field, (ts_type, required) in turn_fields.items():
                if not required or field in turn:
                    continue
                if field == "expectedTools":
                    # EvalRunner flatMaps round.expectedTools without a guard.
                    report.error(rel, turn_line, f"`{name}`: turn has no `expectedTools` — EvalRunner reads it unguarded and the scenario throws")
                else:
                    report.warn(rel, turn_line, f"`{name}`: turn has no `{field}`, which EvalTurn declares required (tests/eval/types.ts). The runner guards it, so this only means the turn scripts nothing")
            for field, value in turn.items():
                if field not in turn_fields:
                    report.warn(rel, turn.lines.get(field, turn_line), f"`{name}`: unknown turn field `{field}` — not in EvalTurn (tests/eval/types.ts)")
                    continue
                if not python_type_ok(value, turn_fields[field][0], enums):
                    report.error(rel, turn.lines.get(field, turn_line), f"`{name}`: turn field `{field}` should be {turn_fields[field][0]}, got {type(value).__name__}")

            for expected in turn.get("expectedTools") or []:
                if not isinstance(expected, dict):
                    report.error(rel, turn_line, f"`{name}`: expectedTools entry is not a mapping")
                    continue
                exp_line = expected.line if isinstance(expected, Map) else turn_line
                for field, value in expected.items():
                    if field not in expected_fields:
                        report.warn(rel, expected.lines.get(field, exp_line), f"`{name}`: unknown expectedTools field `{field}` — not in ExpectedToolCall")
                tool_name = expected.get("name")
                if not isinstance(tool_name, str) or not tool_name:
                    report.error(rel, exp_line, f"`{name}`: expectedTools entry has no `name`")
                    continue
                if tool_name not in tool_names:
                    report.error(rel, exp_line, f"`{name}`: expects tool `{tool_name}`, which is in neither META_TOOLS nor NEXUS_TOOLS (tests/eval/fixtures/tools.ts) — the assertion can never pass")
                    continue
                params = expected.get("params")
                selector = params.get("tool") if isinstance(params, dict) else None
                if isinstance(selector, str) and tool_name in ("getTools", "useTools"):
                    check_selector(rel, name, tool_name, selector, exp_line, domain_index, report)

            responses = turn.get("mockResponses")
            if isinstance(responses, dict):
                for key, response in responses.items():
                    key_line = responses.lines.get(key, turn_line)
                    if key not in tool_names:
                        report.error(rel, key_line, f"`{name}`: mockResponses key `{key}` matches no tool in tests/eval/fixtures/tools.ts — it will never be used")
                    if not isinstance(response, dict) or "success" not in response:
                        report.error(rel, key_line, f"`{name}`: mockResponses[{key}] must be a mapping with a `success` field (MockToolResponse)")

        check_discovery(rel, name, scenario, turns, sequential, domain_index, report)


def check_selector(rel, name, tool_name, selector, line, domain_index, report) -> None:
    for segment in split_segments(selector):
        tokens = tokenize(segment)
        if not tokens:
            continue
        if tokens[0].startswith("--"):
            continue  # `--help` and friends are legal selectors
        agent = to_kebab(tokens[0])
        tool = to_kebab(tokens[1].lstrip("-")) if len(tokens) > 1 and not tokens[1].startswith("--") else None
        if agent not in domain_index:
            report.error(rel, line, f"`{name}`: {tool_name} params.tool selector `{segment}` names agent `{agent}`, which no NEXUS_TOOLS entry provides")
            continue
        if tool_name == "useTools" and tool is None:
            report.error(rel, line, f"`{name}`: useTools params.tool `{segment}` has no command — a useTools command needs `<agent> <tool>`")
            continue
        if tool and tool not in domain_index[agent]:
            report.error(rel, line, f"`{name}`: {tool_name} params.tool `{segment}` names tool `{tool}` on agent `{agent}`; known tools are [{', '.join(sorted(domain_index[agent]))}]")


def check_discovery(rel, name, scenario, turns, sequential, domain_index, report) -> None:
    """The forever-loop trap: a scripted getTools payload is selector-blind."""
    for exchange in exchanges_of(turns):
        scripted = []
        needed = set()
        first_line = None
        for turn in exchange:
            if not isinstance(turn, dict):
                continue
            responses = turn.get("mockResponses")
            if isinstance(responses, dict) and "getTools" in responses:
                scripted.append((responses["getTools"], responses.lines.get("getTools", turn.line)))
                if first_line is None:
                    first_line = responses.lines.get("getTools", turn.line)
            for expected in turn.get("expectedTools") or []:
                if not isinstance(expected, dict):
                    continue
                tool_name = expected.get("name")
                params = expected.get("params")
                if tool_name == "useTools" and isinstance(params, dict) and isinstance(params.get("tool"), str):
                    for segment in split_segments(params["tool"]):
                        tokens = tokenize(segment)
                        if tokens and not tokens[0].startswith("--"):
                            needed.add(to_kebab(tokens[0]))
                elif isinstance(tool_name, str) and "_" in tool_name:
                    needed.add(to_kebab(tool_name.split("_")[0]))

        if not scripted:
            continue

        if len(scripted) > 1 and not sequential:
            report.warn(
                rel,
                scripted[-1][1],
                f"`{name}`: this exchange scripts `getTools` more than once. Without `sequentialMockResponses: true` the LAST one wins for every getTools call in the exchange (last-write-wins), including the earlier rounds'",
            )

        effective = [payload for payload, _ in scripted] if sequential else [scripted[-1][0]]
        exposed = set()
        for payload in effective:
            exposed |= agents_exposed(payload)
        if not exposed:
            report.warn(rel, first_line, f"`{name}`: scripted `getTools` response exposes no `agent`/`command` entries — the model gets an empty catalog")
            continue
        missing = sorted(agent for agent in needed if agent not in exposed and agent in domain_index)
        if missing:
            report.error(
                rel,
                first_line,
                f"`{name}`: this exchange needs agent(s) [{', '.join(missing)}] but its scripted `getTools` response only exposes [{', '.join(sorted(exposed))}]. A scripted getTools mock ignores the requested selector (registerStaticResponse discards its args), so the model re-asks, gets the same blob, and loops until the timeout",
            )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def collect_files(target: str) -> list:
    if os.path.isfile(target):
        return [target]
    found = []
    for base, _dirs, files in os.walk(target):
        for filename in sorted(files):
            if filename.endswith(".eval.yaml"):
                found.append(os.path.join(base, filename))
    return sorted(found)


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--root", default=".", help="repo root (default: cwd)")
    parser.add_argument("--scenarios", default="tests/eval/scenarios", help="scenario file or directory, relative to --root")
    parser.add_argument("--types", default="tests/eval/types.ts", help="harness type definitions, relative to --root")
    parser.add_argument("--tools", default="tests/eval/fixtures/tools.ts", help="tool fixtures, relative to --root")
    args = parser.parse_args(argv)

    root = os.path.abspath(args.root)
    types_path = os.path.join(root, args.types)
    tools_path = os.path.join(root, args.tools)
    scenarios_path = os.path.join(root, args.scenarios)

    for required in (types_path, tools_path, scenarios_path):
        if not os.path.exists(required):
            print(f"usage error: not found: {required}", file=sys.stderr)
            print("Run from the repo root, or pass --root.", file=sys.stderr)
            return 2

    with open(types_path, "r", encoding="utf-8") as handle:
        types_source = handle.read()
    with open(tools_path, "r", encoding="utf-8") as handle:
        tools_source = handle.read()

    domain_names = read_tool_names(tools_source, "NEXUS_TOOLS")
    meta_names = read_tool_names(tools_source, "META_TOOLS")
    if not domain_names or not meta_names:
        print(f"usage error: could not read tool names from {tools_path}", file=sys.stderr)
        return 2

    domain_index: dict = {}
    for full in domain_names:
        agent, _, tool = full.partition("_")
        domain_index.setdefault(to_kebab(agent), set()).add(to_kebab(tool))

    contracts = {
        "scenario_fields": read_interface_fields(types_source, "EvalScenario"),
        "turn_fields": read_interface_fields(types_source, "EvalTurn"),
        "expected_fields": read_interface_fields(types_source, "ExpectedToolCall"),
        "enums": {"ToolSetType": read_union(types_source, "ToolSetType")},
        "tool_names": set(domain_names) | set(meta_names),
        "domain_index": domain_index,
    }
    if not contracts["scenario_fields"] or not contracts["turn_fields"]:
        print(f"usage error: could not read EvalScenario/EvalTurn from {types_path}", file=sys.stderr)
        return 2

    files = collect_files(scenarios_path)
    if not files:
        print(f"usage error: no *.eval.yaml under {scenarios_path}", file=sys.stderr)
        return 2

    report = Report()
    seen_names: dict = {}
    counter: dict = {}
    for path in files:
        rel = os.path.relpath(path, root)
        if rel.startswith(".."):
            rel = path
        check_file(path, rel, contracts, report, seen_names, counter)

    print(
        f"\nchecked {len(files)} file(s), {counter.get('entries', 0)} scenario entr(ies): "
        f"{report.errors} error(s), {report.warnings} warning(s)"
    )
    if report.errors:
        print("Fix the errors above, then re-run. See references/scenario-contract.md for what each one means.")
        return 1
    print("NEXT: a structural pass is not a behavioural one. Run the scenario once against a cheap model")
    print("      (protocols/configure-a-run.md) and read the report before trusting it.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
