// Slices: a feature's tasks grouped into an ordered chain, each slice shipping as its own PR. This part
// covers the plan: validation, size warnings, tasks.md, your edits before approval, and what approval makes.
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
import { validateSlices, type ProposedTask } from "../server/core/graph";
import { FakeHost, fixtureRepo, type Turn } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;
const t = (ref: string, slice: number | undefined, refs: string[], deps: string[] = [], size?: "S" | "M" | "L"): ProposedTask => ({
  ref,
  title: `Task ${ref}`,
  requirement_refs: refs,
  slice,
  size,
  depends_on: deps.map((d) => ({ ref: d, reason: "needs it" })),
});

test("validateSlices: one slice by default; a requirement ships with the last slice covering it", () => {
  const one = validateSlices("Shout", undefined, [t("T1", undefined, ["R1"]), t("T2", undefined, ["R2"])]);
  assert.deepEqual(one.slices.map((s) => [s.n, s.title, s.tasks, s.requirement_refs]), [[1, "Shout", ["T1", "T2"], ["R1", "R2"]]]);
  const two = validateSlices("Shout", [{ n: 1, title: "Core" }, { n: 2, title: "CLI" }], [t("T1", 1, ["R1"]), t("T2", 2, ["R1", "R2"], ["T1"])]);
  assert.deepEqual(two.slices.map((s) => s.requirement_refs), [[], ["R1", "R2"]], "R1 is finished by slice 2's task");
  assert.deepEqual(two.warnings, []);
});

test("validateSlices refuses gaps, empty slices and dependencies on a later slice", () => {
  assert.throws(
    () => validateSlices("F", [{ n: 1, title: "A" }, { n: 3, title: "C" }], [t("T1", 1, ["R1"]), t("T2", 3, ["R1"])]),
    (e) => code("SLICE_INVALID")(e) && /numbered 1, 2, 3/.test((e as FoundryError).message),
  );
  assert.throws(() => validateSlices("F", [{ n: 1, title: "A" }, { n: 2, title: "B" }], [t("T1", 1, ["R1"])]), (e) => code("SLICE_INVALID")(e) && /Slice 2 \(B\) has no tasks/.test((e as FoundryError).message));
  assert.throws(
    () => validateSlices("F", [{ n: 1, title: "A" }, { n: 2, title: "B" }], [t("T1", 1, ["R1"], ["T2"]), t("T2", 2, ["R1"])]),
    (e) => code("SLICE_INVALID")(e) && /T1 \(slice 1\) depends on T2 in a later slice/.test((e as FoundryError).message),
  );
  assert.throws(() => validateSlices("F", [{ n: 1, title: "A" }], [t("T1", 2, ["R1"])]), code("SLICE_INVALID"));
});

test("validateSlices warns when a slice or the feature is over the budget", () => {
  const big = Array.from({ length: 9 }, (_, i) => t(`T${i + 1}`, 1, ["R1"]));
  assert.match(validateSlices("F", undefined, big).warnings.join("\n"), /Slice 1 \(F\) is big: 9 tasks/);
  const heavy = Array.from({ length: 5 }, (_, i) => t(`T${i + 1}`, 1, ["R1"], [], "L"));
  assert.match(validateSlices("F", undefined, heavy).warnings.join("\n"), /size weight 15/);
  const many = Array.from({ length: 26 }, (_, i) => t(`T${i + 1}`, Math.floor(i / 6) + 1, ["R1"]));
  const sl = [1, 2, 3, 4, 5].map((n) => ({ n, title: `S${n}` }));
  assert.match(validateSlices("F", sl, many).warnings.join("\n"), /This feature is big: 26 tasks in 5 slices.*separate features/);
});

const R = (ref: string, title: string) => ({ ref, title, acceptance_criteria: [`WHEN ${title} is used THE CLI SHALL work`] });

