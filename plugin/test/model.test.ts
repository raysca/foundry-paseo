import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedMoves, assertTransition, featureBucket, FoundryError } from "../server/core/model";

test("direct moves on the board are only the spec's four", () => {
  assert.deepEqual(allowedMoves("Backlog", "you").sort(), ["Cancelled", "Ready"]);
  assert.deepEqual(allowedMoves("Ready", "you").sort(), ["Backlog", "Cancelled", "In_Progress"]);
  assert.deepEqual(allowedMoves("Failed", "you").sort(), ["Cancelled", "In_Progress", "Ready"]);
  assert.deepEqual(allowedMoves("Done", "you"), []);
  assert.deepEqual(allowedMoves("Cancelled", "system"), []);
});

test("only the system moves a running issue to review or failed", () => {
  assert.ok(allowedMoves("In_Progress", "system").includes("In_Review"));
  assert.ok(!allowedMoves("In_Progress", "you").includes("In_Review"));
  assert.ok(!allowedMoves("In_Progress", "pm").includes("Failed"));
});

test("an invalid transition names the current status and the allowed ones", () => {
  try {
    assertTransition("Done", "Ready", "you");
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof FoundryError);
    assert.equal(e.code, "INVALID_TRANSITION");
    assert.equal(e.detail.current, "Done");
    assert.deepEqual(e.detail.allowed, []);
  }
});

test("features fall into the overview's buckets", () => {
  assert.equal(featureBucket("clarify", false, false), "pending");
  assert.equal(featureBucket("tasks", false, false), "pending");
  assert.equal(featureBucket("build", false, true), "in_progress");
  assert.equal(featureBucket("spec", true, true), "in_progress");
  assert.equal(featureBucket("spec", true, false), "pending");
  assert.equal(featureBucket("done", false, true), "completed");
});
