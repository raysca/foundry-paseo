// Build, Verify and Ship per slice. A feature ships as an ordered chain of slices. The front slice (the
// lowest one not shipped) lives on the feature's own branch and integration workspace, and the feature's
// stage mirrors it. While the front slice is in Ship the next slice builds on its own branch, cut from
// the front branch (one-deep stack: at most two active slices). When the front ships the next slice is
// promoted: its branch and workspace become the feature's, and its PR is retargeted at base.
import { git, head, FOUNDRY_IDENT, identEnv, sh } from "./git";
import type { Host } from "./host";
import { FoundryError, type Actor, type FeatureStage } from "./model";
import { parse, type Feature, type Issue, type Requirement, type Slice, type SliceStatus, type Store } from "./store";

const ACTIVE: SliceStatus[] = ["building", "verify", "ship"];
const STAGE_OF: Partial<Record<SliceStatus, FeatureStage>> = { building: "build", verify: "verify", ship: "ship" };
const STATUS_OF: Partial<Record<FeatureStage, SliceStatus>> = { build: "building", verify: "verify", ship: "ship" };
/** Active slices at once: the front and the one building on top of it. */
export const MAX_ACTIVE_SLICES = 2;

/** Where an operation on one slice of a feature works: its branch, workspace, head and stage. */
export interface Target {
  feature: Feature;
  slice: Slice | null;
  front: boolean;
  /** The feature as seen from the slice: branch, integration_path, integration_workspace_id, head_sha and stage are the slice's. */
  view: Feature;
}

export function activeSlices(store: Store, featureId: number) {
  return store.slices(featureId).filter((s) => ACTIVE.includes(s.status));
}

/** The front of the merge order: the lowest slice that hasn't shipped or been cancelled. */
export function frontSlice(store: Store, featureId: number) {
  return store.slices(featureId).find((s) => s.status !== "shipped" && s.status !== "cancelled") ?? null;
}

/** The slice a task ships in. Tasks from before slices (none recorded) ship with the front. */
export function sliceOfIssue(store: Store, i: Issue) {
  if (!i.feature_id) return null;
  return (i.slice_id ? store.slice(i.slice_id) : null) ?? frontSlice(store, i.feature_id);
}

export function target(store: Store, featureId: number, sliceId?: number | null): Target {
  const feature = store.feature(featureId);
  if (!feature) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
  const front = frontSlice(store, featureId);
  const slice = sliceId ? store.slice(sliceId) : front;
  if (sliceId && (!slice || slice.feature_id !== featureId)) throw new FoundryError("NOT_FOUND", `No slice ${sliceId} in this feature`);
  if (!slice || slice.id === front?.id) return { feature, slice: slice ?? null, front: true, view: feature };
  const view: Feature = {
    ...feature,
    branch: slice.branch ?? "",
    integration_path: slice.path,
    integration_workspace_id: slice.workspace_id,
    head_sha: slice.head_sha,
    stage: STAGE_OF[slice.status] ?? feature.stage,
  };
  return { feature, slice, front: false, view };
}

/**
 * The slice an operation on a feature means when none is named: the first active slice whose status
 * fits, else the front.
 */
export function pickTarget(store: Store, featureId: number, sliceId: number | null | undefined, fits: (s: Slice) => boolean): Target {
  if (sliceId) return target(store, featureId, sliceId);
  const s = activeSlices(store, featureId).find(fits);
  return target(store, featureId, s?.id ?? null);
}

/** The settings key of a slice's prepared ship. The front's is the feature's own, as before slices. */
export function shipKey(t: Target) {
  return t.front || !t.slice ? `ship:${t.feature.id}` : `ship:slice:${t.slice.id}`;
}

export function setTargetHead(store: Store, t: Target, sha: string) {
  if (t.front) store.updateFeature(t.feature.id, { head_sha: sha });
  if (t.slice) store.updateSlice(t.slice.id, { head_sha: sha });
  t.view = { ...t.view, head_sha: sha };
}

/** Move a slice through Build, Verify and Ship. The front moves the feature's stage with it. */
export function setTargetStage(store: Store, t: Target, stage: "build" | "verify" | "ship", actor: Actor = "system") {
  if (t.front) store.setStage(t.feature.id, stage, actor);
  else if (t.slice && t.slice.status !== STATUS_OF[stage]) {
    store.updateSlice(t.slice.id, { status: STATUS_OF[stage]! });
    store.event("slice_stage_changed", { actor, project: t.feature.project_id, feature: t.feature.id, detail: { slice: t.slice.n, from: t.slice.status, to: STATUS_OF[stage] } });
  }
  t.view = { ...t.view, stage };
}

/** The branch a slice merges into: base for the front, the slice before it otherwise. */
export function parentRef(store: Store, t: Target) {
  const p = store.project(t.feature.project_id)!;
  if (t.front || !t.slice) return p.base_ref;
  const before = activeSlices(store, t.feature.id).filter((s) => s.n < t.slice!.n).pop();
  return before?.branch ?? t.feature.branch;
}

