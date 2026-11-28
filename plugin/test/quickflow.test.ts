// The Quick flow: one Clarify round at most, then spec, plan and the task proposal in the same turn,
// approved once at the task list with all three SHAs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Locks } from "../server/core/locks";
import { TaskLoop } from "../server/core/taskloop";
import { Planning } from "../server/core/planning";
import { FoundryError } from "../server/core/model";
import { FakeHost, fixtureRepo, type Turn } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;

const REQS = [
  { ref: "R1", title: "Shout", acceptance_criteria: ["WHEN shout is called THE library SHALL return the text upper-cased with !"] },
  { ref: "R2", title: "CLI flag", acceptance_criteria: ["WHERE --shout is given, THE CLI SHALL print the shouted text"] },
];
const TASKS = [
  { ref: "T1", title: "Add shout()", requirement_refs: ["R1"], touches: ["shout/core.py"], size: "S" as const },
  { ref: "T2", title: "Add --shout flag", requirement_refs: ["R2"], depends_on: [{ ref: "T1", reason: "uses shout()" }], touches: ["shout/cli.py"] },
];

async function setup(o: { ask?: boolean; skipTasks?: boolean } = {}, windowMs = 50) {
  const repo = fixtureRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const locks = new Locks();
  const loop = new TaskLoop(store, host, locks, { maxFixRounds: 2, questionWindowMs: windowMs, checkTimeoutMs: 30_000 });
  const planning = new Planning(store, host, locks, { questionWindowMs: windowMs, turnTimeoutMs: 0 }, async () => {}, () => loop.tick());
  host.loop = { onTurnEnd: (id, out, t) => (store.agent(id)?.role === "planner" ? planning.onTurnEnd(id, out, t) : loop.onTurnEnd(id, out, t)) };
  const replies: string[] = [];
  const turns: string[] = [];
  const dirOf = (t: Turn) => /Write only under (\S+)\//.exec(host.agents.get(t.agentId)!.messages[0]!)![1]!;
  host.behaviours.planner = async (t) => {
    turns.push(t.text);
    const dir = dirOf(t);
    if (t.text.includes("Step 1, Clarify") && o.ask) {
      const r = await planning.askQuestions(t.agentId, [{ id: "q1", text: "Also -s?", recommended: "yes" }]);
      replies.push(r);
      if (r.startsWith("The developer hasn't answered")) return;
    }
    if (t.text.includes("Step 2") || t.text.includes("propose_requirements")) {
      t.write(`${dir}/spec.md`, `# Spec\n\n## Requirements\n\nR1, R2\n\n<!-- turn ${turns.length} -->\n`);
      planning.proposeRequirements(t.agentId, REQS);
    }
    if (t.text.includes("Step 3") || t.text.includes("plan.md")) t.write(`${dir}/plan.md`, `# Plan\n\n<!-- turn ${turns.length} -->\n`);
    if (!o.skipTasks && t.text.includes("propose_tasks")) planning.proposeTasks(t.agentId, TASKS);
  };
  host.behaviours.builder = (t) => {
    t.write("done.txt", "ok\n");
  };
  host.behaviours.reviewer = (t) => void loop.reportVerdict(t.agentId, { decision: "pass", reason: "ok" });
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  return { store, host, loop, planning, p, replies, turns };
}

const shas = (s: Store, id: number) => ({ spec: s.doc(id, "spec")!.head_sha!, plan: s.doc(id, "plan")!.head_sha!, tasks: s.doc(id, "tasks")!.head_sha! });

