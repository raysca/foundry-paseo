// Verify and Ship: close loop 1. Verify checks what would ship (base merged in, every task's checks on
// a fresh check workspace at the merged head, a reviewer's per-requirement report) and never changes
// code itself apart from merging base. Ship opens a GitHub PR (pr mode, with a remote) and follows it,
// or merges the feature into base at the SHA you read under the base-integration rule (local merge).
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesFromBase, paseoScripts, resolveChecks, tail, type ResolvedChecks, type TaskChecks } from "./checks";
import { assertIntegrationUntouched, featureDir } from "./features";
import { changedPaths, FOUNDRY_IDENT, git, head, identEnv, sh, treeOf } from "./git";
import type { Host } from "./host";
import type { Locks } from "./locks";
import { projectLoops, resolveLoop, type LoopStep } from "./loops";
import { createPr, editPrBase, firstRemote, pushBranch, redact, viewPr, type PrInfo } from "./github";
import { FoundryError, type Actor } from "./model";
import { activeSlices, frontSlice, issuesThrough, openPromoted, parentRef, pickTarget, requirementsThrough, setTargetHead, setTargetStage, shipFront, shipKey, sliceOfIssue, startNextSlice, target, type Promotion, type Target } from "./slices";
import { parse, type Feature, type Slice, type Store } from "./store";

export interface Verification {
  id: number;
  feature_id: number;
  /** The slice it verified (with every slice before it). */
  slice_id: number | null;
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

/** The prepared ship, kept in settings as ship:<feature id> (ship:slice:<slice id> for a slice behind the front) until it lands or is dropped. */
export interface PreparedShip {
  sha: string;
  tree: string;
  mode: "pr" | "local_merge";
  pr?: { number: number; url: string; remote: string };
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

  /** The latest Verify of a slice (the front when none is named). */
  verification(featureId: number, sliceId?: number | null) {
    const s = sliceId === undefined ? (frontSlice(this.store, featureId)?.id ?? null) : sliceId;
    if (s === null) return this.store.get<Verification>("SELECT * FROM verifications WHERE feature_id=? ORDER BY id DESC LIMIT 1", featureId);
    return this.store.get<Verification>("SELECT * FROM verifications WHERE feature_id=? AND (slice_id=? OR slice_id IS NULL) ORDER BY id DESC LIMIT 1", featureId, s);
  }

  /** Start the next slice when the newest active one reached Ship; its Ready tasks then auto-start. */
  private async startNext(featureId: number) {
    try {
      if (await startNextSlice(this.store, this.host, featureId)) await this.onBuild();
    } catch (e) {
      this.store.event("slice_start_error", { feature: featureId, detail: { error: String(e instanceof Error ? e.message : e) } });
    }
  }

  // ---------- Build → Verify ----------
  /**
   * A slice's Build ends when every task of the slice is Done or Cancelled (a feature without slices:
   * every task). Called on each accept and from the scheduler tick.
   */
  async checkBuildDone() {
    for (const f of this.store.features().filter((x) => ["build", "verify", "ship"].includes(x.stage) && x.status === "active" && !x.spec_change_open)) {
      const sliced = this.store.slices(f.id).length > 0;
      const targets: Target[] = sliced ? activeSlices(this.store, f.id).filter((s) => s.status === "building").map((s) => target(this.store, f.id, s.id)) : f.stage === "build" ? [target(this.store, f.id)] : [];
      for (const t of targets) {
        if (t.front && t.feature.stage !== "build") continue;
        const all = this.store.issues({ featureId: f.id });
        const issues = t.slice ? all.filter((i) => sliceOfIssue(this.store, i)?.id === t.slice!.id) : all;
        if (!issues.length || issues.some((i) => !["Done", "Cancelled"].includes(i.status))) continue;
        setTargetStage(this.store, t, "verify");
        await this.verify(f.id, "system", false, t.slice?.id ?? null).catch((e) => this.store.event("verify_error", { feature: f.id, detail: { error: String(e), slice: t.slice?.n ?? null } }));
      }
      if (sliced) await this.startNext(f.id);
    }
  }

