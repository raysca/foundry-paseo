// Foundry's tool contract, delivered through Paseo's agent tool transport. Each role gets only its own
// tools, attached in agent.open.before, and every tool re-checks the caller against Foundry's record
// of the agent id. The set grows with each part of M1 (ask_human, report_verdict, propose_tasks, ...).
import { z } from "zod";
import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
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

/** A FoundryError goes back to the agent as a tool error with its code, so it can react to it. */
const refusal = (e: unknown) => {
  if (e instanceof FoundryError) return { text: `${e.code}: ${e.message}`, structuredContent: { error: { code: e.code, message: e.message } }, isError: true };
  throw e;
};

export function buildTools(f: Foundry): ToolSet {
  const askHuman = defineAgentTool({
    name: "ask_human",
    title: "Ask the developer",
    description:
      "Ask the developer a question about your task and wait for the answer. If no answer comes within the question window, the reply tells you to end your turn; Foundry resumes you with the answer later.",
    input: z.object({ question: z.string().min(1), choices: z.array(z.string()).max(6).optional() }),
    async execute({ question, choices }, { agent, signal }) {
      try {
        guardRole(f, agent.id, "builder");
        return { text: await f.tasks.askHuman(agent.id, question, choices ?? [], signal) };
      } catch (e) {
        return refusal(e);
      }
    },
  });

  const verdict = (role: "builder" | "reviewer") =>
    defineAgentTool({
      name: "report_verdict",
      title: "Report verdict",
      description:
        role === "reviewer"
          ? "Report your review of the task's commit, once: pass, rework (with findings the builder must fix), fail, or human (with action_required)."
          : "Use only when you cannot finish the task: fail (it can't be done as asked) or human (you need the developer, with action_required).",
      input: z.object({
        decision: role === "reviewer" ? z.enum(["pass", "rework", "fail", "human"]) : z.enum(["fail", "human"]),
        reason: z.string().min(1),
        action_required: z.string().optional(),
        findings: z.array(z.object({ severity: z.enum(["low", "medium", "high"]), title: z.string(), evidence: z.string().optional() })).optional(),
        issue_key: z.string().optional(),
      }),
      async execute(input, { agent }) {
        try {
          guardRole(f, agent.id, role);
          return ok(f.tasks.reportVerdict(agent.id, input));
        } catch (e) {
          return refusal(e);
        }
      },
    });

  const none: AgentToolDefinition[] = [];
  return { builder: [askHuman, verdict("builder")], reviewer: [verdict("reviewer")], planner: none, pm: none };
}
