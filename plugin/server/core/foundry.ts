// Foundry's runtime: owns the store and the host, and answers host events. Loop 1, loop 2 and the PM
// plug in here as they land; the foundations only record what happens and run the setup check.
import { ensureIntegration } from "./features";
import type { Host, ProfileChoice } from "./host";
import { Locks } from "./locks";
import { FoundryError, type Actor } from "./model";
import { checkSetup, setupReady, type Finding } from "./setup";
import type { Store } from "./store";
import { TaskLoop, type LoopSettings } from "./taskloop";
import { Planning } from "./planning";
import { Delivery } from "./delivery";
import { ProjectManager } from "./pm";

export interface FoundryConfig {
  /** Where Foundry keeps its own files (store). Worktrees are Paseo's. */
  home: string;
  /** Read on every use, so a settings change applies to the next step. */
  loop: () => LoopSettings & { planningTimeoutMs?: number };
  /** How often the scheduler looks for Ready work, in ms. 0 turns the timer off (tests). */
  tickMs?: number;
}

export class Foundry {
  private lastSetup: { at: string; findings: Finding[] } | null = null;
  readonly locks = new Locks();
  readonly tasks: TaskLoop;
  readonly planning: Planning;
  readonly delivery: Delivery;
  readonly pm: ProjectManager;
  private lastTriage = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly store: Store,
    readonly host: Host,
    readonly cfg: FoundryConfig,
  ) {
    const settings = cfg.loop;
    this.tasks = new TaskLoop(
      store,
      host,
      this.locks,
      {
        get maxFixRounds() {
          return settings().maxFixRounds;
        },
        get questionWindowMs() {
          return settings().questionWindowMs;
        },
        get checkTimeoutMs() {
          return settings().checkTimeoutMs;
        },
      },
      () => this.requireSetup(),
    );
    this.planning = new Planning(
      store,
      host,
      this.locks,
      {
        get questionWindowMs() {
          return settings().questionWindowMs;
        },
        get turnTimeoutMs() {
          return settings().planningTimeoutMs ?? 15 * 60_000;
        },
      },
      () => this.requireSetup(),
      () => this.tick(),
    );
    this.delivery = new Delivery(
      store,
      host,
      this.locks,
      {
        get checkTimeoutMs() {
          return settings().checkTimeoutMs;
        },
      },
      () => this.tick(),
    );
    this.pm = new ProjectManager(store, host, this.locks, this.tasks, () => this.requireSetup());
  }

  /** One scheduler pass: start Ready work, move features whose Build has ended to Verify, and every
   * 30 seconds post failed and flagged tasks to the PM. */
  async tick() {
    await this.tasks.tick();
    await this.delivery.checkBuildDone();
    if (Date.now() - this.lastTriage >= 30_000) {
      this.lastTriage = Date.now();
      await this.pm.triage();
    }
  }

  /** Accept a task; the last accepted task of a feature ends its Build. */
  async accept(key: string, headSha: string, treeSha: string, actor: Actor = "you", feedback = "") {
    const r = await this.tasks.accept(key, headSha, treeSha, actor, feedback);
    await this.delivery.checkBuildDone();
    return r;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- setup ----------
  async runSetupCheck() {
    const findings = checkSetup(await this.host.facts());
    this.lastSetup = { at: new Date().toISOString(), findings };
    this.store.event("setup_checked", { detail: { ready: setupReady(findings), errors: findings.filter((f) => f.level === "error").map((f) => f.code) } });
    return this.lastSetup;
  }
  /** Onboarding: the harnesses and models the host offers, for the profile step. */
  harnesses() {
    return this.host.harnesses();
  }

  /** Onboarding: adds the foundry-* profiles you chose a harness and model for, and the provider each
   *  harness runs on, only where missing. Existing profiles are never changed; what Foundry created is
   *  recorded so uninstall can tell it apart from yours. */
  async createProfiles(choices: ProfileChoice[]) {
    const roles = new Set(["builder", "reviewer", "planner", "pm"]);
    for (const c of choices)
      if (!roles.has(c.role) || !c.harness || !c.model)
        throw new FoundryError("PROFILE_CHOICE_INVALID", `Each profile needs a role, a harness and a model (got ${JSON.stringify(c)}).`);
    const { added, created } = await this.host.writeProfiles(choices);
    this.store.tx(() => {
      for (const c of created) this.store.addOwned(c.kind, c.id, c.value);
    });
    this.store.event("profiles_created", { actor: "you", detail: { added } });
    return { added, setup: await this.runSetupCheck() };
  }

  /** Paseo workspaces Foundry made, from everything it recorded. */
  foundryWorkspaces(): string[] {
    const ids = new Set<string>();
    const add = (rows: { id: string | null }[]) => rows.forEach((r) => r.id && ids.add(r.id));
    add(this.store.all("SELECT integration_workspace_id id FROM features"));
    add(this.store.all("SELECT workspace_id id FROM attempts UNION SELECT check_workspace_id FROM attempts"));
    add(this.store.all("SELECT workspace_id id FROM agents"));
    add(this.store.all("SELECT workspace_id id FROM verifications"));
    for (const r of this.store.all<{ value: string }>("SELECT value FROM settings WHERE key LIKE 'pm_ws:%'")) {
      try {
        add([{ id: JSON.parse(r.value)?.workspaceId ?? null }]);
      } catch {}
    }
    return [...ids];
  }

  /** Development only: what a reset would remove. */
  async devResetPlan() {
    const facts = await this.host.facts();
    return {
      workspaces: this.foundryWorkspaces(),
      profiles: (facts.profiles ?? []).map((p) => p.id).filter((id) => id.startsWith("foundry-")),
      data: this.cfg.home,
    };
  }

  /** Development only: back to a fresh install. Archives Foundry's workspaces, removes every foundry-*
   *  profile, copies the database to `backupPath` and empties it, then reloads the plugin. */
  async devReset(backupPath: string) {
    const plan = await this.devResetPlan();
    this.stop();
    const archived: string[] = [];
    for (const id of plan.workspaces) {
      await this.host.archiveWorkspace(id).then(() => archived.push(id)).catch(() => {});
    }
    const removed = await this.host.removeProfiles(plan.profiles);
    this.store.wipe(backupPath);
    this.lastSetup = null;
    return { archived, removed, backup: backupPath };
  }

  setupStatus() {
    return this.lastSetup;
  }
  /** Work that starts agents calls this first; it refuses while setup has errors. */
  async requireSetup() {
    const s = this.lastSetup ?? (await this.runSetupCheck());
    if (!setupReady(s.findings)) {
      const s2 = await this.runSetupCheck();
      if (!setupReady(s2.findings))
        throw new FoundryError("SETUP_INCOMPLETE", "Foundry's setup check has errors. Fix them in Settings → Foundry.", {
          findings: s2.findings.filter((f) => f.level === "error"),
        });
    }
  }

  /** Called once the host SDK is attached, at start and after a restart. */
  async recover() {
    this.store.event("foundry_started");
    await this.runSetupCheck();
    await this.planning.recover();
    await this.tasks.recover();
    await this.delivery.recover();
    await this.pm.recover();
    const ms = this.cfg.tickMs ?? 2000;
    if (ms > 0 && !this.timer)
      this.timer = setInterval(() => void this.tick().catch((e) => this.store.event("tick_error", { detail: { error: String(e) } })), ms);
  }

  // ---------- actions ----------
  /** The integration workspace for a feature (made on first need). Loop 1 calls this when the plan is approved. */
  ensureIntegration(featureId: number) {
    return ensureIntegration(this.store, this.host, featureId);
  }
  startIssue(key: string, actor: Actor = "you") {
    return this.tasks.start(key, actor);
  }

  // ---------- host events ----------
  onTurnStart(agentId: string, tracked: boolean) {
    if (tracked) return;
    const a = this.store.agent(agentId);
    this.store.event("untracked_turn", { actor: "host-user", issue: a?.issue_key, attempt: a?.attempt_id, feature: a?.feature_id, detail: { agentId } });
  }

  async onTurnEnd(agentId: string, outcome: { kind: string; message?: string }, tracked: boolean) {
    if (this.delivery.isVerifier(agentId)) return this.delivery.onTurnEnd(agentId, outcome);
    const a = this.store.agent(agentId);
    if (a && (a.role === "builder" || a.role === "reviewer")) return this.tasks.onTurnEnd(agentId, outcome, tracked);
    if (a?.role === "planner") return this.planning.onTurnEnd(agentId, outcome, tracked);
    if (a?.role === "pm" && this.pm.isPm(agentId)) return this.pm.onTurnEnd(agentId, outcome);
    this.store.event(tracked ? "turn_ended" : "untracked_turn_ended", {
      actor: tracked ? "agent" : "host-user",
      issue: a?.issue_key,
      attempt: a?.attempt_id,
      feature: a?.feature_id,
      detail: { agentId, role: a?.role, outcome: outcome.kind, message: outcome.message },
    });
  }

  async onWorkspaceArchived(workspaceId: string) {
    await this.tasks.onWorkspaceArchived(workspaceId);
  }

  async onAgentArchived(agentId: string) {
    const a = this.store.agent(agentId);
    // Foundry archives a task's workspaces when it is accepted; only an archive mid-attempt is the host's doing.
    const att = this.store.attemptByAgent(agentId);
    if (a && att && !att.ended_at) this.store.event("agent_archived_by_host", { actor: "host-user", issue: a.issue_key, attempt: a.attempt_id, detail: { agentId } });
  }

  /** A harness's own question tool (Claude's AskUserQuestion and the like), routed like ask_human. */
  async onNativeQuestion(agentId: string, text: string): Promise<string | null> {
    const a = this.store.agent(agentId);
    if (a?.role !== "builder") return null;
    return this.tasks.askNative(agentId, text).catch(() => null);
  }
}
