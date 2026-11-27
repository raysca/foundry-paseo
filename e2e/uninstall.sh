#!/bin/bash
# Uninstalling deletes nothing by itself; --purge cleans up only what Foundry made. Install Foundry, let it
# add profiles next to one of yours, use a project, then:
#   1. scripts/uninstall-local.sh removes the plugin and keeps the data and profiles; reinstalling picks them up
#   2. scripts/uninstall-local.sh --purge removes Foundry's unedited profiles, keeps an edited one and yours,
#      deletes the data folder after a final copy, keeps the repo's branches, and removes the plugin
source "$(dirname "$0")/lib.sh"
stop_daemon; rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
U() { PASEO_BIN="$PASEO_BIN" PASEO_HOME="$PHOME" bash "$ROOT/scripts/uninstall-local.sh" "$@"; }
profiles() { python3 -c "import json;print(' '.join(sorted(x['id'] for x in json.load(open('$PHOME/config.json'))['daemon']['agentProfiles'])))"; }

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
# Foundry adds builder and reviewer (pm and planner are the e2e's own), next to a profile of yours.
python3 - "$PHOME/config.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p))
c["daemon"]["agentProfiles"] = [x for x in c["daemon"]["agentProfiles"] if x["id"] in ("foundry-pm", "foundry-planner")]
c["daemon"]["agentProfiles"].append({"id": "users-own", "name": "Mine", "provider": "claude", "model": "keep-me"})
json.dump(c, open(p, "w"), indent=2)
PY
P daemon stop >/dev/null 2>&1 || true; P start --timeout 300 >/dev/null
wait_for "True" 30 "daemon back" || true; sleep 3
fact setup.create_profiles '{"choices":[{"role":"builder","harness":"claude","model":"claude-sonnet-5-5"},{"role":"reviewer","harness":"claude","model":"claude-sonnet-5-5"}]}' >/dev/null
fresh_repo
git -C "$WORK/repo" branch foundry/feature/kept
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" >/dev/null
fact uninstall.leftovers | python3 -c "import json,sys;d=json.load(sys.stdin);print([(p['id'],p['state']) for p in d['profiles']], d['branches']);assert [p['id'] for p in d['profiles']]==['foundry-builder','foundry-reviewer'], d"

log "1. plain uninstall keeps everything"
U >/dev/null
P plugin ls 2>/dev/null | grep -qE '^foundry[[:space:]]' && { log "plugin still installed"; exit 1; }
[ -f "$FOUNDRY_HOME/foundry.db" ] || { log "data folder was touched"; exit 1; }
[ "$(profiles)" = "foundry-builder foundry-planner foundry-pm foundry-reviewer users-own" ] || { log "profiles changed: $(profiles)"; exit 1; }
install_plugins
wait_for "len(d['projects'])==1" 60 "reinstall picks the project up again"

log "2. --purge removes only what Foundry made and nobody changed"
# You changed the reviewer after Foundry added it: it stays.
python3 - "$PHOME/config.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p))
for x in c["daemon"]["agentProfiles"]:
    if x["id"] == "foundry-reviewer": x["model"] = "changed-by-you"
json.dump(c, open(p, "w"), indent=2)
PY
P daemon stop >/dev/null 2>&1 || true; P start --timeout 300 >/dev/null
wait_for "True" 30 "daemon back" || true; sleep 3
U --purge
[ "$(profiles)" = "foundry-planner foundry-pm foundry-reviewer users-own" ] || { log "wrong profiles left: $(profiles)"; exit 1; }
[ ! -e "$FOUNDRY_HOME" ] || { log "data folder still there"; exit 1; }
ls "$(dirname "$FOUNDRY_HOME")"/foundry-home-final-backup-*.db >/dev/null || { log "no final copy"; exit 1; }
git -C "$WORK/repo" rev-parse --verify -q foundry/feature/kept >/dev/null || { log "a branch was deleted"; exit 1; }
P plugin ls 2>/dev/null | grep -qE '^foundry[[:space:]]' && { log "plugin still installed"; exit 1; }
log "uninstall test passed"
