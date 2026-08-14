# Protocol: export-subset

Context: someone wants to see the real command and argument shape for some part
of the registry — to answer a question, to write a doc, or to hand an agent's
signatures to a caller. Nothing downstream depends on the file, so the output is
scratch: the default destination (a gitignored path under docs/generated) or
stdout is exactly right. If the artifact is meant to be committed and tested
against, you are in the wrong protocol — use `refresh-catalog.md`.

## Mission
Produce the smallest export that answers the question, from the live normalizer
rather than from source reading or memory.

## Steps
1. Turn the request into a selector. The grammar is `getTools`'s own: `--help`
   for everything, `agent`, or `agent tool`, comma-separated for several. The
   agent token is the CLI alias, not the class or registry name — `webTools` is
   `web`, and a trailing Manager/Agent/Tools is stripped before kebab-casing. Use
   `cli_name.py` in the `nexus-agents` skill to compute one rather than guessing;
   a wrong token makes the exporter throw with the normalizer's own message.
2. Run the exporter with that selector, sending JSON to stdout when you only need
   to read it:

   ```bash
   npm run schemas:tools -- --selector "storage" --output -
   npm run schemas:tools -- --selector "storage move, content read" --output -
   npm run schemas:tools -- --selector "prompt generate-image" --output docs/generated/prompt-image.json
   ```

   With no `--selector` the default is `--help`, which is every registered agent
   except toolManager. With no `--output` the file lands at
   docs/generated/cli-first-tool-schemas.json.
3. If the exporter throws, do not fall back to reading TypeScript by hand and
   describing the shape from it — that is the failure this export exists to
   prevent. Diagnose against `../references/exporter-internals.md` and re-run.
4. Answer from the JSON, quoting `command`, `usage` and the argument flags
   verbatim. Say which selector produced it, so the reader knows the scope.
5. If you wrote a file, note that it is scratch and gitignored, so nothing else
   will read it.

## Guidelines
- Pattern: narrow the selector to the tools actually asked about. A full export
  is a large document to answer a small question with.
- Pattern: remember that the exported schema is always the FULL shape, while a
  live broad `getTools` call returns compact entries. Do not tell a caller they
  will receive this much detail from `--help`.
- Anti-pattern: pasting an export into a doc that the shipped-docs gate reads
  without then running `refresh-catalog.md`. Guidance and catalog must move
  together.

## Next
If the export turned out to be the committed artifact after all, continue with
`refresh-catalog.md`. Otherwise close the session with `self-refine.md`.
