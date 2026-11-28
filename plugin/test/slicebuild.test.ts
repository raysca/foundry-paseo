// Slices, part 2: Build, Verify and Ship per slice. The front slice builds on the feature branch; once it
// reaches Ship the next slice builds on its own branch cut from it (at most two active). Each slice has
// its own Verify (its tasks and the ones before it, its requirements) and its own PR, stacked on the one
// before; when the front ships the next slice is promoted and its PR retargeted at base.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, parse } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { FoundryError } from "../server/core/model";
import type { RequirementResult } from "../server/core/delivery";
import { FakeHost, fixtureRepo, run, type Turn } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;
const R = (ref: string, title: string) => ({ ref, title, acceptance_criteria: [`WHEN ${title} is used THE CLI SHALL work`] });
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
  const read = () => JSON.parse(readFileSync(state, "utf8")) as { prs: { number: number; state: string; head: string; base: string; title: string; body: string }[] };
  const set = (n: number, s: string) => {
    const st = read();
    st.prs.find((p) => p.number === n)!.state = s;
    writeFileSync(state, JSON.stringify(st));
  };
  return { remote, read, set };
}

/**
 * Shout mode in three slices: T1 (R1) in slice 1; T2 (R2, after T1) and T3 (docs, no dependency) in
 * slice 2; T4 (R3, after T2) in slice 3. Tasks start but are accepted by the test.
 */
async function threeSlices(o: { mode: "pr" | "local_merge"; failOnce?: string }) {
  const repo = fixtureRepo();
  const gh = o.mode === "pr" ? fakeGitHub(repo) : null;
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, { home: "", tickMs: 0, loop: () => ({ maxFixRounds: 2, questionWindowMs: 50, checkTimeoutMs: 30_000, planningTimeoutMs: 0 }) });
  foundry.requireSetup = async () => {};
  host.loop = foundry;
  const dirOf = (t: Turn) => /Write only under (\S+)\//.exec(host.agents.get(t.agentId)!.messages[0]!)![1]!;
  host.behaviours.planner = (t) => {
    const dir = dirOf(t);
    if (t.text.includes("call propose_tasks with"))
      return void foundry.planning.proposeTasks(
        t.agentId,
        [
          { ref: "T1", title: "Add shout()", requirement_refs: ["R1"], slice: 1, size: "S" },
          { ref: "T2", title: "Add --shout", requirement_refs: ["R2"], slice: 2, depends_on: [{ ref: "T1", reason: "uses shout()" }] },
          { ref: "T3", title: "Document --shout", requirement_refs: ["R2"], slice: 2 },
          { ref: "T4", title: "Add --loud", requirement_refs: ["R3"], slice: 3, depends_on: [{ ref: "T2", reason: "extends the flag" }] },
        ],
        [
          { n: 1, title: "Shout core" },
          { n: 2, title: "CLI flag" },
          { n: 3, title: "Loud alias" },
        ],
      );
    if (t.text.includes("plan.md with")) return t.write(`${dir}/plan.md`, "# Plan\n");
    if (t.text.includes("Step 2")) {
      t.write(`${dir}/spec.md`, "# Spec\n\n## Goal\nShout.\n\n## Requirements\n");
      foundry.planning.proposeRequirements(t.agentId, [R("R1", "shout"), R("R2", "--shout"), R("R3", "--loud")]);
    }
  };
  // Each task writes its own file, so what reached which branch shows.
  host.behaviours.builder = (t) => {
    const key = /(SHT-\d+)/.exec(host.agents.get(t.agentId)!.messages[0]!)?.[1] ?? "x";
    t.write("done.txt", "ok\n"); // the fixture's check script wants it
    t.write(`${key}.txt`, `${key}\n`);
  };
  const reported: string[][] = [];
  let failed = false;
  host.behaviours.reviewer = (t) => {
    if (!t.text.includes("report_requirements")) return void foundry.tasks.reportVerdict(t.agentId, { decision: "pass", reason: "ok" });
    const refs = [...(/Requirements:\n([\s\S]*?)\n\n/.exec(t.text)?.[1] ?? "").matchAll(/^- (R\d+) /gm)].map((m) => m[1]!);
    reported.push(refs);
    const fail = o.failOnce && !failed && refs.includes(o.failOnce) && reported.length > 1;
    if (fail) failed = true;
    foundry.delivery.reportRequirements(t.agentId, refs.map((r) => ({ requirement_ref: r, passed: !(fail && r === o.failOnce), evidence: "checked" }) as RequirementResult));
  };
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  store.setShipMode(p.id, o.mode);
  const f = await foundry.planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  await foundry.planning.approveSpec(f.id, store.doc(f.id, "spec")!.head_sha!);
  await host.idle();
  await foundry.planning.approvePlan(f.id, store.doc(f.id, "plan")!.head_sha!);
  await host.idle();
  await foundry.planning.approveTasks(f.id, store.proposal(f.id)!.id, store.doc(f.id, "tasks")!.head_sha!);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await host.idle();
      await foundry.delivery.settled();
    }
  };
  await settle();
  const accept = async (key: string) => {
    const a = store.latestAttempt(key)!;
    await foundry.accept(key, a.head_sha!, a.tree_sha!);
    await settle();
  };
  // Keys follow the waves: look tasks up by title.
  const k = (title: string) => store.issues({ featureId: f.id }).find((i) => i.title === title)!.key;
  const slice = (n: number) => store.slices(f.id).find((s) => s.n === n)!;
  const status = () => store.slices(f.id).map((s) => `${s.n}:${s.status}`).join(" ");
  return { repo, gh, store, host, foundry, fid: f.id, settle, accept, slice, status, reported, k };
}

