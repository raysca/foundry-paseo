// Feature branches and integration workspaces. A feature owns foundry/feature/<slug>, checked out only
// in its integration workspace (a hidden Paseo workspace; Paseo runs paseo.json setup when it makes it).
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
  const exists = await git(p.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${f.branch}`).then(
    () => true,
    () => false,
  );
  if (!exists) await git(p.repo, "branch", f.branch, p.base_ref);
  const ws = await host.createWorktreeWorkspace({ repo: p.repo, title: `Foundry: ${f.title}`, branch: f.branch, purpose: "integration", visible: false });
  const sha = await head(ws.path);
  store.updateFeature(f.id, { integration_workspace_id: ws.workspaceId, integration_path: ws.path, head_sha: sha });
  store.event("integration_ready", { project: f.project_id, feature: f.id, detail: { path: ws.path, head: sha } });
  return store.feature(f.id)!;
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

/** A slug from a title, unique among the project's features and the repo's feature branches. */
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
    if (store.featureBySlug(projectId, slug)) continue;
    const branchTaken = await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/foundry/feature/${slug}`).then(
      () => true,
      () => false,
    );
    if (!branchTaken) return slug;
  }
}
