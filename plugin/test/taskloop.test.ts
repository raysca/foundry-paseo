import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, parse } from "../server/core/store";
import { Locks } from "../server/core/locks";
import { TaskLoop, type LoopSettings } from "../server/core/taskloop";
import { ensureIntegration } from "../server/core/features";
import { FoundryError } from "../server/core/model";
import { FakeHost, fixtureRepo, run, type Behaviour } from "./fake-host";

const ok: Behaviour = (t) => t.write("done.txt", "ok\n");
const pass: Behaviour = (t) => void loopOf.get(t.agentId)?.reportVerdict(t.agentId, { decision: "pass", reason: "looks right" });
const loopOf = new Map<string, TaskLoop>();

async function setup(o: { settings?: Partial<LoopSettings>; builder?: Behaviour; reviewer?: Behaviour; autoStart?: boolean } = {}) {
  const repo = fixtureRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const loop = new TaskLoop(store, host, new Locks(), { maxFixRounds: 2, questionWindowMs: 50, checkTimeoutMs: 30_000, ...o.settings });
  host.loop = loop;
  // Every agent this host starts can reach the loop's tools.
  const origStart = host.startAgent.bind(host);
  host.startAgent = async (spec) => {
    loopOf.set(spec.agentId, loop);
    return origStart(spec);
  };
  host.behaviours.builder = o.builder ?? ok;
  host.behaviours.reviewer = o.reviewer ?? pass;
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  const f0 = store.createFeature({ projectId: p.id, slug: "shout", title: "Shout", idea: "louder", flow: "standard", branch: "foundry/feature/shout" });
  if (o.autoStart !== false) {
    for (const d of store.docs(f0.id)) store.updateDoc(f0.id, d.kind, { status: "approved" });
    store.setStage(f0.id, "build");
  }
  const f = await ensureIntegration(store, host, f0.id);
  const issue = (title: string, extra: Partial<Parameters<Store["createIssue"]>[0]> = {}) =>
    store.createIssue({ projectId: p.id, featureId: f.id, origin: "feature", title, status: "Backlog", ...extra });
  const shas = (key: string) => {
    const a = store.latestAttempt(key)!;
    return [a.head_sha!, a.tree_sha!] as const;
  };
  return { repo, store, host, loop, p, f, issue, shas };
}

const attempt = (s: Store, key: string) => s.latestAttempt(key)!;
const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;

test("pass path: build, checks, review, then accept merges into the feature branch", async () => {
  const { store, host, loop, f, issue, shas } = await setup();
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  assert.equal(store.issue(i.key)!.status, "In_Review");
  const a = attempt(store, i.key);
  assert.equal(a.outcome, "passed");
  assert.equal(a.fix_rounds, 0);
  assert.equal(run(a.worktree_path!, "git", "show", `${a.head_sha}:done.txt`), "ok");
  assert.equal(run(a.worktree_path!, "git", "log", "-1", "--format=%an"), "Foundry");
  assert.deepEqual(host.scripts, [{ script: "test", code: 0 }]);
  assert.ok(host.notifications.some((n) => n.key === `review:${i.key}`));

  const [h, t] = shas(i.key);
  const r = await loop.accept(i.key, h, t);
  assert.ok(r.merged);
  assert.equal(store.issue(i.key)!.status, "Done");
  assert.equal(run(f.integration_path!, "git", "rev-parse", "HEAD"), store.feature(f.id)!.head_sha);
  assert.equal(run(f.integration_path!, "git", "show", "HEAD:done.txt"), "ok");
});

test("a failed check starts a fix round in the same session, and the rerun passes", async () => {
  const { store, host, loop, issue } = await setup({ builder: (t) => t.write("done.txt", t.n === 1 ? "nope\n" : "ok\n") });
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  const a = attempt(store, i.key);
  assert.equal(store.issue(i.key)!.status, "In_Review");
  assert.equal(a.fix_rounds, 1);
  assert.deepEqual(host.scripts.map((s) => s.code), [1, 0]);
  const msgs = host.agents.get(a.builder_agent_id!)!.messages;
  assert.match(msgs[1]!, /fix round 1 of 2/);
  assert.match(msgs[1]!, /done.txt is not ok/);
});

