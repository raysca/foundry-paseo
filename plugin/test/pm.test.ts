import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, parse, type Card, type ChatMessage } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { FoundryError } from "../server/core/model";
import { UPDATES_THREAD } from "../server/core/pm";
import { FakeHost, fixtureRepo, type Turn } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function setup() {
  const repo = fixtureRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, { home: "", tickMs: 0, loop: () => ({ maxFixRounds: 1, questionWindowMs: 50, checkTimeoutMs: 30_000 }) });
  foundry.requireSetup = async () => {};
  host.loop = foundry;
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  const quick = (title: string) => store.createIssue({ projectId: p.id, origin: "quick", title, status: "Ready" });
  host.behaviours.reviewer = (t) => void foundry.tasks.reportVerdict(t.agentId, { decision: "pass", reason: "ok" });
  const chat = (thread = "main") => store.all<ChatMessage>("SELECT * FROM chat WHERE project_id=? AND thread=? ORDER BY id", p.id, thread);
  const cards = () => store.all<Card>("SELECT * FROM cards ORDER BY id");
  return { repo, store, host, foundry, p, quick, chat, cards };
}

test("the PM answers in its thread from the board, one turn at a time, and links its sources", async () => {
  const { host, foundry, p, quick, chat, store } = await setup();
  quick("Add shout()");
  const first = gate();
  const seen: string[] = [];
  host.behaviours.pm = async (t: Turn) => {
    seen.push(t.text);
    if (t.n === 1) await first.p;
    const board = foundry.pm.board(t.agentId) as { key: string; status: string }[];
    t.reply(`${board.map((i) => `${i.key} is ${i.status}`).join("; ")}.`);
  };
  await foundry.pm.send(p.id, "Where are we?", "main", { issue: "SHT-1" });
  await foundry.pm.send(p.id, "And what's next?");
  first.open();
  await host.idle();

  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /You are Foundry's project manager for Shout/);
  assert.match(seen[0]!, /The developer \(looking at SHT-1\): Where are we\?/);
  assert.doesNotMatch(seen[0]!, /what's next/);
  assert.match(seen[1]!, /^The developer: And what's next\?$/);
  assert.deepEqual(chat().map((m) => [m.role, m.text]), [
    ["you", "Where are we?"],
    ["you", "And what's next?"],
    ["pm", "SHT-1 is Ready."],
    ["pm", "SHT-1 is Ready."],
  ]);
  // Its session runs on its own branch, cut from base.
  const ws = host.workspaces.get(parse<{ workspaceId: string }>(store.setting(`pm_ws:${p.id}`), { workspaceId: "" }).workspaceId)!;
  assert.equal(ws.branch, "foundry/pm/SHT");
  await assert.rejects(foundry.pm.send(p.id, "  "), code("MESSAGE_EMPTY"));
  await assert.rejects(foundry.pm.send(p.id, "hi", UPDATES_THREAD), code("THREAD_READ_ONLY"));
  assert.throws(() => foundry.pm.board("not-the-pm"), code("TOOL_REFUSED"));
});

test("triage posts a failed task to the Updates thread; the PM's retry touches no active work and applies at once", async () => {
  const { store, host, foundry, quick, chat, cards } = await setup();
  quick("Add shout()");
  let builds = 0;
  host.behaviours.builder = (t) => {
    if (++builds === 1) return "failed";
    t.write("done.txt", "ok\n");
  };
  let reply: unknown;
  host.behaviours.pm = async (t) => {
    if (!t.text.includes("Foundry triage")) return;
    reply = await foundry.pm.proposeActions(t.agentId, [{ action: "retry", issue: "SHT-1" }], "The builder crashed once; retry it.");
    t.reply("Retried SHT-1 (agent error on its first run).");
  };
  await foundry.startIssue("SHT-1");
  await host.idle();
  assert.equal(store.issue("SHT-1")!.status, "Failed");

  assert.deepEqual(await foundry.pm.triage(), { posted: 1 });
  await host.idle();
  const updates = chat(UPDATES_THREAD);
  assert.match(updates[0]!.text, /SHT-1 "Add shout\(\)": Failed \(AGENT_ERROR\), last outcome failed/);
  assert.match(updates[0]!.text, /<agent-data>\ndetail: builder turn failed\n<\/agent-data>/);
  assert.deepEqual((reply as { status: string }).status, "applied");
  const c = cards()[0]!;
  assert.equal([c.status, c.decided_by, c.thread].join(" "), "applied pm updates");
  assert.deepEqual(parse<string[]>(c.warnings, ["x"]), []);
  assert.equal(store.issue("SHT-1")!.status, "In_Review");
  assert.deepEqual(updates.map((m) => m.role).slice(1), ["card", "system", "pm"]);
  assert.ok(store.events({ issue: "SHT-1" }).some((e) => e.kind === "issue_status" && e.actor === "pm" && e.detail.includes('"to":"Ready"')));

  // The position is kept: nothing new, nothing posted.
  assert.deepEqual(await foundry.pm.triage(), { posted: 0 });
});

test("warn-first: cancelling a running task is a card that waits for your yes, then stops the run", async () => {
  const { store, host, foundry, p, quick, cards } = await setup();
  quick("Add shout()");
  quick("Add --shout");
  const building = gate();
  host.behaviours.builder = async (t) => {
    await building.p;
    t.write("done.txt", "ok\n");
  };
  host.behaviours.pm = async (t) => {
    await assert.rejects(
      foundry.pm.proposeActions(t.agentId, [{ action: "merge" as never, issue: "SHT-1" }], "x"),
      code("ACTION_NOT_ALLOWED"),
    );
    await foundry.pm.proposeActions(
      t.agentId,
      [
        { action: "cancel", issue: "SHT-1" },
        { action: "set_priority", issue: "SHT-2", priority: 90 },
      ],
      "Drop shout(); do the flag first.",
    );
    t.reply("I proposed a card: it cancels SHT-1, which is running, so it needs your yes.");
  };
  await foundry.startIssue("SHT-1");
  await foundry.pm.send(p.id, "Drop shout() and do the flag first");
  await until(() => cards().length === 1 && store.get<{ busy: number }>("SELECT busy FROM pm_threads")!.busy === 0);

  let c = cards()[0]!;
  assert.equal(c.status, "proposed");
  assert.match(parse<string[]>(c.warnings, [])[0]!, /SHT-1 is In_Progress with a run in progress: cancelling stops its work/);
  assert.equal(store.issue("SHT-1")!.status, "In_Progress");
  assert.equal(store.issue("SHT-2")!.priority, 50); // all or nothing: the safe action waits with the rest
  assert.ok(host.notifications.some((n) => n.key === `card:${c.id}`));

  const att = store.latestAttempt("SHT-1")!;
  const r = await foundry.pm.accept(c.id);
  assert.equal(r.status, "accepted");
  c = cards()[0]!;
  assert.equal([c.status, c.decided_by].join(" "), "accepted you");
  assert.equal(store.issue("SHT-1")!.status, "Cancelled");
  assert.equal(store.issue("SHT-2")!.priority, 90);
  assert.equal(store.attempt(att.id)!.flag, "CANCELLED");
  assert.ok(host.interrupted.includes(att.builder_agent_id!));
  await assert.rejects(foundry.pm.accept(c.id), code("CARD_CLOSED"));

  // The run's late turn end changes nothing, and triage ignores the cancellation.
  building.open();
  await host.idle();
  assert.equal(store.issue("SHT-1")!.status, "Cancelled");
  assert.deepEqual(await foundry.pm.triage(), { posted: 0 });
});

test("a card re-checks at your yes: work that moved on fails the card and changes nothing; a no changes nothing", async () => {
  const { store, host, foundry, p, quick, cards } = await setup();
  quick("Add shout()");
  quick("Add --shout");
  store.setIssueStatus("SHT-2", "Blocked", "system", "INFRA_ERROR");
  host.behaviours.builder = (t) => t.write("done.txt", "ok\n");
  let n = 0;
  host.behaviours.pm = async (t) => {
    n++;
    if (n === 1) await foundry.pm.proposeActions(t.agentId, [{ action: "cancel", issue: "SHT-1" }, { action: "set_priority", issue: "SHT-2", priority: 10 }], "Cancel SHT-1.");
    if (n === 2) await foundry.pm.proposeActions(t.agentId, [{ action: "cancel", issue: "SHT-2" }], "Cancel SHT-2 too.");
  };
  await foundry.startIssue("SHT-1");
  await host.idle();
  assert.equal(store.issue("SHT-1")!.status, "In_Review");
  await foundry.pm.send(p.id, "cancel SHT-1");
  await host.idle();
  const c1 = cards()[0]!;
  assert.equal(c1.status, "proposed"); // SHT-1 is In_Review: active work

  store.setIssueStatus("SHT-1", "Done", "you"); // accepted meanwhile
  const r = await foundry.pm.accept(c1.id);
  assert.equal(r.status, "failed");
  assert.match(String(parse<{ error: string }>(cards()[0]!.result, { error: "" }).error), /INVALID_TRANSITION: SHT-1 is Done/);
  assert.equal(store.issue("SHT-2")!.priority, 50);

  // SHT-2 is Blocked, not active work: the PM's cancel applies at once.
  await foundry.pm.send(p.id, "cancel SHT-2 too");
  await host.idle();
  assert.equal(store.issue("SHT-2")!.status, "Cancelled");
  assert.equal(cards()[1]!.status, "applied");

  const t3 = store.createIssue({ projectId: p.id, origin: "quick", title: "x", status: "Backlog" });
  store.run("INSERT INTO cards(project_id,kind,actions,reason,warnings) VALUES(?,?,?,?,?)", p.id, "actions", JSON.stringify([{ action: "cancel", issue: t3.key }]), "r", "[]");
  const id = cards()[2]!.id;
  assert.equal(foundry.pm.reject(id).status, "rejected");
  assert.equal(store.issue(t3.key)!.status, "Backlog");
});

test("after a restart, a thread whose turn was cut off gets its messages again in a fresh session", async () => {
  const { store, host, foundry, p, chat } = await setup();
  const cut = gate();
  host.behaviours.pm = async (t) => {
    if (t.n === 1 && !t.text.includes("again")) await cut.p; // never finishes: the daemon died
    t.reply("Here's where we are.");
  };
  await foundry.pm.send(p.id, "Where are we?");
  const before = store.get<{ agent_id: string }>("SELECT agent_id FROM pm_threads WHERE project_id=?", p.id)!.agent_id;
  host.behaviours.pm = (t) => {
    assert.match(t.text, /Where are we\?/);
    t.reply("Here's where we are, again.");
  };
  await foundry.pm.recover();
  await until(() => chat().some((m) => m.role === "pm"));
  const after = store.get<{ agent_id: string }>("SELECT agent_id FROM pm_threads WHERE project_id=?", p.id)!.agent_id;
  assert.notEqual(after, before);
  assert.deepEqual(chat().map((m) => m.role), ["you", "pm"]);
  cut.open();
});
