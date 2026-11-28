// Task Flows, part 2: the bugfix loop's repro step. A bug fix must add a test that fails with the fix
// reverted and passes with it. Foundry checks both in the check workspace and shows the two runs in review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, parse } from "../server/core/store";
import { Locks } from "../server/core/locks";
import { TaskLoop } from "../server/core/taskloop";
import { ensureIntegration } from "../server/core/features";
import { BUILTIN_LOOPS, parseLoopFile } from "../server/core/loops";
import { reproScript, splitRepro } from "../server/core/checks";
import { FakeHost, fixtureRepo, run, type Behaviour, type Turn } from "./fake-host";

const BUGGY = 'shout() { echo "$1" | tr a-z A-Z | tr -d "!"; }\n';
const FIXED = 'shout() { echo "$1" | tr a-z A-Z; }\n';
const REPRO = '. ./lib.sh\n[ "$(shout "hi!")" = "HI!" ] || { echo "shout dropped the !: $(shout "hi!")"; exit 1; }\n';

/** A repo whose lib.sh drops punctuation, and a `test` script that runs every test/*.sh. */
function bugRepo() {
  const repo = fixtureRepo();
  writeFileSync(join(repo, "lib.sh"), BUGGY);
  writeFileSync(join(repo, "run-tests.sh"), 'for t in test/*.sh; do [ -e "$t" ] || continue; sh "$t" || exit 1; done\n');
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test/smoke.sh"), ". ./lib.sh\n[ -n \"$(shout hi)\" ]\n");
  writeFileSync(join(repo, "paseo.json"), JSON.stringify({ scripts: { test: { type: "script", command: "sh run-tests.sh" } } }, null, 2));
  run(repo, "git", "add", "-A");
  run(repo, "git", "commit", "-q", "-m", "shout drops punctuation");
  return repo;
}

const loopOf = new Map<string, TaskLoop>();
const pass: Behaviour = (t) => void loopOf.get(t.agentId)?.reportVerdict(t.agentId, { decision: "pass", reason: "fixed at the root" });

async function setup(builder: Behaviour, maxFixRounds = 2) {
  const repo = bugRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const loop = new TaskLoop(store, host, new Locks(), { maxFixRounds, questionWindowMs: 50, checkTimeoutMs: 30_000 });
  host.loop = loop;
  const origStart = host.startAgent.bind(host);
  host.startAgent = async (spec) => {
    loopOf.set(spec.agentId, loop);
    return origStart(spec);
  };
  const prompts: string[] = [];
  host.behaviours.builder = builder;
  host.behaviours.reviewer = (t) => {
    prompts.push(t.text);
    return pass(t);
  };
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  const f0 = store.createFeature({ projectId: p.id, slug: "shout", title: "Shout", idea: "louder", flow: "standard", branch: "foundry/feature/shout" });
  for (const d of store.docs(f0.id)) store.updateDoc(f0.id, d.kind, { status: "approved" });
  store.setStage(f0.id, "build");
  const f = await ensureIntegration(store, host, f0.id);
  const i = store.createIssue({ projectId: p.id, featureId: f.id, origin: "feature", title: "Fix shout() dropping punctuation", status: "Backlog", loop: "bugfix" });
  const runs = (key: string) =>
    store
      .runs(store.latestAttempt(key)!.id)
      .filter((r) => r.kind === "check")
      .map((r) => `${parse<{ name: string }>(r.detail, { name: "" }).name}: ${r.status}`);
  return { store, host, loop, i, runs, prompts };
}

const fixWithTest = (t: Turn) => {
  t.write("lib.sh", FIXED);
  t.write("test/punctuation.sh", REPRO);
};

test("the bugfix loop reproduces first: the test fails without the fix and passes with it, and review sees both runs", async () => {
  assert.deepEqual(BUILTIN_LOOPS.bugfix!.steps.map((s) => s.kind), ["agent", "repro", "check", "review"]);
  const { store, host, loop, i, runs, prompts } = await setup(fixWithTest);
  await loop.start(i.key, "you");
  await host.idle();
  const a = store.latestAttempt(i.key)!;
  assert.equal(a.outcome, "passed");
  assert.equal(a.fix_rounds, 0);
  assert.equal(store.issue(i.key)!.status, "In_Review");
  assert.deepEqual(runs(i.key), ["repro: without the fix (expected to fail): passed", "repro: with the fix: passed", "test: passed"]);
  assert.deepEqual(host.scripts.map((s) => s.code), [1, 0, 0], "fails without the fix, passes with it, then the checks");
  assert.match(prompts[0]!, /repro: without the fix \(expected to fail\): passed/);
  // The builder's worktree and commit are untouched by the revert.
  assert.equal(run(a.worktree_path!, "git", "show", `${a.head_sha}:lib.sh`), FIXED.trim());
});

