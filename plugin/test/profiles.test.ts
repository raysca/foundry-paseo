import { test } from "node:test";
import assert from "node:assert/strict";
import { profilesPatch, removeProfilesPatch } from "../server/adapter/profiles";
import { checkSetup, PASEO_ORCHESTRATION_TOOLS, setupReady } from "../server/core/setup";
import type { ProfileChoice } from "../server/core/host";
import { Store } from "../server/core/store";
import { Foundry } from "../server/core/foundry";
import { FoundryError } from "../server/core/model";
import { FakeHost } from "./fake-host";

const all = (harness: string, model: string): ProfileChoice[] => (["builder", "reviewer", "planner", "pm"] as const).map((role) => ({ role, harness, model }));

test("onboarding adds each profile on the harness and model chosen for it, with a provider that hides Paseo's orchestration tools", () => {
  const choices: ProfileChoice[] = [
    { role: "builder", harness: "codex", model: "gpt-6" },
    { role: "reviewer", harness: "claude", model: "claude-sonnet-5-5" },
    { role: "planner", harness: "claude", model: "claude-opus-5-5" },
    { role: "pm", harness: "opencode", model: "kimi" },
  ];
  const { patch, added, created } = profilesPatch({ providers: {}, agentProfiles: [] }, choices);
  const providers = patch.providers as Record<string, any>;
  assert.deepEqual(Object.keys(providers).sort(), ["foundry-claude", "foundry-codex", "foundry-opencode"]);
  assert.equal(providers["foundry-codex"].extends, "codex");
  for (const t of PASEO_ORCHESTRATION_TOOLS) assert.ok(providers["foundry-claude"].paseoTools.disabledTools.includes(t), t);
  const profiles = patch.agentProfiles as any[];
  assert.deepEqual(profiles.map((p) => [p.id, p.provider, p.model]), [
    ["foundry-builder", "foundry-codex", "gpt-6"],
    ["foundry-reviewer", "foundry-claude", "claude-sonnet-5-5"],
    ["foundry-planner", "foundry-claude", "claude-opus-5-5"],
    ["foundry-pm", "foundry-opencode", "kimi"],
  ]);
  assert.equal(added.length, 7);
  assert.equal(created.length, 7);
  const facts = Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, { disabledTools: v.paseoTools.disabledTools }]));
  const findings = checkSetup({ shell: "/bin/zsh", mcpInjectIntoAgents: true, paseoVersion: null, providers: facts, profiles });
  assert.ok(setupReady(findings), JSON.stringify(findings));
});

test("onboarding never changes existing profiles or providers and keeps the user's own profiles", () => {
  const mine = { id: "my-profile", name: "Mine", provider: "codex", model: "gpt" };
  const builder = { id: "foundry-builder", name: "Custom", provider: "foundry-claude", model: "claude-haiku-5-5" };
  const { patch, added } = profilesPatch({ providers: { "foundry-claude": { custom: true } }, agentProfiles: [mine, builder] }, all("claude", "m"));
  assert.equal(patch.providers, undefined);
  const profiles = patch.agentProfiles as any[];
  assert.deepEqual(profiles.slice(0, 2), [mine, builder]);
  assert.deepEqual(profiles.slice(2).map((p) => p.id), ["foundry-reviewer", "foundry-planner", "foundry-pm"]);
  assert.deepEqual(added, ["foundry-reviewer (m)", "foundry-planner (m)", "foundry-pm (m)"]);
});

test("onboarding is a no-op when every profile exists", () => {
  const existing = ["builder", "reviewer", "planner", "pm"].map((r) => ({ id: `foundry-${r}` }));
  assert.deepEqual(profilesPatch({ providers: {}, agentProfiles: existing }, all("claude", "m")), { patch: {}, added: [], created: [] });
});

test("removing profiles keeps every other profile as it is", () => {
  const ps = [{ id: "mine" }, { id: "foundry-builder" }, { id: "foundry-pm" }];
  assert.deepEqual(removeProfilesPatch({ agentProfiles: ps }, ["foundry-builder", "foundry-pm", "absent"]), { patch: { agentProfiles: [{ id: "mine" }] }, removed: ["foundry-builder", "foundry-pm"] });
  assert.deepEqual(removeProfilesPatch({ agentProfiles: ps }, ["absent"]), { patch: {}, removed: [] });
});

test("Foundry's create-profiles action clears the missing-profile errors and records what it created", async () => {
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const foundry = new Foundry(store, host, { home: "", tickMs: 0, loop: () => ({ maxFixRounds: 1, questionWindowMs: 50, checkTimeoutMs: 30_000 }) });
  assert.ok((await foundry.runSetupCheck()).findings.some((f) => f.code === "PROFILE_MISSING"));
  await assert.rejects(foundry.createProfiles([{ role: "builder", harness: "claude", model: "" }]), (e) => e instanceof FoundryError && e.code === "PROFILE_CHOICE_INVALID");
  const r = await foundry.createProfiles(all("claude", "claude-sonnet-5-5"));
  assert.ok(setupReady(r.setup.findings), JSON.stringify(r.setup.findings));
  assert.deepEqual(store.owned().map((o) => `${o.kind}:${o.id}`), ["profile:foundry-builder", "profile:foundry-planner", "profile:foundry-pm", "profile:foundry-reviewer", "provider:foundry-claude"]);
  assert.equal((await foundry.createProfiles(all("claude", "x"))).added.length, 0);
});
