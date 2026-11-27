import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, parse } from "../server/core/store";
import { Locks } from "../server/core/locks";
import { TaskLoop } from "../server/core/taskloop";
import { Planning } from "../server/core/planning";
import { FoundryError } from "../server/core/model";
import { lintRequirements, validateTasks, earsOk } from "../server/core/graph";
import { FakeHost, fixtureRepo, run, type Behaviour, type Turn } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;

const REQS = [
  { ref: "R1", title: "Shout", acceptance_criteria: ["WHEN shout is called THE library SHALL return the text upper-cased with !"] },
  { ref: "R2", title: "CLI flag", acceptance_criteria: ["WHERE --shout is given, THE CLI SHALL print the shouted text"] },
];
const TASKS = [
  { ref: "T1", title: "Add shout()", requirement_refs: ["R1"], touches: ["shout/core.py"], size: "S" as const },
  { ref: "T2", title: "Add --shout flag", requirement_refs: ["R2"], depends_on: [{ ref: "T1", reason: "uses shout()" }], touches: ["shout/cli.py"] },
];

interface Script {
  ask?: boolean;
  stray?: boolean;
  noSpec?: boolean;
}

async function setup(script: Script = {}, windowMs = 50) {
  const repo = fixtureRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const locks = new Locks();
  const loop = new TaskLoop(store, host, locks, { maxFixRounds: 2, questionWindowMs: windowMs, checkTimeoutMs: 30_000 });
  const planning = new Planning(store, host, locks, { questionWindowMs: windowMs, turnTimeoutMs: 0 }, async () => {}, () => loop.tick());
  host.loop = { onTurnEnd: (id, o, t) => (store.agent(id)?.role === "planner" ? planning.onTurnEnd(id, o, t) : loop.onTurnEnd(id, o, t)) };
  const replies: string[] = [];
  const dirOf = (t: Turn) => /Write only under (\S+)\//.exec(host.agents.get(t.agentId)!.messages[0]!)![1]!;
  const planner: Behaviour = async (t) => {
    const dir = dirOf(t);
    if (t.text.includes("Step 1, Clarify") && script.ask) {
      const r = await planning.askQuestions(t.agentId, [{ id: "q1", text: "Also -s?", recommended: "yes" }]);
      replies.push(r);
      if (r.startsWith("The developer hasn't answered")) return;
    }
    if (t.text.includes("Step 2")) {
      if (script.stray) t.write("README.md", "the PM was here\n");
      if (script.noSpec) return;
      t.write(`${dir}/spec.md`, "# Spec\n\n## Requirements\n\nR1, R2\n");
      planning.proposeRequirements(t.agentId, REQS);
      return;
    }
    if (t.text.includes("propose_tasks")) {
      t.write(`${dir}/tasks.md`, "the PM must not write this\n");
      planning.proposeTasks(t.agentId, TASKS);
      return;
    }
    if (t.text.includes("write") && t.text.includes("plan.md")) return t.write(`${dir}/plan.md`, "# Plan\n");
  };
  host.behaviours.planner = planner;
  host.behaviours.builder = (t) => {
    t.write("done.txt", "ok\n");
  };
  host.behaviours.reviewer = (t) => void loop.reportVerdict(t.agentId, { decision: "pass", reason: "ok" });
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  return { repo, store, host, loop, planning, p, replies };
}

const doc = (s: Store, id: number, kind: "spec" | "plan" | "tasks") => s.doc(id, kind)!;

