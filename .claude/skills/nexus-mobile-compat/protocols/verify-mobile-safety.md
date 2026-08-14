# Protocol: verify mobile safety

Context: a change is ready and touched imports, the startup path, DOM, paths or
dependencies. This is the gate before it lands. `npm run build` now runs the
reachability checker for you (via `npm run lint` → `lint:mobile`), so a violation
cannot reach a release build — but the build is the last line, not the first.
Working the steps below is how you find it before the build does.

## Mission
Prove the change did not put anything on the mobile init path that mobile cannot
run, and did not break a store rule.

## Steps

1. **Run the reachability checker. It MUST exit 0.**
   ```bash
   python3 .claude/skills/nexus-mobile-compat/scripts/check_mobile_imports.py .
   # or, identically, the wired-in form the build uses:
   npm run lint:mobile
   ```
   A violation prints the offending file and line plus the import chain from
   `src/main.ts` that made it reachable. Fix it with
   `import-without-crashing.md`; you can break the chain at any link, and the
   right link is usually the one nearest the leaf.

2. **Compare the startup surface, not just the exit code.** The clean run also
   prints how many modules init loads and which npm packages are on that path.
   Run it before and after a large change: a jump in either number means
   something moved onto the startup path. Loading a package eagerly is not a
   crash, but it is init cost paid by every launch on every device.
   ```bash
   python3 .claude/skills/nexus-mobile-compat/scripts/check_mobile_imports.py . --packages
   ```

3. **Trace anything you are unsure about.**
   ```bash
   python3 .claude/skills/nexus-mobile-compat/scripts/check_mobile_imports.py . --trace path/to/module.ts
   ```
   Use this when a module has a top-level import that is only safe because
   nothing loads it at startup. "Not reachable" is a fact about today's graph, not
   a guarantee.

4. **Run lint.** It carries the store rules that are mechanical, including the
   direct-mutation tripwire and the `src/settings/components/**` import
   blocklist, and then re-runs step 1 as `lint:mobile`. `npm run build` runs it
   first anyway.
   ```bash
   npm run lint
   ```

5. **Review by eye what neither tool sees** — the "not enforced" list in
   `references/plugin-store-rules.md`: inline styles, `innerHTML` with dynamic
   content, raw `addEventListener`, `fetch` instead of `requestUrl`, hardcoded
   storage roots.

6. **Run the tests.**
   ```bash
   npm test
   ```
   `nexus-testing` owns lane choice and the question of whether a mock is
   deciding the outcome. Note that the plugin-store compliance tests replicate
   patterns rather than importing the modules they describe, so a green run there
   is weaker evidence than it looks.

7. **If a real device is available, load it there.** Nothing above proves
   startup on a phone, and this is the one class where a device is cheap and
   decisive. `obsidian dev:mobile on` is NOT a substitute — see
   `references/init-order.md`.

8. **Report, do not silently fix, violations the checker finds outside your
   change.** They are pre-existing latent hazards and belong in an issue with the
   printed chain attached.

## Guidelines
- Pattern: run step 1 before you start as well as after. A baseline turns "is
  this mine?" into a diff.
- Pattern: paste the checker's import chain into the PR description when the fix
  is non-obvious. The chain is the argument.
- Anti-pattern: replacing the checker with a grep because it is faster. Grep
  reports the separate Node-targeted builds and generated asset strings as
  violations, and misses everything transitive.
- Anti-pattern: treating a green run as permanent. It is a statement about the
  current import graph and expires with the next import.

## Next
Terminal for a change. If the session used this skill, finish at
`self-refine.md`; if you are cutting a release, hand off to `nexus-release`.
