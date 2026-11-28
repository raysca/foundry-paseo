// Ship in PR mode: with a remote, Prepare pushes the feature branch and opens a PR with gh; Foundry
// follows the PR (merged → Done, closed → prepare again, new commits → Verify again). A fake gh on PATH
// stands in for GitHub and a bare repo for the remote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { FoundryError } from "../server/core/model";
import { redact } from "../server/core/github";
import type { RequirementResult } from "../server/core/delivery";
import { FakeHost, fixtureRepo, run, type Turn } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;
const R1 = { ref: "R1", title: "Shout", acceptance_criteria: ["WHEN shout is called THE library SHALL return the text upper-cased"] };

// The fake gh the e2e suite puts on the daemon's PATH (pr create records a PR in a JSON state file; pr view
// reports it, with headRefOid read from the bare remote, so a push to the PR branch shows as new commits).
const FAKE_GH = readFileSync(join(__dirname, "../../e2e/fake-gh/gh"), "utf8");

function fakeGitHub(repo: string) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-gh-"));
  const remote = join(dir, "remote.git");
  run(dir, "git", "init", "-q", "--bare", remote);
  run(repo, "git", "remote", "add", "origin", remote);
  run(repo, "git", "push", "-q", "origin", "main");
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  const state = join(dir, "gh-state.json");
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.FAKE_GH_STATE = state;
  process.env.FAKE_GH_REMOTE = remote;
  const read = () => JSON.parse(readFileSync(state, "utf8")) as { prs: { number: number; state: string; head: string; base: string; title: string; body: string }[]; fail?: string };
  const set = (n: number, s: string) => {
    const st = read();
    st.prs.find((p) => p.number === n)!.state = s;
    writeFileSync(state, JSON.stringify(st));
  };
  return { remote, read, set, dir };
}

/** A feature through Build and a passing Verify, in Ship, in a repo with a remote. */
async function inShip(o: { remote?: boolean; mode?: "pr" | "local_merge" } = {}) {
  const repo = fixtureRepo();
  const gh = o.remote === false ? null : fakeGitHub(repo);
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, { home: "", tickMs: 0, loop: () => ({ maxFixRounds: 2, questionWindowMs: 50, checkTimeoutMs: 30_000, planningTimeoutMs: 0 }) });
  foundry.requireSetup = async () => {};
  host.loop = foundry;
  const dirOf = (t: Turn) => /Write only under (\S+)\//.exec(host.agents.get(t.agentId)!.messages[0]!)![1]!;
  host.behaviours.planner = (t) => {
    const dir = dirOf(t);
    if (t.text.includes("call propose_tasks with")) return void foundry.planning.proposeTasks(t.agentId, [{ ref: "T1", title: "Add shout()", requirement_refs: ["R1"], size: "S" }]);
    if (t.text.includes("plan.md with")) return t.write(`${dir}/plan.md`, "# Plan\n");
    if (t.text.includes("Step 2")) {
      t.write(`${dir}/spec.md`, "# Spec\n\n## Goal\nShout, with api_key=sk-abcdefghijklmnopqrstuvwxyz kept out of PRs.\n\n## Requirements\n");
      foundry.planning.proposeRequirements(t.agentId, [R1]);
    }
  };
  host.behaviours.builder = (t) => t.write("done.txt", "ok\n");
  let verifies = 0;
  host.behaviours.reviewer = (t) => {
    if (!t.text.includes("report_requirements")) return void foundry.tasks.reportVerdict(t.agentId, { decision: "pass", reason: "ok" });
    verifies++;
    foundry.delivery.reportRequirements(t.agentId, [{ requirement_ref: "R1", passed: true, evidence: "shout() upper-cases" } as RequirementResult]);
  };
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  if (o.mode) store.setShipMode(p.id, o.mode);
  const f = await foundry.planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  await foundry.planning.approveSpec(f.id, store.doc(f.id, "spec")!.head_sha!);
  await host.idle();
  await foundry.planning.approvePlan(f.id, store.doc(f.id, "plan")!.head_sha!);
  await host.idle();
  await foundry.planning.approveTasks(f.id, store.proposal(f.id)!.id, store.doc(f.id, "tasks")!.head_sha!);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await host.idle();
      await foundry.delivery.settled();
    }
  };
  await settle();
  const a = store.latestAttempt("SHT-1")!;
  await foundry.accept("SHT-1", a.head_sha!, a.tree_sha!);
  await settle();
  assert.equal(store.feature(f.id)!.stage, "ship");
  return { repo, store, foundry, gh, fid: f.id, settle, verifies: () => verifies };
}

test("new projects ship by PR; projects from before keep merging locally; the mode is validated", () => {
  const store = new Store(":memory:");
  const p = store.createProject({ key: "SHT", name: "Shout", repo: "/tmp/x", baseRef: "main" });
  assert.equal(p.ship_mode, "pr");
  assert.throws(() => store.setShipMode(p.id, "yolo" as never), code("INVALID_SHIP_MODE"));
  assert.equal(store.setShipMode(p.id, "local_merge").ship_mode, "local_merge");
  assert.equal(redact("token: ghp_abcdefghijklmnopqrstuvwxyz0123 and password=hunter2"), "token: [redacted] and password=[redacted]");
});

