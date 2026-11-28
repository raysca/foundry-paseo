// Feature branches and integration workspaces. A feature owns one branch, checked out only in its
// integration workspace (a hidden Paseo workspace; Paseo runs paseo.json setup when it makes it). Paseo
// names the branch from the feature's slug; features from before keep their foundry/feature/<slug>.
import { git, head } from "./git";
import type { Host } from "./host";
import { FoundryError } from "./model";
import type { Feature, Store } from "./store";

export function featureDir(slug: string) {
  return `.foundry/features/${slug}`;
}

/** Create the feature branch from base and its integration workspace, if they don't exist yet. */
export async function ensureIntegration(store: Store, host: Host, featureId: number): Promise<Feature> {
  const f = store.feature(featureId)!;
  if (f.integration_path && f.integration_workspace_id) return f;
  const p = store.project(f.project_id)!;
  const exists =
    !!f.branch &&
    (await git(p.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${f.branch}`).then(
      () => true,
      () => false,
    ));
  const title = `Foundry: ${f.title}`;
  const ws = exists
    ? await host.createWorktreeWorkspace({ repo: p.repo, title, branch: f.branch, purpose: "integration", visible: false })
    : await host.createWorktreeWorkspace({ repo: p.repo, title, slug: f.slug, from: p.base_ref, purpose: "integration", visible: false });
  if (!exists) store.recordBranch(p.repo, ws.branch, "feature");
  const sha = await head(ws.path);
  store.updateFeature(f.id, { branch: ws.branch, integration_workspace_id: ws.workspaceId, integration_path: ws.path, head_sha: sha });
  store.event("integration_ready", { project: f.project_id, feature: f.id, detail: { path: ws.path, head: sha } });
  return store.feature(f.id)!;
}

/**
 * Reopen a Done feature for a spec change. Its shipped work is already in base, so a new feature branch
 * is cut from base (Paseo names it from `<slug>-r<round>`) in a new integration workspace. The old
 * workspace stays until the change set is approved (discarding the change goes back to it). Base must hold the shipped docs: after a PR merge on GitHub Foundry looks at
 * the remote's base too, and refuses with BASE_BEHIND when neither has them.
 */
export async function reopenOnBase(store: Store, host: Host, featureId: number, firstRemote: (repo: string) => Promise<string | null>): Promise<{ feature: Feature; previous: Reopened }> {
  const f = store.feature(featureId)!;
  const p = store.project(f.project_id)!;
  const spec = `${featureDir(f.slug)}/spec.md`;
  const has = (ref: string) => git(p.repo, "cat-file", "-e", `${ref}:${spec}`).then(() => true, () => false);
  let from: string | null = (await has(p.base_ref)) ? p.base_ref : null;
  if (!from) {
    const remote = await firstRemote(p.repo);
    if (remote) {
      await git(p.repo, "fetch", "-q", remote, p.base_ref).catch(() => "");
      if (await has(`${remote}/${p.base_ref}`)) from = `${remote}/${p.base_ref}`;
    }
  }
  if (!from) throw new FoundryError("BASE_BEHIND", `${p.base_ref} does not have this feature's shipped docs yet. Pull ${p.base_ref}, then edit again.`, { base: p.base_ref });
  const round = (f.round ?? 1) + 1;
  const ws = await host.createWorktreeWorkspace({ repo: p.repo, title: `Foundry: ${f.title} (round ${round})`, slug: `${f.slug}-r${round}`, from, purpose: "integration", visible: false });
  store.recordBranch(p.repo, ws.branch, "feature");
  const sha = await head(ws.path);
  const previous: Reopened = { round: f.round ?? 1, branch: f.branch, workspace_id: f.integration_workspace_id, path: f.integration_path, head_sha: f.head_sha, planner_agent_id: f.planner_agent_id };
  store.tx(() => {
    // A new planner session starts in the new workspace; the old one stays with the old branch.
    store.updateFeature(f.id, { branch: ws.branch, integration_workspace_id: ws.workspaceId, integration_path: ws.path, head_sha: sha, round, planner_agent_id: null });
    store.event("feature_reopened", { actor: "you", project: f.project_id, feature: f.id, detail: { round, branch: ws.branch, from, previous_branch: f.branch } });
  });
  return { feature: store.feature(f.id)!, previous };
}

/** Where a reopened feature was before: kept with its spec change so a discard can go back to Done. */
export interface Reopened {
  round: number;
  branch: string;
  workspace_id: string | null;
  path: string | null;
  head_sha: string | null;
  planner_agent_id: string | null;
}

/**
 * The integration worktree must be exactly what Foundry left: clean, at the head Foundry recorded.
 * A merge made outside Foundry (Paseo's "Merge locally" has no plugin hook) is caught here.
 */
export async function assertIntegrationUntouched(store: Store, f: Feature) {
  if (!f.integration_path) throw new FoundryError("NO_INTEGRATION", `Feature ${f.slug} has no integration worktree`);
  const now = await head(f.integration_path);
  const dirty = (await git(f.integration_path, "status", "--porcelain", "--untracked-files=all")).trim();
  if (now !== f.head_sha || dirty) {
    store.event("integration_moved_outside_foundry", {
      project: f.project_id,
      feature: f.id,
      detail: { expected: f.head_sha, head: now, dirty: dirty.split("\n").filter(Boolean) },
    });
    throw new FoundryError(
      "INTEGRATION_MOVED",
      `The feature branch changed outside Foundry (expected ${String(f.head_sha).slice(0, 10)}, found ${now.slice(0, 10)}${dirty ? ", with uncommitted changes" : ""}). Auto-start is paused for this feature until it is reconciled.`,
      { expected: f.head_sha, head: now },
    );
  }
}

/** Whether a feature lets its Ready tasks auto-start (spec: Build). */
export function featureAllowsAutoStart(store: Store, f: Feature) {
  if (f.status !== "active" || f.stage !== "build" || f.spec_change_open) return false;
  if (store.setting(`feature_hold:${f.id}`)) return false;
  return store.docs(f.id).every((d) => d.status === "approved");
}

/** .foundry/steering/{product,tech,structure}.md on base, for PM and builder prompts. */
export async function steering(repo: string, baseRef: string): Promise<string> {
  const parts: string[] = [];
  for (const name of ["product", "tech", "structure"]) {
    const body = await git(repo, "show", `${baseRef}:.foundry/steering/${name}.md`).catch(() => "");
    if (body.trim()) parts.push(`### ${name}.md\n${body.trim()}`);
  }
  return parts.length ? `Project steering (from .foundry/steering on ${baseRef}):\n\n${parts.join("\n\n")}` : "";
}

/** A slug from a title, unique among the project's features. (Paseo makes the branch name unique.) */
export async function uniqueSlug(store: Store, projectId: number, repo: string, title: string): Promise<string> {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "feature";
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!store.featureBySlug(projectId, slug)) return slug;
  }
}
