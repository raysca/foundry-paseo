// The host Foundry runs on. Core code talks only to this interface; server/adapter/paseo.ts implements
// it on Paseo, and tests implement it with a fake. Every capability here is something Paseo already
// owns (no duplication of Paseo): workspaces, agents, scripts, timelines, notifications, profiles.
import type { Role } from "./model";

/** Where an agent runs. */
export type AgentPlace =
  | { kind: "new-worktree"; repo: string; branch: string; fromRef: string; visible: boolean }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "directory"; path: string; visible: boolean };

export interface AgentSpec {
  /** Foundry assigns the agent id up front, so it recognises the agent's first turn and can resume after a crash. */
  agentId: string;
  role: Role;
  place: AgentPlace;
  prompt: string;
  title: string;
  env?: Record<string, string>;
  /** Paseo profile to use instead of the role's `foundry-<role>` profile (an issue's suggested profile). */
  profile?: string | null;
  issueKey?: string | null;
  attemptId?: number | null;
  featureId?: number | null;
  projectId?: number | null;
}

export interface StartedAgent {
  agentId: string;
  workspaceId: string;
  path: string;
}

export type AgentStatus = "running" | "idle" | "error" | "gone";

export interface ScriptResult {
  code: number;
  output: string;
  terminalId: string | null;
}

/** A Paseo agent profile, as Foundry reads it. */
export interface HostProfile {
  id: string;
  name?: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  options?: Record<string, unknown>;
  systemPrompt?: string;
}

/** What Foundry needs to know about the daemon for its setup check. */
export interface HostFacts {
  profiles: HostProfile[] | null; // null = could not read
  providers: Record<string, { extends?: string; disabledTools?: string[] }> | null;
  mcpInjectIntoAgents: boolean | null;
  shell: string | null;
  paseoVersion: string | null;
}

export type TimelineData =
  | { step: "commit"; sha: string; message: string }
  | { step: "check"; name: string; status: "passed" | "failed"; code: number; sha: string; tail: string }
  | { step: "fix_round"; round: number; checks: string[] }
  | { step: "verdict"; verdict: string; summary: string; sha: string }
  | { step: "status"; issue: string; status: string; detail?: string }
  | { step: "untracked"; paths: string[]; commit: string | null }
  | { step: "question"; question: string; status: string };

export interface Host {
  /** Start an agent with a pre-assigned id. Resolves once the host has accepted it. */
  startAgent(spec: AgentSpec): Promise<StartedAgent>;
  /** Send a message to an agent's session (a fix round, an answer, a follow-up, a rework). */
  send(agentId: string, text: string): Promise<void>;
  /** Ask an agent to end its turn. */
  interrupt(agentId: string): Promise<void>;
  agentStatus(agentId: string): Promise<AgentStatus>;
  lastReply(agentId: string): Promise<string>;

  /** A worktree workspace on an existing branch (checkout) or a new one (branch-off from `from`). */
  createWorktreeWorkspace(o: { repo: string; title: string; branch: string; from?: string; purpose: string; visible: boolean }): Promise<{
    workspaceId: string;
    path: string;
  }>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  /** Run one of the project's paseo.json scripts with Paseo's script runner and wait for its exit code. */
  runScript(o: { workspaceId: string; script: string; env: Record<string, string>; timeoutMs: number }): Promise<ScriptResult>;

  timeline(agentId: string, rowId: string, data: TimelineData): Promise<void>;
  setWorkspaceMetadata(workspaceId: string, data: Record<string, unknown>): Promise<void>;
  notify(n: { title: string; body: string; key: string; screen?: string }): Promise<void>;

  facts(): Promise<HostFacts>;
}
