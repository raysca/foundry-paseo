import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { FoundryError } from "../server/core/model";
import { git } from "../server/core/git";
import { FakeHost, fixtureRepo } from "./fake-host";

const roles = ["builder", "reviewer", "planner", "pm"] as const;

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "foundry-uninstall-"));
  const store = new Store(join(home, "foundry.db"));
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, { home, tickMs: 0, loop: () => ({ maxFixRounds: 1, questionWindowMs: 50, checkTimeoutMs: 30_000 }) });
  host.profiles.push({ id: "mine", name: "Mine", provider: "codex", model: "gpt" });
  // The user made foundry-pm by hand; Foundry adds the other three.
  host.profiles.push({ id: "foundry-pm", name: "PM", provider: "foundry-claude", model: "hand-made" });
  await foundry.createProfiles(roles.map((role) => ({ role, harness: "claude", model: "m" })));
  return { home, store, host, foundry };
}

test("leftovers name Foundry's workspaces, its own profiles (edited or not), its providers, foundry/* branches and the data folder", async () => {
  const { home, store, host, foundry } = await setup();
  const repo = fixtureRepo();
  await git(repo, "branch", "foundry/feature/x");
  await git(repo, "branch", "other");
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  store.setSetting(`pm_ws:${p.id}`, JSON.stringify({ workspaceId: "ws-pm" }));
  host.profiles.find((x) => x.id === "foundry-reviewer")!.model = "changed-by-you";
  const l = await foundry.leftovers();
  assert.deepEqual(l.workspaces, ["ws-pm"]);
  assert.deepEqual(
    l.profiles.map((x) => [x.id, x.state]),
    [["foundry-builder", "unedited"], ["foundry-planner", "unedited"], ["foundry-reviewer", "edited"]],
    "foundry-pm was the user's, so it isn't Foundry's to list",
  );
  assert.deepEqual(l.providers, ["foundry-claude"]);
  assert.deepEqual(l.branches, [{ project: "SHT", repo, branches: ["foundry/feature/x"] }]);
  assert.equal(l.data.home, home);
  assert.ok(l.data.files.some((f) => f.name === "foundry.db"));
});

test("removing Foundry's profiles takes only unedited ones it created, and refuses edited ones", async () => {
  const { host, foundry, store } = await setup();
  host.profiles.find((x) => x.id === "foundry-reviewer")!.model = "changed-by-you";
  await assert.rejects(foundry.removeOwnProfiles(["foundry-builder", "foundry-reviewer"]), (e) => e instanceof FoundryError && e.code === "PROFILE_EDITED");
  assert.equal(host.profiles.length, 5, "a refused removal removes nothing");
  const r = await foundry.removeOwnProfiles(["foundry-builder", "foundry-planner", "foundry-pm", "mine"]);
  assert.deepEqual(r.removed, ["foundry-builder", "foundry-planner"]);
  assert.deepEqual(host.profiles.map((x) => x.id), ["mine", "foundry-pm", "foundry-reviewer"]);
  assert.deepEqual(store.owned().map((o) => o.id), ["foundry-reviewer", "foundry-claude"]);
});

test("stopping all work archives every Foundry workspace and reports failures", async () => {
  const { store, host, foundry } = await setup();
  const p = store.createProject({ key: "SHT", name: "Shout", repo: fixtureRepo(), baseRef: "main" });
  store.setSetting(`pm_ws:${p.id}`, JSON.stringify({ workspaceId: "ws-pm" }));
  store.run("INSERT INTO agents(agent_id, role, workspace_id) VALUES('a1','builder','ws-task')");
  host.archiveWorkspace = async (id: string) => {
    if (id === "ws-task") throw new Error("gone");
  };
  const r = await foundry.stopAllWork();
  assert.deepEqual(r, { archived: ["ws-pm"], failed: ["ws-task"] });
});
