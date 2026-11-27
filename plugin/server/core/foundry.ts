// Foundry's runtime: owns the store and the host, and answers host events. Loop 1, loop 2 and the PM
// plug in here as they land; the foundations only record what happens and run the setup check.
import type { Host } from "./host";
import { FoundryError } from "./model";
import { checkSetup, setupReady, type Finding } from "./setup";
import type { Store } from "./store";

export interface FoundryConfig {
  /** Where Foundry keeps its own files (store). Worktrees are Paseo's. */
  home: string;
}

export class Foundry {
  private lastSetup: { at: string; findings: Finding[] } | null = null;

  constructor(
    readonly store: Store,
    readonly host: Host,
    readonly cfg: FoundryConfig,
  ) {}

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
  }

  // ---------- host events ----------
  onTurnStart(agentId: string, tracked: boolean) {
    if (tracked) return;
    const a = this.store.agent(agentId);
    this.store.event("untracked_turn", { actor: "host-user", issue: a?.issue_key, attempt: a?.attempt_id, feature: a?.feature_id, detail: { agentId } });
  }

  async onTurnEnd(agentId: string, outcome: { kind: string; message?: string }, tracked: boolean) {
    const a = this.store.agent(agentId);
    this.store.event(tracked ? "turn_ended" : "untracked_turn_ended", {
      actor: tracked ? "agent" : "host-user",
      issue: a?.issue_key,
      attempt: a?.attempt_id,
      feature: a?.feature_id,
      detail: { agentId, role: a?.role, outcome: outcome.kind, message: outcome.message },
    });
  }

  async onWorkspaceArchived(workspaceId: string) {
    const a = this.store.attemptByWorkspace(workspaceId);
    if (a && !a.ended_at) this.store.event("workspace_archived_by_host", { actor: "host-user", issue: a.issue_key, attempt: a.id, detail: { workspaceId } });
  }

  async onAgentArchived(agentId: string) {
    const a = this.store.agent(agentId);
    if (a) this.store.event("agent_archived_by_host", { actor: "host-user", issue: a.issue_key, attempt: a.attempt_id, detail: { agentId } });
  }

  async onNativeQuestion(_agentId: string, _text: string): Promise<string | null> {
    return null;
  }
}
