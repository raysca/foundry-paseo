#!/bin/bash
# M1 exit test (the extended Shout scenario) on a real daemon: idea, Clarify, spec, plan and task list
# approved at their SHAs; SHT-1 runs and is accepted; while SHT-2 waits on a question you edit the spec
# (a new requirement), approve the changed spec and the PM's change set (keep both tasks, a new task for
# R3); SHT-2 resumes and SHT-3 runs; Verify, ship with the gap, local merge into main, Done.
#
# HARNESS=claude runs it on a Mac with real Claude Code. A real agent doesn't follow the scripted moves
# (whether it asks, how many tasks it plans, what it names things), so that run edits the spec while the
# first task is in flight, finds the added requirement by diff, accepts whatever reaches review and checks
# outcomes, with longer waits; the scripted run asserts each move exactly.
source "$(dirname "$0")/lib.sh"
REAL=0; X=1
[ "$HARNESS" = "scripted" ] || { REAL=1; X=5; }
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
if [ $REAL = 1 ]; then
  wait_for "$(feat)['stage']=='spec' or any(x['feature_id']==$FID and x['status'] in ('waiting','live') for x in d['questions'])" 600 "Clarify questions, or straight to the spec"
  q "import sys; sys.exit(0 if any(x['feature_id']==$FID and x['status'] in ('waiting','live') for x in d['questions']) else 1)" \
    && fact feature.answer "{\"id\":$FID,\"answers\":{}}" | ok "answered (all recommended)"
else
  wait_for "any(x['feature_id']==$FID and x['status']=='waiting' for x in d['questions'])" 120 "Clarify question waiting"
  fact feature.answer "{\"id\":$FID,\"answers\":{\"short_flag\":\"\"}}" | ok "answered (recommended)"
fi
wait_for "$(feat)['stage']=='spec'" $((120*X)) "spec ready for review"

log "approve the spec at its SHA (a stale SHA is refused)"
fact feature.approve_spec "{\"id\":$FID,\"sha\":\"0000000000000000000000000000000000000000\"}" \
  | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['error']['code']=='STALE_APPROVAL', r;print('STALE_APPROVAL')"
fact feature.approve_spec "{\"id\":$FID,\"sha\":\"$(docsha spec)\"}" | ok "spec approved"
wait_for "any(x['feature_id']==$FID and x['kind']=='plan' and x['status']=='in_review' for x in d['docs'])" $((120*X)) "plan ready"
fact feature.approve_plan "{\"id\":$FID,\"sha\":\"$(docsha plan)\"}" | ok "plan approved"
wait_for "any(x['feature_id']==$FID and x['kind']=='tasks' and x['status']=='in_review' for x in d['docs'])" $((120*X)) "task list ready"
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
if [ $REAL = 1 ]; then
  # A real PM may plan a single task, which would end Build at its accept, so the spec is edited while
  # the first task is still in flight.
  log "SHT-1 starts"
  wait_for "$(st SHT-1) in ('In_Progress','Awaiting_Human','In_Review')" 600 "SHT-1 started"
else
  log "SHT-1 runs and is accepted; SHT-2 starts and asks"
  wait_for "$(st SHT-1)=='In_Review'" 240 "SHT-1 In_Review"
  accept SHT-1
  wait_for "$(st SHT-2)=='Awaiting_Human'" 240 "SHT-2 asks"
fi
# The requirement the edit adds is the one ref that wasn't there before (R3 with the scripted PM).
BEFORE=$(q "print(' '.join(r['ref'] for r in d['requirements'] if r['feature_id']==$FID))")
newref() { echo "[r['ref'] for r in d['requirements'] if r['feature_id']==$FID and r['ref'] not in '$BEFORE'.split()]"; }

