#!/bin/bash
# Development only: put Foundry back to a fresh install so onboarding can be tested again.
#
#   scripts/dev-reset.sh             show what a reset would remove, change nothing
#   scripts/dev-reset.sh --yes       reset Foundry in your Paseo: archive its workspaces, remove the foundry-*
#                                    agent profiles, copy its database to /tmp and empty it, reload the plugin
#   scripts/dev-reset.sh --sandbox   leave your Paseo alone: start a separate, throwaway Paseo daemon with a
#                                    fresh Foundry, and open its web app in a browser
#
# --yes needs a development install (scripts/install-local.sh) or a daemon started with FOUNDRY_DEV=1.
# FOUNDRY_DAEMON_URL picks the daemon (default ws://127.0.0.1:6767/ws); PASEO_BIN a paseo CLI not on PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$ROOT/plugin"
PASEO_BIN="${PASEO_BIN:-paseo}"
trap 'rc=$?; [ $rc -eq 0 ] || printf "dev-reset: stopped (exit code %s); the step above it failed\n" "$rc" >&2' EXIT
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'dev-reset: %s\n' "$*" >&2; exit 1; }
fact() { (cd "$PLUGIN" && node bin/foundry.mjs act "$1" "${2:-{\}}"); }
[ -d "$PLUGIN/node_modules" ] || die "run scripts/install-local.sh first (it installs the plugin's dependencies)."

case "${1:-}" in
  --sandbox)
    SANDBOX="${SANDBOX:-${TMPDIR:-/tmp}/foundry-sandbox}"
    PORT="${SANDBOX_PORT:-6799}"
    S() { "$PASEO_BIN" --home "$SANDBOX/paseo" "$@"; }
    if [ -d "$SANDBOX/paseo" ]; then S daemon stop >/dev/null 2>&1 || true; fi
    rm -rf "$SANDBOX" && mkdir -p "$SANDBOX/paseo" "$SANDBOX/data"
    # A daemon of its own: its own home, port and Foundry data, with Paseo's web app on.
    node -e '
      const [path, port] = process.argv.slice(1);
      const c = { version: 1, pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } }, features: { webUi: { enabled: true } } };
      require("fs").writeFileSync(path, JSON.stringify(c, null, 2));' "$SANDBOX/paseo/config.json" "$PORT"
    say "Starting a sandbox Paseo daemon on port $PORT"
    FOUNDRY_HOME="$SANDBOX/data" FOUNDRY_DEV=1 FOUNDRY_DAEMON_URL="ws://127.0.0.1:$PORT/ws" S start --timeout 300 >/dev/null
    S plugin install "$PLUGIN" >/dev/null
    say "Sandbox ready."
    echo "Open http://127.0.0.1:$PORT in a browser (Paseo's web app), add a git project, then open Foundry."
    echo "Your own Paseo is untouched. Stop the sandbox with: $PASEO_BIN --home $SANDBOX/paseo daemon stop"
    echo "Run this again for a clean sandbox."
    ;;
  --yes)
    say "Resetting Foundry"
    fact dev.reset '{"confirm":"reset"}'
    sleep 2
    say "Done. Open Foundry in Paseo: the welcome guide starts again."
    ;;
  "")
    say "A reset would remove this (run again with --yes to do it, or --sandbox to leave your Paseo alone):"
    fact dev.reset_plan
    ;;
  *) die "unknown option $1 (use --yes or --sandbox)";;
esac
