// Paseo host adapter: the only file that knows Paseo's SDK. Reused from the POC (kit v3.3) behind the
// core Host interface: hidden workspaces, agents with pre-assigned ids, role profiles, paseo.json
// scripts, timeline rows, metadata, notifications, and the hooks that guard Foundry's state.
import { createHash, randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext, AgentToolDefinition } from "@getpaseo/plugin/server";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSpec, AgentStatus, Harness, Host, WorktreeRequest, HostFacts, HostProfile, ProfileChoice, ScriptResult, ServiceStart, StartedAgent, TimelineData } from "../core/host";
import type { Role } from "../core/model";
import type { Store } from "../core/store";
import { profileId, roleProfile } from "../core/setup";
import { currentBranch } from "../core/git";
import { profilesPatch, removeProfilesPatch } from "./profiles";

/** What the adapter reports back to Foundry's core. */
export interface HostEvents {
  onTurnStart(agentId: string, tracked: boolean): void;
  onTurnEnd(agentId: string, outcome: { kind: string; message?: string }, tracked: boolean): Promise<void>;
  onWorkspaceArchived(workspaceId: string): Promise<void>;
  onAgentArchived(agentId: string): Promise<void>;
  /** The harness's own "ask the user" tool, routed into Foundry's question flow. Resolves with the answer, or null to deny. */
  onNativeQuestion(agentId: string, text: string): Promise<string | null>;
  /** A Paseo permission card is waiting on the developer for this agent (true), or was answered (false). */
  onPermission(agentId: string, waiting: boolean): void;
}

export interface AdapterConfig {
  /** Where the plugin reaches its own daemon for calls the plugin SDK lacks (paseo.json scripts). */
  daemonUrl: string;
  daemonPassword?: string;
}

/** Foundry's own tools per role, as the agent sees them under Paseo's MCP server. */
export type ToolSet = Partial<Record<Role, AgentToolDefinition[]>>;

/** Builders, reviewers and the PM show in Paseo's sidebar; integration and check checkouts stay hidden. */
const VISIBLE_ROLES = new Set<Role>(["builder", "reviewer", "pm"]);

const CLAUDE_READONLY_DENY = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
  "SlashCommand",
  "ExitPlanMode",
];

/**
 * Guard rails per harness and role, applied under the role's Paseo profile. The profile decides
 * provider, model, mode and prompt; these only fill what the profile leaves unset.
 */
