# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-10-08 | Released 5.20.1 from db1d352a after independent Astra review and
  remediation, newest-first model picker checks, clean npm ci/build, shipped
  guidance checks and a clean readiness guard. CI run 37828415997 succeeded;
  the published release has all five assets and successful attestation. The
  broad Windows test run had one unchanged OAuth random-port EACCES failure
  (11/11 passed on rerun), and two Unix-specific suites were excluded. The
  Obsidian CLI was unavailable, so in-app verification was explicitly skipped.
  The release reference still claimed only three assets were attested despite
  the workflow including both versioned tool catalogs. | Corrected the
  attestation description to follow the workflow's subject-path. |
  `references/release-machinery.md`.

2026-10-01 | Cutting 5.19.1 for Sonnet 5.5, GPT-6.1 Sol, and the Codex
reconnect state. The version lifecycle updated metadata and catalogs before the
sandbox blocked its git staging step; retrying the exact target with
`--allow-same-version` finished without another bump. Prior model/auth skill
notes had been saved only in the Codex mirror, so they were preserved in
`.skills/` before syncing. Build, all active Jest assertions, in-app verification,
readiness, and the tag workflow passed; all five assets and attestation were
verified. Jest retained an open handle after its passing summary and the finished
runner was stopped. | Added the partial-bump retry instruction to step 5. |
`protocols/cut-release.md`.

2026-09-08 | Cutting 5.18.6 for GPT-6 Astra and GPT Image 2.5. Clean dependency
install and build passed, the plugin was VERIFIED in the Code vault on
Obsidian 1.13.7, and PR/main CI passed. The numeric tag workflow published all
five expected assets and completed provenance attestation. The readiness
check's missing PR-link warning was reviewed: the changelog covered the actual
model and adapter changes. | No procedure change. | none.

2026-09-02 | Cutting 5.18.4 and 5.18.5 the same day as 5.18.3 (image API
merge, OpenAI image wiring, CLI tools/call timeout). Every step ran as
written, including the `NEXUS_OBSIDIAN_CLI=obsidian-cli` line added that
morning; all three workflows green first try. | No change. | none.

2026-09-02 | Cutting 5.18.3 (clean: patch, one model PR, VERIFIED in-app,
workflow green in 2m41s). The one friction was pre-empted from session memory
rather than from the skill: `verify-in-obsidian.mjs` probes `obsidian` before
`obsidian-cli`, and on macOS `obsidian` resolves to the GUI binary, which
answers intermittently with empty output. The skill never mentioned the
`NEXUS_OBSIDIAN_CLI` override, so a reader without that memory gets a false
SKIPPED or a hang at step 8. | Put `NEXUS_OBSIDIAN_CLI=obsidian-cli` in the
step 8 command with a two-sentence reason. | `protocols/cut-release.md`.

2026-08-27 | Cutting 5.18.1 (clean release). Step 6 said only `npm run build`;
the executor ran `npm ci` first solely because project memory recalled that
local `node_modules` drift from `package-lock.json` broke the 5.16.0 tag. The
workflow runs `npm ci`, so a drifted local install makes the "CI parity check"
not parity at all — the skill knew this in `references/release-machinery.md`
and `recover.md` but the protocol step itself never said to do it. | Added
`npm ci` before `npm run build` in cut-release step 6 with the one-line reason.
| `protocols/cut-release.md`.

2026-08-19 | Release readiness had no guard for the newly required versioned CLI/MCP artifacts. | Added manifest/artifact/version checks and updated release machinery, bump, asset, and verification guidance. | `scripts/check_release_ready.py`, `references/release-machinery.md`, `protocols/cut-release.md`.

2026-08-15 | Cutting 5.17.0. An `**Unreleased**` changelog entry already existed
and read as finished, but it had been written when the first feature of the cycle
landed and covered 2 of the 41 commits since 5.16.4 — Defuddle web capture, the
provider error-frame fix, two new models, Perplexity pricing, the workspace-delete
and IPC-socket fixes were all merged after it and would have shipped undocumented.
`cut-release.md` step 4 already says to verify an existing entry "against what
actually merged", but nothing made that mechanical, and prose loses to an entry
that looks complete. | Added `check_changelog_coverage()` to
`check_release_ready.py`: it diffs the `#NNN` references in the commits since the
previous bare-semver tag against those in the new version's changelog block and
warns with the ones the entry never mentions. A warning, not an error — CI, build
and internal work legitimately earn no bullet, so this is a triage list. Needed
read-only git (`tag`, `log`), so the script's "does not run git" claim was
corrected rather than left wrong; the check skips itself when git cannot answer.
| `scripts/check_release_ready.py`.

