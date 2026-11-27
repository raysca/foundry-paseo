// Verify and Ship: close loop 1. Verify checks what would ship (base merged in, every task's checks on
// a fresh check workspace at the merged head, a reviewer's per-requirement report) and never changes
// code itself apart from merging base. Ship (local merge in M1) merges the feature into base at the SHA
// you read, under the base-integration rule.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesFromBase, paseoScripts, resolveChecks, tail, type ResolvedChecks, type TaskChecks } from "./checks";
import { assertIntegrationUntouched, featureDir } from "./features";
import { changedPaths, FOUNDRY_IDENT, git, head, identEnv, sh, treeOf } from "./git";
import type { Host } from "./host";
import type { Locks } from "./locks";
import { resolveLoop, type LoopStep } from "./loops";
import { FoundryError, type Actor } from "./model";
import { parse, type Feature, type Store } from "./store";

export interface Verification {
  id: number;
  feature_id: number;
  head_sha: string | null;
  status: "running" | "passed" | "failed";
  failure: string | null;
  checks: string; // JSON [{name, code, status, tail}]
  requirements: string; // JSON [{requirement_ref, passed, evidence}]
  workspace_id: string | null;
  path: string | null;
  reviewer_agent_id: string | null;
  created_at: string;
  ended_at: string | null;
}

export interface RequirementResult {
  requirement_ref: string;
  passed: boolean;
  evidence: string;
}

export class Delivery {
  constructor(
    private store: Store,
    private host: Host,
    private locks: Locks,
    private settings: { checkTimeoutMs: number },
    private onBuild: () => Promise<void> = async () => {},
  ) {}

  private inflight = new Set<Promise<unknown>>();
  private track(p: Promise<unknown>) {
    this.inflight.add(p);
    void p.catch(() => {}).finally(() => this.inflight.delete(p));
  }
  /** Resolves once no Verify work started here is still running (tests, shutdown). */
  async settled() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  verification(featureId: number) {
    return this.store.get<Verification>("SELECT * FROM verifications WHERE feature_id=? ORDER BY id DESC LIMIT 1", featureId);
  }

  // ---------- Build → Verify ----------
  /** Build ends when every task is Done or Cancelled. Called on each accept and from the scheduler tick. */
  async checkBuildDone() {
    for (const f of this.store.features().filter((x) => x.stage === "build" && x.status === "active" && !x.spec_change_open)) {
      const issues = this.store.issues({ featureId: f.id });
      if (!issues.length || issues.some((i) => !["Done", "Cancelled"].includes(i.status))) continue;
      this.store.setStage(f.id, "verify");
      await this.verify(f.id, "system").catch((e) => this.store.event("verify_error", { feature: f.id, detail: { error: String(e) } }));
    }
  }

