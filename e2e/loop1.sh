#!/bin/bash
# Loop 1 into loop 2 on a real daemon: a feature from an idea through a Clarify round answered late,
# spec, plan and task list approved at their SHAs, its two tasks run and are accepted, then Verify
# fails a check in its fresh workspace, you ship with the gap, and the feature merges into main locally.
source "$(dirname "$0")/lib.sh"
rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
echo '{"questionWindowSeconds": 5}' > "$FOUNDRY_HOME/config.json"

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" >/dev/null

log "create a feature from an idea"
FID=$(fact feature.create '{"project":"SHT","idea":"Shout mode\nLet the CLI shout its input."}' | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' not in r, r;print(r['id'])")
feat() { echo "[f for f in d['features'] if f['id']==$FID][0]"; }
docsha() { q "print([x['head_sha'] for x in d['docs'] if x['feature_id']==$FID and x['kind']=='$1'][0])"; }
ok() { python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' not in r, r;print('$1')"; }

log "the PM asks a Clarify question; the window passes; the answer starts a turn"
wait_for "any(x['feature_id']==$FID and x['status']=='waiting' for x in d['questions'])" 120 "Clarify question waiting"
fact feature.answer "{\"id\":$FID,\"answers\":{\"short_flag\":\"\"}}" | ok "answered (recommended)"
wait_for "$(feat)['stage']=='spec'" 120 "spec ready for review"

log "approve the spec at its SHA (a stale SHA is refused)"
fact feature.approve_spec "{\"id\":$FID,\"sha\":\"0000000000000000000000000000000000000000\"}" \
  | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['error']['code']=='STALE_APPROVAL', r;print('STALE_APPROVAL')"
fact feature.approve_spec "{\"id\":$FID,\"sha\":\"$(docsha spec)\"}" | ok "spec approved"
wait_for "any(x['feature_id']==$FID and x['kind']=='plan' and x['status']=='in_review' for x in d['docs'])" 120 "plan ready"
fact feature.approve_plan "{\"id\":$FID,\"sha\":\"$(docsha plan)\"}" | ok "plan approved"
wait_for "any(x['feature_id']==$FID and x['kind']=='tasks' and x['status']=='in_review' for x in d['docs'])" 120 "task list ready"
PROP=$(q "print([p['id'] for p in d['proposals'] if p['feature_id']==$FID and p['status']=='proposed'][0])")
fact feature.approve_tasks "{\"id\":$FID,\"proposal\":$PROP,\"sha\":\"$(docsha tasks)\"}" | ok "task list approved"
q "assert $(feat)['stage']=='build'; print('feature in Build')"

st() { echo "[i['status'] for i in d['issues'] if i['key']=='$1'][0]"; }
att() { echo "[a for a in d['attempts'] if a['issue_key']=='$1'][0]"; }
accept() {
  local args
  args=$(q "a=$(att "$1"); import json; print(json.dumps({'key':'$1','head_sha':a['head_sha'],'tree_sha':a['tree_sha']}))")
  fact issue.accept "$args" | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'merged' in r, r;print('merged', r['merged'][:10])"
}
log "its tasks run through loop 2"
wait_for "$(st SHT-1)=='In_Review'" 240 "SHT-1 In_Review"
accept SHT-1
wait_for "$(st SHT-2)=='Awaiting_Human'" 240 "SHT-2 asks"
QID=$(q "print([x['id'] for x in d['questions'] if x['issue_key']=='SHT-2'][0])")
fact question.answer "{\"id\":$QID,\"text\":\"yes, -s too\"}" >/dev/null
wait_for "$(st SHT-2)=='In_Review'" 240 "SHT-2 In_Review"
accept SHT-2

log "the feature branch has the docs and both tasks, and no stray PM writes"
B=foundry/feature/$(q "print($(feat)['slug'])")
git -C "$WORK/repo" show "$B:.foundry/features/shout-mode/tasks.md" | grep "Written by Foundry" >/dev/null
git -C "$WORK/repo" show "$B:shout/cli.py" | grep '"-s"' >/dev/null
git -C "$WORK/repo" log --format=%an "$B" | grep "Foundry PM" >/dev/null
verif() { echo "[v for v in d['verifications'] if v['feature_id']==$FID][0]"; }
log "Build ends: Verify checks the merged head in a fresh workspace; fail_once fails its first run there (no fix rounds in Verify)"
wait_for "$(verif)['status']=='failed'" 300 "Verify failed"
q "v=$(verif); assert v['failure']=='CHECKS_FAILED', v; import json; print('CHECKS_FAILED', [(c['name'],c['status']) for c in json.loads(v['checks'])])"
q "r=[r for r in d['overview']['rows'] if r['id']==$FID][0]; assert r['delivery_label']=='Verify: 1 check failed', r; print(r['delivery_label'])"
q "import json; v=$(verif); assert len(json.loads(v['requirements']))==2, v; print('reviewer reported 2 requirements')"
log "ship with the gap"
fact feature.ship_with_gaps "{\"id\":$FID}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r.get('gaps')==['check fail_once'], r;print('gaps', r['gaps'])"
q "assert $(feat)['stage']=='ship'; print('feature in Ship')"

log "prepare and accept the ship; main is checked out in the developer's checkout, so it needs confirming"
PREP=$(fact feature.prepare_ship "{\"id\":$FID}")
SHIP=$(echo "$PREP" | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' not in r, r;print(json.dumps({'id':$FID,'head_sha':r['sha'],'tree_sha':r['tree']}))")
fact feature.accept_ship "$SHIP" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['error']['code']=='BASE_CHECKED_OUT', r;print('BASE_CHECKED_OUT')"
fact feature.accept_ship "$(echo "$SHIP" | python3 -c "import json,sys;r=json.load(sys.stdin);r['confirm']=True;print(json.dumps(r))")" \
  | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'merged' in r, r;print('shipped', r['merged'][:10])"
q "assert $(feat)['stage']=='done'; print('feature Done')"
grep -q '"-s"' "$WORK/repo/shout/cli.py"
log "loop1 passed"
