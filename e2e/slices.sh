#!/bin/bash
# Slices on a real daemon (the slices exit test). A Quick-flow feature planned in three slices:
# slice 1 builds alone; once it reaches Ship slice 2 builds on its own branch while slice 1's PR is open;
# slice 2's PR is stacked on slice 1's branch and can't ship first; merging PR 1 promotes slice 2, retargets
# its PR at main and starts slice 3; a spec change lands its new task in slice 3 and checks slice 2 again;
# PR 2 and PR 3 merge in order and the feature is Done. A fake gh stands in for GitHub.
source "$(dirname "$0")/lib.sh"
rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
echo '{"questionWindowSeconds": 5}' > "$FOUNDRY_HOME/config.json"
export PATH="$E2E/fake-gh:$PATH" FAKE_GH_STATE="$WORK/gh-state.json" FAKE_GH_REMOTE="$WORK/remote.git" FAKE_SLICES=1

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo
git init -q --bare "$FAKE_GH_REMOTE"
git -C "$WORK/repo" remote add origin "$FAKE_GH_REMOTE"
git -C "$WORK/repo" push -q origin main
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" >/dev/null

FID=$(fact feature.create '{"project":"SHT","idea":"Shout mode\nLet the CLI shout its input.","flow":"quick","grill":"none"}' | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' not in r, r;print(r['id'])")
feat() { echo "[f for f in d['features'] if f['id']==$FID][0]"; }
docsha() { q "print([x['head_sha'] for x in d['docs'] if x['feature_id']==$FID and x['kind']=='$1'][0])"; }
ok() { python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' not in r, r;print('$1')"; }
err() { python3 -c "import json,sys;r=json.load(sys.stdin);assert r.get('error',{}).get('code')=='$1', r;print('$1')"; }
st() { echo "[i['status'] for i in d['issues'] if i['key']=='$1'][0]"; }
att() { echo "[a for a in d['attempts'] if a['issue_key']=='$1'][0]"; }
accept() {
  local args
  args=$(q "a=$(att "$1"); import json; print(json.dumps({'key':'$1','head_sha':a['head_sha'],'tree_sha':a['tree_sha']}))")
  fact issue.accept "$args" | ok "accepted $1"
}
sl() { echo "[x for x in d['slices'] if x['feature_id']==$FID and x['n']==$1][0]"; }
sid() { q "print($(sl "$1")['id'])"; }
order() { echo "' '.join(f\"{x['n']}:{x['status']}\" for x in d['slices'] if x['feature_id']==$FID)"; }
verif() { echo "([v for v in d['verifications'] if v['feature_id']==$FID and v['slice_id']==$(sid "$1")] or [{'status':'none'}])[0]"; }
merge_pr() {
  python3 -c "import json;p='$FAKE_GH_STATE';s=json.load(open(p));s['prs'][$1-1]['state']='MERGED';json.dump(s,open(p,'w'))"
  # GitHub merged it into its main.
  git -C "$FAKE_GH_REMOTE" update-ref refs/heads/main "refs/heads/$(python3 -c "import json;print(json.load(open('$FAKE_GH_STATE'))['prs'][$1-1]['head'])")"
  fact feature.refresh_pr "{\"id\":$FID}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['results'][0]['result']=='merged', r;print('PR #$1 merged')"
}
pr_base() { python3 -c "import json;print(json.load(open('$FAKE_GH_STATE'))['prs'][$1-1]['base'])"; }
# Verify fails fail_once's check in every fresh verify workspace, so each slice ships with that gap.
gaps() {
  wait_for "$(verif "$1")['status']=='failed'" 300 "slice $1 Verify done (fail_once gap)"
  fact feature.ship_with_gaps "{\"id\":$FID,\"slice\":$(sid "$1")}" | ok "slice $1 ships with the gap"
}

log "plan in three slices; only slice 1 builds"
wait_for "$(feat)['stage']=='tasks' and not $(feat)['planning_busy']" 120 "task list ready"
PROP=$(q "print([p['id'] for p in d['proposals'] if p['feature_id']==$FID and p['status']=='proposed'][0])")
fact feature.approve_tasks "{\"id\":$FID,\"proposal\":$PROP,\"sha\":\"$(docsha tasks)\",\"spec_sha\":\"$(docsha spec)\",\"plan_sha\":\"$(docsha plan)\"}" | ok "approved"
q "assert $(order)=='1:building 2:planned 3:planned', $(order); print('slices', $(order))"
wait_for "$(st SHT-1)=='In_Review'" 240 "SHT-1 In_Review"
accept SHT-1
gaps 1

log "slice 1 in Ship: slice 2 builds on its own branch, cut from slice 1"
wait_for "$(order)=='1:ship 2:building 3:planned'" 60 "slice 2 started"
B1=$(q "print($(sl 1)['branch'])"); B2=$(q "print($(sl 2)['branch'])")
git -C "$WORK/repo" merge-base --is-ancestor "$B1" "$B2" && echo "$B2 is cut from $B1"
wait_for "$(st SHT-2)=='Awaiting_Human'" 240 "SHT-2 (slice 2) asks"
QID=$(q "print([x['id'] for x in d['questions'] if x['issue_key']=='SHT-2'][0])")
fact question.answer "{\"id\":$QID,\"text\":\"yes\"}" >/dev/null
fact feature.prepare_ship "{\"id\":$FID,\"slice\":$(sid 1)}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['pr']['number']==1, r;print('PR #1 for slice 1')"
[ "$(pr_base 1)" = "main" ] && echo "PR #1 targets main"
wait_for "$(st SHT-2)=='In_Review'" 240 "SHT-2 In_Review"
accept SHT-2
q "assert $(feat)['head_sha']==$(sl 1)['head_sha']; print('slice 2 work merged into slice 2, not the feature branch')"
gaps 2
q "assert $(order)=='1:ship 2:ship 3:planned', $(order); assert $(st SHT-3)!='In_Progress'; print('slice 3 waits: two slices are active')"

log "slice 2's PR stacks on slice 1's branch and can't ship before it"
fact feature.prepare_ship "{\"id\":$FID,\"slice\":$(sid 2)}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['pr']['number']==2, r;print('PR #2 for slice 2')"
[ "$(pr_base 2)" = "$B1" ] && echo "PR #2 targets $B1"
fact feature.accept_ship "{\"id\":$FID,\"slice\":$(sid 2),\"head_sha\":\"x\",\"tree_sha\":\"x\"}" | err SLICE_ORDER

log "PR #1 merges: slice 2 is promoted, its PR retargeted at main, slice 3 starts"
merge_pr 1
q "assert $(order)=='1:shipped 2:ship 3:building', $(order); assert $(feat)['branch']=='$B2'; print('slice 2 is the front:', $(order))"
[ "$(pr_base 2)" = "main" ] && echo "PR #2 now targets main"

log "a spec change while slice 3 builds: its new task joins slice 3; slice 2 is checked again"
SPEC=$(fact feature.doc "{\"id\":$FID,\"kind\":\"spec\"}")
EDIT=$(echo "$SPEC" | python3 -c "import json,sys;r=json.load(sys.stdin);print(json.dumps({'id':$FID,'kind':'spec','base_sha':r['sha'],'text':r['text'].rstrip()+'\n\nAlso accept --loud as an alias of --shout.\n'}))")
fact feature.edit_doc "$EDIT" | ok "edited the spec"
wait_for "$(feat)['spec_change_open']==1 and not $(feat)['planning_busy'] and [x['status'] for x in d['docs'] if x['feature_id']==$FID and x['kind']=='spec'][0]=='in_review'" 120 "spec change open"
V2=$(q "print($(verif 2)['id'])")
fact feature.approve_spec "{\"id\":$FID,\"sha\":\"$(docsha spec)\"}" | ok "spec approved"
wait_for "not $(feat)['planning_busy'] and any(p['feature_id']==$FID and p['status']=='proposed' and p['kind']=='change' and p.get('tasks_sha') for p in d['proposals'])" 120 "change set proposed"
PROP=$(q "print([p['id'] for p in d['proposals'] if p['feature_id']==$FID and p['status']=='proposed'][0])")
fact feature.approve_tasks "{\"id\":$FID,\"proposal\":$PROP,\"sha\":\"$(docsha tasks)\"}" | ok "change set approved"
q "i=[i for i in d['issues'] if i['key']=='SHT-4'][0]; assert i['slice_id']==$(sid 3), i; print('SHT-4 (--loud) is in slice 3')"
wait_for "$(verif 2)['id']!=$V2 and $(verif 2)['status']=='failed' and $(feat)['stage']=='verify'" 300 "slice 2 verified again against the new requirements"
gaps 2
fact feature.prepare_ship "{\"id\":$FID,\"slice\":$(sid 2)}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['pr']['number']==2, r;print('PR #2 reused')"

log "slice 3 builds both tasks, verifies every requirement and stacks on slice 2"
wait_for "$(st SHT-3)=='In_Review'" 240 "SHT-3 In_Review"
accept SHT-3
wait_for "$(st SHT-4)=='In_Review'" 240 "SHT-4 In_Review"
accept SHT-4
gaps 3
q "import json; v=$(verif 3); assert sorted(r['requirement_ref'] for r in json.loads(v['requirements']))==['R1','R2','R3'], v; print('slice 3 checked R1, R2 and R3')"
fact feature.prepare_ship "{\"id\":$FID,\"slice\":$(sid 3)}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['pr']['number']==3, r;print('PR #3 for slice 3')"
[ "$(pr_base 3)" = "$B2" ] && echo "PR #3 targets $B2"

log "PR #2 then PR #3 merge; the feature is Done"
merge_pr 2
[ "$(pr_base 3)" = "main" ] && echo "PR #3 now targets main"
merge_pr 3
q "assert $(feat)['stage']=='done' and $(order)=='1:shipped 2:shipped 3:shipped', $(order); print('Done:', $(order))"
log "PASS: slices exit test"
