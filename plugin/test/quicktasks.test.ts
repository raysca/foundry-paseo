// Task Flows, part 5: quick tasks end to end (own branch from base, reviewed, shipped as their own PR or
// merged into base), discovered work landing in Backlog, and follow-ups queued for a running task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, parse } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { FoundryError } from "../server/core/model";
import { FakeHost, fixtureRepo, run, type Behaviour } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;
const FAKE_GH = readFileSync(join(__dirname, "../../e2e/fake-gh/gh"), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function setup(o: { remote?: boolean; builder?: Behaviour } = {}) {
  const repo = fixtureRepo();
  const gh = o.remote ? fakeGitHub(repo) : null;
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, { home: "", tickMs: 0, loop: () => ({ maxFixRounds: 2, questionWindowMs: 50, checkTimeoutMs: 30_000, planningTimeoutMs: 0 }) });
  foundry.requireSetup = async () => {};
  host.loop = foundry;
  host.behaviours.builder = o.builder ?? ((t) => t.write("done.txt", "ok\n"));
  host.behaviours.reviewer = (t) => void foundry.tasks.reportVerdict(t.agentId, { decision: "pass", reason: "ok" });
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  if (!o.remote) store.setShipMode(p.id, "local_merge");
  const shas = (key: string) => {
    const a = store.latestAttempt(key)!;
    return [a.head_sha!, a.tree_sha!] as const;
  };
  return { repo, gh, store, host, foundry, p, shas };
}

test("a quick task builds on its own branch from base and ships as its own PR; merged moves it to Done", async () => {
  const { repo, gh, store, host, foundry, p, shas } = await setup({ remote: true });
  await assert.rejects(foundry.quick.create({ projectId: p.id, title: "  " }), code("TITLE_REQUIRED"));
  await assert.rejects(foundry.quick.create({ projectId: p.id, title: "x", loop: "mobile" }), code("LOOP_MISSING"));
  const i = await foundry.quick.create({ projectId: p.id, title: "Fix the --help typo", description: "It says shuot.", start: true });
  assert.equal([i.origin, i.feature_id].join(), "quick,");
  await host.idle();
  assert.equal(store.issue(i.key)!.status, "In_Review");
  const a = store.latestAttempt(i.key)!;
  assert.equal(run(repo, "git", "merge-base", a.head_sha!, "main"), run(repo, "git", "rev-parse", "main"), "branched from base");
  const review = await foundry.tasks.review(i.key);
  assert.match(review.diff, /done\.txt/, "the review diff is against base");

  const r = (await foundry.accept(i.key, ...shas(i.key))) as { pr: { number: number; url: string } };
  assert.equal(r.pr.number, 1);
  const pr = gh!.read().prs[0]!;
  assert.deepEqual([pr.base, pr.head, pr.title], ["main", a.branch, `${i.key}: Fix the --help typo`]);
  assert.match(pr.body, /It says shuot[\s\S]*✅ test[\s\S]*quick task/);
  assert.equal(run(gh!.remote, "git", "rev-parse", a.branch), a.head_sha, "the branch is pushed");
  assert.equal(store.issue(i.key)!.status, "In_Review", "it waits for the PR");
  await assert.rejects(foundry.accept(i.key, ...shas(i.key)), code("PR_OPEN"));
  assert.deepEqual(await foundry.quick.refreshPrs(), [{ issue: i.key, result: "open" }]);

  gh!.set(1, "MERGED");
  assert.deepEqual(await foundry.quick.refreshPrs(), [{ issue: i.key, result: "merged" }]);
  assert.equal(store.issue(i.key)!.status, "Done");
  assert.equal(foundry.quick.shipped(i.key), null);
  assert.ok(host.archived.includes(a.workspace_id!), "its workspace is archived");
});