test("a test that passes without the fix goes back to the builder, and a real reproduction then passes", async () => {
  const { store, host, loop, i, runs } = await setup((t) => {
    t.write("lib.sh", FIXED);
    t.write("test/punctuation.sh", t.n === 1 ? ". ./lib.sh\n[ -n \"$(shout hi)\" ]\n" : REPRO);
  });
  await loop.start(i.key, "you");
  await host.idle();
  const a = store.latestAttempt(i.key)!;
  assert.equal(a.outcome, "passed");
  assert.equal(a.fix_rounds, 1);
  const msg = host.agents.get(a.builder_agent_id!)!.messages[1]!;
  assert.match(msg, /bug reproduction failed .* \(fix round 1 of 2\)/);
  assert.match(msg, /"test" passes with your fix reverted \(lib.sh\), so test\/punctuation.sh doesn't reproduce the bug/);
  assert.deepEqual(runs(i.key).slice(0, 2), ["repro: without the fix (expected to fail): failed", "repro: with the fix: passed"]);
});

test("no test, or only a test, is REPRO_FAILED once the fix budget is spent; no review runs", async () => {
  const noTest = await setup((t) => t.write("lib.sh", FIXED), 1);
  await noTest.loop.start(noTest.i.key, "you");
  await noTest.host.idle();
  const a = noTest.store.latestAttempt(noTest.i.key)!;
  assert.equal([a.outcome, a.flag, a.reviewer_agent_id].join(), "rework,REPRO_FAILED,");
  assert.match(noTest.host.agents.get(a.builder_agent_id!)!.messages[1]!, /No test reproduces the bug/);
  assert.deepEqual(noTest.host.scripts, [], "nothing runs without a test");

  const onlyTest = await setup((t) => t.write("test/punctuation.sh", REPRO), 0);
  await onlyTest.loop.start(onlyTest.i.key, "you");
  await onlyTest.host.idle();
  const b = onlyTest.store.latestAttempt(onlyTest.i.key)!;
  assert.equal(b.flag, "REPRO_FAILED");
  assert.match(onlyTest.store.events({ issue: onlyTest.i.key }).find((e) => e.kind === "attempt_ended")!.detail ?? "", /bug reproduction still failing after 0 fix round\(s\): Only tests changed \(test\/punctuation.sh\)/);
});

test("the fix must make the test pass; the task can name its repro script and test files", async () => {
  const broken = await setup((t) => {
    t.write("lib.sh", 'shout() { echo "$1"; }\n');
    t.write("test/punctuation.sh", REPRO);
  }, 0);
  await broken.loop.start(broken.i.key, "you");
  await broken.host.idle();
  assert.deepEqual(broken.runs(broken.i.key), ["repro: without the fix (expected to fail): passed", "repro: with the fix: failed"]);
  assert.equal(broken.store.latestAttempt(broken.i.key)!.flag, "REPRO_FAILED");

  // Named files: a test outside the naming conventions counts, and other test-looking files are the fix.
  const named = await setup((t) => {
    t.write("lib.sh", FIXED);
    t.write("checks/punct.sh", REPRO);
  });
  named.store.updateIssue(named.i.key, { checks: JSON.stringify({ repro: { files: ["checks/punct.sh"] } }) }, "you");
  await named.loop.start(named.i.key, "you");
  await named.host.idle();
  // run-tests.sh only runs test/*.sh, so checks/punct.sh never runs: it passes without the fix.
  assert.match(named.host.agents.get(named.store.latestAttempt(named.i.key)!.builder_agent_id!)!.messages[1]!, /checks\/punct.sh doesn't reproduce the bug/);

  const avail = [{ name: "lint", command: "x" }, { name: "test", command: "y" }];
  const step = { kind: "repro" as const, name: "repro" };
  assert.equal(reproScript(step, {}, avail), "test");
  assert.equal(reproScript(step, { scripts: ["lint"] }, avail), "lint");
  assert.equal(reproScript(step, { scripts: ["lint"], repro: { script: "unit" } }, avail), "unit");
  assert.equal(reproScript({ ...step, script: "e2e" }, { repro: { script: "unit" } }, avail), "e2e");
  assert.equal(reproScript(step, {}, []), null);
  const split = splitRepro([
    { status: "M", path: "src/shout.ts" },
    { status: "A", path: "src/shout.test.ts" },
    { status: "A", path: "tests/test_shout.py" },
    { status: "D", path: "test/old.sh" },
    { status: "M", path: "pkg/shout_test.go" },
  ]);
  assert.deepEqual([split.tests.map((c) => c.path), split.fix.map((c) => c.path)], [["src/shout.test.ts", "tests/test_shout.py", "pkg/shout_test.go"], ["src/shout.ts", "test/old.sh"]]);
});

test("project loop files can use a repro step", () => {
  const r = parseLoopFile("bug-strict", { steps: [{ kind: "agent", name: "fix" }, { kind: "repro", name: "repro", script: "unit", max_fix_rounds: 1 }, { kind: "review", name: "review", back_to: "fix" }] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(parseLoopFile("x", { steps: [{ kind: "agent", name: "fix" }, { kind: "repro", name: "repro", script: ["unit"], scripts: ["a"] }] }).errors, [
    'Step 2 (repro) has an unknown field "scripts".',
    "Step 2: script must be a script name.",
  ]);
});
