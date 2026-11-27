// Foundry's runtime: owns the store and the host, and answers host events. Loop 1, loop 2 and the PM
// plug in here as they land; the foundations only record what happens and run the setup check.
import { ensureIntegration } from "./features";
import type { Host } from "./host";
import { Locks } from "./locks";
import { FoundryError, type Actor } from "./model";
import { checkSetup, setupReady, type Finding } from "./setup";
import type { Store } from "./store";
import { TaskLoop, type LoopSettings } from "./taskloop";

export interface FoundryConfig {
  /** Where Foundry keeps its own files (store). Worktrees are Paseo's. */
  home: string;
  /** Read on every use, so a settings change applies to the next step. */
  loop: () => LoopSettings;
  /** How often the scheduler looks for Ready work, in ms. 0 turns the timer off (tests). */
  tickMs?: number;
}

export class Foundry {
  private lastSetup: { at: string; findings: Finding[] } | null = null;
  readonly locks = new Locks();
  readonly tasks: TaskLoop;
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
    await this.tasks.recover();
    const ms = this.cfg.tickMs ?? 2000;
    if (ms > 0 && !this.timer)
      this.timer = setInterval(() => void this.tasks.tick().catch((e) => this.store.event("tick_error", { detail: { error: String(e) } })), ms);
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
    const a = this.store.agent(agentId);
    if (a && (a.role === "builder" || a.role === "reviewer")) return this.tasks.onTurnEnd(agentId, outcome, tracked);
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
