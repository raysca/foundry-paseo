#!/bin/bash
# Ship by GitHub PR on a real daemon: a Quick-flow feature in a repo with a remote goes through Build and
# Verify, Prepare pushes its branch and opens a PR (a fake gh on the daemon's PATH stands in for GitHub),
# a push to the PR branch sends it back to Verify, Prepare reuses the open PR, and merging it on
# "GitHub" moves the feature to Done.
#
# Then the rest of the M2 exit test: you edit the shipped spec, which reopens the feature on a new branch
# cut from GitHub's main (local main is behind); the PM's change set adds one task for the new requirement;
# Verify fails that requirement, you turn the failure into a task, Build runs it, and a second PR merges.
source "$(dirname "$0")/lib.sh"
rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
echo '{"questionWindowSeconds": 5}' > "$FOUNDRY_HOME/config.json"
export PATH="$E2E/fake-gh:$PATH" FAKE_GH_STATE="$WORK/gh-state.json" FAKE_GH_REMOTE="$WORK/remote.git" FAKE_FAIL_REQ_ONCE=R3

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo
git init -q --bare "$FAKE_GH_REMOTE"
git -C "$WORK/repo" remote add origin "$FAKE_GH_REMOTE"
git -C "$WORK/repo" push -q origin main
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['ship_mode']=='pr', r;print('new project ships by PR')"

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
verif() { echo "[v for v in d['verifications'] if v['feature_id']==$FID][0]"; }
ship() { q "import json; print(json.dumps(json.loads(([s['value'] for s in d['ships'] if s['key']=='ship:$FID'] or ['null'])[0] or 'null')))"; }

log "plan in one turn, approve once, build both tasks"
wait_for "$(feat)['stage']=='tasks' and not $(feat)['planning_busy']" 120 "task list ready"
PROP=$(q "print([p['id'] for p in d['proposals'] if p['feature_id']==$FID and p['status']=='proposed'][0])")
fact feature.approve_tasks "{\"id\":$FID,\"proposal\":$PROP,\"sha\":\"$(docsha tasks)\",\"spec_sha\":\"$(docsha spec)\",\"plan_sha\":\"$(docsha plan)\"}" | ok "approved"
wait_for "$(st SHT-1)=='In_Review'" 240 "SHT-1 In_Review"
accept SHT-1
wait_for "$(st SHT-2)=='Awaiting_Human'" 240 "SHT-2 asks"
QID=$(q "print([x['id'] for x in d['questions'] if x['issue_key']=='SHT-2'][0])")
fact question.answer "{\"id\":$QID,\"text\":\"yes\"}" >/dev/null
wait_for "$(st SHT-2)=='In_Review'" 240 "SHT-2 In_Review"
accept SHT-2

log "Verify: fail_once fails in every fresh verify workspace, so ship with that gap"
wait_for "$(verif)['status']=='failed'" 300 "Verify failed (fail_once)"
fact feature.ship_with_gaps "{\"id\":$FID}" | ok "shipping with the gap"
q "assert $(feat)['stage']=='ship'; print('in Ship')"

log "Prepare pushes the branch and opens a PR"
B=$(q "print($(feat)['branch'])")
fact feature.prepare_ship "{\"id\":$FID}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r.get('mode')=='pr' and r['pr']['number']==1, r;print('PR', r['pr']['url'])"
[ "$(git -C "$FAKE_GH_REMOTE" rev-parse "$B")" = "$(q "print($(feat)['head_sha'])")" ] && echo "branch $B pushed at the ship SHA"
python3 -c "import json;s=json.load(open('$FAKE_GH_STATE'));b=s['prs'][0]['body'];assert '## Requirements' in b and 'SHT-1' in b, b;print('PR body has the requirement report and tasks')"
SHIP=$(ship)
fact feature.accept_ship "$(echo "$SHIP" | python3 -c "import json,sys;r=json.load(sys.stdin);print(json.dumps({'id':$FID,'head_sha':r['sha'],'tree_sha':r['tree']}))")" | err PR_OPEN
fact feature.refresh_pr "{\"id\":$FID}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['results'][0]['result']=='open', r;print('PR open')"

log "a push to the PR branch sends the feature back to Verify; Prepare then reuses the open PR"
git clone -q -b "$B" "$FAKE_GH_REMOTE" "$WORK/clone"
echo "review fix" > "$WORK/clone/FIX.md"
git -C "$WORK/clone" add -A && git -C "$WORK/clone" commit -q -m "review fix" && git -C "$WORK/clone" push -q origin "$B"
fact feature.refresh_pr "{\"id\":$FID}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['results'][0]['result']=='reverify', r;print('back to Verify')"
wait_for "$(verif)['id']==2 and $(verif)['status']!='running' and $(feat)['stage']=='verify'" 300 "verified again on the new head"
fact feature.ship_with_gaps "{\"id\":$FID}" | ok "shipping with the gap again"
git -C "$WORK/repo" show "$B:FIX.md" | grep -q "review fix" && echo "the fix is on $B"
fact feature.prepare_ship "{\"id\":$FID}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['pr']['number']==1, r;print('reused PR #1')"