log "edit the spec during Build: a new requirement"
SPEC=$(fact feature.doc "{\"id\":$FID,\"kind\":\"spec\"}")
EDIT=$(echo "$SPEC" | python3 -c "
import json,sys
d=json.load(sys.stdin); assert 'error' not in d, d
text=d['text'].replace('## Out of scope', 'Also: --loud is an alias of --shout.\n\n## Out of scope')
print(json.dumps({'id':$FID,'kind':'spec','text':text,'base_sha':d['sha']}))")
fact feature.edit_doc "$EDIT" | ok "spec edited"
q "f=$(feat); assert f['spec_change_open']==1, f; print('spec change open')"
wait_for "len($(newref))==1 and any(x['feature_id']==$FID and x['kind']=='spec' and x['status']=='in_review' for x in d['docs'])" $((120*X)) "PM restated the requirements (one added)"
NEW=$(q "print($(newref)[0])")
[ $REAL = 1 ] || [ "$NEW" = "R3" ]
log "added $NEW"
git -C "$WORK/repo" show "foundry/feature/shout-mode:.foundry/features/shout-mode/spec.md" | grep "### $NEW " >/dev/null

log "approve the changed spec; the PM proposes one change set"
fact feature.approve_spec "{\"id\":$FID,\"sha\":\"$(docsha spec)\"}" | ok "changed spec approved"
wait_for "any(p['feature_id']==$FID and p['status']=='proposed' and p['kind']=='change' for p in d['proposals'])" $((120*X)) "change set proposed"
PROP=$(q "print([p['id'] for p in d['proposals'] if p['feature_id']==$FID and p['status']=='proposed'][0])")
fact feature.approve_tasks "{\"id\":$FID,\"proposal\":$PROP,\"sha\":\"$(docsha tasks)\"}" | ok "change set approved"
q "f=$(feat); assert f['spec_change_open']==0 and f['stage']=='build', f; i=[i for i in d['issues'] if i['feature_id']==$FID and '\"$NEW\"' in i['requirement_refs']]; assert i, 'nothing covers $NEW'; print(i[0]['key'], 'covers $NEW')"

if [ $REAL = 1 ]; then
  log "every task runs and is accepted (questions get 'use your recommendation')"
  # Answer any question, accept whatever reaches review, until every task of the feature is Done.
  left() { q "print(sum(1 for i in d['issues'] if i['feature_id']==$FID and i['status'] not in ('Done','Cancelled')))"; }
  for _ in $(seq 1 360); do
    [ "$(left)" = "0" ] && break
    for QID in $(q "print(' '.join(str(x['id']) for x in d['questions'] if x['issue_key'] and x['status'] in ('live','waiting')))"); do
      fact question.answer "{\"id\":$QID,\"text\":\"Use your recommendation.\"}" >/dev/null
    done
    for K in $(q "print(' '.join(i['key'] for i in d['issues'] if i['feature_id']==$FID and i['status']=='In_Review'))"); do accept "$K"; done
    sleep 5
  done
  [ "$(left)" = "0" ] || { log "TIMEOUT: tasks still open"; exit 1; }
else
  log "SHT-2 resumes with the answer; SHT-3 runs after it"
  QID=$(q "print([x['id'] for x in d['questions'] if x['issue_key']=='SHT-2'][0])")
  fact question.answer "{\"id\":$QID,\"text\":\"yes, -s too\"}" >/dev/null
  wait_for "$(st SHT-2)=='In_Review'" 240 "SHT-2 In_Review"
  accept SHT-2
  wait_for "$(st SHT-3)=='In_Review'" 240 "SHT-3 In_Review"
  accept SHT-3
fi

verif() { echo "[v for v in d['verifications'] if v['feature_id']==$FID][0]"; }
log "Build ends: Verify in a fresh workspace (fail_once fails there), the reviewer reports R1 to R3"
wait_for "len([v for v in d['verifications'] if v['feature_id']==$FID]) and $(verif)['status']!='running'" $((300*X)) "Verify done"
if [ $REAL = 1 ]; then
  q "import json; v=$(verif); print('Verify:', v['status'], v['failure'], [(c['name'],c['status']) for c in json.loads(v['checks'])], [(r['requirement_ref'],r['passed']) for r in json.loads(v['requirements'])])"
  q "import sys; sys.exit(0 if $(verif)['status']=='failed' else 1)" && fact feature.ship_with_gaps "{\"id\":$FID}" | ok "shipping with the gaps"
else
  q "import json; v=$(verif); assert v['failure']=='CHECKS_FAILED', v; assert sorted(r['requirement_ref'] for r in json.loads(v['requirements']))==['R1','R2','R3'], v; print('CHECKS_FAILED (fail_once); requirements R1 R2 R3 reported')"
  fact feature.ship_with_gaps "{\"id\":$FID}" | ok "shipping with the gap"
fi

log "prepare and accept the ship, confirming the merge into the main checkout"
PREP=$(fact feature.prepare_ship "{\"id\":$FID}")
SHIP=$(echo "$PREP" | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' not in r, r;print(json.dumps({'id':$FID,'head_sha':r['sha'],'tree_sha':r['tree'],'confirm':True}))")
fact feature.accept_ship "$SHIP" | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'merged' in r, r;print('shipped', r['merged'][:10])"
q "assert $(feat)['stage']=='done'; print('feature Done')"
grep -- '--loud' "$WORK/repo/shout/cli.py" >/dev/null
echo "main has --loud"
[ $REAL = 1 ] || grep '"-s"' "$WORK/repo/shout/cli.py" >/dev/null
(cd "$WORK/repo" && python3 -m unittest discover -s tests >/dev/null 2>&1)
echo "main's tests pass"
log "exit test passed"