test("EARS lint and task graph validation", () => {
  assert.ok(earsOk("THE CLI SHALL print help"));
  assert.ok(earsOk("WHEN a flag is given, THE CLI SHALL shout"));
  assert.ok(earsOk("IF the input is empty, THEN THE CLI SHALL print nothing"));
  assert.ok(!earsOk("The CLI prints help"));
  assert.deepEqual(lintRequirements(REQS), []);
  assert.equal(lintRequirements([{ ref: "1", title: "x", acceptance_criteria: ["nope"] }]).length, 2);
  const g = validateTasks(TASKS, ["R1", "R2"]);
  assert.deepEqual(g.waves, [["T1"], ["T2"]]);
  assert.deepEqual(g.critical_path, ["T1", "T2"]);
  assert.equal(g.priority.T1, 60);
  assert.equal(g.priority.T2, 50);
  assert.throws(() => validateTasks([TASKS[0]!], ["R1", "R2"]), (e: FoundryError) => e.code === "TASKS_INVALID" && /R2 is not covered/.test(e.message));
  assert.throws(
    () => validateTasks([{ ...TASKS[0]!, depends_on: [{ ref: "T2", reason: "" }] }, TASKS[1]!], ["R1", "R2"]),
    (e: FoundryError) => /Cycle: T\d → T\d → T\d/.test(e.message),
  );
  const w = validateTasks([...TASKS, { ref: "T3", title: "x", requirement_refs: ["R1"], touches: ["shout/core.py"], size: "L" }], ["R1", "R2"]);
  assert.ok(w.warnings.some((x) => /T1 and T3 both touch shout\/core.py/.test(x)));
  assert.ok(w.warnings.some((x) => /T3 is size L/.test(x)));
});

test("standard flow: clarify to spec, approve spec, plan, tasks, then issues that run through loop 2", async () => {
  const { store, host, planning, p } = await setup();
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode\nMake the CLI shout." });
  assert.equal(f.slug, "shout-mode");
  await host.idle();
  let ff = store.feature(f.id)!;
  assert.equal(ff.stage, "spec");
  assert.equal(doc(store, f.id, "spec").status, "in_review");
  assert.equal(run(ff.integration_path!, "git", "log", "-1", "--format=%an"), "Foundry PM");

  await assert.rejects(planning.approveSpec(f.id, "0".repeat(40)), code("STALE_APPROVAL"));
  await assert.rejects(planning.approvePlan(f.id, doc(store, f.id, "spec").head_sha!), code("WRONG_STAGE"));
  await planning.approveSpec(f.id, doc(store, f.id, "spec").head_sha!);
  await host.idle();
  assert.equal(store.feature(f.id)!.stage, "plan");
  assert.equal(doc(store, f.id, "plan").status, "in_review");

  await planning.approvePlan(f.id, doc(store, f.id, "plan").head_sha!);
  await host.idle();
  ff = store.feature(f.id)!;
  assert.equal(ff.stage, "tasks");
  const prop = store.proposal(f.id)!;
  const tasksDoc = await planning.readDoc(f.id, "tasks");
  assert.match(tasksDoc.text, /Written by Foundry/);
  assert.match(tasksDoc.text, /\| T2 \| Add --shout flag \| R2 \| T1 \(uses shout\(\)\)/);
  assert.equal(run(ff.integration_path!, "git", "log", "-1", "--format=%an"), "Foundry");

  await assert.rejects(planning.approveTasks(f.id, prop.id + 1, tasksDoc.sha!), code("PROPOSAL_CHANGED"));
  const r = await planning.approveTasks(f.id, prop.id, tasksDoc.sha!);
  assert.deepEqual((r as { issues: Record<string, string> }).issues, { T1: "SHT-1", T2: "SHT-2" });
  assert.equal(store.feature(f.id)!.stage, "build");
  assert.equal(store.issue("SHT-2")!.status, "Backlog");
  assert.deepEqual(store.deps("SHT-2").map((d) => [d.depends_on, d.reason]), [["SHT-1", "uses shout()"]]);
  assert.equal(store.issue("SHT-1")!.priority, 60);
  assert.deepEqual(parse(store.issue("SHT-1")!.requirement_refs, []), ["R1"]);
  await host.idle();
  assert.equal(store.issue("SHT-1")!.status, "In_Review", "auto-started once the feature reached Build");
});

