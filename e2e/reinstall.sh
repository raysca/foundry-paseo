#!/bin/bash
# Updating Foundry keeps your data: install it, create a project and a feature, run
# scripts/install-local.sh twice the way you would after pulling, and check the project, the feature and
# the event log are all still there. (Schema upgrades are covered by plugin/test/upgrade.test.ts.)
source "$(dirname "$0")/lib.sh"
stop_daemon; rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" >/dev/null
fact feature.create '{"project":"SHT","idea":"Shout mode\nLet the CLI shout its input."}' >/dev/null
before=$(q "print(len(d['events']))")

for round in 1 2; do
  log "update $round: scripts/install-local.sh"
  PASEO_BIN="$PASEO_BIN" PASEO_HOME="$PHOME" bash "$ROOT/scripts/install-local.sh" >/dev/null
  wait_for "len(d['projects'])==1 and len(d['features'])==1" 60 "data still there after update $round"
done
q "assert len(d['events'])>=$before, (len(d['events']), $before); print('event log kept')"
n=$(find "$FOUNDRY_HOME" -name 'foundry.db.backup-*' | wc -l | tr -d ' ')
[ "$n" = 0 ] || { log "unexpected backups: $n (the schema didn't change)"; exit 1; }
log "reinstall test passed"
