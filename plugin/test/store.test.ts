import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, SCHEMA_VERSION, parse } from "../server/core/store";
import { FoundryError } from "../server/core/model";

const mem = () => new Store(":memory:");

test("a fresh store migrates to the current schema, and reopening is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-store-"));
  const s1 = new Store(join(dir, "f.db"));
  s1.createProject({ key: "SHT", name: "Shout", repo: "/r", baseRef: "main" });
  s1.close();
  const s2 = new Store(join(dir, "f.db"));
  assert.equal(s2.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'")!.value, String(SCHEMA_VERSION));
  assert.equal(s2.projects().length, 1);
  s2.close();
});

test("project keys are 2 to 5 capital letters and unique", () => {
  const s = mem();
  assert.throws(() => s.createProject({ key: "sh", name: "x", repo: "/a", baseRef: "main" }), (e: FoundryError) => e.code === "INVALID_KEY");
  s.createProject({ key: "SHT", name: "x", repo: "/a", baseRef: "main" });
  assert.throws(() => s.createProject({ key: "SHT", name: "y", repo: "/b", baseRef: "main" }), (e: FoundryError) => e.code === "KEY_TAKEN");
});

test("issue keys count up per project", () => {
  const s = mem();
  const p = s.createProject({ key: "SHT", name: "x", repo: "/a", baseRef: "main" });
  const a = s.createIssue({ projectId: p.id, origin: "quick", title: "A", status: "Ready" });
  const b = s.createIssue({ projectId: p.id, origin: "quick", title: "B", status: "Backlog" });
  assert.equal(a.key, "SHT-1");
  assert.equal(b.key, "SHT-2");
});

test("a feature is created with its three docs in drafting", () => {
  const s = mem();
  const p = s.createProject({ key: "SHT", name: "x", repo: "/a", baseRef: "main" });
  const f = s.createFeature({ projectId: p.id, slug: "shout-mode", title: "Shout mode", idea: "...", flow: "standard", branch: "foundry/feature/shout-mode" });
  assert.equal(f.stage, "clarify");
  assert.equal(f.status, "active");
  assert.deepEqual(s.docs(f.id).map((d) => [d.kind, d.status]), [["plan", "drafting"], ["spec", "drafting"], ["tasks", "drafting"]]);
});

test("status changes go through the transition rules and are recorded with their actor", () => {
  const s = mem();
  const p = s.createProject({ key: "SHT", name: "x", repo: "/a", baseRef: "main" });
  const i = s.createIssue({ projectId: p.id, origin: "quick", title: "A", status: "Ready" });
  s.setIssueStatus(i.key, "In_Progress", "system");
  assert.throws(() => s.setIssueStatus(i.key, "Done", "you"), (e: FoundryError) => e.code === "INVALID_TRANSITION");
  s.setIssueStatus(i.key, "In_Review", "system");
  s.setIssueStatus(i.key, "Done", "you");
  const changes = s.events({ issue: i.key }).filter((e) => e.kind === "issue_status").map((e) => [e.actor, parse<{ to: string }>(e.detail, { to: "" }).to]);
  assert.deepEqual(changes, [["system", "In_Progress"], ["system", "In_Review"], ["you", "Done"]]);
});

test("a transaction is all or nothing", () => {
  const s = mem();
  const p = s.createProject({ key: "SHT", name: "x", repo: "/a", baseRef: "main" });
  assert.throws(() =>
    s.tx(() => {
      s.createIssue({ projectId: p.id, origin: "quick", title: "A", status: "Ready" });
      throw new Error("boom");
    }),
  );
  assert.equal(s.issues().length, 0);
  assert.equal(s.project(p.id)!.next_issue_n, 1);
});

test("attempts number per issue and carry their frozen loop", () => {
  const s = mem();
  const p = s.createProject({ key: "SHT", name: "x", repo: "/a", baseRef: "main" });
  const i = s.createIssue({ projectId: p.id, origin: "quick", title: "A", status: "Ready" });
  const a1 = s.createAttempt(i.key, "foundry/task/SHT-1/{n}", { name: "backend" });
  const a2 = s.createAttempt(i.key, "foundry/task/SHT-1/{n}", { name: "backend" });
  assert.equal(a1.n, 1);
  assert.equal(a2.n, 2);
  assert.equal(a2.branch, "foundry/task/SHT-1/2");
  assert.deepEqual(parse(a2.loop, null), { name: "backend" });
  assert.equal(s.latestAttempt(i.key)!.id, a2.id);
});

test("event mirroring never breaks the write path", () => {
  const s = mem();
  const seen: string[] = [];
  s.onEvent = (row) => {
    seen.push(row.kind);
    throw new Error("mirror failed");
  };
  s.event("hello", { detail: { a: 1 } });
  assert.deepEqual(seen, ["hello"]);
  assert.equal(s.events().at(-1)!.kind, "hello");
});

test("owned paths cover integration checkouts and live check checkouts", () => {
  const s = mem();
  const p = s.createProject({ key: "SHT", name: "x", repo: "/a", baseRef: "main" });
  const f = s.createFeature({ projectId: p.id, slug: "x", title: "X", idea: "...", flow: "standard", branch: "b" });
  s.updateFeature(f.id, { integration_path: "/wt/int" });
  const i = s.createIssue({ projectId: p.id, origin: "quick", title: "A", status: "Ready" });
  const a = s.createAttempt(i.key, "t/{n}", null);
  s.updateAttempt(a.id, { check_path: "/wt/check" });
  assert.deepEqual(s.ownedPaths().sort(), ["/wt/check", "/wt/int"]);
  s.updateAttempt(a.id, { ended_at: new Date().toISOString() });
  assert.deepEqual(s.ownedPaths(), ["/wt/int"]);
});
