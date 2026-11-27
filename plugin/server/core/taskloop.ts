// Loop 2: the task loop. A task runs unattended in its own worktree through its loop (builder turn,
// runner checks, reviewer) and comes back as committed code bound to a SHA. The runner, not the agent,
// decides whether it passed. Concurrency is Paseo's: Foundry decides only the order work starts in.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { filesFromBase, paseoScripts, resolveChecks, tail, type TaskChecks } from "./checks";
import { assertIntegrationUntouched, featureAllowsAutoStart, featureDir, steering } from "./features";
import { changedPaths, commitAll, FOUNDRY_IDENT, git, head, HOST_IDENT, identEnv, sh, treeOf } from "./git";
import type { Host } from "./host";
import type { Locks } from "./locks";
import { resolveLoop, stepIndex, type LoopDef, type LoopStep } from "./loops";
import { FoundryError, type Actor, type AttemptOutcome, type IssueStatus, type ReasonCode, type Verdict } from "./model";
import { parse, type Attempt, type Issue, type Question, type Store } from "./store";

export interface LoopSettings {
  maxFixRounds: number;
  questionWindowMs: number;
  checkTimeoutMs: number;
}

interface VerdictInput {
  decision: Verdict;
  reason: string;
  action_required?: string;
  findings?: { severity: string; title: string; evidence?: string }[];
  issue_key?: string;
}

const END_TURN_MESSAGE =
  "Your question is waiting for the developer. Stop here and end your turn without further changes; the answer will arrive as your next message.";

export class TaskLoop {
  private liveQuestions = new Map<number, (answer: string | null) => void>();
  private verdicts = new Map<number, { role: "builder" | "reviewer"; v: VerdictInput }>();
  private ticking = false;
  private retick = false;

  constructor(
    private store: Store,
    private host: Host,
    private locks: Locks,
    private settings: LoopSettings,
    private beforeStart: () => Promise<void> = async () => {},
  ) {}

