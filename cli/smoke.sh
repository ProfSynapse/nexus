#!/usr/bin/env bash
#
# smoke.sh — minimum-viable local smoke test for the Nexus CLI bridge spike.
#
# Bundles cli/nexus-cli.ts and drives it against a LIVE vault: lists vaults,
# handshakes, discovers tools, and runs a read-only execution. Proves the whole
# path (socket → MCP handshake → getTools/useTools → agents) without MCP config.
#
# Requires: Obsidian OPEN with Nexus running (so /tmp/nexus_mcp_*.sock exists).
#
# Usage:
#   cli/smoke.sh [vaultName]
#     vaultName  optional; if omitted and exactly one vault is open, it's used;
#                if multiple are open you MUST pass one (e.g. cli/smoke.sh code)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VAULT="${1:-}"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"
if [[ ! -x "$ESBUILD" ]]; then
  echo "esbuild not found at $ESBUILD — run npm install first." >&2
  exit 1
fi

echo "▸ bundling cli/nexus-cli.ts …"
"$ESBUILD" cli/nexus-cli.ts --bundle --platform=node --target=node18 \
  --outfile="$BUILD_DIR/nexus-cli.js" >/dev/null

NEXUS() { node "$BUILD_DIR/nexus-cli.js" "$@"; }
VAULT_FLAG=()
[[ -n "$VAULT" ]] && VAULT_FLAG=(--vault "$VAULT")

echo
echo "▸ nexus vaults  (socket enumeration — must find at least one)"
VAULTS_OUT="$(NEXUS vaults)"
echo "$VAULTS_OUT"
if ! printf '%s' "$VAULTS_OUT" | grep -q '/nexus_mcp_'; then
  echo "✗ nexus vaults found no sockets — enumeration is broken (regression check)." >&2
  exit 1
fi

echo
echo "▸ nexus doctor  (connect + MCP handshake + tools/list)"
NEXUS doctor "${VAULT_FLAG[@]}" | head -1

echo
echo "▸ nexus tools storage  (getTools discovery)"
NEXUS tools storage "${VAULT_FLAG[@]}" | head -8

echo
echo "▸ nexus use \"storage list\"  (read-only useTools execution)"
NEXUS use "storage list" "${VAULT_FLAG[@]}" \
  --memory "smoke test of local CLI bridge" \
  --goal "list vault root to prove end-to-end execution" | head -12

echo
echo "▸ nexus playbook  (list — no socket needed)"
NEXUS_PLAYBOOKS_DIR="$REPO_ROOT/skill/playbooks" NEXUS playbook | head -8

echo
echo "▸ nexus playbook vault-work  (compose: spine + workspaces + recipe + preloaded schemas)"
NEXUS_PLAYBOOKS_DIR="$REPO_ROOT/skill/playbooks" NEXUS playbook vault-work "${VAULT_FLAG[@]}" \
  | grep -E "^## (Your workspaces|Preloaded tool schemas)|^# Playbook: vault-work" || true

echo
echo "✓ smoke passed — socket → handshake → getTools → useTools + playbooks all round-tripped."
