#!/bin/bash
# Install Foundry into your own Paseo, or update it in place. Run it again after pulling new code.
#
#   scripts/install-local.sh            install, or update and reload
#   scripts/install-local.sh --pull     git pull --ff-only first
#
# PASEO_HOME picks a daemon home other than ~/.paseo; PASEO_BIN a paseo CLI other than the one on PATH.
# Paseo runs a directory plugin from this checkout, so the checkout must stay where it is.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$ROOT/plugin"
PASEO_BIN="${PASEO_BIN:-paseo}"
HOME_ARGS=()
[ -n "${PASEO_HOME:-}" ] && HOME_ARGS=(--home "$PASEO_HOME")
P() { "$PASEO_BIN" "${HOME_ARGS[@]}" "$@"; }
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'install-local: %s\n' "$*" >&2; exit 1; }

command -v "$PASEO_BIN" >/dev/null || die "no paseo CLI found. Install Paseo, or set PASEO_BIN to its CLI."
command -v node >/dev/null || die "Node.js is needed (22 or newer)."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "Node.js 22 or newer is needed (node:sqlite); found $(node -v)."
P daemon status >/dev/null 2>&1 || die "your Paseo daemon isn't running. Open Paseo (or run: $PASEO_BIN daemon start) and try again."

if [ "${1:-}" = "--pull" ]; then
  say "Pulling the latest code"
  git -C "$ROOT" pull --ff-only
fi

say "Installing the plugin's dependencies"
(cd "$PLUGIN" && if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi)

say "Type-checking"
(cd "$PLUGIN" && npm run --silent typecheck)

# Is Foundry installed already, and from where?
INSTALLED="$(P plugin ls --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const j = JSON.parse(s); const rows = Array.isArray(j) ? j : (j.plugins ?? j.rows ?? []);
      const f = rows.find((r) => r.id === "foundry");
      process.stdout.write(f ? String(f.path ?? f.installation?.identity?.path ?? "?") : "");
    } catch { process.stdout.write(""); }
  });')"

if [ -z "$INSTALLED" ]; then
  say "Installing Foundry into Paseo"
  P plugin install "$PLUGIN"
else
  if [ "$INSTALLED" != "?" ] && [ "$(cd "$INSTALLED" 2>/dev/null && pwd -P)" != "$(cd "$PLUGIN" && pwd -P)" ]; then
    say "Foundry is installed from $INSTALLED; switching it to this checkout"
    P plugin remove foundry >/dev/null
    P plugin install "$PLUGIN"
  else
    say "Reloading Foundry"
    P plugin reload foundry >/dev/null
  fi
fi

# Wait for it to come up and report what Paseo says.
for _ in $(seq 1 30); do
  ROW="$(P plugin ls 2>/dev/null | awk '$1=="foundry"')"
  case "$ROW" in *running*) break ;; esac
  sleep 1
done
echo "$ROW"
case "$ROW" in
  *running*) ;;
  *) echo; P plugin logs foundry 2>/dev/null | tail -20; die "Foundry didn't start; its last log lines are above." ;;
esac

say "Done."
echo "In Paseo: Foundry is in the sidebar. Settings → Foundry runs the setup check (role profiles"
echo "foundry-builder, foundry-reviewer, foundry-pm and optionally foundry-planner; a zsh daemon shell)."
echo "After pulling new code, run this script again; it reloads Foundry without losing its data."