async function toTasks(propose: (p: Planning, agentId: string) => void) {
  const repo = fixtureRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const locks = new Locks();
  const loop = new TaskLoop(store, host, locks, { maxFixRounds: 2, questionWindowMs: 50, checkTimeoutMs: 30_000 });
  const planning = new Planning(store, host, locks, { questionWindowMs: 50, turnTimeoutMs: 0 }, async () => {}, () => loop.tick());
  host.loop = { onTurnEnd: (id, o, tr) => (store.agent(id)?.role === "planner" ? planning.onTurnEnd(id, o, tr) : loop.onTurnEnd(id, o, tr)) };
  const dirOf = (tr: Turn) => /Write only under (\S+)\//.exec(host.agents.get(tr.agentId)!.messages[0]!)![1]!;
  const errors: string[] = [];
  host.behaviours.planner = (tr) => {
    const dir = dirOf(tr);
    if (tr.text.includes("call propose_tasks with")) {
      try {
        // A slice that depends on a later one is refused first; the PM fixes it.
        planning.proposeTasks(tr.agentId, [{ ref: "T1", title: "x", requirement_refs: ["R1"], slice: 1, depends_on: [{ ref: "T2", reason: "" }] }, { ref: "T2", title: "y", requirement_refs: ["R2", "R3"], slice: 2 }], [{ n: 1, title: "A" }, { n: 2, title: "B" }]);
      } catch (e) {
        errors.push((e as FoundryError).code);
      }
      return propose(planning, tr.agentId);
    }
    if (tr.text.includes("plan.md with")) return tr.write(`${dir}/plan.md`, "# Plan\n");
    if (tr.text.includes("Step 2")) {
      tr.write(`${dir}/spec.md`, "# Spec\n\n## Goal\nShout.\n\n## Requirements\n\n## Out of scope\nWhisper.\n");
      planning.proposeRequirements(tr.agentId, [R("R1", "shout"), R("R2", "--shout"), R("R3", "--loud")]);
    }
  };
  host.behaviours.builder = (tr) => tr.write("done.txt", "ok\n");
  host.behaviours.reviewer = (tr) => void loop.reportVerdict(tr.agentId, { decision: "pass", reason: "ok" });
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  await planning.approveSpec(f.id, store.doc(f.id, "spec")!.head_sha!);
  await host.idle();
  await planning.approvePlan(f.id, store.doc(f.id, "plan")!.head_sha!);
  await host.idle();
  const tasksMd = () => {
    const ff = store.feature(f.id)!;
    return readFileSync(join(ff.integration_path!, ".foundry/features", ff.slug, "tasks.md"), "utf8");
  };
  return { store, host, planning, fid: f.id, tasksMd, errors };
}

const threeSlices = (p: Planning, agentId: string) =>
  p.proposeTasks(
    agentId,
    [
      { ref: "T1", title: "Add shout()", requirement_refs: ["R1"], slice: 1, size: "S" },
      { ref: "T2", title: "Add --shout", requirement_refs: ["R2"], slice: 2, depends_on: [{ ref: "T1", reason: "uses shout()" }] },
      { ref: "T3", title: "Test --shout", requirement_refs: ["R2"], slice: 2, depends_on: [{ ref: "T2", reason: "tests it" }] },
      { ref: "T4", title: "Add --loud", requirement_refs: ["R3"], slice: 3, depends_on: [{ ref: "T2", reason: "extends the flag" }] },
    ],
    [
      { n: 1, title: "Shout core", goal: "shout() works" },
      { n: 2, title: "CLI flag" },
      { n: 3, title: "Loud alias" },
    ],
  );