test("when the fix budget is spent the task comes to you flagged CHECKS_FAILED", async () => {
  const { store, host, loop, issue } = await setup({ settings: { maxFixRounds: 1 }, builder: (t) => t.write("done.txt", "nope\n") });
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  const a = attempt(store, i.key);
  assert.equal(store.issue(i.key)!.status, "In_Review");
  assert.equal(a.outcome, "rework");
  assert.equal(a.flag, "CHECKS_FAILED");
  assert.equal(a.reviewer_agent_id, null, "no review after failing checks");
});

test("a builder cannot weaken the checks: paseo.json and the files its commands name come from base", async () => {
  const { store, host, loop, issue } = await setup({
    settings: { maxFixRounds: 0 },
    builder: (t) => {
      t.write("check.sh", "exit 0\n");
      t.write("paseo.json", JSON.stringify({ scripts: { test: { type: "script", command: "true" } } }));
    },
  });
  const i = issue("Cheat");
  await loop.start(i.key, "you");
  await host.idle();
  assert.equal(attempt(store, i.key).flag, "CHECKS_FAILED");
});

test("a reviewer rework sends findings to the builder and loops back through the checks", async () => {
  const { store, host, loop, issue } = await setup({
    builder: (t) => t.write("done.txt", t.n === 1 ? "ok\n" : "ok\nwith tests\n"),
    reviewer: (t) =>
      void loopOf.get(t.agentId)!.reportVerdict(t.agentId, t.read("done.txt").includes("tests") ? { decision: "pass", reason: "good" } : { decision: "rework", reason: "missing tests", findings: [{ severity: "high", title: "no tests" }] }),
  });
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  const a = attempt(store, i.key);
  assert.equal(store.issue(i.key)!.status, "In_Review");
  assert.equal(a.reworks, 1);
  assert.equal(a.outcome, "passed");
  assert.match(host.agents.get(a.builder_agent_id!)!.messages[1]!, /missing tests[\s\S]*no tests/);
  assert.equal(host.scripts.length, 2);
});

test("a second rework request comes to you flagged REVIEW_REWORK; reviewer edits are reset", async () => {
  const { store, host, loop, issue } = await setup({
    reviewer: (t) => {
      t.write("done.txt", "reviewer was here\n");
      loopOf.get(t.agentId)!.reportVerdict(t.agentId, { decision: "rework", reason: "still wrong" });
    },
  });
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  const a = attempt(store, i.key);
  assert.equal(store.issue(i.key)!.status, "In_Review");
  assert.equal(a.flag, "REVIEW_REWORK");
  assert.equal(run(a.worktree_path!, "git", "status", "--porcelain"), "");
  assert.ok(store.events({ issue: i.key }).some((e) => e.kind === "reviewer_changes_reset"));
});

test("a reviewer fail verdict fails the task with REVIEW_FAIL", async () => {
  const { store, host, loop, issue } = await setup({ reviewer: (t) => void loopOf.get(t.agentId)!.reportVerdict(t.agentId, { decision: "fail", reason: "wrong approach" }) });
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  assert.equal(store.issue(i.key)!.status, "Failed");
  assert.equal(store.issue(i.key)!.reason, "REVIEW_FAIL");
});

test("accept is SHA-bound: STALE_REVIEW when it moved, DIRTY_WORKTREE when uncommitted, NOT_IN_REVIEW otherwise", async () => {
  const { store, host, loop, issue, shas } = await setup();
  const i = issue("Add shout");
  await assert.rejects(loop.accept(i.key, "x", "y"), code("NOT_IN_REVIEW"));
  await loop.start(i.key, "you");
  await host.idle();
  const [h, t] = shas(i.key);
  await assert.rejects(loop.accept(i.key, "0".repeat(40), t), code("STALE_REVIEW"));
  const a = attempt(store, i.key);
  writeFileSync(join(a.worktree_path!, "stray.txt"), "x");
  await assert.rejects(loop.accept(i.key, h, t), code("DIRTY_WORKTREE"));
  run(a.worktree_path!, "rm", "stray.txt");
  await assert.rejects(loop.rework(i.key, h, t, "  "), code("FEEDBACK_REQUIRED"));
  await loop.accept(i.key, h, t);
  assert.equal(store.issue(i.key)!.status, "Done");
});