2026-08-14 | Skill had never been checked against the repo: it forbade the
`version` npm lifecycle script as "stale" (it is current and correct), listed a
version line in `CLAUDE.md` that does not exist, and named an orphaned
`docs/features/` tree that is gone. It also had no mechanical check, so a
half-done bump could only be caught by the workflow after the tag was pushed. |
Rebuilt as a router plus protocols/references, corrected every claim against the
tree, and added `scripts/check_release_ready.py`, which reproduces the workflow's
version guard locally. | whole skill.

2026-09-17 | Cutting 5.18.7 (clean release). Step 8 said verify reloads
`.obsidian/plugins/nexus/` and to "run your deploy step first" unless that
folder is a symlink. Neither held: the vault's `nexus/` folder held only `data/`,
the live plugin folder was this checkout itself (`claudesidian-mcp/`, manifest id
`nexus`, inside vault `Code`), and `npm run deploy` is a Windows PowerShell
script. The executor had to inspect the vault's plugin folders before trusting
VERIFIED. | Reworded the step-8 paragraph: Obsidian keys on the manifest id, the
in-vault checkout is built in place with nothing to deploy, one `ls` confirms
it, and the deploy script is Windows-only. | `protocols/cut-release.md`.

2026-09-22 | Cutting 5.19.0 (clean minor release). Every step ran as written:
`npm version minor --no-git-tag-version` regenerated the schema catalogs, `npm ci`
+ build left `src/utils/` byte-identical, full Jest green, verify:obsidian said
VERIFIED on the in-vault checkout with no deploy (the 2026-09-17 wording held),
readiness check 0/0, and the run published all five assets with attestation. |
No change. | —

2026-10-08 | Cutting 5.20.0 (clean minor release). Remote agents (#407/#408)
probe every enabled connection at startup and every 30 s, which contradicted
README Network Use ("Nothing is sent when the plugin loads"). No PR had touched
that section, and doc-review's surface table did not name it, so it surfaced
only because the executor happened to check the polling before writing the
disclosure. Also: a leftover `styles.css` edit in the working tree was
byte-identical to upstream #406 and was dropped before the pull. | Added README
**Network Use** to doc-review's surface table, with what to look for (new hosts,
user-entered URLs, requests without a user action) and a grep to find them.
| `protocols/doc-review.md`.

2026-10-12 | Preparing 5.20.2: the Obsidian CLI existed outside PATH and was
disabled, so the earlier availability probe had skipped a usable desktop app.
After the user enabled it, an explicit Obsidian.com path passed the running-app
verification. | Added Windows binary discovery and CLI-toggle guidance to the
release verification step. | `protocols/cut-release.md`.

- 2026-10-13 | Release candidate matched installed files, but CLI reload success retained the old running manifest version. A vault-asserted disable/manifest refresh/enable loaded the new version and fresh error capture stayed clean. | Added bundle, installed-manifest and running-version verification to cut-release step 8.

- 2026-10-13 | Prepared 5.20.4 under the machine's pnpm policy. The version lifecycle generated the release catalogs but pnpm left both npm-lockfile root versions at the previous release. | Documented the version/lifecycle checks and root-only lockfile synchronization; temporary pnpm tooling is not committed. Local Node 24 validation differs from the workflow's pinned Node 20. | `protocols/cut-release.md`.

- 2026-10-14 | Cut 5.21.0 (minor: settings redesign, minAppVersion 1.11.0, Gemini Omni video). Steps ran as written: the Unreleased draft covered #416/#418/#419 but missed most of #417's fixes and every PR link, which the coverage check would not have flagged because #417 was mentioned once. The check did warn about #410, which only appeared in a #416 commit body ("reverses ... PR #410") and had shipped in 5.20.2. verify:obsidian said VERIFIED after copying the bundle into a test vault, confirmed by a vault-asserted running-version check; build on local Node 24 vs CI Node 20.19 and the run published all five assets with attestation. | `check_changelog_coverage()` now ignores references whose squash commit subject is already in the previous release's history, so citations of shipped PRs in commit bodies no longer warn. | `scripts/check_release_ready.py`.

- 2026-10-15 | Cut 5.21.1 (patch: model-free API key checks, #420/#421). Every step ran as written; doc-review's Network Use row caught that opening a provider's settings now fetches its model list. The coverage check, after the 2026-10-14 fix, reported 0 warnings. Readiness 0/0, verify:obsidian VERIFIED with the running version asserted, all five assets published with attestation. | No change. | —

- 2026-10-24 | Planning verification found that newer installed Obsidian types caused lint errors absent with the committed npm lockfile. A pnpm import also needed a temporary hoisted layout for the ESLint config’s transitive globals import. Clarified locked-install parity and temporary pnpm files in protocols/cut-release.md.
