// A Host for loop tests: real git worktrees in a temp dir, scripted agents, and paseo.json scripts run
// with `sh -c`. It stands in for Paseo the way the adapter does, so the loop under test is the real one.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sh } from "../server/core/git";
import { profilesPatch, removeProfilesPatch } from "../server/adapter/profiles";
import type { AgentSpec, Harness, Host, HostFacts, ProfileChoice, ScriptResult, StartedAgent, TimelineData } from "../server/core/host";
import type { Role } from "../server/core/model";
import type { Store } from "../server/core/store";

export interface Turn {
  agentId: string;
  role: Role;
  /** The prompt (first turn) or the message that started this turn. */
  text: string;
  path: string;
  /** 1 for the agent's first turn. */
  n: number;
  write(file: string, content: string): void;
  read(file: string): string;
  git(...args: string[]): string;
  /** The agent's reply text for this turn (what lastReply returns). */
  reply(text: string): void;
}

/** What an agent does in a turn. Return a non-"completed" kind to make the turn fail. */
export type Behaviour = (t: Turn) => Promise<void | string> | void | string;

export interface TurnEnds {
  onTurnEnd(agentId: string, outcome: { kind: string; message?: string }, tracked: boolean): Promise<void>;
}

export const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@localhost",
};
Object.assign(process.env, GIT_ENV);

export function run(cwd: string, cmd: string, ...args: string[]) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repo on main with a paseo.json `test` script that passes once done.txt says ok. */
export function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "foundry-loop-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  run(repo, "git", "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "shout\n");
  writeFileSync(join(repo, "check.sh"), "grep -q ok done.txt 2>/dev/null || { echo 'done.txt is not ok'; exit 1; }\n");
  writeFileSync(join(repo, "paseo.json"), JSON.stringify({ scripts: { test: { type: "script", command: "sh check.sh" } } }, null, 2));
  run(repo, "git", "add", "-A");
  run(repo, "git", "commit", "-q", "-m", "init");
  return repo;
}

export class FakeHost implements Host {
  behaviours: Partial<Record<Role, Behaviour>> = {};
  loop!: TurnEnds;
  workspaces = new Map<string, { path: string; purpose: string; branch: string }>();
  agents = new Map<string, { role: Role; path: string; turns: number; messages: string[] }>();
  archived: string[] = [];
  notifications: { title: string; key: string }[] = [];
  timelineRows: TimelineData[] = [];
  scripts: { script: string; code: number }[] = [];
  failStart = false;
  replies = new Map<string, string>();
  interrupted: string[] = [];
  private pending = 0;
  private n = 0;
  private root = mkdtempSync(join(tmpdir(), "foundry-ws-"));

  constructor(private store: Store) {}

  async startAgent(spec: AgentSpec): Promise<StartedAgent> {
    if (this.failStart) throw new Error("provider unavailable");
    let workspaceId: string;
    let path: string;
    if (spec.place.kind === "new-worktree") {
      const ws = await this.createWorktreeWorkspace({ repo: spec.place.repo, title: spec.title, branch: spec.place.branch, from: spec.place.fromRef, purpose: "task", visible: true });
      workspaceId = ws.workspaceId;
      path = ws.path;
    } else if (spec.place.kind === "workspace") {
      workspaceId = spec.place.workspaceId;
      path = this.workspaces.get(workspaceId)!.path;
    } else {
      workspaceId = `dir:${spec.place.path}`;
      path = spec.place.path;
    }
    this.store.registerAgent({
      agent_id: spec.agentId,
      role: spec.role,
      project_id: spec.projectId ?? null,
      feature_id: spec.featureId ?? null,
      issue_key: spec.issueKey ?? null,
      attempt_id: spec.attemptId ?? null,
      workspace_id: workspaceId,
    });
    this.agents.set(spec.agentId, { role: spec.role, path, turns: 0, messages: [] });
    this.turn(spec.agentId, spec.prompt);
    return { agentId: spec.agentId, workspaceId, path };
  }

  async send(agentId: string, text: string) {
    this.turn(agentId, text);
  }

