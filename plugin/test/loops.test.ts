// Task Flows, part 1: the loop library. Four built-in loops (backend, frontend, bugfix, docs), project loops
// in .foundry/loops/*.yaml read from base and validated, the PM's loop pick checked at propose_tasks, your
// pick before approval and on an idle task, and the project's default loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { FoundryError } from "../server/core/model";
import { BUILTIN_LOOPS, parseLoopFile, projectLoops, resolveLoop, validateLoop } from "../server/core/loops";
import { checkLoops } from "../server/core/graph";
import { resolveChecks } from "../server/core/checks";
import { FakeHost, fixtureRepo, run, type Turn } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;

const STRICT = `# backend with a second review pass
steps:
  - kind: agent
    name: build
    prompt: Keep the public API unchanged.
  - kind: check
    name: check
    max_fix_rounds: 1
  - kind: review
    name: review
    back_to: build
    max_reworks: 2
`;

function withLoops(repo: string, files: Record<string, string>) {
  mkdirSync(join(repo, ".foundry/loops"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, ".foundry/loops", name), body);
  run(repo, "git", "add", "-A");
  run(repo, "git", "commit", "-q", "-m", "loops");
}

test("the four built-in loops validate; docs runs no project scripts, only the task's own checks", () => {
  assert.deepEqual(Object.keys(BUILTIN_LOOPS), ["backend", "frontend", "bugfix", "docs"]);
  for (const l of Object.values(BUILTIN_LOOPS)) assert.deepEqual(validateLoop(l), [], l.name);
  assert.match(BUILTIN_LOOPS.bugfix!.steps[0]!.kind === "agent" ? (BUILTIN_LOOPS.bugfix!.steps[0] as { prompt?: string }).prompt! : "", /reproduces the bug/);
  const available = [{ name: "test", type: "script", command: "sh check.sh" }, { name: "lint", type: "script", command: "true" }] as never;
  const docs = BUILTIN_LOOPS.docs!.steps.find((s) => s.kind === "check")!;
  const backend = BUILTIN_LOOPS.backend!.steps.find((s) => s.kind === "check")!;
  assert.deepEqual(resolveChecks(docs as never, { paths: ["docs/x.md"] }, available).scripts, []);
  assert.deepEqual(resolveChecks(docs as never, { scripts: ["lint"] }, available).scripts.map((s) => s.name), ["lint"]);
  assert.deepEqual(resolveChecks(backend as never, {}, available).scripts.map((s) => s.name), ["test", "lint"]);
});

