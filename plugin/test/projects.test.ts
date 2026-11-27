import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Store } from "../server/core/store";
import { adoptRepo, suggestKey } from "../server/core/projects";
import { fixtureRepo, run } from "./fake-host";

test("project keys come from the name and stay unique", () => {
  assert.equal(suggestKey("shout-cli", new Set()), "SC");
  assert.equal(suggestKey("paseo", new Set()), "PAS");
  assert.equal(suggestKey("foundryPaseo", new Set()), "FP");
  assert.equal(suggestKey("shout-cli", new Set(["SC"])), "SHO");
  assert.match(suggestKey("123", new Set()), /^[A-Z]{2,5}$/);
  assert.match(suggestKey("paseo", new Set(["PAS", "PASE", "PASEO"])), /^[A-Z]{2,5}$/);
});

test("adopting a repo creates the project once, with its default branch, and finds it again", async () => {
  const repo = fixtureRepo();
  run(repo, "git", "checkout", "-q", "-b", "trunk");
  const store = new Store(":memory:");
  const a = await adoptRepo(store, { repo, name: "shout-cli" });
  assert.equal(a.created, true);
  assert.equal(a.key, "SC");
  assert.equal(a.base_ref, "trunk", "the checked-out branch when there is no origin HEAD");
  const b = await adoptRepo(store, { repo: join(repo, "."), name: "other" });
  assert.equal(b.created, false);
  assert.equal(b.id, a.id);
  await assert.rejects(adoptRepo(store, { repo: "/nonexistent-dir-xyz" }), (e: any) => e.code === "NOT_A_REPO");
});
