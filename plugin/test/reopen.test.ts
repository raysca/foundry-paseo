// The full cascade after Build: editing the spec of a feature in Verify, Ship or Done, and resolving a
// task the change flagged while it was in review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
const R2b = { ref: "R2", title: "CLI flag", acceptance_criteria: ["WHERE --shout is given, THE CLI SHALL print the shouted text in red"] };
const R3 = { ref: "R3", title: "Short flag", acceptance_criteria: ["WHERE -s is given, THE CLI SHALL behave as with --shout"] };

interface Script {
  /** The requirements the PM proposes after your spec edit. */
  edited?: typeof R1[];
  /** The change set the PM proposes, given every issue key. */
  changeSet?: (keys: string[]) => unknown[];
  report?: (n: number) => RequirementResult[] | null;
}

const allPass = (refs = ["R1", "R2"]): RequirementResult[] => refs.map((r) => ({ requirement_ref: r, passed: true, evidence: "ok" }));

async function harness(script: Script = {}) {
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
    if (t.text.includes("approved a changed spec")) return void foundry.planning.proposeTasks(t.agentId, script.changeSet!(store.issues().map((i) => i.key)) as never);
    if (t.text.includes("The developer edited")) return void foundry.planning.proposeRequirements(t.agentId, script.edited ?? [R1, R2, R3]);
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
    const live = store.requirements(store.agent(t.agentId)?.feature_id ?? 0).map((r) => r.ref);
    const r = script.report ? script.report(++verifies) : allPass(live.length ? live : undefined);
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
    for (let i = 0; i < 4; i++) {
      await host.idle();
      await foundry.delivery.settled();
      await foundry.tick();
    }
  };
  const accept = async (key: string) => {
    const a = store.latestAttempt(key)!;
    await foundry.accept(key, a.head_sha!, a.tree_sha!);
    await settle();
  };
  const spec = () => {
    const ff = store.feature(f.id)!;
    return readFileSync(join(ff.integration_path!, ".foundry/features", ff.slug, "spec.md"), "utf8");
  };
  /** Your edit to the spec, then the PM's spec-change turn. */
  const edit = async (text: string) => {
    const r = await foundry.planning.editDoc(f.id, "spec", text, store.doc(f.id, "spec")!.head_sha!);
    await settle();
    return r;
  };
  /** Approve the changed spec, let the PM propose its change set, approve that. */
  const approveChange = async () => {
    await foundry.planning.approveSpec(f.id, store.doc(f.id, "spec")!.head_sha!);
    await settle();
    const doc = await foundry.planning.readDoc(f.id, "tasks");
    const r = (await foundry.planning.approveTasks(f.id, store.proposal(f.id)!.id, doc.sha!)) as { applied: Record<string, string> };
    await settle();
    return r.applied;
  };
  const ship = async () => {
    const prep = await foundry.delivery.prepare(f.id);
    return foundry.delivery.acceptShip(f.id, prep.sha, prep.tree);
  };
  await accept("SHT-1");
  run(repo, "git", "checkout", "-q", "--detach"); // base not checked out: ships merge in a temporary worktree
  return { repo, store, host, foundry, fid: f.id, accept, settle, spec, edit, approveChange, ship };
}

const keepAll = (keys: string[]) => keys.map((k) => ({ issue: k, tag: "keep", title: "", requirement_refs: [] }));