test("pr mode: Prepare pushes the branch and opens a PR; accept and Verify wait for it; merged on GitHub moves to Done", async () => {
  const { store, foundry, gh, fid } = await inShip();
  const f = store.feature(fid)!;
  const ship = await foundry.delivery.prepare(fid);
  assert.equal(ship.mode, "pr");
  assert.equal(ship.pr!.number, 1);
  assert.equal(run(gh!.remote, "git", "rev-parse", f.branch), f.head_sha, "the feature branch was pushed at the ship SHA");
  const pr = gh!.read().prs[0]!;
  assert.deepEqual([pr.head, pr.base, pr.title], [f.branch, "main", "Shout mode"]);
  assert.match(pr.body, /## Summary\n\nShout, with api_key=\[redacted\]/);
  assert.doesNotMatch(pr.body, /sk-abc/);
  assert.match(pr.body, /✅ \*\*R1\*\* Shout: shout\(\) upper-cases/);
  assert.match(pr.body, /\[x\] SHT-1 Add shout\(\)/);

  await assert.rejects(foundry.delivery.prepare(fid), code("PR_OPEN"));
  await assert.rejects(foundry.delivery.acceptShip(fid, ship.sha, ship.tree), code("PR_OPEN"));
  await assert.rejects(foundry.delivery.verify(fid, "you", true), code("PR_OPEN"));
  assert.deepEqual(await foundry.delivery.refreshPrs(), [{ feature: fid, result: "open" }]);

  gh!.set(1, "MERGED");
  assert.deepEqual(await foundry.delivery.refreshPrs(fid, "you"), [{ feature: fid, result: "merged" }]);
  assert.equal(store.feature(fid)!.stage, "done");
  assert.equal(foundry.delivery.prepared(fid), null);
  assert.ok(store.events({ feature: fid }).some((e) => e.kind === "pr_merged"));
});

test("a PR closed without merging leaves the feature in Ship to prepare again", async () => {
  const { store, foundry, gh, fid } = await inShip();
  await foundry.delivery.prepare(fid);
  gh!.set(1, "CLOSED");
  assert.deepEqual(await foundry.delivery.refreshPrs(), [{ feature: fid, result: "closed" }]);
  assert.equal(store.feature(fid)!.stage, "ship");
  assert.equal(foundry.delivery.prepared(fid), null);
  const again = await foundry.delivery.prepare(fid);
  assert.equal(again.pr!.number, 2);
});

test("new commits on the PR branch send the feature back to Verify, which takes them in and passes again", async () => {
  const { store, foundry, gh, fid, settle, verifies } = await inShip();
  const f = store.feature(fid)!;
  await foundry.delivery.prepare(fid);
  // Someone pushes a fix to the PR branch on GitHub.
  const clone = join(gh!.dir, "clone");
  run(gh!.dir, "git", "clone", "-q", "-b", f.branch, gh!.remote, clone);
  writeFileSync(join(clone, "FIX.md"), "review fix\n");
  run(clone, "git", "add", "-A");
  run(clone, "git", "-c", "user.name=R", "-c", "user.email=r@x", "commit", "-q", "-m", "review fix");
  run(clone, "git", "push", "-q", "origin", f.branch);
  const before = verifies();
  assert.deepEqual(await foundry.delivery.refreshPrs(), [{ feature: fid, result: "reverify" }]);
  assert.ok(store.events({ feature: fid }).some((e) => e.kind === "pr_new_commits"));
  await settle();
  const ff = store.feature(fid)!;
  assert.equal(ff.stage, "ship", "verified again and back in Ship");
  assert.equal(verifies(), before + 1);
  assert.equal(run(ff.integration_path!, "git", "show", "HEAD:FIX.md"), "review fix");
  assert.equal(foundry.delivery.verification(fid)!.head_sha, ff.head_sha);
  // Prepare again: the PR still open for the branch is reused and gets the verified head.
  const again = await foundry.delivery.prepare(fid);
  assert.equal(again.pr!.number, 1);
  assert.equal(gh!.read().prs.length, 1);
  assert.equal(run(gh!.remote, "git", "rev-parse", ff.branch), ff.head_sha);
  assert.deepEqual(await foundry.delivery.refreshPrs(), [{ feature: fid, result: "open" }]);
});

test("local_merge with a remote merges locally and pushes base; pr mode without a remote merges locally", async () => {
  const a = await inShip({ mode: "local_merge" });
  const prep = await a.foundry.delivery.prepare(a.fid);
  assert.equal(prep.mode, "local_merge");
  const shipped = await a.foundry.delivery.acceptShip(a.fid, prep.sha, prep.tree, { confirmCheckedOut: true });
  assert.equal(shipped.pushed, "origin");
  assert.equal(run(a.gh!.remote, "git", "rev-parse", "main"), shipped.merged);

  const b = await inShip({ remote: false });
  const p2 = await b.foundry.delivery.prepare(b.fid);
  assert.equal(p2.mode, "local_merge");
  assert.ok(b.store.events({ feature: b.fid }).some((e) => e.kind === "ship_prepared" && /no remote/.test(e.detail)));
});

test("gh refusing to open the PR leaves nothing prepared and says why", async () => {
  const { foundry, gh, fid } = await inShip();
  writeFileSync(process.env.FAKE_GH_STATE!, JSON.stringify({ prs: [], fail: "HTTP 401: Bad credentials" }));
  await assert.rejects(foundry.delivery.prepare(fid), (e) => code("GH_FAILED")(e) && /Bad credentials/.test((e as Error).message));
  assert.equal(foundry.delivery.prepared(fid), null);
  assert.ok(gh);
});