export function roleDefaults(kind: string, role: Role, toolNames: string[]): { modeId?: string; options: Record<string, unknown> } {
  if (kind === "claude") {
    // Only the MCP servers Paseo injects (Foundry's tools); never the user's own (scorecard: setting sources).
    const extraArgs = { "strict-mcp-config": null };
    const allowedTools = toolNames.map((t) => `mcp__paseo__${t}`);
    if (role === "builder") return { modeId: "bypassPermissions", options: { extraArgs } };
    // PM: warn-first, not read-only. It edits without asking; shell and network go to Paseo's own permission card.
    if (role === "pm") return { modeId: "acceptEdits", options: { extraArgs, allowedTools } };
    if (role === "planner")
      return { modeId: "acceptEdits", options: { extraArgs, allowedTools, disallowedTools: ["Bash", "WebFetch", "WebSearch", "Task", "Agent"] } };
    return { modeId: "default", options: { extraArgs, allowedTools, disallowedTools: CLAUDE_READONLY_DENY } };
  }
  if (kind === "opencode") {
    // Paseo's OpenCode schema rejects a "*" key, so every key is listed (scorecard Q9).
    const all = { read: "allow", glob: "allow", grep: "allow", list: "allow" };
    if (role === "builder")
      return { options: { permission: { ...all, edit: "allow", task: "allow", todowrite: "allow", webfetch: "allow", websearch: "allow", bash: "allow", external_directory: "deny" } } };
    if (role === "pm")
      return { options: { permission: { ...all, edit: "allow", task: "allow", todowrite: "allow", webfetch: "allow", websearch: "allow", external_directory: "allow", bash: "ask" } } };
    if (role === "planner")
      return { options: { permission: { ...all, edit: "allow", bash: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny", task: "deny" } } };
    return {
      options: {
        permission: { ...all, edit: "deny", bash: "deny", webfetch: "deny", websearch: "deny", codesearch: "deny", external_directory: "deny", task: "deny", todowrite: "deny", skill: "deny" },
      },
    };
  }
  if (kind === "codex") {
    if (role === "builder") return { options: { sandbox_mode: "workspace-write", approval_policy: "never" } };
    if (role === "pm") return { options: { sandbox_mode: "workspace-write", approval_policy: "on-request" } };
    return { options: { sandbox_mode: "read-only", approval_policy: "never", web_search: "disabled" } };
  }
  return { options: {} };
}

/** The harness kind behind a provider id: foundry-claude/sonnet -> claude. */
export function harnessKind(provider: string) {
  return provider.split("/")[0]!.replace(/^foundry-/, "");
}

export class PaseoAdapter implements Host {
  private events!: HostEvents;
  private tools: ToolSet = {};
  /** Turns Foundry asked for and has not yet seen start, per agent. */
  private expected = new Map<string, number>();
  private trackedTurns = new Set<string>();
  /** One-time nonces for agents Foundry is creating (guard on agent.create.before). */
  private nonces = new Set<string>();
  /** Env for the project's scripts in Foundry's workspaces, handed over in terminal.create.before. */
  private scriptEnv = new Map<string, Record<string, string>>();
  private client?: DaemonClient;

  constructor(
    private server: PluginServerContext,
    private paseo: PaseoApi,
    private store: Store,
    private cfg: AdapterConfig,
  ) {}

  // ---------- profiles and facts ----------
  private async daemonConfig(): Promise<Record<string, any> | null> {
    try {
      const { config } = await this.paseo.config.get();
      return config as Record<string, any>;
    } catch {
      return null;
    }
  }

  async facts(): Promise<HostFacts> {
    const config = await this.daemonConfig();
    const profiles = config ? ((config.agentProfiles ?? []) as HostProfile[]) : null;
    const providers = config?.providers
      ? Object.fromEntries(
          Object.entries(config.providers as Record<string, any>).map(([id, p]) => [id, { disabledTools: p?.paseoTools?.disabledTools ?? [] }]),
        )
      : null;
    const inject = config?.mcp ? Boolean(config.mcp.injectIntoAgents) : null;
    return {
      profiles,
      providers,
      mcpInjectIntoAgents: inject,
      // The plugin runs inside the daemon process, so this is the daemon's shell.
      shell: process.env.SHELL ?? null,
      paseoVersion: null,
    };
  }

  async harnesses(): Promise<Harness[]> {
    const providers = this.paseo.providers;
    // Provider discovery is lazy in Paseo; wait a little for it, then take what is known.
    const snap = (await Promise.race([
      providers.waitForReady().catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 8000)),
    ])) as { entries?: any[] } | null;
    const entries = (snap ?? ((await providers.snapshot()) as { entries?: any[] })).entries ?? [];
    return entries
      .filter((e) => e.enabled !== false && !String(e.provider).startsWith("foundry-"))
      .map((e) => ({
        id: String(e.provider),
        label: String(e.label ?? e.provider),
        status: String(e.status),
        models: ((e.models ?? []) as any[])
          .filter((m) => m.isSelectable !== false)
          .map((m) => ({ id: String(m.id), label: String(m.label ?? m.id), isDefault: !!m.isDefault })),
      }));
  }

  async writeProfiles(choices: ProfileChoice[]) {
    const config = await this.daemonConfig();
    if (!config) throw new Error("Could not read Paseo's settings");
    const { patch, added, created } = profilesPatch(config as never, choices);
    if (added.length) await this.paseo.config.patch(patch as never);
    return { added, created };
  }

  async removeProfiles(ids: string[]) {
    const config = await this.daemonConfig();
    if (!config) throw new Error("Could not read Paseo's settings");
    const { patch, removed } = removeProfilesPatch(config as never, ids);
    if (removed.length) await this.paseo.config.patch(patch as never);
    return removed;
  }

  async reloadSelf() {
    const c = await this.daemon();
    await c.reloadPlugin("foundry");
  }

  private async profileFor(role: Role, override?: string | null): Promise<HostProfile> {
    const config = await this.daemonConfig();
    const profiles = ((config?.agentProfiles ?? []) as HostProfile[]) ?? [];
    const p = (override && profiles.find((x) => x.id === override)) || roleProfile(profiles, role);
    if (!p) throw new Error(`No Paseo agent profile "${profileId(role)}". Run Foundry's setup check.`);
    return p;
  }

  /** Agent config for a role: its Paseo profile, Foundry's tools and the harness guard rails under it. */
  private async agentConfig(role: Role, prompt: string, override?: string | null) {
    const profile = await this.profileFor(role, override);
    const names = (this.tools[role] ?? []).map((t) => t.name);
    const base = roleDefaults(harnessKind(profile.provider), role, names);
    const config: Record<string, unknown> = {
      provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
      modeId: profile.modeId ?? base.modeId,
      ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
      options: { ...base.options, ...(profile.options ?? {}) },
    };
    return { config, prompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${prompt}` : prompt, profile: profile.id };
  }

  // ---------- agents ----------
  private expect(agentId: string) {
    this.expected.set(agentId, (this.expected.get(agentId) ?? 0) + 1);
  }
  private consumeExpected(agentId: string) {
    const n = this.expected.get(agentId) ?? 0;
    if (n <= 0) return false;
    this.expected.set(agentId, n - 1);
    return true;
  }

  async startAgent(spec: AgentSpec): Promise<StartedAgent> {
    const { config, prompt, profile } = await this.agentConfig(spec.role, spec.prompt, spec.profile);
    this.store.registerAgent({
      agent_id: spec.agentId,
      role: spec.role,
      project_id: spec.projectId ?? null,
      feature_id: spec.featureId ?? null,
      issue_key: spec.issueKey ?? null,
      attempt_id: spec.attemptId ?? null,
      workspace_id: null,
    });
    this.expect(spec.agentId);
    const nonce = randomUUID();
    this.nonces.add(nonce);

    let ws;
    let path: string;
    let branch: string | undefined;
    const place = spec.place;
    if (place.kind === "new-worktree") {
      // Paseo names the branch from the slug and makes it unique in the repo.
      ws = await this.paseo.workspaces.create({
        source: { kind: "worktree", cwd: place.repo, action: "branch-off", refName: place.fromRef, worktreeSlug: place.slug },
        title: spec.title,
        background: !place.visible,
      } as never);
      path = await this.workspaceDir(ws);
      branch = await currentBranch(path);
    } else if (place.kind === "workspace") {
      ws = this.paseo.workspaces.ref(place.workspaceId);
      path = await this.workspaceDir(ws);
    } else {
      ws = await this.paseo.workspaces.create({ source: { kind: "directory", path: place.path }, title: spec.title, background: !place.visible } as never);
      path = place.path;
    }
    this.store.setAgentWorkspace(spec.agentId, ws.id);
    await ws.agents.create({
      agentId: spec.agentId,
      config,
      title: spec.title,
      prompt,
      env: spec.env,
      background: !VISIBLE_ROLES.has(spec.role),
      labels: { "foundry/role": spec.role, "foundry/issue": spec.issueKey ?? "" },
      metadata: {
        "foundry.role": spec.role,
        "foundry.nonce": nonce,
        "foundry.issue": spec.issueKey ?? null,
        "foundry.attempt": spec.attemptId ?? null,
        "foundry.profile": profile,
      },
    } as never);
    return { agentId: spec.agentId, workspaceId: ws.id, path, branch };
  }

  private async workspaceDir(ws: { id: string; directory?: string | null; refresh(): Promise<unknown> }) {
    if (ws.directory) return String(ws.directory);
    const fresh = (await ws.refresh()) as { workspaceDirectory?: string; directory?: string } | null;
    return String(fresh?.workspaceDirectory ?? fresh?.directory ?? "");
  }

  async send(agentId: string, text: string) {
    this.expect(agentId);
    await this.paseo.agents.ref(agentId).send(text);
  }

  async interrupt(agentId: string) {
    const c = await this.daemon();
    await c.cancelAgent(agentId);
  }

  async agentStatus(agentId: string): Promise<AgentStatus> {
    try {
      const r = await this.paseo.agents.ref(agentId).refresh();
      const s = r?.agent.status;
      if (!s) return "gone";
      if (s === "running" || s === "initializing") return "running";
      if (s === "error") return "error";
      return "idle";
    } catch {
      return "gone";
    }
  }

  async agentActivity(agentId: string): Promise<string | null> {
    try {
      const page = await this.paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 1 } as never);
      const entries = (page as { entries?: unknown[] }).entries ?? [];
      const last = entries[entries.length - 1];
      return last === undefined ? "" : createHash("sha1").update(JSON.stringify(last)).digest("hex");
    } catch {
      return null;
    }
  }

  /**
   * Paseo has no hard stop for a turn that ignores cancel, so Foundry archives the agent, which stops
   * its runtime (upstream ask: a force-stop for an agent's turn). Foundry never reuses that agent.
   */
  async kill(agentId: string) {
    const c = await this.daemon();
    await c.archiveAgent(agentId);
  }

  async lastReply(agentId: string) {
    const page = await this.paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
    const parts: string[] = [];
    for (const e of page.entries as { item: { type: string; text?: string } }[]) {
      if (e.item.type === "user_message") parts.length = 0;
      if (e.item.type === "assistant_message" && e.item.text) parts.push(e.item.text);
    }
    return parts.join("");
  }

  // ---------- workspaces and scripts ----------
  async createWorktreeWorkspace(o: WorktreeRequest) {
    // A new branch is named by Paseo from the slug (unique in the repo); an existing one is checked out.
    const source =
      o.from !== undefined
        ? { kind: "worktree", cwd: o.repo, action: "branch-off", refName: o.from, worktreeSlug: o.slug }
        : { kind: "worktree", cwd: o.repo, action: "checkout", refName: o.branch };
    const ws = await this.paseo.workspaces.create({ source, title: o.title, background: !o.visible } as never);
    const path = await this.workspaceDir(ws);
    await ws.setMetadata({ "foundry.purpose": o.purpose }).catch(() => {});
    return { workspaceId: ws.id, path, branch: await currentBranch(path) };
  }

  async archiveWorkspace(workspaceId: string) {
    await this.paseo.workspaces.archive(workspaceId);
  }

  /** The plugin SDK has no paseo.json script calls yet (upstream ask), so these go through a daemon client. */
  private async daemon() {
    if (!this.client) {
      const c = new DaemonClient({
        url: this.cfg.daemonUrl,
        clientId: `foundry-scripts-${process.pid}`,
        clientType: "cli",
        password: this.cfg.daemonPassword,
      } as never);
      await c.connect();
      this.client = c;
    }
    return this.client;
  }

  async runScript(o: { workspaceId: string; script: string; env: Record<string, string>; timeoutMs: number }): Promise<ScriptResult> {
    const c = await this.daemon();
    this.scriptEnv.set(o.workspaceId, o.env);
    const started = await c.startWorkspaceScriptWithStatus(o.workspaceId, o.script);
    const err = (started as { error?: string }).error;
    if (err) return { code: 127, output: `[foundry] Paseo could not start script ${o.script}: ${err}`, terminalId: null };
    const terminalId = (started as { script?: { terminalId?: string } }).script?.terminalId ?? null;
    const capture = async () => {
      if (!terminalId) return "";
      const cap = (await this.paseo.terminals.ref(terminalId).capture({ start: 0, stripAnsi: true } as never).catch(() => null)) as { lines: string[] } | null;
      return (cap?.lines ?? []).join("\n").trimEnd();
    };
    const deadline = Date.now() + o.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      const list = (await c.listWorkspaceScripts(o.workspaceId).catch(() => null)) as {
        scripts?: { scriptName: string; lifecycle: string; exitCode?: number | null; terminalId?: string | null }[];
      } | null;
      const s = list?.scripts?.find((x) => x.scriptName === o.script);
      if (s && s.lifecycle === "stopped" && (!terminalId || s.terminalId === terminalId))
        return { code: typeof s.exitCode === "number" ? s.exitCode : 1, output: await capture(), terminalId };
    }
    await c.stopWorkspaceScript(o.workspaceId, o.script).catch(() => {});
    return { code: 124, output: (await capture()) + "\n[foundry] check timed out", terminalId };
  }

  /**
   * Start a service script and wait until it answers. Paseo picks the port (PASEO_PORT) and reports it
   * in the workspace's script list; Foundry treats the service as up once Paseo calls it healthy or a
   * plain HTTP request to the port gets any answer.
   */
  async startService(o: { workspaceId: string; script: string; timeoutMs: number }): Promise<ServiceStart> {
    const c = await this.daemon();
    const started = await c.startWorkspaceScriptWithStatus(o.workspaceId, o.script);
    const err = (started as { error?: string }).error;
    if (err) return { ok: false, output: `[foundry] Paseo could not start service ${o.script}: ${err}`, terminalId: null };
    const terminalId = (started as { script?: { terminalId?: string } }).script?.terminalId ?? null;
    const capture = async () => {
      if (!terminalId) return "";
      const cap = (await this.paseo.terminals.ref(terminalId).capture({ start: 0, stripAnsi: true } as never).catch(() => null)) as { lines: string[] } | null;
      return (cap?.lines ?? []).join("\n").trimEnd();
    };
    const deadline = Date.now() + o.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      const list = (await c.listWorkspaceScripts(o.workspaceId).catch(() => null)) as {
        scripts?: { scriptName: string; lifecycle: string; port?: number | null; health?: string | null; terminalId?: string | null }[];
      } | null;
      const s = list?.scripts?.find((x) => x.scriptName === o.script);
      if (!s) continue;
      if (s.lifecycle === "stopped") return { ok: false, output: (await capture()) + "\n[foundry] the service exited", terminalId };
      if (!s.port) continue;
      const url = `http://127.0.0.1:${s.port}`;
      if (s.health === "healthy") return { ok: true, url, terminalId };
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 1500);
      const up = await fetch(url, { signal: ac.signal }).then(
        () => true,
        () => false,
      );
      clearTimeout(timer);
      if (up) return { ok: true, url, terminalId };
    }
    return { ok: false, output: (await capture()) + "\n[foundry] the service didn't answer in time", terminalId };
  }

  async stopService(workspaceId: string, script: string) {
    const c = await this.daemon();
    await c.stopWorkspaceScript(workspaceId, script).catch(() => {});
  }

  // ---------- mirroring ----------
  async timeline(agentId: string, rowId: string, data: TimelineData) {
    try {
      await this.paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: rowId, kind: "foundry-step", version: 1, data: data as never });
    } catch (e) {
      this.store.event("timeline_append_failed", { detail: { agentId, rowId, error: String(e) } });
    }
  }

  async setWorkspaceMetadata(workspaceId: string, data: Record<string, unknown>) {
    try {
      await this.paseo.workspaces.ref(workspaceId).setMetadata(data as never);
    } catch (e) {
      this.store.event("metadata_failed", { detail: { workspaceId, error: String(e) } });
    }
  }

  async notify(n: { title: string; body: string; key: string; screen?: string }) {
    try {
      const r = await this.server.notifications.send({ title: n.title, body: n.body, key: n.key, open: n.screen ? { type: "screen", screenId: n.screen } : undefined });
      this.store.event("notified", { detail: { title: n.title, result: r } });
    } catch (e) {
      this.store.event("notify_failed", { detail: { error: String(e), title: n.title } });
    }
  }

  // ---------- hooks ----------
  isFoundryOwnedPath(p: string) {
    return this.store.ownedPaths().some((o) => p === o || p.startsWith(o + sep));
  }

  /**
   * Install Paseo hooks. `onContext` receives the SDK from every hook, so Foundry attaches even before
   * its loopback bootstrap call lands (scorecard: SDK outside handler contexts).
   */
  install(events: HostEvents, tools: ToolSet, onContext: (paseo: PaseoApi) => void) {
    this.events = events;
    this.tools = tools;
    const server = this.server;
    const add = (name: string, handler: (e: any, ctx: any) => Promise<unknown>) =>
      server.addHook(name as never, (async (e: any, ctx: any) => {
        onContext(ctx.paseo);
        return handler(e, ctx);
      }) as never) as unknown as () => void;
    const removers: (() => void)[] = [];

    // Tools per role, keyed on Foundry's own record of the agent id (not on labels a user can copy).
    removers.push(
      add("agent.open.before", async ({ request }) => {
        if (request.purpose === "history") return;
        const r = this.store.agent(request.agentId);
        if (!r) return;
        const list = this.tools[r.role] ?? [];
        return {
          ...request,
          tools: [...request.tools, ...list],
          appendSystemPrompt: [
            ...(request.appendSystemPrompt ?? []),
            `You are running inside Foundry as its ${r.role}. Foundry owns task state; report back only through the Foundry tools you were given.`,
          ],
        };
      }),
    );

    // Nobody but Foundry starts an agent or a terminal in a Foundry-owned checkout (scorecard P3).
    removers.push(
      add("agent.create.before", async ({ request }) => {
        const nonce = request.metadata?.["foundry.nonce"];
        if (typeof nonce === "string" && this.nonces.delete(nonce)) return;
        const cwd = resolve(String(request.config?.cwd ?? ""));
        if (this.isFoundryOwnedPath(cwd)) {
          this.store.event("foreign_agent_refused", { actor: "host-user", detail: { cwd } });
          throw new Error("This worktree is owned by Foundry. Start agents from Foundry instead.");
        }
      }),
    );
    removers.push(
      add("terminal.create.before", async ({ request }) => {
        const env = request.workspaceId ? this.scriptEnv.get(request.workspaceId) : undefined;
        if (env) return { ...request, env: { ...request.env, ...env } };
        if (request.cwd && this.isFoundryOwnedPath(resolve(request.cwd))) {
          this.store.event("foreign_terminal_refused", { actor: "host-user", detail: { cwd: request.cwd } });
          throw new Error("This worktree is owned by Foundry.");
        }
      }),
    );

    // Permission cards stay Paseo's to answer; Foundry only pauses its timers and shows the wait.
    removers.push(
      add("agent.permission.before", async ({ agent }) => {
        if (this.store.agent(agent.id)) this.events.onPermission(agent.id, true);
      }),
    );
    removers.push(
      add("agent.permission.after", async ({ agent }) => {
        if (this.store.agent(agent.id)) this.events.onPermission(agent.id, false);
      }),
    );

    // Turns: Foundry knows which turns it asked for; any other turn is recorded as untracked (P1).
    removers.push(
      add("agent.turn.before", async ({ agent }) => {
        if (!this.store.agent(agent.id)) return;
        const tracked = this.consumeExpected(agent.id);
        if (tracked) this.trackedTurns.add(agent.id);
        else this.trackedTurns.delete(agent.id);
        this.events.onTurnStart(agent.id, tracked);
      }),
    );
    removers.push(
      add("agent.turn.after", async ({ agent, outcome }) => {
        if (!this.store.agent(agent.id)) return;
        const tracked = this.trackedTurns.delete(agent.id);
        const message = outcome.kind === "failed" ? outcome.error?.message : outcome.kind === "canceled" ? outcome.reason : undefined;
        await this.events
          .onTurnEnd(agent.id, { kind: outcome.kind, message }, tracked)
          .catch((e) => this.store.event("loop_error", { detail: { agentId: agent.id, error: String(e?.stack ?? e) } }));
      }),
    );
    removers.push(add("workspace.archive.after", async ({ workspace }) => void this.events.onWorkspaceArchived(workspace.id)));
    removers.push(add("agent.archive.after", async ({ agent }) => void this.events.onAgentArchived(agent.id)));

    // Permissions: the PM's go to the person through Paseo; builders' native questions go to Foundry's
    // question flow; the planner and reviewer are read-only, so Foundry denies for them.
    removers.push(
      add("agent.permission.before", async ({ agent, request }) => {
        const r = this.store.agent(agent.id);
        if (!r || r.role === "pm") return;
        if (r.role === "builder") {
          if (request.kind === "question") void this.routeQuestion(agent.id, request);
          return;
        }
        this.store.event("permission_denied_by_policy", { actor: "system", detail: { agentId: agent.id, role: r.role, kind: request.kind } });
        await this.paseo.agents
          .ref(agent.id)
          .respondToPermission({ requestId: request.id, response: { behavior: "deny", message: "Denied by Foundry policy: this role is read-only." } } as never)
          .catch((e) => this.store.event("permission_answer_failed", { detail: { error: String(e) } }));
      }),
    );
    return () => removers.forEach((r) => r());
  }

  private async routeQuestion(agentId: string, request: { id: string; input?: Record<string, unknown>; title?: string; description?: string }) {
    const qs = (request.input?.questions as { question: string; options?: { label: string }[] }[] | undefined) ?? [];
    const text = qs.length
      ? qs.map((q) => q.question + (q.options?.length ? ` (options: ${q.options.map((o) => o.label).join(", ")})` : "")).join("\n")
      : String(request.description ?? request.title ?? "The builder has a question.");
    const answer = await this.events.onNativeQuestion(agentId, text).catch(() => null);
    const response =
      answer !== null
        ? { behavior: "allow", updatedInput: { ...(request.input ?? {}), answers: Object.fromEntries(qs.map((q) => [q.question, answer])) } }
        : {
            behavior: "deny",
            message:
              "No answer within the question window. End your turn now with a one-line summary of where you stopped. Foundry will resume this same session with the answer when it arrives.",
          };
    await this.paseo.agents
      .ref(agentId)
      .respondToPermission({ requestId: request.id, response } as never)
      .catch((e) => this.store.event("permission_answer_failed", { detail: { error: String(e) } }));
  }

  async close() {
    await this.client?.close().catch(() => {});
  }
}