log "merged on GitHub: the next check moves the feature to Done"
python3 -c "import json;p='$FAKE_GH_STATE';s=json.load(open(p));s['prs'][0]['state']='MERGED';json.dump(s,open(p,'w'))"
fact feature.refresh_pr "{\"id\":$FID}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['results'][0]['result']=='merged', r;print('merged')"
q "assert $(feat)['stage']=='done'; print('feature Done')"
log "PASS: ship by PR"

log "M2 exit: GitHub merged the PR into its main; editing the shipped spec reopens the feature"
git -C "$FAKE_GH_REMOTE" update-ref refs/heads/main "refs/heads/$B"
SPEC=$(fact feature.doc "{\"id\":$FID,\"kind\":\"spec\"}")
EDIT=$(echo "$SPEC" | python3 -c "import json,sys;r=json.load(sys.stdin);print(json.dumps({'id':$FID,'kind':'spec','base_sha':r['sha'],'text':r['text'].rstrip()+'\n\nAlso accept --loud as an alias of --shout.\n'}))")
fact feature.edit_doc "$EDIT" | ok "edited the shipped spec"
wait_for "$(feat)['round']==2 and $(feat)['stage']=='spec' and $(feat)['spec_change_open']==1 and not $(feat)['planning_busy'] and [x['status'] for x in d['docs'] if x['feature_id']==$FID and x['kind']=='spec'][0]=='in_review'" 120 "reopened, back in Spec with a spec change"
B2=$(q "print($(feat)['branch'])")
[ "$B2" = "$B-r2" ] && echo "new branch $B2"
git -C "$WORK/repo" merge-base --is-ancestor "origin/main" "$B2" && echo "cut from origin/main (local main is behind)"
git -C "$WORK/repo" show "$B2:FIX.md" | grep -q "review fix" && echo "the shipped work is on $B2"
q "assert 'R3' in [r['ref'] for r in d['requirements'] if r['feature_id']==$FID]; print('R3 added')"

log "approve the changed spec and the PM's change set: keep the shipped tasks, one new task for R3"
fact feature.approve_spec "{\"id\":$FID,\"sha\":\"$(docsha spec)\"}" | ok "spec approved"
wait_for "not $(feat)['planning_busy'] and any(p['feature_id']==$FID and p['status']=='proposed' and p['kind']=='change' and p.get('tasks_sha') for p in d['proposals'])" 120 "change set proposed"
PROP=$(q "print([p['id'] for p in d['proposals'] if p['feature_id']==$FID and p['status']=='proposed'][0])")
fact feature.approve_tasks "{\"id\":$FID,\"proposal\":$PROP,\"sha\":\"$(docsha tasks)\"}" | ok "change set approved"
q "assert $(feat)['stage']=='build' and $(st SHT-1)=='Done' and $(st SHT-2)=='Done'; print('Build on the new branch; shipped tasks stay Done')"
wait_for "$(st SHT-3)=='In_Review'" 240 "SHT-3 (--loud) In_Review"
accept SHT-3

log "Verify fails R3; turn the failure into a task, which sends the feature back to Build"
wait_for "$(feat)['stage']=='verify' and $(verif)['status']=='failed' and any(r['requirement_ref']=='R3' and not r['passed'] for r in json.loads($(verif)['requirements'] or '[]'))" 300 "Verify failed R3"
fact feature.task_from_failure "{\"id\":$FID,\"title\":\"Document --loud\",\"description\":\"Verify: --loud is not documented.\",\"requirement_refs\":[\"R3\"]}" | ok "task from the failure"
q "assert $(feat)['stage']=='build'; print('back in Build')"
wait_for "$(st SHT-4)=='In_Review'" 240 "SHT-4 In_Review"
accept SHT-4
wait_for "$(feat)['stage']=='verify' and $(verif)['status']=='failed' and all(r['passed'] for r in json.loads($(verif)['requirements'] or '[]'))" 300 "Verify again: every requirement passes (only fail_once's check gap is left)"
fact feature.ship_with_gaps "{\"id\":$FID}" | ok "shipping with the check gap"

log "a second PR from the new branch merges; the original ship stays in the timeline"
fact feature.prepare_ship "{\"id\":$FID}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['pr']['number']==2, r;print('PR #2')"
python3 -c "import json;p='$FAKE_GH_STATE';s=json.load(open(p));s['prs'][1]['state']='MERGED';json.dump(s,open(p,'w'))"
fact feature.refresh_pr "{\"id\":$FID}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['results'][0]['result']=='merged', r;print('merged')"
q "assert $(feat)['stage']=='done'; assert len([e for e in d['events'] if e.get('feature_id')==$FID and e['kind']=='pr_merged'])==2; print('Done again, with both ships in the timeline')"
log "PASS: M2 exit test"
