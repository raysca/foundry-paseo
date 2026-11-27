import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, parse } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { featuresOverview } from "../server/core/overview";
import { FoundryError } from "../server/core/model";
import type { RequirementResult } from "../server/core/delivery";
import { FakeHost, fixtureRepo, run, type Turn } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;

const R1 = { ref: "R1", title: "Shout", acceptance_criteria: ["WHEN shout is called THE library SHALL return the text upper-cased"] };
const R2 = { ref: "R2", title: "CLI flag", acceptance_criteria: ["WHERE --shout is given, THE CLI SHALL print the shouted text"] };

interface Script {
  /** What the Verify reviewer reports; null reports nothing. */
  report?: (n: number) => RequirementResult[] | null;
}

const allPass = (): RequirementResult[] => [
  { requirement_ref: "R1", passed: true, evidence: "shout() upper-cases" },
  { requirement_ref: "R2", passed: true, evidence: "--shout prints it" },
];

/** A feature planned and approved, SHT-1 accepted and SHT-2 waiting in review (Build's last step). */
async function lastTaskInReview(script: Script = {}) {
  const repo = fixtureRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, {
    home: "",
    tickMs: 0,
    loop: () => ({ maxFixRounds: 2, questionWindowMs: 50, checkTimeoutMs: 30_000, planningTimeoutMs: 0 }),
  });
  foundry.requireSetup = async () => {};
  host.loop = foundry;
  const dirOf = (t: Turn) => /Write only under (\S+)\//.exec(host.agents.get(t.agentId)!.messages[0]!)![1]!;
  host.behaviours.planner = (t) => {
    const dir = dirOf(t);
    if (t.text.includes("call propose_tasks with")) {
      foundry.planning.proposeTasks(t.agentId, [
        { ref: "T1", title: "Add shout()", requirement_refs: ["R1"], size: "S" },
        { ref: "T2", title: "Add --shout", requirement_refs: ["R2"], depends_on: [{ ref: "T1", reason: "uses shout()" }] },
      ]);
      return;
    }
    if (t.text.includes("plan.md with")) return t.write(`${dir}/plan.md`, "# Plan\n");
    if (t.text.includes("Step 2")) {
      t.write(`${dir}/spec.md`, "# Spec\n\n## Goal\nShout.\n\n## Requirements\n\n## Out of scope\nWhisper.\n");
      foundry.planning.proposeRequirements(t.agentId, [R1, R2]);
    }
  };
  let builds = 0;
  host.behaviours.builder = (t) => {
    t.write("done.txt", "ok\n");
    t.write(`work-${++builds}.txt`, "x\n");
  };
  let verifies = 0;
  host.behaviours.reviewer = (t) => {
    if (!t.text.includes("report_requirements")) return void foundry.tasks.reportVerdict(t.agentId, { decision: "pass", reason: "ok" });
    t.write("reviewer-scratch.txt", "should be reset\n");
    const r = (script.report ?? allPass)(++verifies);
    if (r) foundry.delivery.reportRequirements(t.agentId, r);
  };
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  const f = await foundry.planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  await foundry.planning.approveSpec(f.id, store.doc(f.id, "spec")!.head_sha!);
  await host.idle();
  await foundry.planning.approvePlan(f.id, store.doc(f.id, "plan")!.head_sha!);
  await host.idle();
  await foundry.planning.approveTasks(f.id, store.proposal(f.id)!.id, store.doc(f.id, "tasks")!.head_sha!);
  await host.idle();
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await host.idle();
      await foundry.delivery.settled();
    }
  };
  const accept = async (key: string) => {
    const a = store.latestAttempt(key)!;
    await foundry.accept(key, a.head_sha!, a.tree_sha!);
    await settle();
  };
  await accept("SHT-1");
  assert.equal(store.issue("SHT-2")!.status, "In_Review");
  return { repo, store, host, foundry, fid: f.id, accept, settle };
}

const onMain = (repo: string, file: string, content: string, msg: string) => {
  writeFileSync(join(repo, file), content);
  run(repo, "git", "add", "-A");
  run(repo, "git", "commit", "-q", "-m", msg);
};