/** The tasks a slice's Verify checks: every task of this slice and the ones before it. */
export function issuesThrough(store: Store, featureId: number, slice: Slice | null) {
  const all = store.issues({ featureId });
  if (!slice) return all;
  const n = new Map(store.slices(featureId).map((s) => [s.id, s.n]));
  const front = frontSlice(store, featureId);
  return all.filter((i) => (n.get(i.slice_id ?? front?.id ?? -1) ?? 1) <= slice.n);
}

/**
 * The requirements a slice delivers, with the ones before it. A requirement belongs to the last slice
 * with a task covering it; one no task covers belongs to the last slice.
 */
export function requirementsThrough(store: Store, featureId: number, slice: Slice | null): Requirement[] {
  const reqs = store.requirements(featureId);
  const slices = store.slices(featureId).filter((s) => s.status !== "cancelled");
  if (!slice || !slices.length || slice.n >= slices[slices.length - 1]!.n) return reqs;
  const n = new Map(slices.map((s) => [s.id, s.n]));
  const front = frontSlice(store, featureId);
  const owner = new Map<string, number>();
  for (const i of store.issues({ featureId }).filter((x) => x.status !== "Cancelled")) {
    const sn = n.get(i.slice_id ?? front?.id ?? -1) ?? 1;
    for (const ref of parse<string[]>(i.requirement_refs, [])) owner.set(ref, Math.max(owner.get(ref) ?? 0, sn));
  }
  return reqs.filter((r) => (owner.get(r.ref) ?? Infinity) <= slice.n);
}

/** Whether a task's slice lets it auto-start: the feature allows it and its slice is building on its own branch. */
export function sliceAllowsAutoStart(store: Store, f: Feature, i: Issue) {
  if (f.status !== "active" || f.spec_change_open) return false;
  if (store.setting(`feature_hold:${f.id}`)) return false;
  if (!store.docs(f.id).every((d) => d.status === "approved")) return false;
  const s = sliceOfIssue(store, i);
  if (!s) return f.stage === "build";
  if (store.setting(`slice_hold:${s.id}`)) return false;
  if (s.id === frontSlice(store, f.id)?.id) return f.stage === "build";
  return s.status === "building" && !!s.path;
}

/** A slice gets its branch and integration workspace, cut from `from`, and starts building. */
async function openSliceWorkspace(store: Store, host: Host, f: Feature, s: Slice, from: string) {
  const p = store.project(f.project_id)!;
  const ws = await host.createWorktreeWorkspace({ repo: p.repo, title: `Foundry: ${f.title} (slice ${s.n})`, slug: `${f.slug}-s${s.n}`, from, purpose: "integration", visible: false });
  store.recordBranch(p.repo, ws.branch, "feature");
  const sha = await head(ws.path);
  store.tx(() => {
    store.updateSlice(s.id, { status: "building", branch: ws.branch, workspace_id: ws.workspaceId, path: ws.path, head_sha: sha });
    store.event("slice_started", { actor: "system", project: f.project_id, feature: f.id, detail: { slice: s.n, title: s.title, branch: ws.branch, from } });
  });
  return store.slice(s.id)!;
}

/**
 * The next slice starts once the newest active slice reaches Ship, with at most two active. It is cut
 * from the newest active slice's branch, so it builds on everything before it.
 */
export async function startNextSlice(store: Store, host: Host, featureId: number): Promise<Slice | null> {
  const f = store.feature(featureId);
  if (!f || f.status !== "active" || f.spec_change_open) return null;
  const active = activeSlices(store, featureId);
  if (!active.length || active.length >= MAX_ACTIVE_SLICES) return null;
  const newest = active[active.length - 1]!;
  if (newest.status !== "ship") return null;
  const next = store.slices(featureId).find((s) => s.n > newest.n && s.status === "planned");
  if (!next) return null;
  return openSliceWorkspace(store, host, f, next, newest.branch ?? f.branch);
}

/**
 * Merge the front's new head into the slice building on top of it, so its tasks start from the latest
 * front. A conflict holds that slice's auto-start (slice_hold MERGE_CONFLICT) until a merge succeeds.
 */
