// Install and update tracking: which version is installed, what changed since you last looked, the
// one-time acknowledgements onboarding asks for, and the Got it gate on behaviour changes.
import type { Change } from "../../shared/changes";
import { FoundryError } from "./model";
import type { Store } from "./store";

/** Compares dotted versions numerically ("0.10.0" > "0.9.1"). Missing parts count as 0. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type StartKind = "installed" | "updated" | "same";

export class Install {
  constructor(
    private readonly store: Store,
    readonly version: string,
    private readonly changes: readonly Change[],
  ) {}

  /** Called once per load. Records a first install or a version change, as an event with from and to. */
  onStart(): { kind: StartKind; from?: string } {
    const s = this.store;
    const current = s.onboarding("version")?.value;
    if (current === this.version) return { kind: "same" };
    if (!current) {
      // A database with projects but no install record predates install tracking: an update, not an install.
      const existing = (s.get<{ n: number }>("SELECT COUNT(*) n FROM projects")?.n ?? 0) > 0;
      if (existing) {
        s.tx(() => {
          s.setOnboarding("installed_version", "0.0.0");
          s.setOnboarding("version", this.version);
          s.setOnboarding("previous_version", "0.0.0");
          s.setOnboarding("welcome_dismissed", "1");
        });
        s.event("plugin_updated", { detail: { from: null, to: this.version } });
        return { kind: "updated" };
      }
      s.tx(() => {
        s.setOnboarding("installed_version", this.version);
        s.setOnboarding("version", this.version);
        // A fresh install already has the current behaviour: nothing to announce or acknowledge.
        s.setOnboarding("whats_new_seen", this.version);
      });
      s.event("plugin_installed", { detail: { version: this.version } });
      return { kind: "installed" };
    }
    s.tx(() => {
      s.setOnboarding("previous_version", current);
      s.setOnboarding("version", this.version);
    });
    s.event(cmpVersion(this.version, current) > 0 ? "plugin_updated" : "plugin_downgraded", { detail: { from: current, to: this.version } });
    return { kind: "updated", from: current };
  }

  private installedVersion() {
    return this.store.onboarding("installed_version")?.value ?? this.version;
  }

  /** Changes newer than the last What's new you dismissed, up to this version. */
  whatsNew(): Change[] {
    const seen = this.store.onboarding("whats_new_seen")?.value ?? "0.0.0";
    return this.changes.filter((c) => cmpVersion(c.version, seen) > 0 && cmpVersion(c.version, this.version) <= 0);
  }

  /** Gates from versions after the one first installed that you haven't acknowledged. */
  pendingGates(): NonNullable<Change["gate"]>[] {
    const installed = this.installedVersion();
    return this.changes
      .filter((c) => c.gate && cmpVersion(c.version, installed) > 0 && cmpVersion(c.version, this.version) <= 0)
      .map((c) => c.gate!)
      .filter((g) => !this.store.onboarding(`gate:${g.id}`));
  }

  /** Refuses an action a pending gate covers. */
  requireGates(action: string) {
    const g = this.pendingGates().find((x) => x.actions.includes(action));
    if (g) throw new FoundryError("ACK_REQUIRED", `Foundry changed how this works: ${g.text} Press Got it on Foundry's home first.`, { gate: g.id });
  }

  ackWhatsNew() {
    this.store.setOnboarding("whats_new_seen", this.version);
    this.store.event("whats_new_seen", { actor: "you", detail: { version: this.version } });
  }
  ackGate(id: string) {
    if (!this.changes.some((c) => c.gate?.id === id)) throw new FoundryError("NOT_FOUND", `No change ${id} to acknowledge`);
    this.store.setOnboarding(`gate:${id}`, this.version);
    this.store.event("change_acknowledged", { actor: "you", detail: { gate: id } });
  }
  dismissWelcome() {
    this.store.setOnboarding("welcome_dismissed", "1");
    this.store.event("welcome_dismissed", { actor: "you" });
  }
  ackProject(projectId: number) {
    this.store.setOnboarding(`project_ack:${projectId}`, "1");
    this.store.event("project_acknowledged", { actor: "you", project: projectId });
  }

  status() {
    const s = this.store;
    return {
      version: this.version,
      installed_version: s.onboarding("installed_version")?.value ?? null,
      installed_at: s.onboarding("installed_version")?.at ?? null,
      previous_version: s.onboarding("previous_version")?.value ?? null,
      welcome_dismissed: !!s.onboarding("welcome_dismissed"),
      whats_new: this.whatsNew(),
      gates: this.pendingGates(),
    };
  }
}