test("pr mode: slices build one after another, each verified and shipped as a stacked PR, retargeted when the one before merges", async () => {
  const { repo, gh, store, foundry, fid, settle, accept, slice, status, reported, k } = await threeSlices({ mode: "pr" });
  // Only slice 1 builds: T3 is Ready in slice 2 but waits for its slice.
  assert.equal(status(), "1:building 2:planned 3:planned");
  assert.equal(store.issue(k("Document --shout"))!.status, "Ready");
  assert.equal(store.latestAttempt(k("Document --shout")), undefined);
  await assert.rejects(foundry.tasks.start(k("Document --shout"), "you"), code("SLICE_ORDER"));

  // Slice 1 ends: its Verify checks only R1, it reaches Ship, and slice 2 starts on a branch cut from it.
  await accept(k("Add shout()"));
  assert.deepEqual(reported[0], ["R1"]);
  const f1 = store.feature(fid)!;
  assert.equal(f1.stage, "ship");
  assert.equal(status(), "1:ship 2:building 3:planned");
  const s2 = slice(2);
  assert.match(s2.branch!, /-s2$/);
  assert.notEqual(s2.path, f1.integration_path);
  assert.ok(existsSync(join(s2.path!, "SHT-1.txt")), "slice 2 starts with slice 1's work");
  // Its tasks start from its branch: T3 right away, T2 now that T1 is Done.
  for (const key of [k("Add --shout"), k("Document --shout")]) assert.equal(store.issue(key)!.status, "In_Review", key);
  assert.equal(run(repo, "git", "merge-base", "--is-ancestor", s2.head_sha!, store.latestAttempt(k("Document --shout"))!.head_sha!), "");

  // The front opens its PR into main.
  const ship1 = await foundry.delivery.prepare(fid, "you", slice(1).id);
  assert.deepEqual([gh!.read().prs[0]!.base, gh!.read().prs[0]!.title], ["main", "Shout mode (1/3): Shout core"]);

  // Slice 2's tasks merge into slice 2, not the feature branch; its Verify merges slice 1 in and checks R1 and R2.
  await accept(k("Add --shout"));
  await accept(k("Document --shout"));
  assert.equal(store.feature(fid)!.head_sha, f1.head_sha, "the front didn't move");
  assert.deepEqual(reported[1], ["R1", "R2"]);
  assert.equal(status(), "1:ship 2:ship 3:planned", "slice 3 waits: two slices are active");
  const v2 = foundry.delivery.verification(fid, slice(2).id)!;
  assert.equal(v2.status, "passed");
  assert.equal(v2.slice_id, slice(2).id);
  assert.equal(foundry.delivery.verification(fid)!.slice_id, slice(1).id, "the feature's own Verify is the front's");

  // Slice 2 can't ship before slice 1; its PR is stacked on slice 1's branch.
  await assert.rejects(foundry.delivery.acceptShip(fid, slice(2).head_sha!, "x", { slice: slice(2).id }), code("SLICE_ORDER"));
  const ship2 = await foundry.delivery.prepare(fid);
  assert.equal(ship2.pr!.number, 2, "Prepare picks the slice in Ship that isn't prepared yet");
  const pr2 = gh!.read().prs[1]!;
  assert.deepEqual([pr2.head, pr2.base], [slice(2).branch, f1.branch]);
  assert.match(pr2.body, /## Slice 2 of 3: CLI flag[\s\S]*Merge after slice 1 \(#1\)/);
  assert.match(pr2.body, /Add --shout[\s\S]*Document --shout|Document --shout[\s\S]*Add --shout/);
  assert.doesNotMatch(pr2.body, /Add shout\(\)/, "a slice's PR lists its own tasks");

  // PR 1 merges: slice 1 ships, slice 2 is promoted to the front and its PR retargeted at main; slice 3 starts on it.
  gh!.set(1, "MERGED");
  assert.deepEqual(await foundry.delivery.refreshPrs(), [{ feature: fid, result: "merged" }]);
  await settle();
  const f2 = store.feature(fid)!;
  assert.equal(slice(1).shipped_sha, ship1.sha);
  assert.deepEqual([f2.branch, f2.integration_path, f2.head_sha, f2.stage], [slice(2).branch, slice(2).path, slice(2).head_sha, "ship"]);
  assert.equal(gh!.read().prs[1]!.base, "main");
  assert.equal(foundry.delivery.prepared(fid)!.pr!.number, 2, "the PR moved to the feature's ship");
  assert.equal(status(), "1:shipped 2:ship 3:building");
  assert.ok(store.events({ feature: fid }).some((e) => e.kind === "pr_retargeted"));
  assert.equal(store.issue(k("Add --loud"))!.status, "In_Review");

  // Slice 3 verifies everything and stacks on slice 2.
  await accept(k("Add --loud"));
  assert.deepEqual(reported[2], ["R1", "R2", "R3"]);
  const ship3 = await foundry.delivery.prepare(fid, "you", slice(3).id);
  assert.equal(gh!.read().prs[2]!.base, slice(2).branch);
  gh!.set(2, "MERGED");
  await foundry.delivery.refreshPrs();
  await settle();
  assert.equal(gh!.read().prs[2]!.base, "main");
  assert.equal(store.feature(fid)!.stage, "ship");
  gh!.set(3, "MERGED");
  await foundry.delivery.refreshPrs();
  await settle();
  assert.equal(store.feature(fid)!.stage, "done");
  assert.equal(status(), "1:shipped 2:shipped 3:shipped");
  assert.equal(slice(3).shipped_sha, ship3.sha);
});

test("local merge: a fix in the front merges forward into the next slice; shipping the front promotes it and verifies it against base", async () => {
  const { repo, store, foundry, fid, settle, accept, slice, status, reported, k } = await threeSlices({ mode: "local_merge", failOnce: "R1" });
  await accept(k("Add shout()"));
  assert.equal(status(), "1:ship 2:building 3:planned");
  // Verify the front again: the reviewer finds R1 failing; the failure becomes a task of slice 1.
  await foundry.delivery.verify(fid, "you", true, slice(1).id);
  await settle();
  assert.equal(foundry.delivery.verification(fid)!.status, "failed");
  await foundry.delivery.taskFromFailure(fid, "Fix shout()", "", ["R1"], "you", slice(1).id);
  await settle();
  const fix = store.issues({ featureId: fid }).find((i) => i.title === "Fix shout()")!;
  assert.equal(fix.slice_id, slice(1).id);
  assert.equal(status(), "1:building 2:building 3:planned");
  assert.equal(store.feature(fid)!.stage, "build");
  // Accepting it in the front merges it forward into slice 2.
  await accept(fix.key);
  assert.ok(existsSync(join(slice(2).path!, `${fix.key}.txt`)), "slice 2 has the front's fix");
  assert.equal(run(slice(2).path!, "git", "rev-parse", "HEAD"), slice(2).head_sha);
  assert.ok(store.events({ feature: fid }).some((e) => e.kind === "slice_merged_forward"));
  assert.equal(store.feature(fid)!.stage, "ship");

  // Slice 2 finishes and prepares a local merge; it can't be accepted before slice 1.
  await accept(k("Add --shout"));
  await accept(k("Document --shout"));
  assert.equal(status(), "1:ship 2:ship 3:planned");
  const p2 = await foundry.delivery.prepare(fid, "you", slice(2).id);
  await assert.rejects(foundry.delivery.acceptShip(fid, p2.sha, p2.tree, { slice: slice(2).id }), code("SLICE_ORDER"));

  // Ship slice 1: slice 2 is promoted; its prepared local merge is dropped and Verify runs against main.
  const before = reported.length;
  const p1 = await foundry.delivery.prepare(fid, "you", slice(1).id);
  const r = await foundry.delivery.acceptShip(fid, p1.sha, p1.tree, { confirmCheckedOut: true });
  assert.equal(r.next_slice, 2);
  await settle();
  assert.equal(run(repo, "git", "merge-base", "--is-ancestor", p1.sha, "main"), "");
  assert.equal(reported.length, before + 1, "the promoted slice was verified again");
  assert.equal(store.feature(fid)!.branch, slice(2).branch);
  assert.equal(store.feature(fid)!.stage, "ship");
  assert.equal(status(), "1:shipped 2:ship 3:building");
  assert.deepEqual(parse<unknown>(store.setting(`ship:slice:${slice(2).id}`), null), null);
});
