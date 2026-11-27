// Foundry's tool contract, delivered through Paseo's agent tool transport. Each role gets only its own
// tools, attached in agent.open.before, and every tool re-checks the caller against Foundry's record
// of the agent id. The set grows with each part of M1 (ask_human, report_verdict, propose_tasks, ...).
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import type { Foundry } from "../core/foundry";
import { FoundryError, type Role } from "../core/model";
import type { ToolSet } from "./paseo";

/** Refuse a tool call from any agent that isn't Foundry's agent in this role. */
export function guardRole(f: Foundry, agentId: string, role: Role) {
  const r = f.store.agent(agentId);
  if (!r || r.role !== role) throw new FoundryError("TOOL_REFUSED", `Refused: this tool is for Foundry's ${role}`);
  return r;
}

export const ok = (v: unknown) => ({ text: JSON.stringify(v), structuredContent: v as Record<string, unknown> });

export function buildTools(_f: Foundry): ToolSet {
  const none: AgentToolDefinition[] = [];
  return { builder: none, reviewer: none, planner: none, pm: none };
}