test("quick flow: one turn writes spec, plan and the task list; one approval names all three SHAs", async () => {
  const { store, host, planning, p, turns } = await setup();
  await assert.rejects(planning.createFeature({ projectId: p.id, idea: "x", flow: "fast" as never }), code("INVALID_FLOW"));
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode\nMake the CLI shout.", flow: "quick" });
  await host.idle();
  assert.equal(turns.length, 1, "spec, plan and tasks in one turn");
  assert.match(turns[0]!, /Step 3, Plan/);
  assert.match(turns[0]!, /Step 4, Tasks/);
  const ff = store.feature(f.id)!;
  assert.equal(ff.flow, "quick");
  assert.equal(ff.stage, "tasks", "jumps from Clarify to Tasks");
  for (const k of ["spec", "plan", "tasks"] as const) assert.equal(store.doc(f.id, k)!.status, "in_review", k);

  const s = shas(store, f.id);
  await assert.rejects(planning.approveSpec(f.id, s.spec), code("QUICK_FLOW"));
  await assert.rejects(planning.approvePlan(f.id, s.plan), code("QUICK_FLOW"));
  const prop = store.proposal(f.id)!;
  await assert.rejects(planning.approveTasks(f.id, prop.id, s.tasks), code("SHA_REQUIRED"));
  await assert.rejects(planning.approveTasks(f.id, prop.id, s.tasks, "you", { spec: "0".repeat(40), plan: s.plan }), code("STALE_APPROVAL"));
  const r = await planning.approveTasks(f.id, prop.id, s.tasks, "you", { spec: s.spec, plan: s.plan });
  assert.deepEqual((r as { issues: Record<string, string> }).issues, { T1: "SHT-1", T2: "SHT-2" });
  assert.equal(store.feature(f.id)!.stage, "build");
  assert.equal(store.doc(f.id, "spec")!.approved_sha, s.spec);
  assert.equal(store.doc(f.id, "plan")!.approved_sha, s.plan);
  assert.equal(store.approvedRequirements(f.id).length, 2);
  await host.idle();
  assert.equal(store.issue("SHT-1")!.status, "In_Review", "tasks auto-start once all three docs are approved");
});

test("quick flow: at most one Clarify round even at grill normal; the answers continue to all three docs", async () => {
  const { store, host, planning, p, replies, turns } = await setup({ ask: true });
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode", flow: "quick", grill: "normal" });
  await host.idle();
  assert.match(replies[0]!, /hasn't answered/);
  assert.equal(store.feature(f.id)!.stage, "clarify");
  await planning.answer(f.id, { q1: "" });
  await host.idle();
  assert.match(turns[1]!, /q1: yes/);
  assert.match(turns[1]!, /Step 4, Tasks/);
  assert.doesNotMatch(turns[1]!, /Step 1, Clarify/);
  assert.equal(store.feature(f.id)!.stage, "tasks");
  assert.equal(store.feature(f.id)!.clarify_rounds, 1);
});

test("quick flow: a turn that ends without the task proposal is a planning failure", async () => {
  const { store, host, planning, p } = await setup({ skipTasks: true });
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode", flow: "quick" });
  await host.idle();
  assert.match(store.feature(f.id)!.planning_error ?? "", /propose_tasks/);
  assert.equal(store.feature(f.id)!.stage, "clarify");
});

test("quick flow: a revision or an edit in Tasks stays in Tasks and needs a fresh task proposal", async () => {
  const { store, host, planning, p, turns } = await setup();
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode", flow: "quick" });
  await host.idle();
  const first = store.proposal(f.id)!.id;
  await planning.revise(f.id, "plan", "Split the CLI work.");
  await host.idle();
  assert.match(turns.at(-1)!, /Split the CLI work/);
  assert.equal(store.feature(f.id)!.stage, "tasks");
  const second = store.proposal(f.id)!;
  assert.ok(second.id > first, "a new proposal from the revision turn");

  const spec = await planning.readDoc(f.id, "spec");
  await planning.editDoc(f.id, "spec", spec.text + "\nOne more note.\n", spec.sha!);
  await host.idle();
  assert.equal(store.feature(f.id)!.stage, "tasks", "no Spec stage to go back to");
  assert.match(turns.at(-1)!, /propose_tasks again/);
  const s = shas(store, f.id);
  const prop = store.proposal(f.id)!;
  assert.ok(prop.id > second.id);
  await planning.approveTasks(f.id, prop.id, s.tasks, "you", { spec: s.spec, plan: s.plan });
  assert.equal(store.feature(f.id)!.stage, "build");
});
