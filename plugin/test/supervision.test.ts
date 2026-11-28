// Task Flows, part 4: supervision. A silent or overrunning agent turn is interrupted, then stopped; the
// task is retried with backoff, then Blocked; questions and permission cards pause the clocks; repeated
// infrastructure failures pause auto-start until you resume it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, parse } from "../server/core/store";
import { Locks } from "../server/core/locks";
import { TaskLoop, type LoopSettings } from "../server/core/taskloop";
import { ensureIntegration } from "../server/core/features";
import { FakeHost, fixtureRepo, type Behaviour } from "./fake-host";

const loopOf = new Map<string, TaskLoop>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok: Behaviour = (t) => t.write("done.txt", "ok\n");

async function setup(builder: Behaviour, settings: Partial<LoopSettings> = {}) {
  const repo = fixtureRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const loop = new TaskLoop(store, host, new Locks(), { maxFixRounds: 2, questionWindowMs: 50, checkTimeoutMs: 30_000, idleTimeoutMs: 150, turnTimeoutMs: 5_000, stopGraceMs: 100, retryBackoffMs: 50, activityPollMs: 0, maxRetries: 2, ...settings });
  host.loop = loop;
  const origStart = host.startAgent.bind(host);
  host.startAgent = async (spec) => {
    loopOf.set(spec.agentId, loop);
    return origStart(spec);
  };
  host.behaviours.builder = builder;
  host.behaviours.reviewer = (t) => void loopOf.get(t.agentId)!.reportVerdict(t.agentId, { decision: "pass", reason: "fine" });
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  const f0 = store.createFeature({ projectId: p.id, slug: "shout", title: "Shout", idea: "louder", flow: "standard", branch: "foundry/feature/shout" });
  for (const d of store.docs(f0.id)) store.updateDoc(f0.id, d.kind, { status: "approved" });
  store.setStage(f0.id, "build");
  const f = await ensureIntegration(store, host, f0.id);
  const issue = (title: string) => store.createIssue({ projectId: p.id, featureId: f.id, origin: "feature", title, status: "Backlog" });
  /** Run the supervisor and scheduler as Foundry's timer does, until `done` or the time runs out. */
  const drive = async (done: () => boolean, ms = 5_000) => {
    const until = Date.now() + ms;
    while (!done()) {
      if (Date.now() > until) throw new Error("drive timed out");
      await loop.supervise();
      await loop.tick();
      await sleep(15);
    }
    await host.idle();
  };
  const events = (key: string, kind: string) => store.events({ issue: key }).filter((e) => e.kind === kind).map((e) => parse<Record<string, any>>(e.detail, {}));
  return { store, host, loop, issue, drive, events };
}

test("a silent builder is interrupted, the task is retried after a backoff, and the retry passes", async () => {
  const { store, host, loop, issue, drive, events } = await setup(async (t) => {
    if (t.n === 1 && host.agents.size === 1) {
      await t.stopped; // says nothing until Foundry interrupts it
      return "canceled";
    }
    ok(t);
  });
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await drive(() => store.issue(i.key)!.status === "In_Review");
  const [first, second] = store.all<any>("SELECT * FROM attempts WHERE issue_key=? ORDER BY n", i.key);
  assert.equal([first.outcome, first.reason].join(), "failed,TIMEOUT");
  assert.equal(second.outcome, "passed");
  assert.match(events(i.key, "turn_timeout")[0]!.why, /the builder was silent for \d+ s/);
  assert.deepEqual(host.interrupted, [first.builder_agent_id]);
  assert.deepEqual(host.killed, [], "it ended its turn when interrupted");
  const r = events(i.key, "retry_scheduled")[0]!;
  assert.deepEqual([r.retry, r.of, r.reason], [1, 2, "TIMEOUT"]);
  assert.deepEqual([store.issue(i.key)!.retries, store.issue(i.key)!.retry_at], [0, null], "getting through resets the retries");
});