export async function mergeForward(store: Store, host: Host, featureId: number, actor: Actor = "system") {
  const f = store.feature(featureId)!;
  const second = activeSlices(store, featureId).find((s) => s.id !== frontSlice(store, featureId)?.id);
  if (!second?.path || !f.head_sha) return null;
  const path = second.path;
  const now = await head(path).catch(() => "");
  const dirty = now ? (await git(path, "status", "--porcelain", "--untracked-files=all").catch(() => "")).trim() : "x";
  if (now !== second.head_sha || dirty) {
    store.setSetting(`slice_hold:${second.id}`, "INTEGRATION_MOVED");
    store.event("integration_moved_outside_foundry", { project: f.project_id, feature: f.id, detail: { slice: second.n, expected: second.head_sha, head: now } });
    return { held: "INTEGRATION_MOVED" } as const;
  }
  const m = await sh("git", [...FOUNDRY_IDENT, "merge", "--no-ff", "-q", "-m", `merge ${f.branch} into ${second.branch}`, f.head_sha], { cwd: path, env: identEnv(FOUNDRY_IDENT) });
  if (m.code !== 0) {
    const conflicts = (await git(path, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
    await sh("git", ["merge", "--abort"], { cwd: path });
    store.setSetting(`slice_hold:${second.id}`, "MERGE_CONFLICT");
    store.event("slice_merge_conflict", { actor, project: f.project_id, feature: f.id, detail: { slice: second.n, paths: conflicts } });
    void host.notify({
      title: `${f.title}: slice ${second.n} conflicts with slice ${second.n - 1}`,
      body: `Merging the front's new work into slice ${second.n} conflicts in ${conflicts.join(", ")}. Its tasks wait until the merge goes through.`,
      key: `slice-conflict:${second.id}`,
      screen: "feature",
    });
    return { held: "MERGE_CONFLICT", paths: conflicts } as const;
  }
  const sha = await head(path);
  store.tx(() => {
    store.updateSlice(second.id, { head_sha: sha });
    if (store.setting(`slice_hold:${second.id}`) === "MERGE_CONFLICT") store.setSetting(`slice_hold:${second.id}`, "");
    store.event("slice_merged_forward", { actor, project: f.project_id, feature: f.id, detail: { slice: second.n, from: f.head_sha, head: sha } });
  });
  return { merged: sha } as const;
}

/** What happens to the slice promoted to the front. */
export interface Promotion {
  slice: Slice;
  /** Its open PR, now to be retargeted at base. */
  pr?: { number: number; url: string };
  /** A prepared local merge was dropped: Verify runs again against base. */
  reverify: boolean;
}

/**
 * The front slice shipped. It is marked shipped at the feature's head, then the next slice is promoted:
 * its branch, workspace and head become the feature's, its prepared ship moves to the feature's key, and
 * the feature's stage follows it. With no slice left the feature is Done. Runs inside the caller's
 * transaction; the caller retargets the PR and runs Verify (both need the network or the disk).
 */
export function shipFront(store: Store, featureId: number, actor: Actor, event: { kind: string; detail: Record<string, unknown> }): Promotion | null {
  const f = store.feature(featureId)!;
  const front = frontSlice(store, featureId);
  store.setSetting(`ship:${f.id}`, "");
  store.event(event.kind, { actor, project: f.project_id, feature: f.id, detail: { ...event.detail, slice: front?.n ?? null } });
  const rest = store.slices(featureId).filter((s) => s.id !== front?.id && s.status !== "shipped" && s.status !== "cancelled");
  if (!front || !rest.length) {
    store.setStage(f.id, "done", actor);
    return null;
  }
  store.updateSlice(front.id, { status: "shipped", shipped_sha: f.head_sha });
  const next = rest[0]!;
  if (!next.path) {
    // It never started (its start failed): it starts from base once the caller makes its workspace.
    store.updateFeature(f.id, { stage: "build" });
    store.event("slice_promoted", { actor, project: f.project_id, feature: f.id, detail: { slice: next.n, shipped: front.n, pending: true } });
    return { slice: next, reverify: false };
  }
  const prepared = parse<{ mode: string; pr?: { number: number; url: string } } | null>(store.setting(`ship:slice:${next.id}`), null);
  store.setSetting(`ship:slice:${next.id}`, "");
  const reverify = next.status === "ship" && !!prepared && !prepared.pr;
  if (prepared?.pr) store.setSetting(`ship:${f.id}`, JSON.stringify(prepared));
  const stage = STAGE_OF[next.status] ?? "build";
  store.updateFeature(f.id, { branch: next.branch!, integration_workspace_id: next.workspace_id, integration_path: next.path, head_sha: next.head_sha, stage });
  store.event("slice_promoted", { actor, project: f.project_id, feature: f.id, detail: { slice: next.n, shipped: front.n, branch: next.branch, stage, pr: prepared?.pr?.url ?? null } });
  return { slice: store.slice(next.id)!, pr: prepared?.pr, reverify };
}

/** A promoted slice that never got its workspace starts now, from base. */
export async function openPromoted(store: Store, host: Host, featureId: number, s: Slice) {
  const f = store.feature(featureId)!;
  const p = store.project(f.project_id)!;
  const opened = await openSliceWorkspace(store, host, f, s, p.base_ref);
  store.updateFeature(f.id, { branch: opened.branch!, integration_workspace_id: opened.workspace_id, integration_path: opened.path, head_sha: opened.head_sha, stage: "build" });
  return opened;
}