test("loop files: the name is the file's, unknown fields and bad send-backs are refused", () => {
  const ok = parseLoopFile("api-strict", { steps: [{ kind: "agent", name: "build" }, { kind: "review", name: "review", back_to: "build" }] });
  assert.equal(ok.def!.source, "project");
  assert.deepEqual(parseLoopFile("Api_Strict", { steps: [] }).errors, ['"Api_Strict" is not a loop name: use lower case letters, digits and dashes.']);
  assert.match(parseLoopFile("x", { name: "y", steps: [] }).errors[0]!, /doesn't match the file name/);
  assert.match(parseLoopFile("x", { nope: 1 }).errors[0]!, /needs a list of steps/);
  const bad = parseLoopFile("x", { steps: [{ kind: "agent", name: "build", model: "big" }, { kind: "check", name: "check", scripts: "test" }, { kind: "review", name: "review", back_to: "deploy" }] });
  assert.deepEqual(bad.errors, [
    'Step 1 (agent) has an unknown field "model".',
    "Step 2: scripts must be a list of names.",
    'Step "review" goes back to "deploy", which is not an earlier step.',
  ]);
});

test("project loops are read from base: a valid one resolves (before a built-in), a broken one is LOOP_INVALID, an unknown name LOOP_MISSING", async () => {
  const repo = fixtureRepo();
  withLoops(repo, { "api-strict.yaml": STRICT, "broken.yml": "steps: [\n", "half.yaml": "steps:\n  - kind: check\n    name: check\n" });
  // A loop only on a branch is not on base.
  run(repo, "git", "checkout", "-q", "-b", "wip");
  writeFileSync(join(repo, ".foundry/loops/wip.yaml"), STRICT);
  run(repo, "git", "add", "-A");
  run(repo, "git", "commit", "-q", "-m", "wip");
  run(repo, "git", "checkout", "-q", "main");
  const pl = await projectLoops(repo, "main");
  assert.deepEqual(Object.keys(pl.loops), ["api-strict"]);
  assert.deepEqual(Object.keys(pl.invalid).sort(), ["broken", "half"]);
  assert.match(pl.invalid.broken![0]!, /isn't valid YAML/);
  assert.match(pl.invalid.half![0]!, /first step must be the agent/);
  const l = resolveLoop("api-strict", null, pl);
  assert.deepEqual([l.name, l.source, l.steps.length, (l.steps[2] as { max_reworks?: number }).max_reworks], ["api-strict", "project", 3, 2]);
  assert.equal(resolveLoop(null, "api-strict", pl).name, "api-strict", "a project default");
  assert.throws(() => resolveLoop("broken", null, pl), code("LOOP_INVALID"));
  assert.throws(() => resolveLoop("wip", null, pl), (e) => code("LOOP_MISSING")(e) && /backend, frontend, bugfix, docs, api-strict/.test((e as Error).message));
  assert.deepEqual(await projectLoops(fixtureRepo(), "main"), { loops: {}, invalid: {} });
});

test("checkLoops: an unknown or broken loop is refused; a pick that doesn't fit what the task touches is a warning", () => {
  const avail = ["backend", "frontend", "bugfix", "docs"];
  const R = { requirement_refs: [] as string[] };
  assert.throws(() => checkLoops([{ ...R, ref: "T1", title: "x", loop: "qa" }], avail), (e) => code("TASKS_INVALID")(e) && /T1 names loop "qa", which doesn't exist/.test((e as Error).message));
  assert.throws(() => checkLoops([{ ...R, ref: "T1", title: "x", loop: "broken" }], avail, { broken: ["bad"] }), /whose file in .foundry\/loops is invalid: bad/);
  assert.deepEqual(checkLoops([{ ...R, ref: "T1", title: "x", loop: "docs", touches: ["README.md", "src/a.ts"] }, { ...R, ref: "T2", title: "y", loop: "backend", touches: ["docs/guide.md"] }, { ...R, ref: "T3", title: "z", touches: ["src/b.ts"] }], avail), [
    "T1 is on the docs loop but touches src/a.ts; the docs loop runs no project checks.",
    "T2 only touches docs; the docs loop fits it.",
  ]);
});

test("the PM picks loops, you change one before approving, an idle task's loop and the project default can change, and an attempt runs its loop", async () => {
  const repo = fixtureRepo();
  withLoops(repo, { "api-strict.yaml": STRICT });
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, { home: "", tickMs: 0, loop: () => ({ maxFixRounds: 2, questionWindowMs: 50, checkTimeoutMs: 30_000, planningTimeoutMs: 0 }) });
  foundry.requireSetup = async () => {};
  host.loop = foundry;
  const errors: string[] = [];
  let rules = "";
  const dirOf = (t: Turn) => /Write only under (\S+)\//.exec(host.agents.get(t.agentId)!.messages[0]!)![1]!;
  host.behaviours.planner = (t) => {
    const dir = dirOf(t);
    if (t.text.includes("call propose_tasks with")) {
      rules = t.text;
      const tasks = [
        { ref: "T1", title: "Fix shout() dropping punctuation", requirement_refs: ["R1"], loop: "bugfix", size: "S" as const },
        { ref: "T2", title: "Add --shout", requirement_refs: ["R2"], loop: "qa", depends_on: [{ ref: "T1", reason: "uses shout()" }] },
        { ref: "T3", title: "Document --shout", requirement_refs: ["R2"], loop: "docs", touches: ["README.md"], depends_on: [{ ref: "T2", reason: "documents it" }] },
      ];
      try {
        foundry.planning.proposeTasks(t.agentId, tasks);
      } catch (e) {
        errors.push((e as FoundryError).code);
      }
      return void foundry.planning.proposeTasks(t.agentId, tasks.map((x) => (x.loop === "qa" ? { ...x, loop: "api-strict" } : x)));
    }
    if (t.text.includes("plan.md with")) return t.write(`${dir}/plan.md`, "# Plan\n");
    if (t.text.includes("Step 2")) {
      t.write(`${dir}/spec.md`, "# Spec\n\n## Goal\nShout.\n\n## Requirements\n");
      foundry.planning.proposeRequirements(t.agentId, [
        { ref: "R1", title: "Shout", acceptance_criteria: ["WHEN shout is called THE library SHALL keep punctuation"] },
        { ref: "R2", title: "Flag", acceptance_criteria: ["WHERE --shout is given THE CLI SHALL shout"] },
      ]);
    }
  };
  host.behaviours.builder = (t) => t.write("done.txt", "ok\n");
  host.behaviours.reviewer = (t) => void foundry.tasks.reportVerdict(t.agentId, { decision: "pass", reason: "ok" });
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  const f = await foundry.planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  await foundry.planning.approveSpec(f.id, store.doc(f.id, "spec")!.head_sha!);
  await host.idle();
  await foundry.planning.approvePlan(f.id, store.doc(f.id, "plan")!.head_sha!);
  await host.idle();
  assert.match(rules, /bugfix for a task that fixes a defect/);
  assert.deepEqual(errors, ["TASKS_INVALID"]);
  assert.deepEqual((await foundry.planning.readDoc(f.id, "tasks")).text.match(/^\| T\d \|.*$/gm)?.map((r) => r.split("|")[6]!.trim()), ["bugfix", "api-strict", "docs"]);

  // Before approving: T2 back to the project default; an unknown loop is refused.
  await assert.rejects(foundry.planning.editSlices(f.id, { kind: "set_loop", ref: "T2", loop: "qa" }), code("TASKS_INVALID"));
  await foundry.planning.editSlices(f.id, { kind: "set_loop", ref: "T2", loop: null });
  await foundry.planning.editSlices(f.id, { kind: "set_loop", ref: "T3", loop: "frontend" });
  assert.match(JSON.stringify(store.proposal(f.id)!.result), /T3 only touches docs; the docs loop fits it/);
  await foundry.planning.editSlices(f.id, { kind: "set_loop", ref: "T3", loop: "docs" });
  await foundry.planning.approveTasks(f.id, store.proposal(f.id)!.id, store.doc(f.id, "tasks")!.head_sha!);
  const key = (title: string) => store.issues({ featureId: f.id }).find((i) => i.title === title)!.key;
  assert.deepEqual([key("Fix shout() dropping punctuation"), key("Add --shout"), key("Document --shout")].map((k) => store.issue(k)!.loop), ["bugfix", null, "docs"]);

  // The project's default and an idle task's loop.
  await assert.rejects(foundry.tasks.setDefaultLoop(p.id, "qa"), code("LOOP_MISSING"));
  assert.equal((await foundry.tasks.setDefaultLoop(p.id, "api-strict")).default_loop, "api-strict");
  const listed = await foundry.tasks.loops(p.id);
  assert.deepEqual([listed.default, listed.loops.map((l) => `${l.name}:${l.source}`)], ["api-strict", ["backend:built-in", "frontend:built-in", "bugfix:built-in", "docs:built-in", "api-strict:project"]]);
  await host.idle();
  const t1 = key("Fix shout() dropping punctuation");
  const a1 = store.latestAttempt(t1)!;
  assert.equal(JSON.parse(a1.loop!).name, "bugfix", "T1 ran on the bugfix loop");
  assert.equal(JSON.parse(a1.loop!).steps[0].name, "fix");
  assert.match(host.agents.get(a1.builder_agent_id!)!.messages[0]!, /add a test that reproduces the bug/);
  await assert.rejects(foundry.tasks.setIssueLoop(t1, "backend"), code("INVALID_TRANSITION"));
  const t2 = key("Add --shout");
  await foundry.tasks.setIssueLoop(t2, "frontend");
  await foundry.tasks.setIssueLoop(t2, null);
  await foundry.accept(t1, store.latestAttempt(t1)!.head_sha!, store.latestAttempt(t1)!.tree_sha!);
  await host.idle();
  const a2 = store.latestAttempt(t2)!;
  assert.equal(JSON.parse(a2.loop!).name, "api-strict", "T2 names no loop: it ran on the project default");
  assert.match(host.agents.get(a2.builder_agent_id!)!.messages[0]!, /Keep the public API unchanged/);
});