test("a builder that ignores the interrupt is stopped after the grace period", async () => {
  const { store, host, loop, issue, drive, events } = await setup(() => new Promise<void>(() => {}), { maxRetries: 0 });
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await drive(() => store.issue(i.key)!.status === "Blocked");
  const a = store.latestAttempt(i.key)!;
  assert.deepEqual(host.killed, [a.builder_agent_id]);
  assert.equal(events(i.key, "agent_killed").length, 1);
  assert.equal(store.issue(i.key)!.reason, "TIMEOUT");
  assert.match(events(i.key, "attempt_ended")[0]!.detail, /silent for .*it didn't stop when interrupted, so Foundry stopped the agent/);
  assert.ok(store.runs(a.id).every((r) => r.status !== "running"), "its runs are closed");
});

test("a busy turn is stopped at the turn timeout; retries run out and the task is Blocked", async () => {
  const { store, host, loop, issue, drive, events } = await setup(
    async (t) => {
      let stop = false;
      void t.stopped.then(() => (stop = true));
      while (!stop) {
        t.ping(); // keeps working, never finishes
        await sleep(20);
      }
      return "canceled";
    },
    { turnTimeoutMs: 200, maxRetries: 1 },
  );
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  await drive(() => store.issue(i.key)!.status === "Blocked");
  assert.equal(store.all("SELECT * FROM attempts WHERE issue_key=?", i.key).length, 2, "one attempt and one retry");
  assert.ok(events(i.key, "turn_timeout").every((e) => /the builder's turn ran for/.test(e.why)));
  assert.ok(events(i.key, "attempt_ended").some((e) => /gave up after 1 automatic retry/.test(e.detail)));
  assert.ok(host.notifications.some((n) => n.key === `blocked:${i.key}`));
  // Starting it yourself gives it a fresh set of retries.
  host.behaviours.builder = ok;
  await loop.start(i.key, "you");
  assert.equal(store.issue(i.key)!.retries, 0);
  await drive(() => store.issue(i.key)!.status === "In_Review");
});

test("a question waiting on you and a permission card pause the clocks", async () => {
  let qid = 0;
  const { store, host, loop, issue, drive, events } = await setup(
    async (t) => {
      if (t.n === 1) {
        const answer = await loopOf.get(t.agentId)!.askHuman(t.agentId, "Also -s?");
        assert.match(answer, /yes/);
        ok(t);
      }
    },
    { questionWindowMs: 2_000, idleTimeoutMs: 100 },
  );
  const i = issue("Add shout");
  await loop.start(i.key, "you");
  const until = Date.now() + 400;
  while (Date.now() < until) {
    await loop.supervise();
    qid ||= store.get<{ id: number }>("SELECT id FROM questions WHERE issue_key=? AND status='live'", i.key)?.id ?? 0;
    await sleep(20);
  }
  assert.equal(events(i.key, "turn_timeout").length, 0, "four idle timeouts passed while the question waited");
  await loop.answer(qid, "yes");
  await drive(() => store.issue(i.key)!.status === "In_Review");

  // A permission card: the attempt shows it, and the clocks wait.
  const j = issue("Add whisper");
  host.behaviours.builder = async (t) => {
    await t.stopped;
    return "canceled";
  };
  await loop.start(j.key, "you");
  const a = store.latestAttempt(j.key)!;
  loop.onPermission(a.builder_agent_id!, true);
  assert.equal(store.attempt(a.id)!.waiting, "permission");
  for (let n = 0; n < 15; n++) {
    await loop.supervise();
    await sleep(20);
  }
  assert.equal(events(j.key, "turn_timeout").length, 0);
  loop.onPermission(a.builder_agent_id!, false);
  assert.equal(store.attempt(a.id)!.waiting, null);
  await drive(() => events(j.key, "turn_timeout").length > 0);
  assert.deepEqual(events(j.key, "permission_waiting").length + events(j.key, "permission_answered").length, 2);
});

test("repeated infrastructure failures pause auto-start until you resume it", async () => {
  const { store, host, loop, issue, events } = await setup(ok, { maxRetries: 0, breakerThreshold: 2 });
  host.failStart = true;
  const [x, y, z] = [issue("One"), issue("Two"), issue("Three")];
  for (const k of [x.key, y.key]) await loop.start(k, "you");
  assert.deepEqual([store.issue(x.key)!.status, store.issue(y.key)!.reason], ["Blocked", "INFRA_ERROR"]);
  assert.match(loop.autostartPaused()!.why, /2 infrastructure failures/);
  assert.ok(host.notifications.some((n) => n.key === "autostart-paused"));
  assert.equal(store.events({}).filter((e) => e.kind === "autostart_paused").length, 1);

  // Auto-start holds Ready work; you can still start a task yourself.
  host.failStart = false;
  store.setIssueStatus(z.key, "Ready", "you");
  await loop.tick();
  assert.equal(store.issue(z.key)!.status, "Ready");
  loop.resumeAutostart("you");
  await loop.tick();
  await host.idle();
  assert.equal(loop.autostartPaused(), null);
  assert.notEqual(store.issue(z.key)!.status, "Ready", "auto-start picked it up once resumed");
  void events;
});
