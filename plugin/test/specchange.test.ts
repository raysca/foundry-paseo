import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store, parse } from "../server/core/store";
import { Locks } from "../server/core/locks";
import { TaskLoop } from "../server/core/taskloop";
import { Planning } from "../server/core/planning";
import { featuresOverview } from "../server/core/overview";
import { FoundryError } from "../server/core/model";
import { withRequirements, renderRequirements } from "../server/core/graph";
import { FakeHost, fixtureRepo, run, type Turn } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;

const R1 = { ref: "R1", title: "Shout", acceptance_criteria: ["WHEN shout is called THE library SHALL return the text upper-cased"] };
const R1b = { ref: "R1", title: "Shout", acceptance_criteria: ["WHEN shout is called THE library SHALL return the text upper-cased with !"] };
const R2 = { ref: "R2", title: "CLI flag", acceptance_criteria: ["WHERE --shout is given, THE CLI SHALL print the shouted text"] };
const R3 = { ref: "R3", title: "Short flag", acceptance_criteria: ["WHERE -s is given, THE CLI SHALL behave as with --shout"] };

interface Plan {
  changeSet?: (keys: string[]) => unknown[];
}

async function toBuild(plan: Plan = {}) {
  const repo = fixtureRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const locks = new Locks();
  const loop = new TaskLoop(store, host, locks, { maxFixRounds: 2, questionWindowMs: 50, checkTimeoutMs: 30_000 });
  const planning = new Planning(store, host, locks, { questionWindowMs: 50, turnTimeoutMs: 0 }, async () => {}, () => loop.tick());
  host.loop = { onTurnEnd: (id, o, t) => (store.agent(id)?.role === "planner" ? planning.onTurnEnd(id, o, t) : loop.onTurnEnd(id, o, t)) };
  const errors: string[] = [];
  const dirOf = (t: Turn) => /Write only under (\S+)\//.exec(host.agents.get(t.agentId)!.messages[0]!)![1]!;
  host.behaviours.planner = (t) => {
    const dir = dirOf(t);
    if (t.text.includes("approved a changed spec")) {
      const keys = store.issues().map((i) => i.key);
      // An incomplete change set is refused, then the PM sends the full one.
      try {
        planning.proposeTasks(t.agentId, [{ ref: "N1", tag: "new", title: "Add -s", requirement_refs: ["R3"] }]);
      } catch (e) {
        errors.push((e as FoundryError).code);
      }
      planning.proposeTasks(t.agentId, plan.changeSet!(keys) as never);
      return;
    }
    if (t.text.includes("The developer edited")) {
      try {
        planning.proposeRequirements(t.agentId, [R1b, { ...R2, ref: "R9" }, R3]);
      } catch (e) {
        errors.push((e as FoundryError).message);
      }
      planning.proposeRequirements(t.agentId, [R1b, R2, R3]);
      return;
    }
    if (t.text.includes("call propose_tasks with")) {
      planning.proposeTasks(t.agentId, [
        { ref: "T1", title: "Add shout()", requirement_refs: ["R1"], size: "S" },
        { ref: "T2", title: "Add --shout", requirement_refs: ["R2"], depends_on: [{ ref: "T1", reason: "uses shout()" }], size: "L" },
      ]);
      return;
    }
    if (t.text.includes("plan.md with")) return t.write(`${dir}/plan.md`, "# Plan\n");
    if (t.text.includes("Step 2")) {
      t.write(`${dir}/spec.md`, "# Spec\n\n## Goal\nShout.\n\n## Requirements\n\n(the PM's own list)\n\n## Out of scope\nWhisper.\n");
      planning.proposeRequirements(t.agentId, [R1, R2]);
    }
  };
  host.behaviours.builder = (t) => t.write("done.txt", "ok\n");
  host.behaviours.reviewer = (t) => void loop.reportVerdict(t.agentId, { decision: "pass", reason: "ok" });
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  await planning.approveSpec(f.id, store.doc(f.id, "spec")!.head_sha!);
  await host.idle();
  await planning.approvePlan(f.id, store.doc(f.id, "plan")!.head_sha!);
  await host.idle();
  await planning.approveTasks(f.id, store.proposal(f.id)!.id, store.doc(f.id, "tasks")!.head_sha!);
  await host.idle();
  const accept = async (key: string) => {
    const a = store.latestAttempt(key)!;
    await loop.accept(key, a.head_sha!, a.tree_sha!);
    await host.idle();
  };
  return { repo, store, host, loop, planning, f: store.feature(f.id)!, accept, errors };
}

