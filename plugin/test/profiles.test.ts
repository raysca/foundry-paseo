import { test } from "node:test";
import assert from "node:assert/strict";
import { missingProfilesPatch } from "../server/adapter/profiles";
import { checkSetup, PASEO_ORCHESTRATION_TOOLS, setupReady } from "../server/core/setup";
import { Store } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { FakeHost } from "./fake-host";

const o = { harness: "claude", workModel: "claude-sonnet-5-5", pmModel: "claude-opus-5-5" };

test("onboarding adds every Foundry profile and a provider that hides Paseo's orchestration tools", () => {
  const { patch, added } = missingProfilesPatch({ providers: { claude: {} }, agentProfiles: [] }, o);
  assert.deepEqual(Object.keys(patch.providers as object), ["foundry-claude"]);
  const prov = (patch.providers as any)["foundry-claude"];
  assert.equal(prov.extends, "claude");
  for (const t of PASEO_ORCHESTRATION_TOOLS) assert.ok(prov.paseoTools.disabledTools.includes(t), t);
  const profiles = patch.agentProfiles as any[];
  assert.deepEqual(profiles.map((p) => [p.id, p.model]), [
    ["foundry-builder", "claude-sonnet-5-5"],
    ["foundry-reviewer", "claude-sonnet-5-5"],
    ["foundry-planner", "claude-opus-5-5"],
    ["foundry-pm", "claude-opus-5-5"],
  ]);
  assert.equal(added.length, 5);
  // The result passes Foundry's own setup check.
  const findings = checkSetup({ shell: "/bin/zsh", mcpInjectIntoAgents: true, paseoVersion: null, providers: { "foundry-claude": { disabledTools: prov.paseoTools.disabledTools } }, profiles });
  assert.ok(setupReady(findings), JSON.stringify(findings));
});

test("onboarding never changes existing profiles or providers and keeps the user's own profiles", () => {
  const mine = { id: "my-profile", name: "Mine", provider: "codex", model: "gpt" };
  const builder = { id: "foundry-builder", name: "Custom", provider: "foundry-claude", model: "claude-haiku-5-5" };
  const { patch, added } = missingProfilesPatch({ providers: { "foundry-claude": { custom: true } }, agentProfiles: [mine, builder] }, o);
  assert.equal(patch.providers, undefined);
  const profiles = patch.agentProfiles as any[];
  assert.deepEqual(profiles.slice(0, 2), [mine, builder]);
  assert.deepEqual(profiles.slice(2).map((p) => p.id), ["foundry-reviewer", "foundry-planner", "foundry-pm"]);
  assert.deepEqual(added, ["foundry-reviewer (claude-sonnet-5-5)", "foundry-planner (claude-opus-5-5)", "foundry-pm (claude-opus-5-5)"]);
});

test("onboarding is a no-op when everything exists", () => {
  const all = ["builder", "reviewer", "planner", "pm"].map((r) => ({ id: `foundry-${r}` }));
  assert.deepEqual(missingProfilesPatch({ providers: { "foundry-claude": {} }, agentProfiles: all }, o), { patch: {}, added: [] });
});

test("Foundry's create-profiles action clears the missing-profile errors and records an event", async () => {
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, { home: "", tickMs: 0, loop: () => ({ maxFixRounds: 1, questionWindowMs: 50, checkTimeoutMs: 30_000 }) });
  const before = await foundry.runSetupCheck();
  assert.ok(before.findings.some((f) => f.code === "PROFILE_MISSING"));
  const r = await foundry.createProfiles();
  assert.ok(setupReady(r.setup.findings), JSON.stringify(r.setup.findings));
  assert.equal((await foundry.createProfiles()).added.length, 0);
  assert.equal(store.events({ limit: 50 }).filter((e: any) => e.kind === "profiles_created").length, 2);
});