test("a merge into the feature branch made outside Foundry refuses accept with INTEGRATION_MOVED and holds auto-start", async () => {
  const { store, host, loop, f, issue, shas } = await setup();
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  writeFileSync(join(f.integration_path!, "outside.txt"), "merged locally\n");
  run(f.integration_path!, "git", "add", "-A");
  run(f.integration_path!, "git", "commit", "-q", "-m", "outside");
  const [h, t] = shas(i.key);
  await assert.rejects(loop.accept(i.key, h, t), code("INTEGRATION_MOVED"));
  assert.equal(store.issue(i.key)!.status, "In_Review");
  assert.equal(store.setting(`feature_hold:${f.id}`), "INTEGRATION_MOVED");
  const j = issue("Next", { status: "Ready" });
  await loop.tick();
  assert.equal(store.issue(j.key)!.status, "Ready", "held features do not auto-start");
});

test("a merge conflict at accept sends the task back to its agent with the reviewed SHA kept", async () => {
  let resolve = false;
  const { store, host, loop, f, issue, shas } = await setup({
    autoStart: false,
    builder: (t) => {
      if (t.text.includes("merge conflict")) {
        resolve = true;
        t.git("merge", "-q", "-X", "theirs", f.branch, "-m", "merge feature");
        return;
      }
      t.write("README.md", `${t.text.includes("SHT-1") ? "one" : "two"}\n`);
      t.write("done.txt", "ok\n");
    },
  });
  const a1 = issue("One");
  const a2 = issue("Two");
  await loop.start(a1.key, "you");
  await loop.start(a2.key, "you");
  await host.idle();
  const [h1, t1] = shas(a1.key);
  await loop.accept(a1.key, h1, t1);
  const [h2, t2] = shas(a2.key);
  const r = await loop.accept(a2.key, h2, t2);
  assert.deepEqual(r.conflict, ["README.md"]);
  await host.idle();
  assert.ok(resolve);
  assert.equal(store.issue(a2.key)!.status, "In_Review");
  assert.equal(attempt(store, a2.key).n, 2);
  assert.ok(store.events({ issue: a2.key }).some((e) => e.kind === "merge_conflict"));
  const [h3, t3] = shas(a2.key);
  assert.notEqual(h3, h2);
  await loop.accept(a2.key, h3, t3);
  assert.equal(store.issue(a2.key)!.status, "Done");
  assert.equal(run(f.integration_path!, "git", "show", "HEAD:README.md"), "one");
});

test("a question answered after the window resumes the same session in a new attempt", async () => {
  let reply = "";
  const { store, host, loop, issue } = await setup({
    builder: async (t) => {
      if (t.n === 1) {
        reply = await loopOf.get(t.agentId)!.askHuman(t.agentId, "Uppercase or exclamation marks?");
        return;
      }
      t.write("done.txt", "ok\n");
    },
  });
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  assert.match(reply, /end your turn/);
  assert.equal(store.issue(i.key)!.status, "Awaiting_Human");
  const q = store.get<{ id: number; status: string }>("SELECT id,status FROM questions WHERE issue_key=?", i.key)!;
  assert.equal(q.status, "waiting");
  assert.deepEqual(await loop.answer(q.id, "Uppercase"), { delivered: "resumed" });
  await host.idle();
  assert.equal(store.issue(i.key)!.status, "In_Review");
  const a = attempt(store, i.key);
  assert.equal(a.n, 2);
  assert.match(host.agents.get(a.builder_agent_id!)!.messages[1]!, /Uppercase/);
});

test("a question answered inside the window goes straight back to the waiting agent", async () => {
  let reply = "";
  const { store, host, loop, issue } = await setup({
    settings: { questionWindowMs: 5_000 },
    builder: async (t) => {
      reply = await loopOf.get(t.agentId)!.askHuman(t.agentId, "Which?");
      t.write("done.txt", "ok\n");
    },
  });
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  let q: { id: number } | undefined;
  while (!(q = store.get<{ id: number }>("SELECT id FROM questions WHERE issue_key=?", i.key))) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await loop.answer(q.id, "This one"), { delivered: "live" });
  await host.idle();
  assert.equal(reply, "The developer answered: This one");
  assert.equal(store.issue(i.key)!.status, "In_Review");
  assert.equal(attempt(store, i.key).n, 1);
});

