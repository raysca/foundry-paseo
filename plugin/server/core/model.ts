// Foundry's domain model, as the behaviour spec names it. Host-independent: nothing here knows Paseo.

export type Role = "builder" | "reviewer" | "planner" | "pm";
export const ROLES: readonly Role[] = ["builder", "reviewer", "planner", "pm"];

/** Who made a change. Every status change and field edit is recorded with one of these. */
export type Actor = "you" | "system" | "agent" | "pm" | "host-user";

// ---------- Features (loop 1) ----------

export type FeatureStage = "clarify" | "spec" | "plan" | "tasks" | "build" | "verify" | "ship" | "done";
export const FEATURE_STAGES: readonly FeatureStage[] = ["clarify", "spec", "plan", "tasks", "build", "verify", "ship", "done"];
export type FeatureStatus = "active" | "paused" | "cancelled";
export type FeatureFlow = "standard" | "quick";

export type DocKind = "spec" | "plan" | "tasks";
export type DocStatus = "drafting" | "in_review" | "approved" | "stale";

/** Overview buckets (spec: "The features list"). */
export type FeatureBucket = "pending" | "in_progress" | "completed";

export function featureBucket(stage: FeatureStage, specChangeOpen: boolean, hasTasks: boolean): FeatureBucket {
  if (stage === "done") return "completed";
  if (["build", "verify", "ship"].includes(stage)) return "in_progress";
  if (specChangeOpen && hasTasks) return "in_progress";
  return "pending";
}

// ---------- Issues (loop 2) ----------

export type IssueStatus =
  | "Backlog"
  | "Ready"
  | "In_Progress"
  | "Awaiting_Human"
  | "In_Review"
  | "Done"
  | "Cancelled"
  | "Blocked"
  | "Failed";
export const ISSUE_STATUSES: readonly IssueStatus[] = [
  "Backlog",
  "Ready",
  "In_Progress",
  "Awaiting_Human",
  "In_Review",
  "Done",
  "Cancelled",
  "Blocked",
  "Failed",
];
export const TERMINAL_STATUSES: readonly IssueStatus[] = ["Done", "Cancelled"];

export type IssueOrigin = "feature" | "quick" | "discovered";
export type Size = "S" | "M" | "L";
export const SIZE_WEIGHT: Record<Size, number> = { S: 1, M: 2, L: 3 };

/** Reason codes carried by Blocked and Failed (spec: "Statuses and transitions"). */
export type ReasonCode =
  | "HARNESS_MISSING"
  | "INFRA_ERROR"
  | "AGENT_ERROR"
  | "TIMEOUT"
  | "INTERRUPTED"
  | "MERGE_CONFLICT"
  | "SETUP_FAILED"
  | "REVIEW_FAIL"
  | "LOOP_MISSING";

/**
 * Every transition the spec allows, with who may make it. Anything else is INVALID_TRANSITION.
 * "you" moves are the board's direct moves plus review, rework, answer and cancel actions.
 */
const TRANSITIONS: { from: IssueStatus[] | "non-terminal"; to: IssueStatus; actors: Actor[] }[] = [
  { from: ["Backlog"], to: "Ready", actors: ["you", "system", "pm"] },
  { from: ["Ready"], to: "Backlog", actors: ["system", "you"] },
  { from: ["Ready"], to: "In_Progress", actors: ["you", "system"] },
  { from: ["In_Progress"], to: "Awaiting_Human", actors: ["system"] },
  { from: ["Awaiting_Human"], to: "In_Progress", actors: ["you", "system"] },
  { from: ["In_Progress", "Awaiting_Human"], to: "In_Review", actors: ["system"] },
  { from: ["In_Progress", "Awaiting_Human"], to: "Failed", actors: ["system"] },
  { from: ["In_Progress", "Ready"], to: "Blocked", actors: ["system"] },
  { from: ["In_Review"], to: "Done", actors: ["you", "system"] },
  { from: ["In_Review"], to: "In_Progress", actors: ["you", "system"] },
  { from: ["Failed", "Blocked"], to: "Ready", actors: ["you", "pm", "system"] },
  { from: ["Failed", "Blocked"], to: "In_Progress", actors: ["you", "system"] },
  { from: "non-terminal", to: "Cancelled", actors: ["you", "pm", "system"] },
];

export function allowedMoves(from: IssueStatus, actor: Actor): IssueStatus[] {
  const out = new Set<IssueStatus>();
  for (const t of TRANSITIONS) {
    const fromOk = t.from === "non-terminal" ? !TERMINAL_STATUSES.includes(from) : t.from.includes(from);
    if (fromOk && t.actors.includes(actor) && t.to !== from) out.add(t.to);
  }
  return [...out];
}

export class FoundryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FoundryError";
  }
}

export function assertTransition(from: IssueStatus, to: IssueStatus, actor: Actor) {
  const allowed = allowedMoves(from, actor);
  if (!allowed.includes(to))
    throw new FoundryError("INVALID_TRANSITION", `Cannot move from ${from} to ${to} as ${actor}`, { current: from, allowed });
}

// ---------- Attempts and runs ----------

export type AttemptStep = "setup" | "build" | "check" | "fix" | "review" | "ended";
export type AttemptOutcome = "passed" | "completed" | "rework" | "needs_human" | "failed";
export type RunKind = "setup" | "agent" | "fix" | "check" | "review" | "plan" | "pm" | "verify";
export type RunStatus = "running" | "passed" | "failed" | "completed" | "canceled" | "needs_human";

export type Verdict = "pass" | "rework" | "fail" | "human";

// ---------- Ledger and cards (PM) ----------

/** applied: the PM's own card, applied at once because it touched no active work (warn-first). */
export type CardStatus = "proposed" | "accepted" | "applied" | "rejected" | "failed";
