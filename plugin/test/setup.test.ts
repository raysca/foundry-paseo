import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSetup, PASEO_ORCHESTRATION_TOOLS, roleProfile, setupReady } from "../server/core/setup";
import type { HostFacts } from "../server/core/host";

const good = (): HostFacts => ({
  shell: "/bin/zsh",
  mcpInjectIntoAgents: true,
  paseoVersion: null,
  providers: { "foundry-claude": { disabledTools: [...PASEO_ORCHESTRATION_TOOLS] } },
  profiles: [
    { id: "foundry-builder", provider: "foundry-claude", model: "claude-sonnet-5-5" },
    { id: "foundry-reviewer", provider: "foundry-claude", model: "claude-sonnet-5-5" },
    { id: "foundry-pm", provider: "foundry-claude", model: "claude-opus-5-5" },
  ],
});
const codes = (f: HostFacts) => checkSetup(f).map((x) => x.code);

test("a complete setup is ready, with the planner falling back to the PM profile", () => {
  const f = checkSetup(good());
  assert.ok(setupReady(f));
  assert.ok(f.some((x) => x.code === "PLANNER_FALLBACK"));
  assert.equal(roleProfile(good().profiles!, "planner")!.id, "foundry-pm");
});

test("a planner profile of its own is used when it exists", () => {
  const facts = good();
  facts.profiles!.push({ id: "foundry-planner", provider: "foundry-claude", model: "claude-opus-5-5" });
  assert.equal(roleProfile(facts.profiles!, "planner")!.id, "foundry-planner");
  assert.ok(!codes(facts).includes("PLANNER_FALLBACK"));
});

test("a missing builder, reviewer or PM profile is an error", () => {
  const facts = good();
  facts.profiles = facts.profiles!.filter((p) => p.id !== "foundry-reviewer");
  const f = checkSetup(facts);
  assert.ok(!setupReady(f));
  assert.ok(f.some((x) => x.code === "PROFILE_MISSING" && x.message.includes("foundry-reviewer")));
});

test("a non-zsh daemon shell is an error, because script exit codes never arrive", () => {
  const facts = good();
  facts.shell = "/bin/bash";
  assert.ok(codes(facts).includes("SHELL_NOT_ZSH"));
  assert.ok(!setupReady(checkSetup(facts)));
});

test("MCP injection off is an error", () => {
  const facts = good();
  facts.mcpInjectIntoAgents = false;
  assert.ok(codes(facts).includes("MCP_INJECTION_OFF"));
});

test("a profile with a bare provider and no model is an error", () => {
  const facts = good();
  facts.profiles![0] = { id: "foundry-builder", provider: "foundry-claude" };
  assert.ok(codes(facts).includes("PROFILE_NO_MODEL"));
  facts.profiles![0] = { id: "foundry-builder", provider: "foundry-claude/claude-sonnet-5-5" };
  assert.ok(!codes(facts).includes("PROFILE_NO_MODEL"));
});

test("a provider that leaves Paseo's orchestration tools on is an error", () => {
  const facts = good();
  facts.providers!["foundry-claude"] = { disabledTools: ["create_agent"] };
  assert.ok(codes(facts).includes("PROVIDER_TOOLS_OPEN"));
});

test("a profile on a non-Foundry provider is a warning", () => {
  const facts = good();
  facts.profiles![0] = { id: "foundry-builder", provider: "claude", model: "claude-sonnet-5-5" };
  const f = checkSetup(facts);
  assert.ok(f.some((x) => x.code === "PROVIDER_NOT_FOUNDRY" && x.level === "warn"));
  assert.ok(setupReady(f));
});
