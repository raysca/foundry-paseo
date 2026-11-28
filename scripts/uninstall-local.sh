#!/bin/bash
# Uninstall Foundry from your Paseo. On its own this deletes nothing: it lists what Foundry left behind
# and removes the plugin, so reinstalling picks up where you left off.
#
#   scripts/uninstall-local.sh           list what Foundry left, then remove the plugin from Paseo
#   scripts/uninstall-local.sh --purge   first stop Foundry's work, remove the profiles it added that nobody
#                                        changed, and delete its data (a final copy is kept beside the folder)
#
# Branches in your repos are never deleted. PASEO_HOME / PASEO_BIN / FOUNDRY_DAEMON_URL as in install-local.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$ROOT/plugin"
PASEO_BIN="${PASEO_BIN:-paseo}"
P() {
  if [ -n "${PASEO_HOME:-}" ]; then "$PASEO_BIN" --home "$PASEO_HOME" "$@"; else "$PASEO_BIN" "$@"; fi
}
trap 'rc=$?; [ $rc -eq 0 ] || printf "uninstall-local: stopped (exit code %s); the step above it failed\n" "$rc" >&2' EXIT
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'uninstall-local: %s\n' "$*" >&2; exit 1; }
fact() { (cd "$PLUGIN" && node bin/foundry.mjs act "$1" "${2:-{\}}"); }
# Fails (non-zero) when Foundry answered with an error.
ok() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j&&j.error){console.error(j.error.code+": "+j.error.message);process.exit(1)}console.log(process.argv[1]?eval(process.argv[1]):JSON.stringify(j,null,2))})' "${1:-}"; }
[ -d "$PLUGIN/node_modules" ] || die "the plugin's dependencies aren't installed (run scripts/install-local.sh once)."
P plugin ls >/dev/null 2>&1 || die "your Paseo daemon isn't running."
P plugin ls 2>/dev/null | grep -qE '^foundry[[:space:]]' || die "Foundry isn't installed in this Paseo."

say "What Foundry left behind"
LEFT="$(fact uninstall.leftovers)"
echo "$LEFT" | ok

if [ "${1:-}" = "--purge" ]; then
  say "Stopping Foundry's work"
  fact uninstall.stop_work | ok '`archived ${j.archived.length} workspaces`'
  IDS="$(echo "$LEFT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(JSON.stringify(j.profiles.filter(p=>p.state==="unedited").map(p=>p.id)))})')"
  say "Removing the profiles Foundry added that nobody changed"
  fact uninstall.remove_profiles "{\"ids\":$IDS}" | ok '`removed: ${j.removed.join(", ")||"none"}`'
  HOME_DIR="$(echo "$LEFT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).data.home))')"
  say "Deleting Foundry's data in $HOME_DIR"
  fact uninstall.delete_data "{\"confirm\":\"$(basename "$HOME_DIR")\"}" | ok '`deleted; final copy: ${j.backup}`'
elif [ -n "${1:-}" ]; then
  die "unknown option $1 (use --purge)"
fi

say "Removing Foundry from Paseo"
P plugin remove foundry
say "Done."
[ "${1:-}" = "--purge" ] || echo "Foundry's data and profiles are still there; reinstalling picks them up. Use --purge to remove them."