test("a turn Foundry did not start is committed apart as the host user and does not drive the loop", async () => {
  const { store, host, loop, issue } = await setup();
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  const a = attempt(store, i.key);
  writeFileSync(join(a.worktree_path!, "extra.txt"), "from paseo\n");
  await loop.onTurnEnd(a.builder_agent_id!, { kind: "completed" }, false);
  assert.equal(run(a.worktree_path!, "git", "log", "-1", "--format=%an"), "Host user (untracked)");
  assert.equal(store.issue(i.key)!.status, "In_Review");
  assert.ok(store.events({ issue: i.key }).some((e) => e.kind === "untracked_edit"));
  const [h] = [attempt(store, i.key).head_sha];
  assert.equal(h, run(a.worktree_path!, "git", "rev-parse", "HEAD"));
});

test("dependencies: a task waits for its dependency, then auto-starts once it is Done", async () => {
  const { store, host, loop, issue, shas } = await setup();
  const a = issue("Base");
  const b = issue("On top");
  store.addDep(b.key, a.key, "needs the base");
  await assert.rejects(loop.start(b.key, "you"), code("DEPENDENCIES_NOT_DONE"));
  await loop.start(a.key, "you");
  await host.idle();
  assert.equal(store.issue(b.key)!.status, "Backlog");
  const [h, t] = shas(a.key);
  await loop.accept(a.key, h, t);
  await host.idle();
  assert.equal(store.issue(b.key)!.status, "In_Review");
  const ba = attempt(store, b.key);
  assert.equal(run(ba.worktree_path!, "git", "merge-base", "--is-ancestor", h, "HEAD"), "", "started from the feature branch with the base merged");
});

test("report_verdict is refused for another issue, and a human verdict needs action_required", async () => {
  const { store, host, loop, issue } = await setup({
    builder: (t) => {
      const l = loopOf.get(t.agentId)!;
      assert.throws(() => l.reportVerdict(t.agentId, { decision: "pass", reason: "", issue_key: "SHT-99" }), code("TOOL_REFUSED"));
      assert.throws(() => l.reportVerdict(t.agentId, { decision: "human", reason: "unsure" }), code("VERDICT_INVALID"));
      l.reportVerdict(t.agentId, { decision: "human", reason: "unsure", action_required: "pick a colour" });
    },
  });
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  assert.equal(attempt(store, i.key).flag, "BUILDER_NEEDS_HUMAN");
  assert.equal(store.issue(i.key)!.status, "In_Review");
  assert.throws(() => loop.reportVerdict("nobody", { decision: "pass", reason: "" }), code("TOOL_REFUSED"));
});

test("a builder that cannot start leaves the task Blocked with INFRA_ERROR", async () => {
  const { store, host, loop, issue } = await setup();
  host.failStart = true;
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  assert.equal(store.issue(i.key)!.status, "Blocked");
  assert.equal(store.issue(i.key)!.reason, "INFRA_ERROR");
});

test("an unknown loop flags the task LOOP_MISSING and it is not auto-started", async () => {
  const { store, loop, issue } = await setup();
  const i = issue("Add shout", { loop: "frontend", status: "Ready" });
  await assert.rejects(loop.start(i.key, "you"), code("LOOP_MISSING"));
  assert.equal(store.issue(i.key)!.flag, "LOOP_MISSING");
  await loop.tick();
  assert.equal(store.issue(i.key)!.status, "Ready");
  void parse;
});

test("a step Foundry cannot carry out blocks the task with INFRA_ERROR instead of leaving it stuck", async () => {
  const { store, host, loop, issue } = await setup();
  const real = host.createWorktreeWorkspace.bind(host);
  host.createWorktreeWorkspace = async (o) => {
    if (o.purpose === "check") throw new Error("Unknown branch");
    return real(o);
  };
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await host.idle();
  assert.equal(store.issue(i.key)!.status, "Blocked");
  assert.equal(store.issue(i.key)!.reason, "INFRA_ERROR");
});