  // ---------- Verify ----------
  async verify(featureId: number, actor: Actor = "you", force = false, sliceId?: number | null) {
    if (!this.store.feature(featureId)) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
    const t0 = pickTarget(this.store, featureId, sliceId, (s) => s.status === "verify" || s.status === "ship");
    const f0 = t0.view;
    if (f0.status === "cancelled") throw new FoundryError("FEATURE_CLOSED", "This feature is cancelled");
    if (!["verify", "ship"].includes(f0.stage)) throw new FoundryError("WRONG_STAGE", `The feature is in ${f0.stage}; Verify runs once Build ends`);
    if (f0.spec_change_open) throw new FoundryError("SPEC_CHANGE_OPEN", "The spec changed: approve its change set or discard it first");
    // From Ship, Verify runs again while no PR is open (for example when base moved on); a prepared local merge is dropped.
    const open0 = this.preparedFor(t0)?.pr;
    if (f0.stage === "ship" && open0) throw new FoundryError("PR_OPEN", "A PR is open for this feature: merge or close it on GitHub first", { url: open0.url });
    const r = await this.locks.with(`feature:${featureId}`, async () => {
      const t = target(this.store, featureId, t0.slice?.id ?? null);
      const f = t.view;
      const sid = t.slice?.id ?? null;
      const last = this.verification(f.id, sid);
      if (last?.status === "running") throw new FoundryError("VERIFY_RUNNING", "Verify is already running");
      await assertIntegrationUntouched(this.store, f);
      const p = this.store.project(f.project_id)!;
      // 1. Merge base into the feature branch (a slice behind the front: the slice before it).
      const path = f.integration_path!;
      const parent = parentRef(this.store, t);
      const m = await sh("git", [...FOUNDRY_IDENT, "merge", "--no-ff", "-q", "-m", `merge ${parent} into ${f.branch}`, parent], { cwd: path, env: identEnv(FOUNDRY_IDENT) });
      if (m.code !== 0) {
        const conflicts = (await git(path, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
        await sh("git", ["merge", "--abort"], { cwd: path });
        const v = this.newVerification(f, sid, await head(path), "failed", "BASE_CONFLICT");
        this.store.event("verify_done", { actor: "system", project: f.project_id, feature: f.id, detail: { verification: v, failure: "BASE_CONFLICT", paths: conflicts, slice: t.slice?.n ?? null, parent } });
        return { verification: v, failure: "BASE_CONFLICT" } as const;
      }
      const sha = await head(path);
      if (sha !== f.head_sha) setTargetHead(this.store, t, sha);
      if (!force && last?.status === "passed" && last.head_sha === sha) return { skipped: true, verification: last.id } as const;
      if (f.stage === "ship") {
        this.store.setSetting(shipKey(t), "");
        setTargetStage(this.store, t, "verify", actor);
      }
      const id = this.newVerification(f, sid, sha, "running", null);
      this.store.event("verify_started", { actor, project: f.project_id, feature: f.id, detail: { verification: id, head: sha, slice: t.slice?.n ?? null } });
      return { verification: id, sha, sid } as const;
    });
    if ("skipped" in r || "failure" in r) return r;
    // Checks and the reviewer run in the background; the feature view follows the verification row.
    this.track(this.runVerification(featureId, r.verification, r.sha, r.sid));
    return { verification: r.verification, head: r.sha };
  }

  private async runVerification(featureId: number, verificationId: number, sha: string, sliceId: number | null) {
    const r = { verification: verificationId, sha };
    // 2. Checks: every non-cancelled task's of this slice and the ones before it, plus the default loop's
    // check step, at the merged head (no fix rounds).
    const t = target(this.store, featureId, sliceId);
    const f = t.view;
    const p = this.store.project(f.project_id)!;
    try {
      // A fresh hidden workspace at the merged head, so Paseo runs the project's setup on the merged code
      // (Paseo has no call to re-run setup in the integration worktree: upstream ask).
      const ws = await this.host.createWorktreeWorkspace({
        repo: p.repo,
        title: `${f.title} verify`,
        slug: `${f.slug}-verify-${r.verification}`,
        from: r.sha,
        purpose: "verify",
        visible: false,
      });
      this.store.recordBranch(p.repo, ws.branch, "verify");
      this.store.run("UPDATE verifications SET workspace_id=?, path=? WHERE id=?", ws.workspaceId, ws.path, r.verification);
      const union: TaskChecks = { scripts: [], paths: [] };
      for (const i of issuesThrough(this.store, f.id, t.slice).filter((x) => x.status !== "Cancelled")) {
        const c = parse<TaskChecks>(i.checks, {});
        for (const s of c.scripts ?? []) if (!union.scripts!.includes(s)) union.scripts!.push(s);
        for (const x of c.paths ?? []) if (!union.paths!.includes(x)) union.paths!.push(x);
      }
      const loop = resolveLoop(null, p.default_loop, await projectLoops(p.repo, p.base_ref));
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
      const reqs = requirementsThrough(this.store, f.id, t.slice);
      const total = this.store.slices(f.id).filter((s) => s.status !== "cancelled").length;
      const agentId = randomUUID();
      this.store.run("UPDATE verifications SET reviewer_agent_id=? WHERE id=?", agentId, r.verification);
      await this.host.startAgent({
        agentId,
        role: "reviewer",
        place: { kind: "workspace", workspaceId: ws.workspaceId },
        prompt: [
          `You are Foundry's reviewer verifying the feature "${f.title}" at ${r.sha} before it ships.`,
          ...(t.slice && total > 1 ? [`This is slice ${t.slice.n} of ${total} ("${t.slice.title}"). It ships with the slices before it; check only the requirements listed here.`] : []),
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

  private newVerification(f: Feature, sliceId: number | null, sha: string, status: string, failure: string | null) {
    const res = this.store.run("INSERT INTO verifications(feature_id,slice_id,head_sha,status,failure) VALUES(?,?,?,?,?)", f.id, sliceId, sha, status, failure);
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
    const all = requirementsThrough(this.store, v.feature_id, v.slice_id ? (this.store.slice(v.slice_id) ?? null) : null).map((r) => r.ref);
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
    const live = v.slice_id ? this.store.slice(v.slice_id) : null;
    const t = target(this.store, f.id, live && live.status !== "shipped" && live.status !== "cancelled" ? live.id : null);
    if (v.workspace_id) void this.host.archiveWorkspace(v.workspace_id).catch(() => {});
    this.store.tx(() => {
      this.store.run("UPDATE verifications SET status=?, failure=?, ended_at=datetime('now') WHERE id=?", failure ? "failed" : "passed", failure, id);
      if (!failure && t.view.stage === "verify") setTargetStage(this.store, t, "ship");
      this.store.event("verify_done", { actor: "system", project: f.project_id, feature: f.id, detail: { verification: id, failure, detail, slice: t.slice?.n ?? null } });
    });
    if (!failure) this.track(this.startNext(f.id));
    const name = t.slice && this.store.slices(f.id).length > 1 ? `${f.title}, slice ${t.slice.n}` : f.title;
    void this.host.notify({
      title: failure ? `${name}: Verify found gaps (${failure})` : `${name} is verified and ready to ship`,
      body: detail ?? (failure ? "Ship with the gaps, turn a failure into a task, or run Verify again." : "Prepare and accept the ship."),
      key: `verify:${f.id}`,
      screen: "feature",
    });
  }

  /** Ship with the gaps: each failed requirement and check is recorded (ledger shortcut entries arrive with the ledger). */
  async shipWithGaps(featureId: number, actor: Actor = "you", sliceId?: number | null) {
    const out = await this.locks.with(`feature:${featureId}`, async () => {
      const t = this.failedTarget(featureId, sliceId);
      const f = t.view;
      const v = this.verification(featureId, t.slice?.id ?? null);
      if (f.stage !== "verify" || v?.status !== "failed") throw new FoundryError("WRONG_STAGE", "There are no Verify gaps to accept");
      const gaps = [
        ...parse<{ name: string; status: string }[]>(v.checks, []).filter((c) => c.status !== "passed").map((c) => `check ${c.name}`),
        ...parse<RequirementResult[]>(v.requirements, []).filter((r) => !r.passed).map((r) => r.requirement_ref),
      ];
      this.store.tx(() => {
        this.store.event("shipped_with_gaps", { actor, project: f.project_id, feature: f.id, detail: { verification: v.id, failure: v.failure, gaps, slice: t.slice?.n ?? null } });
        setTargetStage(this.store, t, "ship", actor);
      });
      return { gaps };
    });
    await this.startNext(featureId);
    return out;
  }

  /** The slice whose Verify failed (the one named, else the first active slice with a failed Verify, else the front). */
  private failedTarget(featureId: number, sliceId?: number | null) {
    return pickTarget(this.store, featureId, sliceId, (s) => s.status === "verify" && this.verification(featureId, s.id)?.status === "failed");
  }

  /** Turn a Verify failure into a task of the feature; the feature goes back to Build. */
  async taskFromFailure(featureId: number, title: string, description: string, requirementRefs: string[] = [], actor: Actor = "you", sliceId?: number | null) {
    if (!title.trim()) throw new FoundryError("TITLE_REQUIRED", "A task needs a title");
    const key = await this.locks.with(`feature:${featureId}`, async () => {
      const t = this.failedTarget(featureId, sliceId);
      const f = t.view;
      if (f.stage !== "verify" || this.verification(featureId, t.slice?.id ?? null)?.status !== "failed") throw new FoundryError("WRONG_STAGE", "Turn a failure into a task after Verify reports one");
      const live = new Set(this.store.requirements(f.id).map((q) => q.ref));
      const unknown = requirementRefs.filter((x) => !live.has(x));
      if (unknown.length) throw new FoundryError("TASKS_INVALID", `Not requirements of this feature: ${unknown.join(", ")}`);
      return this.store.tx(() => {
        // Nothing depends on it, so its critical-path priority is the base priority.
        const i = this.store.createIssue({ projectId: f.project_id, featureId: f.id, origin: "feature", title, description, status: "Ready", priority: 50, requirementRefs, sliceId: t.slice?.id ?? this.store.openSlice(f.id)?.id ?? null, actor });
        setTargetStage(this.store, t, "build", actor);
        this.store.event("task_from_verify", { actor, project: f.project_id, feature: f.id, issue: i.key, detail: { slice: t.slice?.n ?? null } });
        return i.key;
      });
    });
    await this.onBuild();
    return { issue: key };
  }

  // ---------- Ship ----------
  /** The front slice's prepared ship. */
  prepared(featureId: number) {
    return parse<PreparedShip | null>(this.store.setting(`ship:${featureId}`), null);
  }
  preparedFor(t: Target) {
    return parse<PreparedShip | null>(this.store.setting(shipKey(t)), null);
  }

  /**
   * Prepare: records the ship SHA. In pr mode with a remote it pushes the feature branch and opens a PR
   * with gh; without a remote, or in local_merge, it prepares a local merge.
   */
  async prepare(featureId: number, actor: Actor = "you", sliceId?: number | null) {
    return this.locks.with(`feature:${featureId}`, async () => {
      if (!this.store.feature(featureId)) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
      const t = pickTarget(this.store, featureId, sliceId, (s) => s.status === "ship" && !this.preparedFor(target(this.store, featureId, s.id)));
      const f = t.view;
      if (f.stage !== "ship" || f.status !== "active") throw new FoundryError("WRONG_STAGE", "Prepare runs in Ship on an active feature");
      if (f.spec_change_open) throw new FoundryError("SPEC_CHANGE_OPEN", "The spec changed: approve its change set or discard it first");
      const before = this.preparedFor(t);
      if (before?.pr) throw new FoundryError("PR_OPEN", "A PR is already open for this feature", { url: before.pr.url });
      await assertIntegrationUntouched(this.store, f);
      const p = this.store.project(f.project_id)!;
      const sha = f.head_sha!;
      const tree = await treeOf(f.integration_path!, sha);
      const remote = p.ship_mode === "pr" ? await firstRemote(p.repo) : null;
      let ship: PreparedShip = { sha, tree, mode: "local_merge" };
      // A slice behind the front opens a stacked PR into the slice before it; it is retargeted at base once that one merges.
      const base = parentRef(this.store, t);
      if (remote) {
        if (base !== p.base_ref) await pushBranch(p.repo, remote, base);
        await pushBranch(p.repo, remote, f.branch);
        // A PR still open for the branch (new commits sent the feature back to Verify) carries the new head.
        const open = await viewPr(p.repo, f.branch).catch(() => null);
        const pr = open?.state === "OPEN" ? open : await createPr(p.repo, { base, branch: f.branch, title: this.prTitle(t), body: await this.prBody(t) });
        ship = { sha, tree, mode: "pr", pr: { number: pr.number, url: pr.url, remote } };
      }
      this.store.setSetting(shipKey(t), JSON.stringify(ship));
      this.store.event("ship_prepared", { actor, project: f.project_id, feature: f.id, detail: { sha, mode: ship.mode, pr: ship.pr?.url ?? null, base, slice: t.slice?.n ?? null, why: !remote && p.ship_mode === "pr" ? "no remote" : undefined } });
      return ship;
    });
  }

  /** The PR body: spec summary, requirement report and task list, with anything that looks like a secret blanked out. */
  private prTitle(t: Target) {
    const total = this.store.slices(t.feature.id).filter((s) => s.status !== "cancelled").length;
    return t.slice && total > 1 ? `${t.feature.title} (${t.slice.n}/${total}): ${t.slice.title}` : t.feature.title;
  }

  private async prBody(t: Target) {
    const f = t.view;
    const spec = this.store.doc(f.id, "spec");
    const text = spec?.approved_sha ? await git(f.integration_path!, "show", `${spec.approved_sha}:${featureDir(f.slug)}/spec.md`).catch(() => "") : "";
    const goal = /## Goal\s*\n([\s\S]*?)(?=\n## |$)/.exec(text)?.[1]?.trim() ?? f.idea;
    const v = this.verification(f.id, t.slice?.id ?? null);
    const reqs = parse<RequirementResult[]>(v?.requirements ?? "[]", []);
    const titles = new Map(this.store.requirements(f.id).map((r) => [r.ref, r.title]));
    const slices = this.store.slices(f.id).filter((s) => s.status !== "cancelled");
    const all = this.store.issues({ featureId: f.id });
    const issues = t.slice && slices.length > 1 ? all.filter((i) => sliceOfIssue(this.store, i)?.id === t.slice!.id) : all;
    const order = t.slice && slices.length > 1 ? this.mergeOrderNote(t, slices) : null;
    const body = [
      `## Summary\n\n${goal}`,
      ...(order ? [order] : []),
      `## Requirements\n\n${reqs.length ? reqs.map((r) => `- ${r.passed ? "✅" : "❌"} **${r.requirement_ref}** ${titles.get(r.requirement_ref) ?? ""}: ${r.evidence}`).join("\n") : "_No requirement report._"}`,
      `## Tasks\n\n${issues.map((i) => `- ${i.status === "Done" ? "[x]" : "[ ]"} ${i.key} ${i.title}${i.status === "Done" ? "" : ` (${i.status})`}`).join("\n") || "_None._"}`,
      `---\n_Shipped by Foundry from \`${f.branch}\` at ${f.head_sha?.slice(0, 10)}. Spec, plan and tasks are in \`${featureDir(f.slug)}/\`._`,
    ].join("\n\n");
    return redact(body);
  }

  private mergeOrderNote(t: Target, slices: Slice[]) {
    const s = t.slice!;
    const before = slices.filter((x) => x.n < s.n && x.status !== "shipped");
    const prev = before[before.length - 1];
    const prevPr = prev ? this.preparedFor(target(this.store, t.feature.id, prev.id))?.pr : null;
    const lines = [`## Slice ${s.n} of ${slices.length}: ${s.title}`, s.goal ?? ""];
    if (prev) lines.push(`Merge after slice ${prev.n}${prevPr ? ` (#${prevPr.number})` : ""}. Foundry retargets this PR at base once that one merges.`);
    else lines.push(s.n > 1 ? "The slices before it are merged." : "Merges first.");
    return lines.filter(Boolean).join("\n\n");
  }

  /** Accept the prepared ship at the head and tree you read: merge the feature into base. */
  async acceptShip(featureId: number, headSha: string, treeSha: string, o: { confirmCheckedOut?: boolean; slice?: number | null } = {}, actor: Actor = "you") {
    const r = await this.locks.with(`feature:${featureId}`, async () => {
      const t = target(this.store, featureId, o.slice ?? null);
      if (!t.front) {
        const front = frontSlice(this.store, featureId)!;
        throw new FoundryError("SLICE_ORDER", `Slice ${t.slice!.n} merges after slice ${front.n}: ship slice ${front.n} first`, { slice: t.slice!.n, front: front.n });
      }
      const f = t.feature;
      const prepared = this.prepared(f.id);
      if (f.stage !== "ship" || !prepared) throw new FoundryError("NOT_PREPARED", "Prepare the ship first");
      if (f.spec_change_open) throw new FoundryError("SPEC_CHANGE_OPEN", "The spec changed: approve its change set or discard it first");
      if (prepared.pr) throw new FoundryError("PR_OPEN", "Merge the PR on GitHub; Foundry sees it at its next check", { url: prepared.pr.url });
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
        // git reports real paths (on macOS /private/var/... for /var/...), so compare real paths.
        const owned = this.store.ownedPaths().some((x) => real(x) === real(where));
        if (!owned && !o.confirmCheckedOut) throw new FoundryError("BASE_CHECKED_OUT", `${p.base_ref} is checked out at ${where}. Confirm to merge there.`, { path: where });
        mergedAt = await mergeInto(where, headSha, msg);
      }
      let pushed: string | null = null;
      const remote = (await sh("git", ["remote"], { cwd: p.repo })).stdout.trim().split("\n").filter(Boolean)[0];
      if (remote) {
        const r = await sh("git", ["push", "-q", remote, p.base_ref], { cwd: p.repo });
        pushed = r.code === 0 ? remote : `failed: ${r.stderr.trim()}`;
      }
      const promo = this.store.tx(() => shipFront(this.store, f.id, actor, { kind: "shipped", detail: { head: headSha, merged: mergedAt, base: p.base_ref, pushed } }));
      return { merged: mergedAt, pushed, promo };
    });
    await this.afterPromotion(featureId, r.promo);
    return { merged: r.merged, pushed: r.pushed, next_slice: r.promo?.slice.n ?? null };
  }

  /**
   * The front slice shipped and the next one became the front: a slice that never started gets its
   * workspace from base, its open PR is retargeted at base, a prepared local merge is verified again, and
   * the slice after it may start.
   */
  private async afterPromotion(featureId: number, promo: Promotion | null) {
    if (!promo) return;
    const f = this.store.feature(featureId)!;
    const p = this.store.project(f.project_id)!;
    try {
      if (!promo.slice.path) await openPromoted(this.store, this.host, featureId, promo.slice);
      if (promo.pr) {
        await editPrBase(p.repo, promo.pr.number, p.base_ref);
        this.store.event("pr_retargeted", { actor: "system", project: f.project_id, feature: f.id, detail: { url: promo.pr.url, base: p.base_ref, slice: promo.slice.n } });
      }
    } catch (e) {
      this.store.event("slice_promote_error", { feature: featureId, detail: { slice: promo.slice.n, error: String(e instanceof Error ? e.message : e) } });
      void this.host.notify({ title: `${f.title}: slice ${promo.slice.n} needs a hand`, body: String(e instanceof Error ? e.message : e), key: `slice-promote:${promo.slice.id}`, screen: "feature" });
    }
    if (promo.reverify) this.track(this.verify(featureId, "system", true).catch((e) => this.store.event("verify_error", { feature: featureId, detail: { error: String(e) } })));
    await this.startNext(featureId);
    await this.onBuild();
  }

  /**
   * Follow open PRs (every 5 minutes from the scheduler, and on Refresh). Merged moves the feature to
   * Done; closed unmerged leaves it in Ship to prepare again; new commits on the feature branch after the
   * PR opened send it back to Verify.
   */
  async refreshPrs(only?: number, actor: Actor = "system") {
    const out: { feature: number; result: string }[] = [];
    // While a spec change is open the PR is left alone: what it would merge is decided by the change set.
    for (const f of this.store.features().filter((x) => x.stage === "ship" && !x.spec_change_open && (only === undefined || x.id === only))) {
      const ship = this.prepared(f.id);
      if (!ship?.pr) continue;
      const p = this.store.project(f.project_id)!;
      let pr: PrInfo;
      try {
        pr = await viewPr(p.repo, ship.pr.number);
      } catch (e) {
        this.store.event("pr_check_failed", { actor, project: f.project_id, feature: f.id, detail: { error: String(e instanceof Error ? e.message : e) } });
        if (only !== undefined) throw e;
        continue;
      }
      let promo: Promotion | null = null;
      const result = await this.locks.with(`feature:${f.id}`, async () => {
        const cur = this.store.feature(f.id)!;
        if (cur.stage !== "ship") return "moved";
        if (pr.state === "MERGED") {
          promo = this.store.tx(() => shipFront(this.store, f.id, actor, { kind: "pr_merged", detail: { url: pr.url, head: pr.headRefOid } }));
          return "merged";
        }
        if (pr.state === "CLOSED") {
          this.store.tx(() => {
            this.store.setSetting(`ship:${f.id}`, "");
            this.store.event("pr_closed", { actor, project: f.project_id, feature: f.id, detail: { url: pr.url } });
          });
          void this.host.notify({ title: `${f.title}: the PR was closed without merging`, body: "Prepare the ship again to open a new one.", key: `pr-closed:${f.id}`, screen: "feature" });
          return "closed";
        }
        const local = (await sh("git", ["rev-parse", f.branch], { cwd: p.repo })).stdout.trim();
        if (pr.headRefOid !== ship.sha || (local && local !== ship.sha)) {
          // New commits after the PR opened: what would ship is no longer what was verified.
          this.store.tx(() => {
            this.store.setSetting(`ship:${f.id}`, "");
            this.store.setStage(f.id, "verify", actor);
            this.store.event("pr_new_commits", { actor, project: f.project_id, feature: f.id, detail: { url: pr.url, prepared: ship.sha, pr_head: pr.headRefOid, local } });
          });
          return "reverify";
        }
        return "open";
      });
      if (result === "reverify") this.track(this.verifyAfterPr(f.id));
      if (result === "merged") await this.afterPromotion(f.id, promo);
      out.push({ feature: f.id, result });
    }
    return out;
  }

  /** New commits reached the PR's branch: bring the integration worktree to them, then verify again. */
  private async verifyAfterPr(featureId: number) {
    const f = this.store.feature(featureId)!;
    const p = this.store.project(f.project_id)!;
    const remote = await firstRemote(p.repo);
    if (remote) {
      // Someone pushed to the PR branch on GitHub: take their commits into the feature branch (fast-forward only).
      await sh("git", ["fetch", "-q", remote, f.branch], { cwd: f.integration_path! });
      const ff = await sh("git", ["merge", "--ff-only", "-q", "FETCH_HEAD"], { cwd: f.integration_path! });
      if (ff.code === 0) this.store.updateFeature(f.id, { head_sha: await head(f.integration_path!) });
    }
    await this.verify(featureId, "system", true).catch((e) => this.store.event("verify_error", { feature: featureId, detail: { error: String(e) } }));
  }

  /** After a restart, a feature stuck in Verify is verified again. */
  async recover() {
    for (const v of this.store.all<Verification>("SELECT * FROM verifications WHERE status='running'"))
      this.store.run("UPDATE verifications SET status='failed', failure='INTERRUPTED', ended_at=datetime('now') WHERE id=?", v.id);
    for (const f of this.store.features().filter((x) => ["verify", "ship", "build"].includes(x.stage) && x.status === "active")) {
      // The front, and a slice behind it that was in Verify.
      const behind = activeSlices(this.store, f.id).filter((s) => s.status === "verify" && s.id !== frontSlice(this.store, f.id)?.id);
      const todo: (number | null)[] = [...(f.stage === "verify" ? [frontSlice(this.store, f.id)?.id ?? null] : []), ...behind.map((s) => s.id)];
      for (const sid of todo) {
        const v = this.verification(f.id, sid);
        if (v && v.failure !== "INTERRUPTED") continue;
        await this.verify(f.id, "system", true, sid).catch((e) => this.store.event("verify_error", { feature: f.id, detail: { error: String(e) } }));
      }
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

function real(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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
