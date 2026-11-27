import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmpVersion, Install } from "../server/core/install";
import { VERSION, type Change } from "../shared/changes";
import { readFileSync } from "node:fs";
import { Store } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { FoundryError } from "../server/core/model";
import { FakeHost, fixtureRepo } from "./fake-host";

const CH: Change[] = [
  { version: "0.3.0", notes: ["merges ask first"], gate: { id: "merge-asks", text: "Ship now asks before merging.", actions: ["feature.accept_ship"] } },
  { version: "0.2.0", notes: ["wizard"] },
  { version: "0.1.0", notes: ["m1"] },
];
const code = (c: string) => (e: unknown) => e instanceof FoundryError && e.code === c;

test("versions compare numerically", () => {
  assert.equal(cmpVersion("0.10.0", "0.9.1"), 1);
  assert.equal(cmpVersion("1.0", "1.0.0"), 0);
  assert.equal(cmpVersion("0.2.0", "0.3.0"), -1);
});

test("a fresh install is recorded once, shows no What's new and no gates", () => {
  const store = new Store(":memory:");
  const i = new Install(store, "0.3.0", CH);
  assert.equal(i.onStart().kind, "installed");
  assert.equal(i.onStart().kind, "same");
  const st = i.status();
  assert.equal(st.installed_version, "0.3.0");
  assert.equal(st.welcome_dismissed, false);
  assert.deepEqual(st.whats_new, []);
  assert.deepEqual(st.gates, []);
  i.requireGates("feature.accept_ship");
  assert.equal(store.events({ limit: 10 }).filter((e: any) => e.kind === "plugin_installed").length, 1);
});

test("an update shows What's new once and gates the changed action until Got it", () => {
  const store = new Store(":memory:");
  new Install(store, "0.2.0", CH).onStart();
  const i = new Install(store, "0.3.0", CH);
  assert.deepEqual(i.onStart(), { kind: "updated", from: "0.2.0" });
  assert.deepEqual(i.status().whats_new.map((c) => c.version), ["0.3.0"]);
  assert.throws(() => i.requireGates("feature.accept_ship"), code("ACK_REQUIRED"));
  i.requireGates("issue.start");
  i.ackWhatsNew();
  assert.deepEqual(i.status().whats_new, []);
  assert.throws(() => i.requireGates("feature.accept_ship"), code("ACK_REQUIRED"), "dismissing What's new doesn't acknowledge a gate");
  i.ackGate("merge-asks");
  i.requireGates("feature.accept_ship");
  assert.throws(() => i.ackGate("nope"), code("NOT_FOUND"));
  assert.equal(store.events({ limit: 20 }).filter((e: any) => e.kind === "plugin_updated").length, 1);
});

test("a database from before install tracking counts as an update, with every change shown", () => {
  const store = new Store(":memory:");
  store.createProject({ key: "OLD", name: "Old", repo: "/tmp/old", baseRef: "main" });
  const i = new Install(store, "0.2.0", CH);
  assert.equal(i.onStart().kind, "updated");
  const st = i.status();
  assert.equal(st.welcome_dismissed, true, "an existing user isn't walked through the welcome again");
  assert.deepEqual(st.whats_new.map((c) => c.version), ["0.2.0", "0.1.0"]);
});

test("dev reset archives Foundry's workspaces, removes foundry-* profiles only, backs up and empties the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-reset-"));
  const store = new Store(join(dir, "foundry.db"));
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, { home: dir, tickMs: 0, loop: () => ({ maxFixRounds: 1, questionWindowMs: 50, checkTimeoutMs: 30_000 }) });
  new Install(store, "0.2.0", CH).onStart();
  host.profiles.push({ id: "mine", name: "Mine", provider: "codex" });
  await foundry.createProfiles((["builder", "reviewer", "planner", "pm"] as const).map((role) => ({ role, harness: "claude", model: "m" })));
  const p = store.createProject({ key: "SHT", name: "Shout", repo: fixtureRepo(), baseRef: "main" });
  store.setSetting(`pm_ws:${p.id}`, JSON.stringify({ workspaceId: "ws-pm", path: "/x" }));
  const archived: string[] = [];
  host.archiveWorkspace = async (id: string) => void archived.push(id);

  const plan = await foundry.devResetPlan();
  assert.deepEqual(plan.workspaces, ["ws-pm"]);
  const backup = join(dir, "backup.db");
  const r = await foundry.devReset(backup);
  assert.deepEqual(archived, ["ws-pm"]);
  assert.deepEqual(r.removed.sort(), ["foundry-builder", "foundry-planner", "foundry-pm", "foundry-reviewer"]);
  assert.deepEqual(host.profiles.map((x) => x.id), ["mine"]);
  assert.ok(existsSync(backup));
  assert.equal(store.projects().length, 0);
  assert.equal(store.owned().length, 0);
  // The next load is a first install again.
  assert.equal(new Install(store, "0.2.0", CH).onStart().kind, "installed");
});

test("package.json and the changelog name the same version", () => {
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, VERSION);
});