  // ---------- scheduler ----------
  /** Free Backlog issues whose dependencies are Done, then start Ready ones by priority, then age. */
  async tick() {
    if (this.ticking) {
      this.retick = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.retick = false;
        this.promoteBacklog();
        for (const i of this.store.issues({ status: "Ready" })) {
          if (!this.mayAutoStart(i)) continue;
          if (this.unmetDeps(i.key).length) continue;
          await this.start(i.key, "system").catch((e) => {
            if (!(e instanceof FoundryError)) this.store.event("start_error", { issue: i.key, detail: { error: String(e) } });
          });
        }
      } while (this.retick);
    } finally {
      this.ticking = false;
    }
  }

  private promoteBacklog() {
    for (const i of this.store.issues({ status: "Backlog" }))
      if (this.store.deps(i.key).length && !this.unmetDeps(i.key).length) this.store.setIssueStatus(i.key, "Ready", "system", null, { why: "dependencies done" });
  }

  unmetDeps(key: string) {
    return this.store
      .deps(key)
      .map((d) => this.store.issue(d.depends_on)!)
      .filter((d) => d.status !== "Done")
      .map((d) => d.key);
  }

  private mayAutoStart(i: Issue) {
    if (i.flag === "LOOP_MISSING") return false;
    if (i.origin === "discovered") return false;
    if (!i.feature_id) return false; // quick tasks auto-start only with the project switch (M3)
    const f = this.store.feature(i.feature_id)!;
    return featureAllowsAutoStart(this.store, f);
  }

  // ---------- start ----------
  async start(key: string, actor: Actor) {
    const i = this.store.issue(key);
    if (!i) throw new FoundryError("NOT_FOUND", `No issue ${key}`);
    const waiting = this.unmetDeps(key);
    if (waiting.length) throw new FoundryError("DEPENDENCIES_NOT_DONE", `${key} waits for ${waiting.join(", ")}`, { waiting_for: waiting });
    if (i.status !== "Ready") {
      if (actor === "system") return;
      if (!["Backlog", "Failed", "Blocked"].includes(i.status)) throw new FoundryError("INVALID_TRANSITION", `Cannot start ${key} from ${i.status}`, { current: i.status });
      this.store.setIssueStatus(key, "Ready", actor, null, { why: "started" });
    }
    if (this.store.activeAttempts().some((a) => a.issue_key === key)) return; // a double start cannot start it twice
    await this.beforeStart();

    const project = this.store.project(i.project_id)!;
    let loop: LoopDef;
    try {
      loop = resolveLoop(i.loop, project.default_loop);
    } catch (e) {
      if (e instanceof FoundryError && e.code === "LOOP_MISSING") {
        this.store.updateIssue(key, { flag: "LOOP_MISSING" });
        this.store.event("loop_missing", { issue: key, detail: e.detail });
      }
      throw e;
    }
    if (i.flag === "LOOP_MISSING") this.store.updateIssue(key, { flag: null });

    const feature = i.feature_id ? this.store.feature(i.feature_id)! : null;
    const fromRef = feature ? feature.branch : project.base_ref;
    const branch = `foundry/task/${key}/${randomUUID().slice(0, 6)}`;
    const agentId = randomUUID();
    const a = this.store.tx(() => {
      const a = this.store.createAttempt(key, branch, loop);
      this.store.updateAttempt(a.id, { builder_agent_id: agentId, step: "build", step_index: 0 });
      this.store.setIssueStatus(key, "In_Progress", actor, null, { attempt: a.n });
      return a;
    });
    const runId = this.store.startRun("agent", { attempt: a.id, agent: agentId });
    const prompt = await this.builderPrompt(i, loop);
    // Held while the agent starts: a fast agent can end its turn before startAgent returns, and that
    // turn's end must see the worktree recorded.
    await this.locks.with(`attempt:${key}`, async () => {
      try {
        const started = await this.host.startAgent({
          agentId,
          role: "builder",
          place: { kind: "new-worktree", repo: project.repo, branch, fromRef, visible: true },
          prompt,
          title: `${key} ${i.title}`.slice(0, 80),
          profile: i.profile,
          issueKey: key,
          attemptId: a.id,
          featureId: i.feature_id,
          projectId: i.project_id,
        });
        const base = await head(started.path);
        this.store.updateAttempt(a.id, { workspace_id: started.workspaceId, worktree_path: started.path, head_sha: base, tree_sha: await treeOf(started.path, base) });
      } catch (e) {
        this.store.endRun(runId, "failed", { error: String(e) });
        this.endAttempt(a.id, "failed", { issueStatus: "Blocked", reason: "INFRA_ERROR", detail: `could not start the builder: ${String(e)}` });
      }
    });
    return this.store.attempt(a.id)!;
  }

  private async builderPrompt(i: Issue, loop: LoopDef) {
    const deps = this.store.deps(i.key).map((d) => `- ${d.depends_on}${d.reason ? `: ${d.reason}` : ""}`);
    const touches = parse<string[]>(i.touches, []);
    const checks = parse<TaskChecks>(i.checks, {});
    const f = i.feature_id ? this.store.feature(i.feature_id) : null;
    const step = loop.steps[0] as Extract<LoopStep, { kind: "agent" }>;
    const p = this.store.project(i.project_id)!;
    const reqRefs = parse<string[]>(i.requirement_refs, []);
    const reqs = f ? this.store.requirements(f.id).filter((r) => reqRefs.includes(r.ref)) : [];
    return [
      `You are a Foundry builder working on ${i.key}: ${i.title}.`,
      i.description,
      reqs.length ? `Requirements it covers:\n${reqs.map((r) => `- ${r.ref} ${r.title}: ${parse<string[]>(r.criteria, []).join(" ")}`).join("\n")}` : "",
      i.acceptance ? `Acceptance criteria:\n${i.acceptance}` : "",
      deps.length ? `It builds on:\n${deps.join("\n")}` : "",
      touches.length ? `Expected to touch: ${touches.join(", ")}` : "",
      checks.scripts?.length || checks.paths?.length
        ? `Checks for this task: ${[...(checks.scripts ?? []).map((s) => `script ${s}`), ...(checks.paths ?? []).map((p) => `path ${p} must exist`)].join("; ")}`
        : "",
      f ? `The approved spec and plan are in ${featureDir(f.slug)}/spec.md and plan.md. Read them first.` : "",
      step.prompt ?? "",
      await steering(p.repo, p.base_ref),
      "Make the change with tests. Do not commit: Foundry commits after your turn and runs the project's checks itself.",
      "If you need a decision from the developer, call the ask_human tool. If you can't do the task, call report_verdict with decision fail or human and say why.",
      "End your turn with a short summary of what you changed.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  // ---------- host events ----------
  async onTurnEnd(agentId: string, outcome: { kind: string; message?: string }, tracked: boolean) {
    const a = this.store.attemptByAgent(agentId);
    if (!a) return;
    await this.locks.with(`attempt:${a.issue_key}`, async () => {
      const fresh = this.store.attempt(a.id)!;
      try {
        if (!tracked) return await this.recordUntracked(fresh, agentId, outcome.kind);
        if (fresh.ended_at) return;
        if (agentId === fresh.reviewer_agent_id) return await this.afterReview(fresh, outcome);
        if (agentId === fresh.builder_agent_id && (fresh.step === "build" || fresh.step === "fix")) return await this.afterBuilderTurn(fresh, outcome);
      } catch (e) {
        // A step Foundry could not carry out (git, a workspace, a script) must not leave the task stuck.
        for (const r of this.store.runs(a.id).filter((r) => r.status === "running")) this.store.endRun(r.id, "failed", { error: String(e) });
        this.endAttempt(a.id, "failed", { issueStatus: "Blocked", reason: "INFRA_ERROR", detail: String(e instanceof Error ? e.message : e) });
      }
    });
    await this.tick();
  }

  /** A turn Foundry did not start (someone messaged the agent in Paseo): record it, commit it apart, never let it drive the loop. */
  private async recordUntracked(a: Attempt, agentId: string, kind: string) {
    let commit: string | null = null;
    const dirty = a.worktree_path && existsSync(a.worktree_path) ? await changedPaths(a.worktree_path).catch(() => []) : [];
    if (dirty.length && a.worktree_path) {
      commit = await commitAll(a.worktree_path, `${a.issue_key}: edit from a turn Foundry did not start`, HOST_IDENT);
      if (commit) this.store.updateAttempt(a.id, { head_sha: commit, tree_sha: await treeOf(a.worktree_path, commit) });
    }
    this.store.event("untracked_edit", { actor: "host-user", issue: a.issue_key, attempt: a.id, detail: { agentId, outcome: kind, paths: dirty, commit } });
  }

  private async afterBuilderTurn(a: Attempt, outcome: { kind: string; message?: string }) {
    const run = this.openRun(a.id, a.builder_agent_id);
    const sha = await this.commitTurn(a);
    if (run) this.store.endRun(run, outcome.kind === "completed" ? "completed" : "failed", { outcome: outcome.kind, message: outcome.message }, sha);

    const waiting = this.store.get<Question>("SELECT * FROM questions WHERE attempt_id=? AND status IN ('live','waiting') ORDER BY id DESC", a.id);
    if (waiting) {
      if (waiting.status === "live") this.store.run("UPDATE questions SET status='waiting' WHERE id=?", waiting.id);
      return this.endAttempt(a.id, "needs_human", { issueStatus: "Awaiting_Human", detail: "waiting for your answer" });
    }
    if (outcome.kind !== "completed") {
      const reason: ReasonCode = outcome.kind === "canceled" ? "INTERRUPTED" : "AGENT_ERROR";
      return this.endAttempt(a.id, "failed", { reason, detail: `builder turn ${outcome.kind}${outcome.message ? `: ${outcome.message}` : ""}` });
    }
    const bv = this.verdicts.get(a.id);
    if (bv?.role === "builder") {
      this.verdicts.delete(a.id);
      if (bv.v.decision === "fail") return this.endAttempt(a.id, "failed", { reason: "AGENT_ERROR", detail: `builder: ${bv.v.reason}` });
      if (bv.v.decision === "human") return this.endAttempt(a.id, "needs_human", { flag: "BUILDER_NEEDS_HUMAN", detail: bv.v.action_required ?? bv.v.reason });
    }
    const loop = this.loopOf(a);
    // After a fix round the loop re-runs from the check step that failed; after a build, from the next step.
    const next = a.step === "fix" ? a.step_index : a.step_index + 1;
    this.store.updateAttempt(a.id, { step: "check", step_index: next });
    await this.advance(a.id, loop);
  }

  private async commitTurn(a: Attempt): Promise<string | null> {
    if (!a.worktree_path || !existsSync(a.worktree_path)) throw new Error(`${a.issue_key}'s worktree is missing (${a.worktree_path ?? "never recorded"})`);
    const made = await commitAll(a.worktree_path, `${a.issue_key}: builder turn`, FOUNDRY_IDENT);
    const sha = await head(a.worktree_path);
    this.store.updateAttempt(a.id, { head_sha: sha, tree_sha: await treeOf(a.worktree_path, sha) });
    if (made) this.store.event("commit", { actor: "system", issue: a.issue_key, attempt: a.id, detail: { sha, message: `${a.issue_key}: builder turn` } });
    return sha;
  }

  private loopOf(a: Attempt): LoopDef {
    return parse<LoopDef>(a.loop, resolveLoop(null, null));
  }

  private openRun(attemptId: number, agentId: string | null) {
    return this.store.get<{ id: number }>("SELECT id FROM runs WHERE attempt_id=? AND agent_id IS ? AND status='running' ORDER BY id DESC", attemptId, agentId)?.id;
  }

  // ---------- steps ----------
  /** Run Foundry-driven steps from the attempt's step_index until one waits on an agent or the loop ends. */
  private async advance(attemptId: number, loop: LoopDef) {
    for (;;) {
      const a = this.store.attempt(attemptId)!;
      if (a.ended_at) return;
      const step = loop.steps[a.step_index];
      if (!step) return this.finish(a);
      if (step.kind === "check") {
        const r = await this.runCheckStep(a, step);
        if (r === "passed" || r === "skipped") {
          this.store.updateAttempt(a.id, { step_index: a.step_index + 1 });
          continue;
        }
        return; // a fix round is running, or the attempt ended
      }
      if (step.kind === "review") return this.startReview(a, step);
      // An agent step past the first is a later builder turn in the same session.
      this.store.updateAttempt(a.id, { step: "build" });
      const run = this.store.startRun("agent", { attempt: a.id, agent: a.builder_agent_id, sha: a.head_sha });
      void run;
      await this.host.send(a.builder_agent_id!, step.prompt ?? `Continue with step "${step.name}".`);
      return;
    }
  }

  private async runCheckStep(a: Attempt, step: Extract<LoopStep, { kind: "check" }>): Promise<"passed" | "skipped" | "fixing" | "ended"> {
    const i = this.store.issue(a.issue_key)!;
    const p = this.store.project(i.project_id)!;
    if (!a.head_sha) throw new Error(`${a.issue_key} has no commit to check`);
    const sha = a.head_sha;
    const available = await paseoScripts(p.repo, p.base_ref);
    const checks = resolveChecks(step, parse<TaskChecks>(i.checks, {}), available);
    if (!checks.scripts.length && !checks.paths.length && !checks.unknown.length) {
      this.store.event("check_skipped", { issue: i.key, attempt: a.id, detail: { step: step.name, hint: 'Add scripts of type "script" to paseo.json.' } });
      return "skipped";
    }
    this.store.updateAttempt(a.id, { step: "check" });

    // A per-attempt check workspace at the committed SHA (Paseo runs setup when it creates it), with
    // paseo.json and the files its commands name restored from base so a task can't weaken its checks.
    let ws = a.check_workspace_id;
    let path = a.check_path;
    if (!ws || !path || !existsSync(path)) {
      const made = await this.host.createWorktreeWorkspace({
        repo: p.repo,
        title: `${i.key} checks`,
        branch: `foundry/check/${i.key}/${a.n}-${randomUUID().slice(0, 4)}`,
        from: sha,
        purpose: "check",
        visible: false,
      });
      ws = made.workspaceId;
      path = made.path;
      this.store.updateAttempt(a.id, { check_workspace_id: ws, check_path: path });
    }
    await git(path, "checkout", "-q", "--detach", "--force", sha);
    await git(path, "clean", "-fdq");
    const fromBase = await filesFromBase(p.repo, p.base_ref, checks.scripts);
    await git(path, "checkout", "-q", p.base_ref, "--", ...fromBase);

    const failures: { name: string; code: number; output: string }[] = [];
    for (const name of checks.unknown) failures.push({ name, code: 127, output: `paseo.json has no script "${name}" on ${p.base_ref}.` });
    // Every check runs, not stopping at the first failure.
    for (const s of checks.scripts) {
      const runId = this.store.startRun("check", { attempt: a.id, sha, detail: { name: s.name, command: s.command } });
      const timeoutMs = step.timeout_minutes ? step.timeout_minutes * 60_000 : this.settings.checkTimeoutMs;
      const r = await this.host.runScript({ workspaceId: ws, script: s.name, env: {}, timeoutMs });
      const status = r.code === 0 ? "passed" : "failed";
      this.store.endRun(runId, status, { code: r.code, tail: tail(r.output, 4000), terminal: r.terminalId });
      if (a.builder_agent_id)
        void this.host.timeline(a.builder_agent_id, `foundry-check-${runId}`, { step: "check", name: s.name, status, code: r.code, sha, tail: tail(r.output, 1200) });
      if (r.code !== 0) failures.push({ name: s.name, code: r.code, output: r.output });
    }
    const missing = checks.paths.filter((pth) => !existsSync(join(a.worktree_path ?? path!, pth)));
    if (missing.length) {
      const runId = this.store.startRun("check", { attempt: a.id, sha, detail: { name: "paths", paths: checks.paths } });
      this.store.endRun(runId, "failed", { missing });
    }
    if (!failures.length && !missing.length) return "passed";

    const fresh = this.store.attempt(a.id)!;
    if (fresh.ended_at) return "ended";
    const budget = step.max_fix_rounds ?? i.max_fix_rounds ?? this.settings.maxFixRounds;
    if (fresh.fix_rounds >= budget) {
      this.endAttempt(a.id, "rework", { flag: "CHECKS_FAILED", detail: `checks still failing after ${fresh.fix_rounds} fix round(s): ${failures.map((f) => f.name).concat(missing.map((m) => `path ${m}`)).join(", ")}` });
      return "ended";
    }
    const round = fresh.fix_rounds + 1;
    this.store.updateAttempt(a.id, { step: "fix", fix_rounds: round });
    this.store.event("fix_round", { issue: i.key, attempt: a.id, detail: { round, checks: failures.map((f) => f.name), missing } });
    this.store.startRun("fix", { attempt: a.id, agent: a.builder_agent_id, sha, detail: { round } });
    const msg = [
      `Foundry's checks failed on commit ${sha.slice(0, 10)} (fix round ${round} of ${budget}). Fix only these, then end your turn. Do not commit.`,
      ...failures.map((f) => `Check "${f.name}" exited ${f.code}. Last output:\n${tail(f.output, 4000)}`),
      ...(missing.length ? [`Required paths missing: ${missing.join(", ")}`] : []),
    ].join("\n\n");
    await this.host.send(a.builder_agent_id!, msg);
    return "fixing";
  }

  private async startReview(a: Attempt, step: Extract<LoopStep, { kind: "review" }>) {
    const i = this.store.issue(a.issue_key)!;
    const p = this.store.project(i.project_id)!;
    const f = i.feature_id ? this.store.feature(i.feature_id) : null;
    const baseRef = f ? f.branch : p.base_ref;
    const fork = await git(p.repo, "merge-base", baseRef, a.head_sha!).catch(() => baseRef);
    const diff = await git(p.repo, "diff", `${fork}..${a.head_sha}`).catch((e) => String(e));
    const checkRuns = this.store.runs(a.id).filter((r) => r.kind === "check");
    const checkLines = checkRuns.slice(-12).map((r) => `- ${parse<{ name?: string }>(r.detail, {}).name ?? "check"}: ${r.status}`);
    const agentId = randomUUID();
    this.store.updateAttempt(a.id, { reviewer_agent_id: agentId, step: "review" });
    this.store.startRun("review", { attempt: a.id, agent: agentId, sha: a.head_sha });
    const prompt = [
      `You are Foundry's reviewer for ${i.key}: ${i.title}.`,
      i.description,
      i.acceptance ? `Acceptance criteria:\n${i.acceptance}` : "",
      f ? `The approved spec and plan are in ${featureDir(f.slug)}/.` : "",
      `Review commit ${a.head_sha} against ${baseRef}.`,
      checkLines.length ? `Check results:\n${checkLines.join("\n")}` : "No checks ran for this task.",
      `Diff:\n\`\`\`diff\n${diff.slice(0, 40_000)}\n\`\`\``,
      step.prompt ?? "",
      "Call report_verdict exactly once: pass, rework (with findings the builder must fix), fail, or human (with action_required). Do not edit files: anything you change is reset.",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      await this.host.startAgent({
        agentId,
        role: "reviewer",
        place: a.workspace_id ? { kind: "workspace", workspaceId: a.workspace_id } : { kind: "directory", path: a.worktree_path!, visible: true },
        prompt,
        title: `${i.key} review`,
        issueKey: i.key,
        attemptId: a.id,
        featureId: i.feature_id,
        projectId: i.project_id,
      });
    } catch (e) {
      this.endAttempt(a.id, "completed", { flag: "NO_REVIEWER", detail: `could not start the reviewer: ${String(e)}` });
    }
  }

  private async afterReview(a: Attempt, outcome: { kind: string }) {
    const run = this.openRun(a.id, a.reviewer_agent_id);
    if (run) this.store.endRun(run, outcome.kind === "completed" ? "completed" : "failed", { outcome: outcome.kind });
    // Anything the reviewer changed is reset.
    if (a.worktree_path && a.head_sha && existsSync(a.worktree_path)) {
      const dirty = await changedPaths(a.worktree_path).catch(() => []);
      if (dirty.length) {
        await git(a.worktree_path, "reset", "-q", "--hard", a.head_sha);
        await git(a.worktree_path, "clean", "-fdq");
        this.store.event("reviewer_changes_reset", { issue: a.issue_key, attempt: a.id, detail: { paths: dirty } });
      }
    }
    const loop = this.loopOf(a);
    const step = loop.steps[a.step_index] as Extract<LoopStep, { kind: "review" }>;
    const got = this.verdicts.get(a.id);
    this.verdicts.delete(a.id);
    const v = got?.role === "reviewer" ? got.v : null;
    if (v)
      this.store.run(
        "INSERT INTO reviews(attempt_id,actor,decision,head_sha,tree_sha,feedback,findings) VALUES(?,?,?,?,?,?,?)",
        a.id,
        "agent",
        v.decision,
        a.head_sha,
        a.tree_sha,
        v.reason,
        JSON.stringify(v.findings ?? []),
      );
    if (a.builder_agent_id && v)
      void this.host.timeline(a.builder_agent_id, `foundry-verdict-${a.id}-${a.reworks}`, { step: "verdict", verdict: v.decision, summary: v.reason, sha: a.head_sha ?? "" });

    if (!v || v.decision === "pass") {
      if (!v) this.store.updateAttempt(a.id, { flag: "NO_REVIEW_VERDICT" });
      this.store.updateAttempt(a.id, { step_index: a.step_index + 1, step: "check" });
      return this.advance(a.id, loop);
    }
    if (v.decision === "fail") return this.endAttempt(a.id, "failed", { reason: "REVIEW_FAIL", detail: v.reason });
    if (v.decision === "human") return this.endAttempt(a.id, "needs_human", { flag: "REVIEW_HUMAN", detail: v.action_required ?? v.reason });
    // rework
    const max = step.max_reworks ?? 1;
    const back = step.back_to ? stepIndex(loop, step.back_to) : 0;
    if (a.reworks >= max) return this.endAttempt(a.id, "needs_human", { flag: "REVIEW_REWORK", detail: v.reason });
    this.store.updateAttempt(a.id, { reworks: a.reworks + 1, step: "build", step_index: back });
    this.store.startRun("agent", { attempt: a.id, agent: a.builder_agent_id, sha: a.head_sha, detail: { rework: a.reworks + 1 } });
    const findings = (v.findings ?? []).map((f) => `- [${f.severity}] ${f.title}${f.evidence ? `: ${f.evidence}` : ""}`).join("\n");
    await this.host.send(
      a.builder_agent_id!,
      `Foundry's reviewer asks for changes at ${a.head_sha?.slice(0, 10)}:\n${v.reason}${findings ? `\n\nFindings:\n${findings}` : ""}\n\nFix these, then end your turn. Do not commit.`,
    );
  }

  private finish(a: Attempt) {
    const ranChecks = this.store.runs(a.id).some((r) => r.kind === "check");
    const reviewed = this.store.get("SELECT 1 FROM reviews WHERE attempt_id=? AND actor='agent' AND decision='pass'", a.id);
    if (ranChecks || reviewed) return this.endAttempt(a.id, "passed", {});
    return this.endAttempt(a.id, "completed", { flag: a.flag ?? "NO_VERDICT" });
  }

  /** End an attempt and move its issue: In_Review for anything you should look at, Failed or Blocked otherwise. */
  private endAttempt(attemptId: number, outcome: AttemptOutcome, o: { issueStatus?: IssueStatus; reason?: ReasonCode; flag?: string; detail?: string }) {
    const a = this.store.attempt(attemptId)!;
    if (a.ended_at) return;
    const issueStatus: IssueStatus = o.issueStatus ?? (outcome === "failed" ? "Failed" : "In_Review");
    this.store.tx(() => {
      this.store.updateAttempt(a.id, { outcome, flag: o.flag ?? a.flag, step: "ended", ended_at: new Date().toISOString() });
      const i = this.store.issue(a.issue_key)!;
      if (["In_Progress", "Awaiting_Human", "Ready"].includes(i.status))
        this.store.setIssueStatus(a.issue_key, issueStatus, "system", o.reason ?? null, { attempt: a.n, outcome, flag: o.flag ?? null, detail: o.detail ?? null });
      this.store.event("attempt_ended", { issue: a.issue_key, attempt: a.id, detail: { outcome, flag: o.flag ?? null, detail: o.detail ?? null, head: a.head_sha } });
    });
    if (issueStatus === "In_Review")
      void this.host.notify({ title: `${a.issue_key} is ready for your review`, body: o.flag ? `Flagged ${o.flag}. ${o.detail ?? ""}` : "Checks and review passed.", key: `review:${a.issue_key}`, screen: "board" });
  }

  // ---------- tools ----------
  /** ask_human: waits live up to the question window, else tells the agent to end its turn. */
  async askHuman(agentId: string, question: string, choices: string[] = [], signal?: AbortSignal): Promise<string> {
    const answer = await this.waitForHuman(agentId, question, choices, signal);
    return answer === null ? END_TURN_MESSAGE : `The developer answered: ${answer}`;
  }

  /** The harness's own question tool, routed here. Null means the window ended. */
  async askNative(agentId: string, question: string) {
    return this.waitForHuman(agentId, question, []);
  }

  private async waitForHuman(agentId: string, question: string, choices: string[], signal?: AbortSignal): Promise<string | null> {
    const rec = this.store.agent(agentId);
    const a = this.store.attemptByAgent(agentId);
    if (!rec || rec.role !== "builder" || !a || a.ended_at) throw new FoundryError("TOOL_REFUSED", "ask_human is for the builder of a running task");
    const r = this.store.run(
      "INSERT INTO questions(issue_key,attempt_id,feature_id,agent_id,text,choices,status) VALUES(?,?,?,?,?,?,'live')",
      a.issue_key,
      a.id,
      rec.feature_id,
      agentId,
      question,
      JSON.stringify(choices),
    );
    const qid = Number(r.lastInsertRowid);
    this.store.event("question_asked", { actor: "agent", issue: a.issue_key, attempt: a.id, detail: { qid, question } });
    void this.host.timeline(agentId, `foundry-q-${qid}`, { step: "question", question, status: "asked" });
    void this.host.notify({ title: `${a.issue_key} asks`, body: question, key: `q:${qid}`, screen: "board" });
    const answer = await new Promise<string | null>((resolve) => {
      const t = setTimeout(() => resolve(null), this.settings.questionWindowMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve(null);
      });
      this.liveQuestions.set(qid, (ans) => {
        clearTimeout(t);
        resolve(ans);
      });
    });
    this.liveQuestions.delete(qid);
    if (answer !== null) return answer;
    this.store.run("UPDATE questions SET status='waiting' WHERE id=? AND status='live'", qid);
    this.store.event("question_window_expired", { issue: a.issue_key, attempt: a.id, detail: { qid } });
    return null;
  }

  async answer(qid: number, text: string, actor: Actor = "you") {
    const q = this.store.get<Question>("SELECT * FROM questions WHERE id=?", qid);
    if (!q) throw new FoundryError("NOT_FOUND", `No question ${qid}`);
    if (!text.trim()) throw new FoundryError("ANSWER_EMPTY", "An answer needs text");
    const live = this.liveQuestions.get(qid);
    if (q.status === "live" && live) {
      this.store.run("UPDATE questions SET status='answered', answer=?, answered_at=datetime('now') WHERE id=?", text, qid);
      this.store.event("question_answered", { actor, issue: q.issue_key, attempt: q.attempt_id, detail: { qid, live: true } });
      live(text);
      return { delivered: "live" };
    }
    if (q.status !== "waiting" && q.status !== "live") throw new FoundryError("QUESTION_CLOSED", `Question ${qid} is ${q.status}`);
    this.store.run("UPDATE questions SET status='answered', answer=?, answered_at=datetime('now') WHERE id=?", text, qid);
    this.store.event("question_answered", { actor, issue: q.issue_key, attempt: q.attempt_id, detail: { qid, live: false } });
    const i = q.issue_key ? this.store.issue(q.issue_key) : null;
    if (i?.status === "Awaiting_Human") {
      await this.continueInSession(i.key, `Answer to your earlier question ("${q.text}"): ${text}\n\nContinue the task, then end your turn.`, actor, "answer");
      return { delivered: "resumed" };
    }
    return { delivered: "recorded" };
  }

  /** report_verdict, for builders and the reviewer of this attempt only. */
  reportVerdict(agentId: string, input: VerdictInput) {
    const rec = this.store.agent(agentId);
    const a = this.store.attemptByAgent(agentId);
    if (!rec || !a || (rec.role !== "builder" && rec.role !== "reviewer")) throw new FoundryError("TOOL_REFUSED", "report_verdict is for a task's builder or reviewer");
    if (input.issue_key && input.issue_key !== a.issue_key) throw new FoundryError("TOOL_REFUSED", `Refused: this run works on ${a.issue_key}, not ${input.issue_key}`);
    if (a.ended_at) throw new FoundryError("TOOL_REFUSED", "This attempt has ended");
    if (rec.role === "reviewer" && a.reviewer_agent_id !== agentId) throw new FoundryError("TOOL_REFUSED", "Only this attempt's reviewer can report its verdict");
    if (input.decision === "human" && !input.action_required) throw new FoundryError("VERDICT_INVALID", "A human verdict needs action_required");
    this.verdicts.set(a.id, { role: rec.role, v: input });
    this.store.event("verdict", { actor: "agent", issue: a.issue_key, attempt: a.id, detail: { role: rec.role, decision: input.decision, reason: input.reason, head: a.head_sha } });
    return { recorded: true, head_sha: a.head_sha };
  }

  // ---------- your review ----------
  private async assertReviewable(key: string, headSha: string, treeSha: string) {
    const i = this.store.issue(key);
    if (!i) throw new FoundryError("NOT_FOUND", `No issue ${key}`);
    if (i.status !== "In_Review") throw new FoundryError("NOT_IN_REVIEW", `${key} is ${i.status}, not In_Review`);
    const a = this.store.latestAttempt(key)!;
    const path = a.worktree_path && existsSync(a.worktree_path) ? a.worktree_path : null;
    if (path) {
      const dirty = await changedPaths(path);
      if (dirty.length) throw new FoundryError("DIRTY_WORKTREE", `${key}'s worktree has uncommitted changes`, { paths: dirty });
    }
    const p = this.store.project(i.project_id)!;
    const curHead = path ? await head(path) : await git(p.repo, "rev-parse", a.branch);
    const curTree = await treeOf(path ?? p.repo, curHead);
    if (curHead !== headSha || curTree !== treeSha || a.head_sha !== headSha)
      throw new FoundryError("STALE_REVIEW", `${key} moved since you read it`, { head_sha: curHead, tree_sha: curTree });
    return { i, a };
  }

  /** Accept at the reviewed SHAs. A feature task merges into the feature branch under the feature lock. */
  async accept(key: string, headSha: string, treeSha: string, actor: Actor = "you", feedback = "") {
    const pre = this.store.issue(key);
    if (!pre) throw new FoundryError("NOT_FOUND", `No issue ${key}`);
    if (!pre.feature_id) throw new FoundryError("NOT_SUPPORTED_YET", "Accepting quick tasks arrives with quick tasks (M3).");
    const result: { conflict?: string[]; merged?: string } = await this.locks.with(`feature:${pre.feature_id}`, () =>
      this.locks.with(`attempt:${key}`, async () => {
        const { i, a } = await this.assertReviewable(key, headSha, treeSha);
        const f = this.store.feature(i.feature_id!)!;
        try {
          await assertIntegrationUntouched(this.store, f);
        } catch (e) {
          this.store.setSetting(`feature_hold:${f.id}`, "INTEGRATION_MOVED");
          throw e;
        }
        const path = f.integration_path!;
        let merged: string;
        const ff = await sh("git", ["merge", "--ff-only", "-q", headSha], { cwd: path });
        if (ff.code !== 0) {
          const m = await sh("git", [...FOUNDRY_IDENT, "merge", "--no-ff", "-q", "-m", `merge ${key}: ${i.title}`, headSha], { cwd: path, env: identEnv(FOUNDRY_IDENT) });
          if (m.code !== 0) {
            const conflicts = (await git(path, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
            await sh("git", ["merge", "--abort"], { cwd: path });
            this.store.event("merge_conflict", { actor: "system", issue: key, attempt: a.id, feature: f.id, detail: { paths: conflicts, reviewed: headSha } });
            this.store.updateIssue(key, { flag: "MERGE_CONFLICT" });
            return { conflict: conflicts };
          }
        }
        merged = await head(path);
        this.store.tx(() => {
          this.store.updateFeature(f.id, { head_sha: merged });
          this.store.run("INSERT INTO reviews(attempt_id,actor,decision,head_sha,tree_sha,feedback) VALUES(?,?,?,?,?,?)", a.id, actor, "accept", headSha, treeSha, feedback);
          this.store.setIssueStatus(key, "Done", actor, null, { merged });
          this.store.event("task_merged", { actor, issue: key, attempt: a.id, feature: f.id, detail: { head: headSha, merged } });
        });
        for (const ws of [a.workspace_id, a.check_workspace_id]) if (ws) void this.host.archiveWorkspace(ws).catch(() => {});
        return { merged };
      }),
    );
    if (result.conflict) {
      const conflict = result.conflict;
      // The reviewed SHA is kept (never rebased); the task goes back to its agent to merge the feature branch in.
      const f = this.store.feature(pre.feature_id)!;
      await this.continueInSession(
        key,
        `Accepting your work hit a merge conflict with ${f.branch} in: ${conflict.join(", ")}. Merge ${f.branch} into your branch, resolve the conflicts, and end your turn. Do not commit; Foundry commits for you.`,
        "system",
        "conflict",
      );
      return { conflict };
    }
    await this.tick();
    return result;
  }

  async rework(key: string, headSha: string, treeSha: string, feedback: string, actor: Actor = "you") {
    if (!feedback.trim()) throw new FoundryError("FEEDBACK_REQUIRED", "Rework needs feedback");
    await this.locks.with(`attempt:${key}`, async () => {
      const { a } = await this.assertReviewable(key, headSha, treeSha);
      this.store.run("INSERT INTO reviews(attempt_id,actor,decision,head_sha,tree_sha,feedback) VALUES(?,?,?,?,?,?)", a.id, actor, "rework", headSha, treeSha, feedback);
    });
    await this.continueInSession(key, `The developer reviewed your work at ${headSha} and asks for changes:\n\n${feedback}\n\nMake the changes, then end your turn. Do not commit.`, actor, "rework");
    return { ok: true };
  }

  /** A message to the issue's agent: a follow-up, an answer or a rework. Starts a new attempt in the same session. */
  async followUp(key: string, text: string, actor: Actor = "you") {
    if (!text.trim()) throw new FoundryError("MESSAGE_EMPTY", "A follow-up needs text");
    return this.continueInSession(key, text, actor, "follow_up");
  }

  private async continueInSession(key: string, message: string, actor: Actor, why: "answer" | "rework" | "follow_up" | "conflict") {
    const i = this.store.issue(key)!;
    const prev = this.store.latestAttempt(key);
    if (!prev?.builder_agent_id || !prev.workspace_id) throw new FoundryError("NO_SESSION", `${key} has no builder session to continue`);
    if (!prev.ended_at) throw new FoundryError("BUSY", `${key} is running; your message waits for its turn to end`);
    if (["Done", "Cancelled"].includes(i.status)) throw new FoundryError("INVALID_TRANSITION", `${key} is ${i.status}`, { current: i.status });
    const waiting = this.unmetDeps(key);
    if (waiting.length) throw new FoundryError("DEPENDENCIES_NOT_DONE", `${key} waits for ${waiting.join(", ")}`, { waiting_for: waiting });
    const project = this.store.project(i.project_id)!;
    const loop = resolveLoop(i.loop, project.default_loop);
    const a = this.store.tx(() => {
      const a = this.store.createAttempt(key, prev.branch, loop);
      this.store.updateAttempt(a.id, {
        builder_agent_id: prev.builder_agent_id,
        workspace_id: prev.workspace_id,
        worktree_path: prev.worktree_path,
        check_workspace_id: prev.check_workspace_id,
        check_path: prev.check_path,
        head_sha: prev.head_sha,
        tree_sha: prev.tree_sha,
        step: "build",
        step_index: 0,
      });
      if (i.status === "Failed" || i.status === "Blocked") this.store.setIssueStatus(key, "In_Progress", actor, null, { why });
      else if (i.status !== "In_Progress") this.store.setIssueStatus(key, "In_Progress", actor, null, { why });
      if (i.flag) this.store.updateIssue(key, { flag: null });
      return a;
    });
    this.store.startRun("agent", { attempt: a.id, agent: prev.builder_agent_id, sha: prev.head_sha, detail: { why } });
    this.store.event(why, { actor, issue: key, attempt: a.id });
    await this.host.send(prev.builder_agent_id, message);
    return this.store.attempt(a.id)!;
  }

  // ---------- recovery and host changes ----------
  async onWorkspaceArchived(workspaceId: string) {
    const a = this.store.attemptByWorkspace(workspaceId);
    if (!a || a.ended_at) return;
    this.store.event("workspace_archived_by_host", { actor: "host-user", issue: a.issue_key, attempt: a.id });
    this.endAttempt(a.id, "failed", { reason: "INFRA_ERROR", detail: "workspace archived outside Foundry" });
  }

  async recover() {
    for (const a of this.store.activeAttempts()) {
      this.store.run("UPDATE questions SET status='waiting' WHERE attempt_id=? AND status='live'", a.id);
      if (a.step === "check") {
        // Checks are Foundry's own and safe to re-run.
        await this.locks.with(`attempt:${a.issue_key}`, () => this.advance(a.id, this.loopOf(a))).catch((e) =>
          this.store.event("recover_error", { issue: a.issue_key, detail: { error: String(e) } }),
        );
        continue;
      }
      const agent = a.step === "review" ? a.reviewer_agent_id : a.builder_agent_id;
      const status = agent ? await this.host.agentStatus(agent) : "gone";
      if (status === "running") continue; // its turn.after will arrive
      for (const r of this.store.runs(a.id).filter((r) => r.status === "running")) this.store.endRun(r.id, "failed", { reason: "infra: restarted" });
      const waiting = this.store.get("SELECT 1 FROM questions WHERE attempt_id=? AND status='waiting'", a.id);
      if (waiting) this.endAttempt(a.id, "needs_human", { issueStatus: "Awaiting_Human", detail: "waiting for your answer (restarted)" });
      else this.endAttempt(a.id, "failed", { reason: "INTERRUPTED", detail: "infra: restarted" });
    }
    await this.tick();
  }
}