test("editing a Done feature's spec reopens it on a new branch from base; only the delta is built and shipped", async () => {
  const h = await harness({ changeSet: (keys) => [...keepAll(keys), { ref: "N1", tag: "new", title: "Add -s", requirement_refs: ["R3"] }] });
  const { repo, store, host, foundry, fid } = h;
  await h.accept("SHT-2");
  assert.equal(store.feature(fid)!.stage, "ship");
  await h.ship();
  const shipped = store.feature(fid)!;
  assert.equal(shipped.stage, "done");
  const before = { branch: shipped.branch, path: shipped.integration_path!, ws: shipped.integration_workspace_id! };

  const unchanged = await foundry.planning.editDoc(fid, "spec", h.spec(), store.doc(fid, "spec")!.head_sha!);
  assert.equal(unchanged.changed, false, "an unchanged save does not reopen anything");
  assert.equal(store.feature(fid)!.round, 1);

  await h.edit(h.spec().replace("Shout.", "Shout, also with -s."));
  let f = store.feature(fid)!;
  assert.equal(f.round, 2);
  assert.equal(f.branch, "shout-mode-r2");
  assert.notEqual(f.integration_path, before.path);
  assert.equal(f.stage, "spec");
  assert.equal(f.spec_change_open, 1);
  assert.equal(run(repo, "git", "merge-base", "--is-ancestor", "main", f.branch), "", "cut from base, which holds the shipped work");
  assert.ok(existsSync(join(f.integration_path!, "done.txt")));
  assert.ok(!host.archived.includes(before.ws), "the old workspace stays until the change set is approved");
  assert.deepEqual(store.requirements(fid).map((r) => r.ref), ["R1", "R2", "R3"]);
  const row = featuresOverview(store).rows[0]!;
  assert.equal([row.bucket, row.spec_changed].join(" "), "in_progress true");

  const applied = await h.approveChange();
  assert.deepEqual(applied, { "SHT-1": "keep", "SHT-2": "keep", "SHT-3": "new" });
  assert.ok(host.archived.includes(before.ws));
  // Reopening appends a slice: the shipped one stays shipped, the delta builds in slice 2 on the new branch.
  const sl = store.slices(fid);
  assert.deepEqual(sl.map((x) => [x.n, x.status]), [[1, "shipped"], [2, "building"]]);
  assert.equal(sl[1]!.branch, "shout-mode-r2");
  assert.equal(store.issue("SHT-3")!.slice_id, sl[1]!.id);
  await h.accept("SHT-3");
  f = store.feature(fid)!;
  assert.equal(f.stage, "ship", "Build, then Verify, on the new branch");
  assert.equal(foundry.delivery.verification(fid)!.head_sha, f.head_sha);
  await h.ship();
  assert.equal(store.feature(fid)!.stage, "done");
  assert.ok(existsSync(join(store.feature(fid)!.integration_path!, "work-3.txt")));
  assert.equal(run(repo, "git", "cat-file", "-t", "main:work-3.txt"), "blob", "the delta reached base");
  const kinds = store.events({ feature: fid }).map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === "shipped").length, 2, "the original ship stays in the timeline");
  assert.ok(kinds.includes("feature_reopened"));
});

test("discarding the change that reopened a Done feature puts it back to Done on its shipped branch", async () => {
  const h = await harness();
  const { store, host, foundry, fid } = h;
  await h.accept("SHT-2");
  await h.ship();
  const shipped = store.feature(fid)!;
  const specSha = store.doc(fid, "spec")!.head_sha;
  await h.edit(h.spec().replace("Shout.", "Changed."));
  const reopened = store.feature(fid)!;
  await foundry.planning.discardChange(fid);
  const f = store.feature(fid)!;
  assert.deepEqual([f.stage, f.round, f.branch, f.integration_path, f.spec_change_open], ["done", 1, shipped.branch, shipped.integration_path, 0]);
  assert.equal(store.doc(fid, "spec")!.head_sha, specSha);
  assert.deepEqual(store.docs(fid).map((d) => d.status), ["approved", "approved", "approved"]);
  assert.deepEqual(store.requirements(fid).map((r) => r.ref), ["R1", "R2"]);
  assert.ok(host.archived.includes(reopened.integration_workspace_id!));
});

test("a wording-only change in Ship drops the prepared merge and verifies again; Verify and Prepare wait while it is open", async () => {
  const h = await harness({ edited: [R1, R2], changeSet: keepAll });
  const { store, foundry, fid } = h;
  await h.accept("SHT-2");
  await foundry.delivery.prepare(fid);
  const first = foundry.delivery.verification(fid)!;

  store.run("UPDATE verifications SET status='running' WHERE id=?", first.id);
  await assert.rejects(foundry.planning.editDoc(fid, "spec", h.spec() + "\nx\n", store.doc(fid, "spec")!.head_sha!), code("FEATURE_BUSY"));
  store.run("UPDATE verifications SET status='passed' WHERE id=?", first.id);

  await h.edit(h.spec().replace("Shout.", "Shout loudly."));
  assert.equal(store.feature(fid)!.stage, "ship", "Ship keeps its stage until the change set is approved");
  await assert.rejects(foundry.delivery.verify(fid), code("SPEC_CHANGE_OPEN"));
  const prep = foundry.delivery.prepared(fid)!;
  await assert.rejects(foundry.delivery.acceptShip(fid, prep.sha, prep.tree), code("SPEC_CHANGE_OPEN"));

  const applied = await h.approveChange();
  assert.deepEqual(applied, { "SHT-1": "keep", "SHT-2": "keep" });
  const f = store.feature(fid)!;
  assert.equal(f.stage, "ship", "no task to build: straight back through Verify to Ship");
  const v = foundry.delivery.verification(fid)!;
  assert.notEqual(v.id, first.id);
  assert.equal(v.head_sha, f.head_sha);
  assert.equal(foundry.delivery.prepared(fid), null, "the prepared merge was dropped");
  const stages = store.events({ feature: fid }).filter((e) => e.kind === "stage_changed").map((e) => parse<{ to: string }>(e.detail, { to: "" }).to);
  assert.deepEqual(stages.slice(-3), ["build", "verify", "ship"]);
});