  // ---------- Verify ----------
  async verify(featureId: number, actor: Actor = "you", force = false) {
    const f0 = this.store.feature(featureId);
    if (!f0) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
    if (f0.status === "cancelled") throw new FoundryError("FEATURE_CLOSED", "This feature is cancelled");
    if (!["verify", "ship"].includes(f0.stage)) throw new FoundryError("WRONG_STAGE", `The feature is in ${f0.stage}; Verify runs once Build ends`);
    if (f0.stage === "ship" && this.store.setting(`ship:${f0.id}`)) throw new FoundryError("SHIP_PREPARED", "Verify again after cancelling the prepared ship");
    const r = await this.locks.with(`feature:${featureId}`, async () => {
      const f = this.store.feature(featureId)!;
      const last = this.verification(f.id);
      if (last?.status === "running") throw new FoundryError("VERIFY_RUNNING", "Verify is already running");
      await assertIntegrationUntouched(this.store, f);
      const p = this.store.project(f.project_id)!;
      // 1. Merge base into the feature branch.
      const path = f.integration_path!;
      const m = await sh("git", [...FOUNDRY_IDENT, "merge", "--no-ff", "-q", "-m", `merge ${p.base_ref} into ${f.branch}`, p.base_ref], { cwd: path, env: identEnv(FOUNDRY_IDENT) });
      if (m.code !== 0) {
        const conflicts = (await git(path, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
        await sh("git", ["merge", "--abort"], { cwd: path });
        const v = this.newVerification(f, await head(path), "failed", "BASE_CONFLICT");
        this.store.event("verify_done", { actor: "system", project: f.project_id, feature: f.id, detail: { verification: v, failure: "BASE_CONFLICT", paths: conflicts } });
        return { verification: v, failure: "BASE_CONFLICT" } as const;
      }
      const sha = await head(path);
      if (sha !== f.head_sha) this.store.updateFeature(f.id, { head_sha: sha });
      if (!force && last?.status === "passed" && last.head_sha === sha) return { skipped: true, verification: last.id } as const;
      if (f.stage === "ship") this.store.setStage(f.id, "verify", actor);
      const id = this.newVerification(f, sha, "running", null);
      this.store.event("verify_started", { actor, project: f.project_id, feature: f.id, detail: { verification: id, head: sha } });
      return { verification: id, sha } as const;
    });
    if ("skipped" in r || "failure" in r) return r;
    // Checks and the reviewer run in the background; the feature view follows the verification row.
    this.track(this.runVerification(featureId, r.verification, r.sha));
    return { verification: r.verification, head: r.sha };
  }

  private async runVerification(featureId: number, verificationId: number, sha: string) {
    const r = { verification: verificationId, sha };
    // 2. Checks: every non-cancelled task's, plus the default loop's check step, at the merged head (no fix rounds).
    const f = this.store.feature(featureId)!;
    const p = this.store.project(f.project_id)!;
    try {
      // A fresh hidden workspace at the merged head, so Paseo runs the project's setup on the merged code
      // (Paseo has no call to re-run setup in the integration worktree: upstream ask).
      const ws = await this.host.createWorktreeWorkspace({
        repo: p.repo,
        title: `${f.title} verify`,
        branch: `foundry/verify/${f.slug}/${r.verification}-${randomUUID().slice(0, 4)}`,
        from: r.sha,
        purpose: "verify",
        visible: false,
      });
      this.store.run("UPDATE verifications SET workspace_id=?, path=? WHERE id=?", ws.workspaceId, ws.path, r.verification);
      const union: TaskChecks = { scripts: [], paths: [] };
      for (const i of this.store.issues({ featureId: f.id }).filter((x) => x.status !== "Cancelled")) {
        const c = parse<TaskChecks>(i.checks, {});
        for (const s of c.scripts ?? []) if (!union.scripts!.includes(s)) union.scripts!.push(s);
        for (const x of c.paths ?? []) if (!union.paths!.includes(x)) union.paths!.push(x);
      }
      const loop = resolveLoop(null, p.default_loop);
      const step = (loop.steps.find((s) => s.kind === "check") as Extract<LoopStep, { kind: "check" }>) ?? { kind: "check", name: "check" };
      const resolved = resolveChecks(step, union, await paseoScripts(p.repo, p.base_ref));
      const fromBase = await filesFromBase(p.repo, p.base_ref, resolved.scripts);
      await git(ws.path, "checkout", "-q", p.base_ref, "--", ...fromBase);
      const results: { name: string; status: string; code: number; tail: string }[] = [];
      for (const n of resolved.unknown) results.push({ name: n, status: "failed", code: 127, tail: `paseo.json has no script "${n}" on ${p.base_ref}.` });
      try {
        await this.runChecks(f.id, r.sha, ws.workspaceId, ws.path, resolved, results);
      } finally {
        await cleanTo(ws.path, r.sha);
      }
      this.store.run("UPDATE verifications SET checks=? WHERE id=?", JSON.stringify(results), r.verification);

      // 3. The reviewer reports per requirement.
      const reqs = this.store.requirements(f.id);
      const agentId = randomUUID();
      this.store.run("UPDATE verifications SET reviewer_agent_id=? WHERE id=?", agentId, r.verification);
      await this.host.startAgent({
        agentId,
        role: "reviewer",
        place: { kind: "workspace", workspaceId: ws.workspaceId },
        prompt: [
          `You are Foundry's reviewer verifying the feature "${f.title}" at ${r.sha} before it ships.`,
          `The approved spec and plan are in ${featureDir(f.slug)}/. Read the code; do not edit files.`,
          `Check results:\n${results.map((c) => `- ${c.name}: ${c.status}`).join("\n") || "- no checks"}`,
          `Requirements:\n${reqs.map((q) => `- ${q.ref} ${q.title}: ${parse<string[]>(q.criteria, []).join(" ")}`).join("\n")}`,
          "Call report_requirements once with a result for every requirement: requirement_ref, passed (true or false) and evidence (files, tests, behaviour you checked). Then end your turn.",
        ].join("\n\n"),
        title: `${f.title} verify`,
        featureId: f.id,
        projectId: f.project_id,
      });
    } catch (e) {
      this.finish(r.verification, "INFRA_ERROR", `Verify could not run: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  private async runChecks(
    featureId: number,
    sha: string,
    workspaceId: string,
    path: string,
    resolved: ResolvedChecks,
    results: { name: string; status: string; code: number; tail: string }[],
  ) {
    for (const s of resolved.scripts) {
      const run = this.store.startRun("verify", { feature: featureId, sha, detail: { name: s.name } });
      const out = await this.host.runScript({ workspaceId, script: s.name, env: {}, timeoutMs: this.settings.checkTimeoutMs });
      const status = out.code === 0 ? "passed" : "failed";
      this.store.endRun(run, status, { code: out.code, tail: tail(out.output, 4000) });
      results.push({ name: s.name, status, code: out.code, tail: tail(out.output, 1200) });
    }
    for (const x of resolved.paths) if (!existsSync(join(path, x))) results.push({ name: `path ${x}`, status: "failed", code: 1, tail: `${x} is missing` });
  }

  private newVerification(f: Feature, sha: string, status: string, failure: string | null) {
    const res = this.store.run("INSERT INTO verifications(feature_id,head_sha,status,failure) VALUES(?,?,?,?)", f.id, sha, status, failure);
    return Number(res.lastInsertRowid);
  }

  /** report_requirements: the Verify reviewer's per-requirement report; refs must exist. */
  reportRequirements(agentId: string, results: RequirementResult[]) {
    const v = this.store.get<Verification>("SELECT * FROM verifications WHERE reviewer_agent_id=? AND status='running'", agentId);
    if (!v) throw new FoundryError("TOOL_REFUSED", "report_requirements is for the reviewer of a running Verify");
    const refs = new Set(this.store.requirements(v.feature_id).map((r) => r.ref));
    const unknown = results.filter((r) => !refs.has(r.requirement_ref)).map((r) => r.requirement_ref);
    if (unknown.length) throw new FoundryError("UNKNOWN_REQUIREMENT", `Not requirements of this feature: ${unknown.join(", ")}`);
    this.store.run("UPDATE verifications SET requirements=? WHERE id=?", JSON.stringify(results), v.id);
    this.store.event("requirements_reported", { actor: "agent", feature: v.feature_id, detail: { verification: v.id, failed: results.filter((r) => !r.passed).map((r) => r.requirement_ref) } });
    return { recorded: results.length };
  }

  isVerifier(agentId: string) {
    return !!this.store.get("SELECT 1 FROM verifications WHERE reviewer_agent_id=?", agentId);
  }

  async onTurnEnd(agentId: string, outcome: { kind: string }) {
    const v = this.store.get<Verification>("SELECT * FROM verifications WHERE reviewer_agent_id=? AND status='running'", agentId);
    if (!v) return;
    // Anything the reviewer changed is reset.
    if (v.path && existsSync(v.path)) await cleanTo(v.path, v.head_sha!).catch(() => {});
    const checks = parse<{ status: string }[]>(v.checks, []);
    const reqs = parse<RequirementResult[]>(v.requirements, []);
    const all = this.store.requirements(v.feature_id).map((r) => r.ref);
    let failure: string | null = null;
    if (checks.some((c) => c.status !== "passed")) failure = "CHECKS_FAILED";
    else if (outcome.kind !== "completed" || !reqs.length || all.some((r) => !reqs.some((x) => x.requirement_ref === r))) failure = "NO_REQUIREMENTS_REPORT";
    else if (reqs.some((r) => !r.passed)) failure = "REQUIREMENTS_FAILED";
    this.finish(v.id, failure, null);
  }

  private finish(id: number, failure: string | null, detail: string | null) {
    const v = this.store.get<Verification>("SELECT * FROM verifications WHERE id=?", id)!;
    if (v.status !== "running") return;
    const f = this.store.feature(v.feature_id)!;
    if (v.workspace_id) void this.host.archiveWorkspace(v.workspace_id).catch(() => {});
    this.store.tx(() => {
      this.store.run("UPDATE verifications SET status=?, failure=?, ended_at=datetime('now') WHERE id=?", failure ? "failed" : "passed", failure, id);
      if (!failure) this.store.setStage(f.id, "ship");
      this.store.event("verify_done", { actor: "system", project: f.project_id, feature: f.id, detail: { verification: id, failure, detail } });
    });
    void this.host.notify({
      title: failure ? `${f.title}: Verify found gaps (${failure})` : `${f.title} is verified and ready to ship`,
      body: detail ?? (failure ? "Ship with the gaps, turn a failure into a task, or run Verify again." : "Prepare and accept the ship."),
      key: `verify:${f.id}`,
      screen: "feature",
    });
  }

  /** Ship with the gaps: each failed requirement and check is recorded (ledger shortcut entries arrive with the ledger). */
  async shipWithGaps(featureId: number, actor: Actor = "you") {
    return this.locks.with(`feature:${featureId}`, async () => {
      const f = this.store.feature(featureId)!;
      const v = this.verification(featureId);
      if (f.stage !== "verify" || v?.status !== "failed") throw new FoundryError("WRONG_STAGE", "There are no Verify gaps to accept");
      const gaps = [
        ...parse<{ name: string; status: string }[]>(v.checks, []).filter((c) => c.status !== "passed").map((c) => `check ${c.name}`),
        ...parse<RequirementResult[]>(v.requirements, []).filter((r) => !r.passed).map((r) => r.requirement_ref),
      ];
      this.store.tx(() => {
        this.store.event("shipped_with_gaps", { actor, project: f.project_id, feature: f.id, detail: { verification: v.id, failure: v.failure, gaps } });
        this.store.setStage(f.id, "ship", actor);
      });
      return { gaps };
    });
  }

  /** Turn a Verify failure into a task of the feature; the feature goes back to Build. */
  async taskFromFailure(featureId: number, title: string, description: string, requirementRefs: string[] = [], actor: Actor = "you") {
    if (!title.trim()) throw new FoundryError("TITLE_REQUIRED", "A task needs a title");
    const key = await this.locks.with(`feature:${featureId}`, async () => {
      const f = this.store.feature(featureId)!;
      if (f.stage !== "verify" || this.verification(featureId)?.status !== "failed") throw new FoundryError("WRONG_STAGE", "Turn a failure into a task after Verify reports one");
      const live = new Set(this.store.requirements(f.id).map((q) => q.ref));
      const unknown = requirementRefs.filter((x) => !live.has(x));
      if (unknown.length) throw new FoundryError("TASKS_INVALID", `Not requirements of this feature: ${unknown.join(", ")}`);
      return this.store.tx(() => {
        // Nothing depends on it, so its critical-path priority is the base priority.
        const i = this.store.createIssue({ projectId: f.project_id, featureId: f.id, origin: "feature", title, description, status: "Ready", priority: 50, requirementRefs, actor });
        this.store.setStage(f.id, "build", actor);
        this.store.event("task_from_verify", { actor, project: f.project_id, feature: f.id, issue: i.key });
        return i.key;
      });
    });
    await this.onBuild();
    return { issue: key };
  }

  // ---------- Ship (local merge) ----------
  /** Prepare: records the ship SHA. A PR mode with gh arrives later; M1 ships by local merge. */
  async prepare(featureId: number, actor: Actor = "you") {
    return this.locks.with(`feature:${featureId}`, async () => {
      const f = this.store.feature(featureId)!;
      if (f.stage !== "ship" || f.status !== "active") throw new FoundryError("WRONG_STAGE", "Prepare runs in Ship on an active feature");
      await assertIntegrationUntouched(this.store, f);
      const sha = f.head_sha!;
      const tree = await treeOf(f.integration_path!, sha);
      this.store.setSetting(`ship:${f.id}`, JSON.stringify({ sha, tree, mode: "local_merge" }));
      this.store.event("ship_prepared", { actor, project: f.project_id, feature: f.id, detail: { sha, mode: "local_merge" } });
      return { sha, tree, mode: "local_merge" };
    });
  }

  /** Accept the prepared ship at the head and tree you read: merge the feature into base. */
  async acceptShip(featureId: number, headSha: string, treeSha: string, o: { confirmCheckedOut?: boolean } = {}, actor: Actor = "you") {
    return this.locks.with(`feature:${featureId}`, async () => {
      const f = this.store.feature(featureId)!;
      const prepared = parse<{ sha: string; tree: string } | null>(this.store.setting(`ship:${f.id}`), null);
      if (f.stage !== "ship" || !prepared) throw new FoundryError("NOT_PREPARED", "Prepare the ship first");
      const dirty = await changedPaths(f.integration_path!);
      const cur = await head(f.integration_path!);
      if (dirty.length || cur !== headSha || headSha !== prepared.sha || (await treeOf(f.integration_path!, cur)) !== treeSha)
        throw new FoundryError("STALE_REVIEW", "It changed since you read it", { head_sha: cur });
      const p = this.store.project(f.project_id)!;
      const msg = `merge feature ${f.slug}: ${f.title}`;
      const where = await checkedOutAt(p.repo, p.base_ref);
      let mergedAt: string;
      if (!where) {
        // Base is not checked out anywhere: merge in a temporary worktree and remove it.
        const tmp = mkdtempSync(join(tmpdir(), "foundry-ship-"));
        await git(p.repo, "worktree", "add", "-q", join(tmp, "wt"), p.base_ref);
        try {
          mergedAt = await mergeInto(join(tmp, "wt"), headSha, msg);
        } finally {
          await sh("git", ["worktree", "remove", "--force", join(tmp, "wt")], { cwd: p.repo });
        }
      } else {
        if ((await changedPaths(where)).length) throw new FoundryError("BASE_DIRTY", `${p.base_ref} is checked out at ${where} with uncommitted changes`, { path: where });
        const owned = this.store.ownedPaths().includes(where);
        if (!owned && !o.confirmCheckedOut) throw new FoundryError("BASE_CHECKED_OUT", `${p.base_ref} is checked out at ${where}. Confirm to merge there.`, { path: where });
        mergedAt = await mergeInto(where, headSha, msg);
      }
      let pushed: string | null = null;
      const remote = (await sh("git", ["remote"], { cwd: p.repo })).stdout.trim().split("\n").filter(Boolean)[0];
      if (remote) {
        const r = await sh("git", ["push", "-q", remote, p.base_ref], { cwd: p.repo });
        pushed = r.code === 0 ? remote : `failed: ${r.stderr.trim()}`;
      }
      this.store.tx(() => {
        this.store.setSetting(`ship:${f.id}`, "");
        this.store.setStage(f.id, "done", actor);
        this.store.event("shipped", { actor, project: f.project_id, feature: f.id, detail: { head: headSha, merged: mergedAt, base: p.base_ref, pushed } });
      });
      return { merged: mergedAt, pushed };
    });
  }

  /** After a restart, a feature stuck in Verify is verified again. */
  async recover() {
    for (const v of this.store.all<Verification>("SELECT * FROM verifications WHERE status='running'"))
      this.store.run("UPDATE verifications SET status='failed', failure='INTERRUPTED', ended_at=datetime('now') WHERE id=?", v.id);
    for (const f of this.store.features().filter((x) => x.stage === "verify" && x.status === "active")) {
      const v = this.verification(f.id);
      if (v && v.failure !== "INTERRUPTED") continue;
      await this.verify(f.id, "system", true).catch((e) => this.store.event("verify_error", { feature: f.id, detail: { error: String(e) } }));
    }
    await this.checkBuildDone();
  }
}

/** Undo anything a check or the reviewer left in the verify worktree: tracked changes, commits and
 * untracked files that aren't ignored. Ignored files (build caches, setup output) stay, as in your checkout. */
async function cleanTo(path: string, sha: string) {
  await git(path, "reset", "-q", "--hard", sha);
  await git(path, "clean", "-fdq");
}

async function mergeInto(path: string, sha: string, message: string) {
  const m = await sh("git", [...FOUNDRY_IDENT, "merge", "--no-ff", "-q", "-m", message, sha], { cwd: path, env: identEnv(FOUNDRY_IDENT) });
  if (m.code !== 0) {
    const conflicts = (await git(path, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
    await sh("git", ["merge", "--abort"], { cwd: path });
    throw new FoundryError("MERGE_CONFLICT", `Merging into base conflicts in: ${conflicts.join(", ")}. Run Verify again to merge base in and see it.`, { paths: conflicts });
  }
  return head(path);
}

/** The worktree where a branch is checked out, if any. */
export async function checkedOutAt(repo: string, branch: string): Promise<string | null> {
  const out = await git(repo, "worktree", "list", "--porcelain");
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}
