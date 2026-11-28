// Reviewing a doc: comments on lines (saved, then sent with a revision request), the PM's own comments,
// and the list of revisions with the diff between any two.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Locks } from "../server/core/locks";
import { TaskLoop } from "../server/core/taskloop";
import { Planning } from "../server/core/planning";
import { FoundryError } from "../server/core/model";
import { FakeHost, fixtureRepo, type Turn } from "./fake-host";

const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;
const REQS = [{ ref: "R1", title: "Shout", acceptance_criteria: ["WHEN shout is called THE library SHALL return the text upper-cased with !"] }];

async function setup() {
  const repo = fixtureRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const locks = new Locks();
  const loop = new TaskLoop(store, host, locks, { maxFixRounds: 2, questionWindowMs: 50, checkTimeoutMs: 30_000 });
  const planning = new Planning(store, host, locks, { questionWindowMs: 50, turnTimeoutMs: 0 }, async () => {}, () => loop.tick());
  host.loop = { onTurnEnd: (id, o, t) => (store.agent(id)?.role === "planner" ? planning.onTurnEnd(id, o, t) : loop.onTurnEnd(id, o, t)) };
  const turns: string[] = [];
  let version = 0;
  const dirOf = (t: Turn) => /Write only under (\S+)\//.exec(host.agents.get(t.agentId)!.messages[0]!)![1]!;
  host.behaviours.planner = async (t) => {
    turns.push(t.text);
    const dir = dirOf(t);
    if (t.text.includes("Step 2") || t.text.includes("revision of the spec")) {
      version++;
      t.write(`${dir}/spec.md`, `# Spec v${version}\n\n## Goal\nShout.\n\n## Requirements\n\nR1\n`);
      planning.proposeRequirements(t.agentId, REQS);
      // The PM flags a clash on the Goal line, and replies to a comment it finds unclear.
      if (version === 1) await planning.pmComment(t.agentId, "spec", 4, "Clashes with SHT-9, which also changes output casing.");
      if (t.text.includes("whatever")) await planning.pmComment(t.agentId, "spec", 3, "Not sure what you mean here; keep the Goal as is?");
    }
  };
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  const f = await planning.createFeature({ projectId: p.id, idea: "Shout mode" });
  await host.idle();
  return { store, host, planning, f, turns };
}

test("comments on lines are saved, sent with a revision request, and refused once sent or stale", async () => {
  const { store, host, planning, f, turns } = await setup();
  const pmc = store.comments(f.id, "spec");
  assert.equal(pmc.length, 1);
  assert.equal(pmc[0]!.author, "pm");
  assert.equal(pmc[0]!.quote, "Shout.");
  assert.ok(store.events().some((e) => e.kind === "pm_commented"));

  const sha = store.doc(f.id, "spec")!.head_sha!;
  await assert.rejects(planning.comment(f.id, "spec", "0".repeat(40), 1, "x"), code("STALE_REVIEW"));
  await assert.rejects(planning.comment(f.id, "spec", sha, 99, "x"), code("LINE_INVALID"));
  await assert.rejects(planning.comment(f.id, "spec", sha, 1, "  "), code("FEEDBACK_REQUIRED"));
  const c1 = await planning.comment(f.id, "spec", sha, 1, "Call it Shout mode, not Spec.");
  const c2 = await planning.comment(f.id, "spec", sha, 3, "whatever");
  const c3 = await planning.comment(f.id, "spec", sha, 4, "Drop this one.");
  assert.equal(c1.status, "saved");
  assert.equal(c1.quote, "# Spec v1");
  planning.deleteComment(c3.id);
  assert.equal(store.comment(c3.id), undefined);

  await assert.rejects(planning.revise(f.id, "spec", ""), code("FEEDBACK_REQUIRED"));
  await assert.rejects(planning.revise(f.id, "plan", "", "you", [c1.id]), code("NOT_FOUND"), "a spec comment can't go with a plan revision");
  const r = await planning.revise(f.id, "spec", "", "you", [c1.id, c2.id]);
  assert.deepEqual(r.sent, [c1.id, c2.id]);
  await host.idle();
  const msg = turns.at(-1)!;
  assert.match(msg, /line 1 \("# Spec v1"\): Call it Shout mode, not Spec\./);
  assert.match(msg, /line 3 \("## Goal"\): whatever/);
  assert.match(msg, /reply to it with comment_on_doc/);
  assert.equal(store.comment(c1.id)!.status, "sent");
  assert.throws(() => planning.deleteComment(c1.id), code("COMMENT_SENT"));
  await assert.rejects(planning.revise(f.id, "spec", "", "you", [c1.id]), code("COMMENT_SENT"));
  const replies = store.comments(f.id, "spec").filter((c) => c.author === "pm");
  assert.equal(replies.length, 2, "the PM replied to the unclear comment with its own");
});

test("the doc lists its revisions and diffs any two; unknown SHAs are refused", async () => {
  const { store, host, planning, f } = await setup();
  await planning.revise(f.id, "spec", "Bump it.");
  await host.idle();
  const revs = await planning.revisions(f.id, "spec");
  assert.equal(revs.length, 2);
  assert.ok(revs[0]!.head);
  assert.equal(revs[0]!.author, "Foundry PM");
  const d = await planning.docDiff(f.id, "spec", revs[1]!.sha, revs[0]!.sha);
  assert.match(d.diff, /-# Spec v1/);
  assert.match(d.diff, /\+# Spec v2/);
  await assert.rejects(planning.docDiff(f.id, "spec", "0".repeat(40), revs[0]!.sha), code("NOT_FOUND"));
  assert.equal(store.doc(f.id, "spec")!.head_sha, revs[0]!.sha);
});