test("a change in Verify that adds a task goes back to Build", async () => {
  const h = await harness({
    report: (n) => (n === 1 ? [{ requirement_ref: "R1", passed: true, evidence: "" }, { requirement_ref: "R2", passed: false, evidence: "ignored" }] : allPass(["R1", "R2", "R3"])),
    changeSet: (keys) => [...keepAll(keys), { ref: "N1", tag: "new", title: "Add -s", requirement_refs: ["R3"] }],
  });
  const { store, fid } = h;
  await h.accept("SHT-2");
  assert.equal(store.feature(fid)!.stage, "verify");
  await h.edit(h.spec().replace("Shout.", "Shout, with -s."));
  await h.approveChange();
  assert.equal(store.feature(fid)!.stage, "build");
  assert.equal(store.issue("SHT-3")!.status, "In_Review");
  await h.accept("SHT-3");
  assert.equal(store.feature(fid)!.stage, "ship");
});

test("a task flagged by a spec change is resolved at review: a drafted rework, cancel, or accept as is", async () => {
  const flag = (keys: string[]) => [
    { issue: "SHT-1", tag: "keep", title: "", requirement_refs: [] },
    { issue: "SHT-2", tag: "flag", title: "", requirement_refs: [] },
    ...keys.filter((k) => !["SHT-1", "SHT-2"].includes(k)).map((k) => ({ issue: k, tag: "keep", title: "", requirement_refs: [] })),
    { ref: "N1", tag: "new", title: "Red --shout", requirement_refs: ["R2"] },
  ];
  const h = await harness({ edited: [R1, R2b], changeSet: flag });
  const { store, foundry, fid } = h;
  assert.equal(store.issue("SHT-2")!.status, "In_Review");
  await assert.rejects(Promise.resolve().then(() => foundry.tasks.flagDraft("SHT-2")), code("NOT_FLAGGED"));
  await h.edit(h.spec().replace("Shout.", "Shout in red."));
  await h.approveChange();
  assert.equal(store.issue("SHT-2")!.flag, "SPEC_CHANGED");

  const { feedback } = foundry.tasks.flagDraft("SHT-2");
  assert.match(feedback, /R2 CLI flag \(changed\)/);
  assert.match(feedback, /in red/);
  assert.match(feedback, /Before the change it read: CLI flag; WHERE --shout is given, THE CLI SHALL print the shouted text$/m);

  // Accept as is: merged, but the flag stays, so R2 is not covered by it.
  const a = store.latestAttempt("SHT-2")!;
  await foundry.accept("SHT-2", a.head_sha!, a.tree_sha!);
  await h.settle();
  assert.equal(store.issue("SHT-2")!.status, "Done");
  assert.equal(store.issue("SHT-2")!.flag, "SPEC_CHANGED");
  assert.ok(store.events({ feature: fid }).some((e) => e.kind === "flag_accepted_as_is"));
  const cov = featuresOverview(store).rows[0]!.coverage;
  assert.deepEqual(cov, { covered: 1, total: 2 }, "only R1; R2 waits for SHT-3");
});

test("cancelling a flagged task at review is SHA-bound and only for flagged tasks", async () => {
  const flag = () => [
    { issue: "SHT-1", tag: "keep", title: "", requirement_refs: [] },
    { issue: "SHT-2", tag: "flag", title: "", requirement_refs: [] },
    { ref: "N1", tag: "new", title: "Red --shout", requirement_refs: ["R2"] },
  ];
  const h = await harness({ edited: [R1, R2b], changeSet: flag });
  const { store, foundry } = h;
  const a0 = store.latestAttempt("SHT-2")!;
  await assert.rejects(foundry.tasks.cancelAtReview("SHT-2", a0.head_sha!, a0.tree_sha!), code("NOT_FLAGGED"));
  await h.edit(h.spec().replace("Shout.", "Shout in red."));
  await h.approveChange();
  const a = store.latestAttempt("SHT-2")!;
  await assert.rejects(foundry.tasks.cancelAtReview("SHT-2", "0".repeat(40), a.tree_sha!), code("STALE_REVIEW"));
  await foundry.tasks.cancelAtReview("SHT-2", a.head_sha!, a.tree_sha!);
  assert.equal(store.issue("SHT-2")!.status, "Cancelled");
});