test("Build ends, Verify passes on the merged head and the feature ships by local merge", async () => {
  const { repo, store, host, foundry, fid, accept } = await lastTaskInReview();
  onMain(repo, "NOTES.md", "base moved on\n", "unrelated base change");
  await accept("SHT-2");
  const f = store.feature(fid)!;
  assert.equal(f.stage, "ship");
  const v = foundry.delivery.verification(fid)!;
  assert.equal(v.status, "passed");
  assert.equal(v.head_sha, f.head_sha);
  // Base was merged into the feature branch before checking.
  assert.ok(existsSync(join(f.integration_path!, "NOTES.md")));
  assert.deepEqual(parse<{ name: string; status: string }[]>(v.checks, []).map((c) => [c.name, c.status]), [["test", "passed"]]);
  assert.equal(parse<RequirementResult[]>(v.requirements, []).length, 2);
  // Checks and the reviewer ran in a fresh verify workspace at the merged head, archived after; the
  // reviewer's edits were undone and the integration worktree was never touched.
  assert.notEqual(v.path, f.integration_path);
  assert.equal(host.workspaces.get(v.workspace_id!)!.purpose, "verify");
  assert.ok(host.archived.includes(v.workspace_id!));
  assert.equal(run(v.path!, "git", "status", "--porcelain"), "");
  assert.equal(run(f.integration_path!, "git", "status", "--porcelain"), "");
  assert.ok(host.notifications.some((n) => n.key === `verify:${fid}` && /ready to ship/.test(n.title)));
  assert.equal(featuresOverview(store).rows[0]!.delivery_label, "Ready to ship");

  // A head that already passed is not verified again unless asked.
  assert.deepEqual(await foundry.delivery.verify(fid), { skipped: true, verification: v.id });

  await assert.rejects(foundry.delivery.acceptShip(fid, f.head_sha!, "x"), code("NOT_PREPARED"));
  const prep = await foundry.delivery.prepare(fid);
  assert.equal(prep.sha, f.head_sha);
  await assert.rejects(foundry.delivery.verify(fid), code("SHIP_PREPARED"));
  await assert.rejects(foundry.delivery.acceptShip(fid, "0".repeat(40), prep.tree), code("STALE_REVIEW"));

  // main is checked out in the developer's own checkout: refused when dirty, then until confirmed.
  writeFileSync(join(repo, "README.md"), "local edit\n");
  await assert.rejects(foundry.delivery.acceptShip(fid, prep.sha, prep.tree, { confirmCheckedOut: true }), code("BASE_DIRTY"));
  run(repo, "git", "checkout", "-q", "--", "README.md");
  await assert.rejects(foundry.delivery.acceptShip(fid, prep.sha, prep.tree), (e) => code("BASE_CHECKED_OUT")(e) && realpathSync(String((e as FoundryError).detail?.path)) === realpathSync(repo));
  const shipped = await foundry.delivery.acceptShip(fid, prep.sha, prep.tree, { confirmCheckedOut: true });
  assert.equal(shipped.pushed, null);
  assert.equal(run(repo, "git", "rev-parse", "HEAD"), shipped.merged);
  assert.equal(readFileSync(join(repo, "done.txt"), "utf8"), "ok\n");
  assert.equal(run(repo, "git", "merge-base", "--is-ancestor", prep.sha, "main") , "");
  assert.equal(store.feature(fid)!.stage, "done");
  assert.ok(store.events({ feature: fid }).some((e) => e.kind === "shipped"));
  assert.equal(featuresOverview(store).buckets.completed, 1);
});

test("a failed requirement becomes a task, Build runs it, Verify runs again and Ship merges in a temporary worktree", async () => {
  const { repo, store, foundry, fid, accept, settle } = await lastTaskInReview({
    report: (n) => (n === 1 ? [allPass()[0]!, { requirement_ref: "R2", passed: false, evidence: "--shout is ignored" }] : allPass()),
  });
  await accept("SHT-2");
  const v = foundry.delivery.verification(fid)!;
  assert.equal([v.status, v.failure].join(" "), "failed REQUIREMENTS_FAILED");
  assert.equal(store.feature(fid)!.stage, "verify");
  const row = featuresOverview(store).rows[0]!;
  assert.equal(row.delivery_label, "Verify: 1 of 2 requirements failed");
  assert.ok(row.waiting_on_you >= 1);

  await assert.rejects(foundry.delivery.taskFromFailure(fid, "Fix --shout", "", ["R9"]), code("TASKS_INVALID"));
  const { issue } = await foundry.delivery.taskFromFailure(fid, "Fix --shout", "Verify: --shout is ignored", ["R2"]);
  assert.equal(issue, "SHT-3");
  await settle();
  assert.equal(store.feature(fid)!.stage, "build");
  assert.equal(store.issue("SHT-3")!.status, "In_Review"); // started at once and built
  await accept("SHT-3");
  assert.equal(store.feature(fid)!.stage, "ship");
  assert.equal(store.all("SELECT * FROM verifications WHERE feature_id=?", fid).length, 2);

  // main not checked out anywhere: merged in a temporary worktree with no confirmation.
  run(repo, "git", "checkout", "-q", "--detach");
  const prep = await foundry.delivery.prepare(fid);
  const shipped = await foundry.delivery.acceptShip(fid, prep.sha, prep.tree);
  assert.equal(run(repo, "git", "rev-parse", "main"), shipped.merged);
  assert.equal(store.feature(fid)!.stage, "done");
  assert.ok(!run(repo, "git", "worktree", "list").includes("foundry-ship-"));
});

