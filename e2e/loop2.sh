#!/bin/bash
# Loop 2 on a real daemon: two tasks of an approved feature run unattended through build, Paseo-script
# checks (one fix round), review and SHA-bound accept; the second asks a question nobody answers in time
# and resumes when it is answered.
source "$(dirname "$0")/lib.sh"
rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
echo '{"questionWindowSeconds": 5}' > "$FOUNDRY_HOME/config.json"

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" >/dev/null
fact dev.seed_feature '{"project":"SHT","slug":"shout-mode","title":"Shout mode","tasks":[
  {"title":"Add shout() to shout/core.py with tests"},
  {"title":"Add --shout flag to the CLI with a test","depends_on":[0]}]}' >/dev/null

st() { echo "[i['status'] for i in d['issues'] if i['key']=='$1'][0]"; }
att() { echo "[a for a in d['attempts'] if a['issue_key']=='$1'][0]"; }
accept() {
  local args
  args=$(q "a=$(att "$1"); import json; print(json.dumps({'key':'$1','head_sha':a['head_sha'],'tree_sha':a['tree_sha']}))")
  fact issue.accept "$args" | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'merged' in r, r;print('merged', r['merged'][:10])"
}

log "SHT-1 auto-starts, fails fail_once, gets one fix round, passes review"
wait_for "$(st SHT-1)=='In_Review'" 240 "SHT-1 In_Review"
# Print every check run, so a CI difference in how a script reports is visible.
q "import json
for r in reversed(d['runs']):
  if r['kind']=='check': print('check', r['status'], json.loads(r['detail']).get('name'), json.loads(r['detail']).get('code'), repr((json.loads(r['detail']).get('tail') or '')[-160:]))"
q "a=$(att SHT-1); assert a['outcome']=='passed' and a['fix_rounds']>=1, a; print('fix rounds', a['fix_rounds'])"

log "stale accept is refused"
fact issue.accept '{"key":"SHT-1","head_sha":"0000000000000000000000000000000000000000","tree_sha":"x"}' \
  | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['error']['code']=='STALE_REVIEW', r;print('STALE_REVIEW')"
accept SHT-1

log "SHT-2 starts once SHT-1 is Done, asks, the window passes"
wait_for "$(st SHT-2)=='Awaiting_Human'" 240 "SHT-2 Awaiting_Human"
QID=$(q "print([x['id'] for x in d['questions'] if x['issue_key']=='SHT-2'][0])")
fact question.answer "{\"id\":$QID,\"text\":\"yes, -s too\"}" >/dev/null
wait_for "$(st SHT-2)=='In_Review'" 240 "SHT-2 In_Review after the late answer"
accept SHT-2

log "the feature branch has both tasks"
git -C "$WORK/repo" show foundry/feature/shout-mode:shout/cli.py | grep -q '"-s"'
git -C "$WORK/repo" show foundry/feature/shout-mode:shout/core.py | grep -q upper
log "loop2 passed"
