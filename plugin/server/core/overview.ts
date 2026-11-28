// The features list: three buckets, and per feature a progress bar computed from task statuses
// (never typed in), requirement coverage and what waits on you.
import { featureBucket, SIZE_WEIGHT, type FeatureBucket, type Size } from "./model";
import { parse, type Feature, type Issue, type Store } from "./store";

export interface FeatureRow {
  id: number;
  project_id: number;
  title: string;
  slug: string;
  stage: string;
  status: string;
  bucket: FeatureBucket;
  spec_changed: boolean;
  /** Before tasks exist: the planning stage instead of a percentage. */
  planning_label: string | null;
  /** Verify and Ship show their own state, since every task is Done by then. */
  delivery_label: string | null;
  progress: {
    percent: number | null;
    done: number;
    total: number;
    split: { done: number; in_review: number; in_progress: number; waiting: number; not_started: number; failed_or_blocked: number };
  };
  coverage: { covered: number; total: number };
  /** The feature's chain of slices: how many, and which is next to merge. */
  slices: { total: number; front: number | null; front_title: string | null };
  waiting_on_you: number;
  planning_error: string | null;
  updated_at: string;
}

const weight = (i: Issue) => SIZE_WEIGHT[(i.size as Size | null) ?? "M"] ?? 2;
const STAGE_ORDER = ["clarify", "spec", "plan", "tasks", "build", "verify", "ship", "done"];

export function featureRow(store: Store, f: Feature): FeatureRow {
  const issues = store.issues({ featureId: f.id }).filter((i) => i.status !== "Cancelled");
  const split = { done: 0, in_review: 0, in_progress: 0, waiting: 0, not_started: 0, failed_or_blocked: 0 };
  let doneW = 0;
  let totalW = 0;
  for (const i of issues) {
    totalW += weight(i);
    if (i.status === "Done") {
      split.done++;
      doneW += weight(i);
    } else if (i.status === "In_Review") split.in_review++;
    else if (i.status === "In_Progress") split.in_progress++;
    else if (i.status === "Awaiting_Human") split.waiting++;
    else if (i.status === "Backlog" || i.status === "Ready") split.not_started++;
    else split.failed_or_blocked++;
  }

  // Coverage: requirements covered by Done tasks. After an approved spec change, a changed or added
  // requirement counts only once a task finished after that change covers it.
  const reqs = store.requirements(f.id);
  const change = store.get<{ diff: string }>("SELECT diff FROM spec_changes WHERE feature_id=? AND status='approved' ORDER BY id DESC LIMIT 1", f.id);
  const d = change ? parse<{ changed?: string[]; added?: string[]; done_before?: string[] }>(change.diff, {}) : {};
  const fresh = new Set([...(d.changed ?? []), ...(d.added ?? [])]);
  const doneBefore = new Set(d.done_before ?? []);
  const covered = reqs.filter((r) =>
    issues.some((i) => {
      if (i.status !== "Done" || i.flag === "SPEC_CHANGED") return false;
      if (!parse<string[]>(i.requirement_refs, []).includes(r.ref)) return false;
      return !fresh.has(r.ref) || !doneBefore.has(i.key);
    }),
  ).length;

  const docsInReview = store.docs(f.id).filter((x) => x.status === "in_review").length;
  const questions = store.get<{ n: number }>("SELECT COUNT(*) n FROM questions WHERE feature_id=? AND status IN ('live','waiting')", f.id)?.n ?? 0;
  const hasTasks = issues.length > 0;
  const delivery = deliveryLabel(store, f);
  return {
    id: f.id,
    project_id: f.project_id,
    title: f.title,
    slug: f.slug,
    stage: f.stage,
    status: f.status,
    bucket: featureBucket(f.stage, !!f.spec_change_open, hasTasks),
    spec_changed: !!f.spec_change_open,
    planning_label: hasTasks ? null : planningLabel(store, f),
    delivery_label: delivery.label,
    progress: { percent: hasTasks && totalW ? Math.round((100 * doneW) / totalW) : null, done: split.done, total: issues.length, split },
    coverage: { covered, total: reqs.length },
    waiting_on_you: split.in_review + split.waiting + questions + docsInReview + (f.planning_error ? 1 : 0) + (delivery.waiting ? 1 : 0),
    planning_error: f.planning_error,
    slices: sliceInfo(store, f.id),
    updated_at: f.updated_at,
  };
}

function planningLabel(store: Store, f: Feature) {
  const name = { clarify: "Clarify", spec: "Spec", plan: "Plan", tasks: "Task list" }[f.stage as "clarify"] ?? f.stage;
  const kind = f.stage === "tasks" ? "tasks" : f.stage === "plan" ? "plan" : "spec";
  if (f.stage === "clarify") return "Clarify";
  return store.doc(f.id, kind)?.status === "in_review" ? `${name} in review` : `${name} being written`;
}

function deliveryLabel(store: Store, f: Feature): { label: string | null; waiting: boolean } {
  if (f.stage !== "verify" && f.stage !== "ship") return { label: null, waiting: false };
  const v = store.get<{ status: string; failure: string | null; checks: string; requirements: string }>(
    "SELECT status, failure, checks, requirements FROM verifications WHERE feature_id=? ORDER BY id DESC LIMIT 1",
    f.id,
  );
  if (f.stage === "ship") {
    const prepared = !!store.setting(`ship:${f.id}`);
    return { label: prepared ? "Ship prepared" : "Ready to ship", waiting: true };
  }
  if (!v || v.status === "running") return { label: "Verify running", waiting: false };
  if (v.status === "passed") return { label: "Verified", waiting: false };
  const reqs = parse<{ passed: boolean }[]>(v.requirements, []);
  const failedChecks = parse<{ status: string }[]>(v.checks, []).filter((c) => c.status !== "passed").length;
  const label =
    v.failure === "REQUIREMENTS_FAILED"
      ? `Verify: ${reqs.filter((r) => !r.passed).length} of ${reqs.length} requirements failed`
      : v.failure === "CHECKS_FAILED"
        ? `Verify: ${failedChecks} check${failedChecks === 1 ? "" : "s"} failed`
        : v.failure === "BASE_CONFLICT"
          ? "Verify: base conflicts"
          : `Verify failed (${v.failure})`;
  return { label, waiting: true };
}

/** The features list for a project: buckets with counts, rows sorted by stage then last activity. */
export function featuresOverview(store: Store, projectId?: number) {
  const rows = store
    .features(projectId)
    .map((f) => featureRow(store, f))
    .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || b.updated_at.localeCompare(a.updated_at));
  const visible = rows.filter((r) => r.status === "active");
  const count = (b: FeatureBucket) => visible.filter((r) => r.bucket === b).length;
  return {
    buckets: { pending: count("pending"), in_progress: count("in_progress"), completed: count("completed") },
    rows,
  };
}

/** Where a feature is in its chain of slices: the front slice (the next to merge) of how many. */
function sliceInfo(store: Store, featureId: number) {
  const all = store.slices(featureId).filter((x) => x.status !== "cancelled");
  const front = all.find((x) => x.status !== "shipped");
  return { total: all.length, front: front?.n ?? null, front_title: front?.title ?? null };
}