test("checks that fail on the merged head stop Verify; shipping with the gaps records them", async () => {
  const { repo, store, foundry, fid, accept } = await lastTaskInReview();
  // Base adds a requirement to its test script after the tasks' own checks passed.
  const cfg = { scripts: { test: { type: "script", command: "sh check.sh && test -f CHANGELOG.md" } } };
  onMain(repo, "paseo.json", JSON.stringify(cfg, null, 2), "base wants a changelog");
  await accept("SHT-2");
  const v = foundry.delivery.verification(fid)!;
  assert.equal(v.failure, "CHECKS_FAILED");
  assert.equal(featuresOverview(store).rows[0]!.delivery_label, "Verify: 1 check failed");
  const { gaps } = await foundry.delivery.shipWithGaps(fid);
  assert.deepEqual(gaps, ["check test"]);
  assert.equal(store.feature(fid)!.stage, "ship");
  assert.ok(store.events({ feature: fid }).some((e) => e.kind === "shipped_with_gaps"));
});

test("a base merge that conflicts stops Verify with BASE_CONFLICT and leaves the feature branch clean", async () => {
  const { repo, store, foundry, fid, accept } = await lastTaskInReview();
  onMain(repo, "done.txt", "nope\n", "conflicting base change");
  await accept("SHT-2");
  const f = store.feature(fid)!;
  const v = foundry.delivery.verification(fid)!;
  assert.equal([v.status, v.failure].join(" "), "failed BASE_CONFLICT");
  assert.equal(f.stage, "verify");
  assert.equal(run(f.integration_path!, "git", "status", "--porcelain"), "");
  assert.equal(run(f.integration_path!, "git", "rev-parse", "HEAD"), f.head_sha);
  const e = store.events({ feature: fid }).find((x) => x.kind === "verify_done")!;
  assert.deepEqual(parse<{ paths: string[] }>(e.detail, { paths: [] }).paths, ["done.txt"]);
});

test("a Verify reviewer that reports nothing fails Verify; a restart verifies an interrupted run again", async () => {
  const { store, foundry, fid, accept, settle } = await lastTaskInReview({ report: (n) => (n === 1 ? null : allPass()) });
  await accept("SHT-2");
  assert.equal(foundry.delivery.verification(fid)!.failure, "NO_REQUIREMENTS_REPORT");
  assert.throws(() => foundry.delivery.reportRequirements("someone-else", allPass()), code("TOOL_REFUSED"));

  store.run("UPDATE verifications SET status='running', failure=NULL WHERE feature_id=?", fid);
  await foundry.delivery.recover();
  await settle();
  const rows = store.all<{ status: string; failure: string | null }>("SELECT status, failure FROM verifications WHERE feature_id=? ORDER BY id", fid);
  assert.deepEqual(rows.map((r) => r.failure ?? r.status), ["INTERRUPTED", "passed"]);
  assert.equal(store.feature(fid)!.stage, "ship");
});

test("the review panel's data: the diff against the feature head at the SHAs accept takes", async () => {
  const { store, foundry } = await lastTaskInReview();
  const r = await foundry.tasks.review("SHT-2");
  const a = store.latestAttempt("SHT-2")!;
  assert.equal(r.head_sha, a.head_sha);
  assert.equal(r.tree_sha, a.tree_sha);
  assert.match(r.diff, /work-2\.txt/);
  assert.doesNotMatch(r.diff, /work-1\.txt/, "SHT-1's work is already on the feature head");
  assert.ok(r.runs.some((x) => x.kind === "review"));
  await foundry.accept("SHT-2", r.head_sha!, r.tree_sha!);
  assert.equal(store.issue("SHT-2")!.status, "Done");
});
