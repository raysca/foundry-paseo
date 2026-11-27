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

  const askQuestions = defineAgentTool({
    name: "ask_questions",
    title: "Ask Clarify questions",
    description:
      "One Clarify round: at most 7 questions, each with a unique id, the question and your recommended answer. Waits for the developer's answers up to the question window; if the reply says to end your turn, do so.",
    input: z.object({
      questions: z.array(z.object({ id: z.string(), text: z.string(), recommended: z.string(), choices: z.array(z.string()).optional() })),
    }),
    async execute({ questions }, { agent, signal }) {
      try {
        guardRole(f, agent.id, "planner");
        return { text: await f.planning.askQuestions(agent.id, questions, signal) };
      } catch (e) {
        return refusal(e);
      }
    },
  });

  const proposeRequirements = defineAgentTool({
    name: "propose_requirements",
    title: "Propose requirements",
    description: "Hand Foundry the spec's requirements (replaces the list). Refs like R1, R1.1; each acceptance criterion must be EARS. Errors come back to fix.",
    input: z.object({
      requirements: z.array(z.object({ ref: z.string(), title: z.string(), acceptance_criteria: z.array(z.string()) })),
    }),
    async execute({ requirements }, { agent }) {
      try {
        guardRole(f, agent.id, "planner");
        return ok(f.planning.proposeRequirements(agent.id, requirements));
      } catch (e) {
        return refusal(e);
      }
    },
  });

  const proposeTasks = defineAgentTool({
    name: "propose_tasks",
    title: "Propose the task graph",
    description:
      "Hand Foundry the feature's task graph. Foundry validates it (coverage of every requirement, no cycles, valid dependencies), writes tasks.md and returns waves, the critical path and warnings. Errors come back to fix; nothing is recorded until it passes.",
    input: z.object({
      tasks: z.array(
        z.object({
          ref: z.string(),
          title: z.string(),
          description: z.string().optional(),
          exit_criteria: z.string().optional(),
          requirement_refs: z.array(z.string()),
          depends_on: z.array(z.object({ ref: z.string(), reason: z.string() })).optional(),
          touches: z.array(z.string()).optional(),
          size: z.enum(["S", "M", "L"]).optional(),
          loop: z.string().optional(),
          checks: z.object({ scripts: z.array(z.string()).optional(), paths: z.array(z.string()).optional() }).optional(),
          profile: z.string().optional(),
        }),
      ),
    }),
    async execute({ tasks }, { agent }) {
      try {
        guardRole(f, agent.id, "planner");
        return ok(f.planning.proposeTasks(agent.id, tasks));
      } catch (e) {
        return refusal(e);
      }
    },
  });

  const reportRequirements = defineAgentTool({
    name: "report_requirements",
    title: "Report requirements",
    description:
      "Verify only: report, once, whether the feature meets each requirement, with evidence (files, tests, behaviour you checked). Every requirement of the feature needs a result; refs must exist.",
    input: z.object({
      results: z.array(z.object({ requirement_ref: z.string(), passed: z.boolean(), evidence: z.string().min(1) })).min(1),
    }),
    async execute({ results }, { agent }) {
      try {
        guardRole(f, agent.id, "reviewer");
        return ok(f.delivery.reportRequirements(agent.id, results));
      } catch (e) {
        return refusal(e);
      }
    },
  });

  const none: AgentToolDefinition[] = [];
  return { builder: [askHuman, verdict("builder")], reviewer: [verdict("reviewer"), reportRequirements], planner: [askQuestions, proposeRequirements, proposeTasks], pm: none };
}
