// Foundry's runtime: owns the store and the host, and answers host events. Loop 1, loop 2 and the PM
// plug in here as they land; the foundations only record what happens and run the setup check.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureIntegration } from "./features";
import { git } from "./git";
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
  /** How often open Ship PRs are checked on GitHub (default 5 minutes). */
  prPollMs?: number;
}

export class Foundry {
  private lastSetup: { at: string; findings: Finding[] } | null = null;
  readonly locks = new Locks();
  readonly tasks: TaskLoop;
  readonly planning: Planning;
  readonly delivery: Delivery;
  readonly pm: ProjectManager;
  private lastTriage = 0;
  private lastPrCheck = 0;
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
        get idleTimeoutMs() {
          return settings().idleTimeoutMs;
        },
        get turnTimeoutMs() {
          return settings().turnTimeoutMs;
        },
        get maxRetries() {
          return settings().maxRetries;
        },
        get retryBackoffMs() {
          return settings().retryBackoffMs;
        },
        shotsDir: cfg.home ? join(cfg.home, "shots") : undefined,
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
    await this.tasks.supervise();
    await this.tasks.tick();
    await this.delivery.checkBuildDone();
    if (Date.now() - this.lastPrCheck >= (this.cfg.prPollMs ?? 5 * 60_000)) {
      this.lastPrCheck = Date.now();
      await this.delivery.refreshPrs();
    }
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
    add(this.store.all("SELECT workspace_id id FROM slices"));
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

  // ---------- before you uninstall ----------
  /** Everything Foundry left behind, for Settings → Foundry and scripts/uninstall-local.sh. */
  async leftovers() {
    const facts = await this.host.facts();
    const current = new Map((facts.profiles ?? []).map((p) => [p.id, p]));
    const profiles = this.store
      .owned()
      .filter((o) => o.kind === "profile")
      .map((o) => {
        const now = current.get(o.id);
        const was = JSON.parse(o.value) as Record<string, unknown>;
        const state = !now ? "gone" : sameProfile(now as unknown as Record<string, unknown>, was) ? "unedited" : "edited";
        return { id: o.id, state, model: (now?.model ?? was.model ?? null) as string | null };
      });
    const providers = this.store.owned().filter((o) => o.kind === "provider").map((o) => o.id);
    const branches: { project: string; repo: string; branches: string[] }[] = [];
    for (const p of this.store.projects()) {
      // Branches Foundry made that still exist (never deleted: they are yours).
      const out = await git(p.repo, "branch", "--list", "--format=%(refname:short)").catch(() => "");
      const existing = new Set(out.split("\n").map((x) => x.trim()).filter(Boolean));
      const made = this.store.branchesMade(p.repo);
      // foundry/* is how Foundry named branches before Paseo named them.
      const list = [...existing].filter((b) => made.includes(b) || b.startsWith("foundry/")).sort();
      if (list.length) branches.push({ project: p.key, repo: p.repo, branches: list });
    }
    return {
      workspaces: this.foundryWorkspaces(),
      profiles,
      providers,
      branches,
      data: { home: this.cfg.home, files: dataFiles(this.cfg.home) },
    };
  }

  /** Stops Foundry's agents and archives its Paseo workspaces (Paseo removes their worktrees). */
  async stopAllWork() {
    this.stop();
    const archived: string[] = [];
    const failed: string[] = [];
    for (const id of this.foundryWorkspaces()) {
      await this.host.archiveWorkspace(id).then(() => archived.push(id), () => failed.push(id));
    }
    this.store.event("work_stopped", { actor: "you", detail: { archived, failed } });
    return { archived, failed };
  }

  /** Removes the profiles Foundry created that nobody has edited since. Edited ones are refused. */
  async removeOwnProfiles(ids: string[]) {
    const left = await this.leftovers();
    const edited = left.profiles.filter((p) => ids.includes(p.id) && p.state === "edited").map((p) => p.id);
    if (edited.length) throw new FoundryError("PROFILE_EDITED", `These profiles were changed after Foundry created them, so Foundry leaves them: ${edited.join(", ")}. Remove them in Paseo's settings if you want them gone.`);
    const mine = left.profiles.filter((p) => ids.includes(p.id) && p.state === "unedited").map((p) => p.id);
    const removed = await this.host.removeProfiles(mine);
    this.store.tx(() => {
      for (const p of left.profiles) if (ids.includes(p.id) && (removed.includes(p.id) || p.state === "gone")) this.store.removeOwned("profile", p.id);
    });
    this.store.event("profiles_removed", { actor: "you", detail: { removed } });
    return { removed, setup: await this.runSetupCheck() };
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

  onPermission(agentId: string, waiting: boolean) {
    this.tasks.onPermission(agentId, waiting);
  }

  /** A harness's own question tool (Claude's AskUserQuestion and the like), routed like ask_human. */
  async onNativeQuestion(agentId: string, text: string): Promise<string | null> {
    const a = this.store.agent(agentId);
    if (a?.role !== "builder") return null;
    return this.tasks.askNative(agentId, text).catch(() => null);
  }
}

const PROFILE_KEYS = ["id", "name", "provider", "model"] as const;
/** A profile is unedited while the fields Foundry wrote are as it wrote them. */
function sameProfile(now: Record<string, unknown>, was: Record<string, unknown>) {
  return PROFILE_KEYS.every((k) => (now[k] ?? null) === (was[k] ?? null)) && Object.keys(now).every((k) => (PROFILE_KEYS as readonly string[]).includes(k) || now[k] == null);
}

function dataFiles(home: string): { name: string; bytes: number }[] {
  try {
    return readdirSync(home).map((name) => ({ name, bytes: statSync(join(home, name)).size }));
  } catch {
    return [];
  }
}