  private turn(agentId: string, text: string) {
    const a = this.agents.get(agentId)!;
    a.messages.push(text);
    this.pending++;
    // Runs at once, so a fast agent ends its turn before startAgent has returned (as on a real daemon).
    void (async () => {
      try {
        a.turns++;
        const b = this.behaviours[a.role];
        const t: Turn = {
          agentId,
          role: a.role,
          text,
          path: a.path,
          n: a.turns,
          write: (f, c) => {
            mkdirSync(dirname(join(a.path, f)), { recursive: true });
            writeFileSync(join(a.path, f), c);
          },
          read: (f) => readFileSync(join(a.path, f), "utf8"),
          git: (...args) => run(a.path, "git", ...args),
          reply: (r) => void this.replies.set(agentId, r),
        };
        this.replies.delete(agentId);
        let kind = "completed";
        try {
          const out = b ? b(t) : undefined;
          const r = out instanceof Promise ? await out : out;
          if (typeof r === "string") kind = r;
        } catch (e) {
          kind = "failed";
          a.messages.push(`behaviour threw: ${String(e)}`);
        }
        await this.loop.onTurnEnd(agentId, { kind }, true);
      } finally {
        this.pending--;
      }
    })();
  }

  /** Resolves once no turn is running or queued. */
  async idle(timeoutMs = 20_000) {
    const until = Date.now() + timeoutMs;
    let quiet = 0;
    while (quiet < 3) {
      if (Date.now() > until) throw new Error("FakeHost.idle timed out");
      await new Promise((r) => setTimeout(r, 5));
      quiet = this.pending === 0 ? quiet + 1 : 0;
    }
  }

  async interrupt(agentId: string) {
    this.interrupted.push(agentId);
  }
  async agentStatus() {
    return "idle" as const;
  }
  async lastReply(agentId: string) {
    return this.replies.get(agentId) ?? "";
  }

  async createWorktreeWorkspace(o: { repo: string; title: string; branch: string; from?: string; purpose: string; visible: boolean }) {
    const workspaceId = `ws-${++this.n}`;
    const path = join(this.root, workspaceId);
    if (o.from) run(o.repo, "git", "worktree", "add", "-q", "-b", o.branch, path, o.from);
    else run(o.repo, "git", "worktree", "add", "-q", path, o.branch);
    this.workspaces.set(workspaceId, { path, purpose: o.purpose, branch: o.branch });
    return { workspaceId, path };
  }

  async archiveWorkspace(workspaceId: string) {
    this.archived.push(workspaceId);
  }

  async runScript(o: { workspaceId: string; script: string; env: Record<string, string>; timeoutMs: number }): Promise<ScriptResult> {
    const ws = this.workspaces.get(o.workspaceId)!;
    const cfg = JSON.parse(readFileSync(join(ws.path, "paseo.json"), "utf8")) as { scripts: Record<string, { command: string }> };
    const r = await sh("sh", ["-c", cfg.scripts[o.script]!.command], { cwd: ws.path, timeoutMs: o.timeoutMs });
    this.scripts.push({ script: o.script, code: r.code });
    return { code: r.code, output: r.stdout + r.stderr, terminalId: null };
  }

  async timeline(_agentId: string, _rowId: string, data: TimelineData) {
    this.timelineRows.push(data);
  }
  async setWorkspaceMetadata() {}
  async notify(n: { title: string; body: string; key: string }) {
    this.notifications.push({ title: n.title, key: n.key });
  }
  profiles: { id: string; name: string; provider: string; model?: string }[] = [];
  providers: Record<string, { disabledTools: string[] }> = {};
  async facts(): Promise<HostFacts> {
    return { profiles: this.profiles, providers: this.providers, mcpInjectIntoAgents: true, shell: "/bin/zsh", paseoVersion: "0.18.0" };
  }
  harnessList: Harness[] = [
    { id: "claude", label: "Claude Code", status: "ready", models: [{ id: "claude-sonnet-5-5", label: "Sonnet", isDefault: true }, { id: "claude-opus-5-5", label: "Opus" }] },
  ];
  reloads = 0;
  async harnesses() {
    return this.harnessList;
  }
  async writeProfiles(choices: ProfileChoice[]) {
    const { patch, added, created } = profilesPatch({ providers: this.providers, agentProfiles: this.profiles }, choices);
    for (const [id, v] of Object.entries((patch.providers ?? {}) as Record<string, any>)) this.providers[id] = { disabledTools: v.paseoTools.disabledTools };
    if (patch.agentProfiles) this.profiles = patch.agentProfiles as never;
    return { added, created };
  }
  async removeProfiles(ids: string[]) {
    const { patch, removed } = removeProfilesPatch({ agentProfiles: this.profiles }, ids);
    if (patch.agentProfiles) this.profiles = patch.agentProfiles as never;
    return removed;
  }
  async reloadSelf() {
    this.reloads++;
  }
}