test("the PM proposes slices; tasks.md groups them in merge order; approval makes the slices and puts each task in its slice", async () => {
  const { store, host, planning, fid, tasksMd, errors } = await toTasks(threeSlices);
  assert.deepEqual(errors, ["SLICE_INVALID"]);
  const prop = store.proposal(fid)!;
  assert.deepEqual(parse<any[]>(prop.slices, []).map((x) => x.title), ["Shout core", "CLI flag", "Loud alias"]);
  const md = tasksMd();
  assert.match(md, /## Slice 1: Shout core\n\nshout\(\) works\n\nDelivers R1\. Merges first\./);
  assert.match(md, /## Slice 2: CLI flag\n\nDelivers R2\. Merges after slice 1\.[\s\S]*\| T2 \|[\s\S]*\| T3 \|[\s\S]*## Slice 3: Loud alias/);

  const r = await planning.approveTasks(fid, prop.id, store.doc(fid, "tasks")!.head_sha!);
  await host.idle();
  const slices = store.slices(fid);
  assert.deepEqual(slices.map((x) => [x.n, x.title, x.status, parse<string[]>(x.requirement_refs, [])]), [
    [1, "Shout core", "building", ["R1"]],
    [2, "CLI flag", "planned", ["R2"]],
    [3, "Loud alias", "planned", ["R3"]],
  ]);
  const f = store.feature(fid)!;
  assert.equal(slices[0]!.branch, f.branch, "slice 1 builds on the feature branch");
  assert.equal(slices[1]!.branch, null, "later slices wait for their turn");
  const sliceOf = (ref: string) => store.slice(store.issue((r as any).issues[ref])!.slice_id!)!.n;
  assert.deepEqual(["T1", "T2", "T3", "T4"].map(sliceOf), [1, 2, 2, 3]);
  assert.deepEqual(featuresOverview(store).rows[0]!.slices, { total: 3, front: 1, front_title: "Shout core" });
});

test("before approving you can move a task to another slice, reorder, merge and rename slices", async () => {
  const { store, planning, fid, tasksMd } = await toTasks(threeSlices);
  const slices = () => parse<any[]>(store.proposal(fid)!.slices, []).map((x) => `${x.n}:${x.title}`);
  const sliceOf = (ref: string) => parse<ProposedTask[]>(store.proposal(fid)!.tasks, []).find((x) => x.ref === ref)!.slice;

  // T4 into a new slice 4; slice 3 is left empty and goes; T4's slice becomes 3 again.
  await planning.editSlices(fid, { kind: "move_task", ref: "T4", slice: 4 });
  assert.deepEqual(slices(), ["1:Shout core", "2:CLI flag", "3:Slice 4"]);
  assert.equal(sliceOf("T4"), 3);
  await planning.editSlices(fid, { kind: "rename", slice: 3, title: "Loud alias", goal: "--loud works" });
  // Moving slice 3 before slice 2 would put T4 ahead of T2, which it depends on: approval is blocked until fixed.
  const before = store.doc(fid, "tasks")!.head_sha;
  await planning.editSlices(fid, { kind: "move_slice", from: 3, to: 2 });
  assert.deepEqual(slices(), ["1:Shout core", "2:Loud alias", "3:CLI flag"]);
  assert.notEqual(store.doc(fid, "tasks")!.head_sha, before, "tasks.md was rewritten");
  assert.match(parse<any>(store.proposal(fid)!.result, {}).warnings.join("\n"), /Blocks approval: T4 \(slice 2\) depends on T2 in a later slice/);
  await assert.rejects(planning.approveTasks(fid, store.proposal(fid)!.id, store.doc(fid, "tasks")!.head_sha!), code("SLICE_INVALID"));
  // Merge them instead: one slice for the CLI.
  await planning.editSlices(fid, { kind: "merge", from: 3, into: 2 });
  assert.deepEqual(slices(), ["1:Shout core", "2:Loud alias"]);
  assert.deepEqual(["T1", "T2", "T3", "T4"].map(sliceOf), [1, 2, 2, 2]);
  assert.match(tasksMd(), /## Slice 2: Loud alias\n\n--loud works/);
  await assert.rejects(planning.editSlices(fid, { kind: "move_task", ref: "T1", slice: 7 }), code("SLICE_INVALID"));
  await planning.approveTasks(fid, store.proposal(fid)!.id, store.doc(fid, "tasks")!.head_sha!);
  assert.equal(store.slices(fid).length, 2);
});

test("a feature planned without slices is one slice named after it", async () => {
  const { store, host, planning, fid, tasksMd } = await toTasks((p, a) =>
    p.proposeTasks(a, [
      { ref: "T1", title: "Add shout()", requirement_refs: ["R1", "R2", "R3"] },
    ]),
  );
  assert.match(tasksMd(), /## Wave 1/);
  assert.doesNotMatch(tasksMd(), /## Slice/);
  await planning.approveTasks(fid, store.proposal(fid)!.id, store.doc(fid, "tasks")!.head_sha!);
  await host.idle();
  assert.deepEqual(store.slices(fid).map((x) => [x.n, x.title]), [[1, "Shout mode"]]);
  assert.equal(store.issue("SHT-1")!.slice_id, store.slices(fid)[0]!.id);
});