test("a closed PR puts it back to accept again; without a remote a quick task merges into base", async () => {
  const pr = await setup({ remote: true });
  const i = await pr.foundry.quick.create({ projectId: pr.p.id, title: "Tidy", start: true });
  await pr.host.idle();
  await pr.foundry.accept(i.key, ...pr.shas(i.key));
  pr.gh!.set(1, "CLOSED");
  assert.deepEqual(await pr.foundry.quick.refreshPrs(), [{ issue: i.key, result: "closed" }]);
  assert.equal(pr.store.issue(i.key)!.status, "In_Review");
  assert.ok(pr.host.notifications.some((n) => n.key === `pr-closed:${i.key}`));
  const again = (await pr.foundry.accept(i.key, ...pr.shas(i.key))) as { pr: { number: number } };
  assert.equal(again.pr.number, 2, "a new PR");

  const local = await setup();
  const j = await local.foundry.quick.create({ projectId: local.p.id, title: "Tidy", start: true });
  await local.host.idle();
  // main is checked out in the developer's own checkout: merging there needs your yes.
  await assert.rejects(local.foundry.accept(j.key, ...local.shas(j.key)), code("BASE_CHECKED_OUT"));
  const r = (await local.foundry.accept(j.key, ...local.shas(j.key), "you", "", { confirmCheckedOut: true })) as { merged: string };
  assert.equal(local.store.issue(j.key)!.status, "Done");
  assert.equal(run(local.repo, "git", "rev-parse", "main"), r.merged);
  assert.equal(run(local.repo, "git", "show", "main:done.txt"), "ok");
});

test("discovered work lands in Backlog, never auto-starts, and you start or drop it", async () => {
  let reported: any;
  const { store, host, foundry, p } = await setup({
    builder: (t) => {
      t.write("done.txt", "ok\n");
      if (t.n === 1 && !reported) {
        reported = foundry.quick.discover(t.agentId, { title: "check.sh ignores errors", description: "It doesn't set -e.", why: "A failing step can pass." });
        foundry.quick.discover(t.agentId, { title: "check.sh ignores errors", description: "again" });
      }
    },
  });
  const i = await foundry.quick.create({ projectId: p.id, title: "Tidy", start: true });
  await host.idle();
  const d = store.issue(reported.key)!;
  assert.deepEqual([d.origin, d.status, d.found_in, d.feature_id], ["discovered", "Backlog", i.key, null]);
  assert.match(d.description, /doesn't set -e[\s\S]*Why it matters: A failing step can pass[\s\S]*Found by the builder of SHT-1/);
  assert.equal(store.issues({}).filter((x) => x.origin === "discovered").length, 1, "the same report twice is one task");
  assert.ok(host.notifications.some((n) => n.key === `discovered:${d.key}`));
  await foundry.tick();
  assert.equal(store.issue(d.key)!.status, "Backlog", "never started on its own");
  assert.throws(() => foundry.quick.discover("nobody", { title: "x", description: "y" }), code("TOOL_REFUSED"));
  await foundry.startIssue(d.key);
  await host.idle();
  assert.equal(store.issue(d.key)!.status, "In_Review");
  // The PM creates quick tasks into Backlog.
  const pm = await foundry.quick.create({ projectId: p.id, title: "Bump deps" }, "pm");
  assert.equal(pm.status, "Backlog");
});

test("follow-ups wait for a running task's next turn, can be taken back, and reach the builder", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { store, host, foundry, p, shas } = await setup({
    builder: async (t) => {
      if (t.n === 1) await gate;
      t.write("done.txt", "ok\n");
    },
  });
  const i = await foundry.quick.create({ projectId: p.id, title: "Tidy", start: true });
  await sleep(20);
  const one = (await foundry.tasks.followUp(i.key, "Also update the README")) as { queued: number };
  const two = (await foundry.tasks.followUp(i.key, "Never mind the changelog")) as { queued: number };
  foundry.tasks.cancelFollowUp(two.queued);
  assert.throws(() => foundry.tasks.cancelFollowUp(two.queued), code("FOLLOWUP_SENT"));
  assert.deepEqual(foundry.tasks.queuedFollowUps(i.key).map((x) => x.text), ["Also update the README"]);
  release();
  await host.idle();
  // It would have stopped for review, but a follow-up was waiting: its builder took it in a new turn.
  const a = store.latestAttempt(i.key)!;
  const msgs = host.agents.get(a.builder_agent_id!)!.messages;
  assert.equal(msgs.length, 2);
  assert.match(msgs[1]!, /also left a message[\s\S]*- Also update the README/);
  assert.doesNotMatch(msgs[1]!, /changelog/);
  assert.equal(store.get<{ status: string; attempt_id: number }>("SELECT status, attempt_id FROM followups WHERE id=?", one.queued)!.status, "sent");
  assert.equal(store.issue(i.key)!.status, "In_Review");
  assert.equal(foundry.tasks.queuedFollowUps(i.key).length, 0);
  // An idle task: a follow-up starts a new turn at once, as before.
  const r = await foundry.tasks.followUp(i.key, "One more thing");
  assert.ok("id" in (r as object));
  await host.idle();
  void shas;
  void parse;
});