test("a Clarify round answered after the window starts a turn with the answers; blanks take the recommendation", async () => {
  const { store, host, planning, p, replies } = await setup({ ask: true });
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  assert.match(replies[0]!, /hasn't answered/);
  assert.equal(store.feature(f.id)!.stage, "clarify");
  await assert.rejects(planning.approveSpec(f.id, "x"), code("WRONG_STAGE"));
  assert.deepEqual(await planning.answer(f.id, { q1: "" }), { delivered: "turn" });
  await host.idle();
  const q = store.get<{ answer: string }>("SELECT answer FROM questions WHERE feature_id=?", f.id)!;
  assert.equal(q.answer, "yes");
  assert.equal(store.feature(f.id)!.stage, "spec");
  const pmMsgs = host.agents.get(store.feature(f.id)!.planner_agent_id!)!.messages;
  assert.match(pmMsgs[1]!, /q1: yes/);
});

test("a Clarify round answered inside the window goes straight back; a second round is refused at grill light", async () => {
  const { store, host, planning, p, replies } = await setup({ ask: true }, 5_000);
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  while (!store.get("SELECT 1 FROM questions WHERE feature_id=?", f.id)) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(planning.approveSpec(f.id, "x"), code("FEATURE_BUSY"));
  assert.deepEqual(await planning.answer(f.id, { q1: "no" }), { delivered: "live" });
  await host.idle();
  assert.match(replies[0]!, /q1: no/);
  assert.equal(store.feature(f.id)!.stage, "spec");
  const agent = store.feature(f.id)!.planner_agent_id!;
  assert.throws(() => planning.proposeRequirements(agent, REQS), code("TOOL_REFUSED"), "tools only work inside a planning turn");
});

test("the write guard undoes edits outside the feature folder and the PM's own tasks.md", async () => {
  const { store, host, planning, p } = await setup({ stray: true });
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  const ff = store.feature(f.id)!;
  assert.equal(run(ff.integration_path!, "git", "show", "HEAD:README.md"), "shout");
  assert.equal(run(ff.integration_path!, "git", "status", "--porcelain"), "");
  const guard = store.events({ feature: f.id }).find((e) => e.kind === "write_guard")!;
  assert.deepEqual(parse<{ reverted: string[] }>(guard.detail, { reverted: [] }).reverted, ["README.md"]);
});

test("a turn that ends without the spec is a planning failure you can retry", async () => {
  const script: Script = { noSpec: true };
  const { store, host, planning, p } = await setup(script);
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  assert.match(store.feature(f.id)!.planning_error!, /without writing .*spec\.md/);
  script.noSpec = false;
  await planning.retry(f.id);
  await host.idle();
  assert.equal(store.feature(f.id)!.planning_error, null);
  assert.equal(store.feature(f.id)!.stage, "spec");
});

test("cutting the only task for a requirement blocks approval until it is restored", async () => {
  const { store, host, planning, p } = await setup();
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  await planning.approveSpec(f.id, doc(store, f.id, "spec").head_sha!);
  await host.idle();
  await planning.approvePlan(f.id, doc(store, f.id, "plan").head_sha!);
  await host.idle();
  const prop = store.proposal(f.id)!;
  const cut = await planning.cutTask(f.id, "T2", true);
  await assert.rejects(planning.approveTasks(f.id, prop.id, cut.tasks_sha!), code("TASKS_INVALID"));
  const back = await planning.cutTask(f.id, "T2", false);
  assert.notEqual(back.tasks_sha, cut.tasks_sha);
  await assert.rejects(planning.approveTasks(f.id, prop.id, cut.tasks_sha!), code("STALE_APPROVAL"));
  await planning.approveTasks(f.id, prop.id, back.tasks_sha!);
  assert.equal(store.issues({ featureId: f.id }).length, 2);
});

test("a revision request runs a turn in the same stage; slugs stay unique; empty ideas are refused", async () => {
  const { store, host, planning, p } = await setup();
  await assert.rejects(planning.createFeature({ projectId: p.id, idea: "  " }), code("IDEA_REQUIRED"));
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  const g = await planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  assert.equal(g.slug, "shout-mode-2");
  await host.idle();
  await assert.rejects(planning.revise(f.id, "spec", ""), code("FEEDBACK_REQUIRED"));
  await planning.revise(f.id, "spec", "Mention Windows too.");
  await host.idle();
  assert.equal(store.feature(f.id)!.stage, "spec");
  const pm = host.agents.get(store.feature(f.id)!.planner_agent_id!)!;
  assert.match(pm.messages.at(-1)!, /Mention Windows too/);
  await planning.setStatus(f.id, "cancelled");
  await assert.rejects(planning.approveSpec(f.id, "x"), code("FEATURE_CLOSED"));
});
