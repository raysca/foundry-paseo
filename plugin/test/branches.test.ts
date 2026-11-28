import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { ensureIntegration } from "../server/core/features";
import { git } from "../server/core/git";
import { FakeHost, fixtureRepo } from "./fake-host";

function setup() {
  const repo = fixtureRepo();
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, { home: "", tickMs: 0, loop: () => ({ maxFixRounds: 1, questionWindowMs: 50, checkTimeoutMs: 30_000 }) });
  foundry.requireSetup = async () => {};
  host.loop = foundry;
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  return { repo, store, host, foundry, p };
}

test("a new feature's branch is named by the host from its slug, unique in the repo, and recorded", async () => {
  const { repo, store, host, p } = setup();
  await git(repo, "branch", "taken");
  const a = store.createFeature({ projectId: p.id, slug: "shout-mode", title: "Shout mode", idea: "x", flow: "standard", branch: "" });
  const b = store.createFeature({ projectId: p.id, slug: "taken", title: "Taken", idea: "x", flow: "standard", branch: "" });
  const fa = await ensureIntegration(store, host, a.id);
  const fb = await ensureIntegration(store, host, b.id);
  assert.equal(fa.branch, "shout-mode");
  assert.equal(fb.branch, "taken-2", "a name already in the repo gets a suffix, never the user's branch");
  assert.equal(host.workspaces.get(fa.integration_workspace_id!)!.branch, "shout-mode");
  assert.deepEqual(store.branchesMade(repo), ["shout-mode", "taken-2"]);
});

test("a feature from before keeps its foundry/feature branch and checks it out", async () => {
  const { repo, store, host, p } = setup();
  await git(repo, "branch", "foundry/feature/old", "main");
  const f = store.createFeature({ projectId: p.id, slug: "old", title: "Old", idea: "x", flow: "standard", branch: "foundry/feature/old" });
  const r = await ensureIntegration(store, host, f.id);
  assert.equal(r.branch, "foundry/feature/old");
  assert.ok(store.branchesMade(repo).includes("foundry/feature/old"));
});

test("a task's branch is named from its issue key and recorded on the attempt", async () => {
  const { repo, store, foundry, p } = setup();
  const i = store.createIssue({ projectId: p.id, origin: "quick", title: "Add flag", status: "Ready" });
  const a = (await foundry.tasks.start(i.key, "you"))!;
  assert.equal(a.branch, "sht-1");
  assert.equal((await git(a.worktree_path!, "rev-parse", "--abbrev-ref", "HEAD")).trim(), "sht-1");
  assert.ok(store.branchesMade(repo).includes("sht-1"));
  const l = await foundry.leftovers();
  assert.ok(l.branches[0]!.branches.includes("sht-1"), "the uninstall list shows the branches Foundry made");
});