const specText = (s: Store, id: number) => {
  const f = s.feature(id)!;
  return readFileSync(join(f.integration_path!, ".foundry/features", f.slug, "spec.md"), "utf8");
};

test("Foundry writes spec.md's Requirements section from the requirements it holds", () => {
  const block = renderRequirements([{ ref: "R1", title: "Shout", criteria: ["THE CLI SHALL shout"] }]);
  const once = withRequirements("# S\n\n## Requirements\n\nmine\n\n## Out of scope\nx\n", block);
  assert.match(once, /## Requirements\n\n<!-- foundry:requirements[^\n]*\n### R1 Shout\n\n- THE CLI SHALL shout\n<!-- \/foundry:requirements -->\n\n## Out of scope/);
  assert.doesNotMatch(once, /mine/);
  const twice = withRequirements(once, renderRequirements([{ ref: "R2", title: "Flag", criteria: ["THE CLI SHALL flag"] }]));
  assert.match(twice, /### R2 Flag/);
  assert.doesNotMatch(twice, /R1 Shout/);
  assert.match(withRequirements("# S\n\n## Out of scope\nx\n", block), /## Requirements\n\n<!-- foundry[\s\S]*## Out of scope/);
});

test("a spec edit during Build opens a spec change; its change set is applied all at once", async () => {
  const { store, host, planning, f, accept, errors } = await toBuild({
    changeSet: () => [
      { issue: "SHT-1", tag: "keep", title: "", requirement_refs: [] },
      { issue: "SHT-2", tag: "keep", title: "", requirement_refs: [] },
      { ref: "F1", tag: "followup", title: "Add ! to shout()", requirement_refs: ["R1"], depends_on: [{ ref: "SHT-1", reason: "brings it in line" }] },
      { ref: "N1", tag: "new", title: "Add -s", requirement_refs: ["R3"], depends_on: [{ ref: "SHT-2", reason: "extends the flag" }] },
    ],
  });
  assert.match(specText(store, f.id), /### R1 Shout[\s\S]*### R2 CLI flag/);
  assert.doesNotMatch(specText(store, f.id), /the PM's own list/);
  await accept("SHT-1");
  assert.equal(store.issue("SHT-2")!.status, "In_Review");

  const spec = store.doc(f.id, "spec")!;
  await assert.rejects(planning.editDoc(f.id, "spec", "x", "0".repeat(40)), code("STALE_EDIT"));
  const r = await planning.editDoc(f.id, "spec", specText(store, f.id).replace("Shout.", "Shout, with ! and -s."), spec.head_sha!);
  assert.equal(r.changed, true);
  await host.idle();
  let ff = store.feature(f.id)!;
  assert.equal(ff.spec_change_open, 1);
  assert.equal(store.doc(f.id, "spec")!.status, "in_review");
  assert.equal(store.doc(f.id, "tasks")!.status, "stale");
  assert.match(errors[0]!, /R2 reappears unchanged as R9; keep R2/);
  assert.match(specText(store, f.id), /### R3 Short flag/);
  const row = featuresOverview(store).rows[0]!;
  assert.equal(row.spec_changed, true);
  assert.equal(row.bucket, "in_progress");

  await planning.approveSpec(f.id, store.doc(f.id, "spec")!.head_sha!);
  await host.idle();
  assert.deepEqual(errors[1], "TASKS_INVALID");
  const change = store.openSpecChange(f.id)!;
  const d = parse<{ changed: string[]; unchanged: string[]; added: string[]; removed: string[] }>(change.diff, { changed: [], unchanged: [], added: [], removed: [] });
  assert.deepEqual([d.unchanged, d.changed, d.added, d.removed], [["R2"], ["R1"], ["R3"], []]);
  const prop = store.proposal(f.id)!;
  assert.equal(prop.kind, "change");
  const tasksDoc = await planning.readDoc(f.id, "tasks");
  assert.match(tasksDoc.text, /\| SHT-1 \| keep \|/);

  const res = (await planning.approveTasks(f.id, prop.id, tasksDoc.sha!)) as { applied: Record<string, string> };
  assert.deepEqual(res.applied, { "SHT-1": "keep", "SHT-2": "keep", "SHT-3": "followup", "SHT-4": "new" });
  ff = store.feature(f.id)!;
  assert.equal(ff.spec_change_open, 0);
  assert.equal(store.doc(f.id, "tasks")!.status, "approved");
  assert.deepEqual(store.deps("SHT-3").map((x) => x.depends_on), ["SHT-1"]);
  await host.idle();
  assert.equal(store.issue("SHT-3")!.status, "In_Review", "auto-start resumed for the follow-up");
  assert.equal(store.issue("SHT-4")!.status, "Backlog", "waits for SHT-2");

  const cov = featuresOverview(store).rows[0]!.coverage;
  assert.deepEqual(cov, { covered: 0, total: 3 }, "R1 changed and is not covered until its follow-up is Done");
  await accept("SHT-3");
  assert.deepEqual(featuresOverview(store).rows[0]!.coverage, { covered: 1, total: 3 });
});

test("a change set that keeps a task in review on a changed requirement is refused (it must be flagged)", async () => {
  const { store, host, planning, f } = await toBuild({
    changeSet: () => [
      { issue: "SHT-1", tag: "keep", title: "", requirement_refs: [] },
      { issue: "SHT-2", tag: "keep", title: "", requirement_refs: [] },
      { ref: "N1", tag: "new", title: "Add -s", requirement_refs: ["R3"] },
    ],
  });
  // SHT-1 is In_Review (covers R1, which will change), SHT-2 is Backlog.
  await planning.editDoc(f.id, "spec", specText(store, f.id) + "\nMore.\n", store.doc(f.id, "spec")!.head_sha!);
  await host.idle();
  await planning.approveSpec(f.id, store.doc(f.id, "spec")!.head_sha!);
  await host.idle();
  assert.equal(store.proposal(f.id), undefined, "the bad change set was not recorded");
  assert.match(store.feature(f.id)!.planning_error!, /last turn failed|without calling propose_tasks/);
});

test("discarding a spec change restores the approved spec and requirements and resumes auto-start", async () => {
  const { store, host, planning, f } = await toBuild();
  const approved = specText(store, f.id);
  await planning.editDoc(f.id, "spec", approved.replace("Shout.", "Changed."), store.doc(f.id, "spec")!.head_sha!);
  await host.idle();
  assert.equal(store.requirements(f.id).length, 3);
  await planning.discardChange(f.id);
  const ff = store.feature(f.id)!;
  assert.equal(ff.spec_change_open, 0);
  assert.equal(specText(store, f.id).trim(), approved.trim());
  assert.deepEqual(store.requirements(f.id).map((r) => r.ref), ["R1", "R2"]);
  assert.deepEqual(store.docs(f.id).map((x) => x.status), ["approved", "approved", "approved"]);
  assert.equal(run(ff.integration_path!, "git", "log", "-1", "--format=%s"), "shout-mode: discard spec change");
  await assert.rejects(planning.discardChange(f.id), code("NO_SPEC_CHANGE"));
});

test("an edit before Build sends the feature back to that doc's stage", async () => {
  const repo = fixtureRepo();
  void repo;
  const { store, host, planning, f } = await toBuild();
  void f;
  // A second feature stopped in Plan.
  const p = store.projects()[0]!;
  const g = await planning.createFeature({ projectId: p.id, idea: "Whisper mode" });
  await host.idle();
  await planning.approveSpec(g.id, store.doc(g.id, "spec")!.head_sha!);
  await host.idle();
  assert.equal(store.feature(g.id)!.stage, "plan");
  const unchanged = await planning.editDoc(g.id, "spec", specText(store, g.id), store.doc(g.id, "spec")!.head_sha!);
  assert.equal(unchanged.changed, false, "an unchanged save is a no-op");
  await planning.editDoc(g.id, "spec", specText(store, g.id) + "\nAlso quiet.\n", store.doc(g.id, "spec")!.head_sha!);
  await host.idle();
  assert.equal(store.feature(g.id)!.stage, "spec");
  assert.equal(store.doc(g.id, "spec")!.status, "in_review");
  assert.equal(store.doc(g.id, "plan")!.status, "stale");
  assert.equal(run(store.feature(g.id)!.integration_path!, "git", "log", "-2", "--format=%an").split("\n")[1], "Test", "your edit is committed with your identity");
});

test("the features list: buckets, size-weighted progress and the planning label", async () => {
  const { store, host, planning, accept } = await toBuild();
  const p = store.projects()[0]!;
  await planning.createFeature({ projectId: p.id, idea: "Whisper mode" });
  await host.idle();
  await accept("SHT-1");
  const o = featuresOverview(store);
  assert.deepEqual(o.buckets, { pending: 1, in_progress: 1, completed: 0 });
  const build = o.rows.find((r) => r.stage === "build")!;
  assert.equal(build.progress.percent, 25, "S done (1) of S+L (1+3)");
  assert.equal(build.progress.split.done, 1);
  const spec = o.rows.find((r) => r.stage === "spec")!;
  assert.equal(spec.progress.percent, null);
  assert.equal(spec.planning_label, "Spec in review");
  assert.ok(spec.waiting_on_you >= 1);
});
