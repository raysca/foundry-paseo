// Loop 2: the task loop. A task runs unattended in its own worktree through its loop (builder turn,
// runner checks, reviewer) and comes back as committed code bound to a SHA. The runner, not the agent,
// decides whether it passed. Concurrency is Paseo's: Foundry decides only the order work starts in.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesFromBase, paseoScripts, paseoServices, reproScript, resolveChecks, resolvePage, SHOT_FILE, splitRepro, tail, type TaskChecks } from "./checks";
import { assertIntegrationUntouched, featureDir, steering } from "./features";
import { frontSlice, mergeForward, setTargetHead, sliceAllowsAutoStart, sliceOfIssue, target } from "./slices";
import { changedPaths, commitAll, FOUNDRY_IDENT, git, head, HOST_IDENT, identEnv, sh, treeOf } from "./git";
import type { Host } from "./host";
import type { Locks } from "./locks";
import { BUILTIN_LOOPS, loopNames, projectLoops, resolveLoop, stepIndex, type LoopDef, type LoopStep } from "./loops";
import { FoundryError, type Actor, type AttemptOutcome, type IssueStatus, type ReasonCode, type Verdict } from "./model";
import { parse, type Attempt, type Issue, type Question, type Store } from "./store";

export interface LoopSettings {
  maxFixRounds: number;
  questionWindowMs: number;
  checkTimeoutMs: number;
  /** Where page checks leave their screenshots (Foundry's home in production); a temp folder if unset. */
  shotsDir?: string;
  /** An agent turn with no activity this long is stopped (default 15 min). Paused while it waits on you. */
  idleTimeoutMs?: number;
  /** An agent turn running this long is stopped (default 60 min), not counting time it waits on you. */
  turnTimeoutMs?: number;
  /** Automatic retries after a timeout, an infrastructure error or a failed turn (default 2), then Blocked. */
  maxRetries?: number;
  /** The first retry's delay (default 1 min); each later one doubles it. */
  retryBackoffMs?: number;
  /** How often a turn's activity is read from the host (default 10 s). */
  activityPollMs?: number;
  /** How long an interrupted turn has to end before Foundry stops the agent (default 30 s). */
  stopGraceMs?: number;
  /** Infrastructure failures within breakerWindowMs that pause auto-start (default 3 in 10 min). */
  breakerThreshold?: number;
  breakerWindowMs?: number;
}

/** Failures worth an automatic retry: nothing about the task itself says it can't be done. */
const RETRYABLE: ReasonCode[] = ["TIMEOUT", "INFRA_ERROR", "AGENT_ERROR"];
const BREAKER_KEY = "autostart_paused";

/** A turn under supervision, keyed by its run. Clocks live in memory: a restart gives running turns a fresh start. */
interface Watched {
  attemptId: number;
  agentId: string;
  startedAt: number;
  lastActivity: number;
  marker?: string | null;
  polledAt?: number;
  pausedMs: number;
  pausedSince: number | null;
  stopping?: { at: number; why: string };
}

/** How long a page step waits for its service to answer. */
const SERVICE_START_MS = 120_000;

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
  private watched = new Map<number, Watched>();
  private supervising = false;
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
        if (this.autostartPaused()) continue;
        await this.startDueRetries();
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

  // ---------- loops ----------
  /** The loops a project can use: the built-ins and its own from .foundry/loops on base (invalid files with their errors). */
  async loops(projectId: number) {
    const p = this.store.project(projectId);
    if (!p) throw new FoundryError("NOT_FOUND", `No project ${projectId}`);
    const pl = await projectLoops(p.repo, p.base_ref);
    const all = { ...BUILTIN_LOOPS, ...pl.loops };
    return {
      default: p.default_loop ?? "backend",
      loops: loopNames(pl).map((n) => ({ name: n, source: all[n]!.source, steps: all[n]!.steps.map((s) => ({ kind: s.kind, name: s.name })) })),
      invalid: Object.entries(pl.invalid).map(([name, errors]) => ({ name, errors })),
    };
  }

  private async assertLoop(projectId: number, loop: string) {
    const p = this.store.project(projectId)!;
    resolveLoop(loop, null, await projectLoops(p.repo, p.base_ref));
  }

  /** The loop a project's tasks run when they name none. */
  async setDefaultLoop(projectId: number, loop: string | null, actor: Actor = "you") {
    if (loop) await this.assertLoop(projectId, loop);
    return this.store.setDefaultLoop(projectId, loop || null, actor);
  }

  /** Change a task's loop while it isn't running; the next attempt runs it. */
  async setIssueLoop(key: string, loop: string | null, actor: Actor = "you") {
    const i = this.store.issue(key);
    if (!i) throw new FoundryError("NOT_FOUND", `No issue ${key}`);
    if (!["Backlog", "Ready", "Failed", "Blocked"].includes(i.status)) throw new FoundryError("INVALID_TRANSITION", `${key} is ${i.status}; change its loop when it isn't running`, { current: i.status });
    if (loop) await this.assertLoop(i.project_id, loop);
    this.store.updateIssue(key, { loop: loop || null, ...(i.flag === "LOOP_MISSING" ? { flag: null } : {}) }, actor);
    this.store.event("issue_loop_set", { actor, issue: key, detail: { from: i.loop, to: loop || null } });
    return this.store.issue(key)!;
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
    return sliceAllowsAutoStart(this.store, f, i);
  }

  // ---------- start ----------
  async start(key: string, actor: Actor) {
    const i = this.store.issue(key);
    if (!i) throw new FoundryError("NOT_FOUND", `No issue ${key}`);
    const waiting = this.unmetDeps(key);
    if (waiting.length) throw new FoundryError("DEPENDENCIES_NOT_DONE", `${key} waits for ${waiting.join(", ")}`, { waiting_for: waiting });
    // You starting a task again gives it a fresh set of automatic retries.
    if (actor !== "system" && (i.retries || i.retry_at)) this.store.updateIssue(key, { retries: 0, retry_at: null }, actor);
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
      loop = resolveLoop(i.loop, project.default_loop, await projectLoops(project.repo, project.base_ref));
    } catch (e) {
      if (e instanceof FoundryError && e.code === "LOOP_MISSING") {
        this.store.updateIssue(key, { flag: "LOOP_MISSING" });
        this.store.event("loop_missing", { issue: key, detail: e.detail });
      }
      throw e;
    }
    if (i.flag === "LOOP_MISSING") this.store.updateIssue(key, { flag: null });

    // A feature task starts from its slice's branch: the feature's for the front slice.
    const slice = sliceOfIssue(this.store, i);
    const view = i.feature_id ? target(this.store, i.feature_id, slice?.id ?? null).view : null;
    if (view && slice && slice.id !== frontSlice(this.store, i.feature_id!)?.id && !slice.path) {
      if (actor === "system") return;
      throw new FoundryError("SLICE_ORDER", `${key} is in slice ${slice.n}, which starts once the slice before it reaches Ship`, { slice: slice.n });
    }
    const fromRef = view ? view.branch : project.base_ref;
    const agentId = randomUUID();
    const a = this.store.tx(() => {
      // The branch is Paseo's to name (from the issue key); it is recorded once the workspace exists.
      const a = this.store.createAttempt(key, "", loop);
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
          place: { kind: "new-worktree", repo: project.repo, slug: key.toLowerCase(), fromRef, visible: true },
          prompt,
          title: `${key} ${i.title}`.slice(0, 80),
          profile: i.profile,
          issueKey: key,
          attemptId: a.id,
          featureId: i.feature_id,
          projectId: i.project_id,
        });
        const base = await head(started.path);
        if (started.branch) this.store.recordBranch(project.repo, started.branch, "task");
        this.store.updateAttempt(a.id, { branch: started.branch ?? "", workspace_id: started.workspaceId, worktree_path: started.path, head_sha: base, tree_sha: await treeOf(started.path, base) });
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
        const stopped = this.stoppedTurn(fresh, agentId);
        if (stopped) return this.endStopped(fresh, stopped.why);
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
      if (step.kind === "check" || step.kind === "repro" || step.kind === "page") {
        const r = step.kind === "check" ? await this.runCheckStep(a, step) : step.kind === "repro" ? await this.runReproStep(a, step) : await this.runPageStep(a, step);
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

    const { ws, path } = await this.checkWorkspace(a, i, p, sha);
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

    return this.fixOrEnd(a, step, sha, {
      flag: "CHECKS_FAILED",
      what: "checks",
      names: failures.map((f) => f.name),
      missing,
      lines: [
        ...failures.map((f) => `Check "${f.name}" exited ${f.code}. Last output:\n${tail(f.output, 4000)}`),
        ...(missing.length ? [`Required paths missing: ${missing.join(", ")}`] : []),
      ],
    });
  }

  /**
   * A per-attempt check workspace at the committed SHA (Paseo runs setup when it creates it), reset
   * to the SHA. Callers restore paseo.json and the files its commands name from base, so a task can't
   * weaken its checks.
   */
  private async checkWorkspace(a: Attempt, i: Issue, p: { repo: string }, sha: string): Promise<{ ws: string; path: string }> {
    let ws = a.check_workspace_id;
    let path = a.check_path;
    if (!ws || !path || !existsSync(path)) {
      const made = await this.host.createWorktreeWorkspace({
        repo: p.repo,
        title: `${i.key} checks`,
        slug: `${i.key.toLowerCase()}-check-${a.n}`,
        from: sha,
        purpose: "check",
        visible: false,
      });
      this.store.recordBranch(p.repo, made.branch, "check");
      ws = made.workspaceId;
      path = made.path;
      this.store.updateAttempt(a.id, { check_workspace_id: ws, check_path: path });
    }
    await git(path, "checkout", "-q", "--detach", "--force", sha);
    await git(path, "clean", "-fdq");
    return { ws, path };
  }

  /** A failed check or repro step: another fix round for the builder within budget, else rework with the flag. */
  private async fixOrEnd(
    a: Attempt,
    step: { max_fix_rounds?: number },
    sha: string,
    o: { flag: "CHECKS_FAILED" | "REPRO_FAILED" | "PAGE_CHECK_FAILED"; what: string; names: string[]; missing?: string[]; lines: string[] },
  ): Promise<"fixing" | "ended"> {
    const i = this.store.issue(a.issue_key)!;
    const fresh = this.store.attempt(a.id)!;
    if (fresh.ended_at) return "ended";
    const missing = o.missing ?? [];
    const budget = step.max_fix_rounds ?? i.max_fix_rounds ?? this.settings.maxFixRounds;
    if (fresh.fix_rounds >= budget) {
      // Checks name what failed; a repro says why, since there is one step and several ways to fail it.
      const why = o.flag !== "CHECKS_FAILED" ? o.lines.map((l) => l.split("\n")[0]).join(" ") : o.names.concat(missing.map((m) => `path ${m}`)).join(", ");
      this.endAttempt(a.id, "rework", { flag: o.flag, detail: `${o.what} still failing after ${fresh.fix_rounds} fix round(s): ${why}` });
      return "ended";
    }
    const round = fresh.fix_rounds + 1;
    this.store.updateAttempt(a.id, { step: "fix", fix_rounds: round });
    this.store.event("fix_round", { issue: i.key, attempt: a.id, detail: { round, checks: o.names, missing } });
    this.store.startRun("fix", { attempt: a.id, agent: a.builder_agent_id, sha, detail: { round } });
    const msg = [`Foundry's ${o.what} failed on commit ${sha.slice(0, 10)} (fix round ${round} of ${budget}). Fix only these, then end your turn. Do not commit.`, ...o.lines].join("\n\n");
    await this.host.send(a.builder_agent_id!, msg);
    return "fixing";
  }

  /** The commit the attempt's change starts from: where it forked from its target branch. */
  private async forkOf(a: Attempt, i: Issue, p: { repo: string; base_ref: string }) {
    const f = i.feature_id ? target(this.store, i.feature_id, sliceOfIssue(this.store, i)?.id ?? null).view : null;
    const baseRef = f ? f.branch : p.base_ref;
    const fork = await git(p.repo, "merge-base", baseRef, a.head_sha!).catch(() => baseRef);
    return { f, baseRef, fork };
  }

  /**
   * A bug's reproduction. The change must add or edit a test and change something else (the fix).
   * In the check workspace the fix is reverted to the fork point and the test script must fail; with
   * the fix back it must pass. Both runs are recorded as checks so the reviewer and the review panel
   * see them. Anything else goes back to the builder as a fix round, then REPRO_FAILED rework.
   */
  private async runReproStep(a: Attempt, step: Extract<LoopStep, { kind: "repro" }>): Promise<"passed" | "skipped" | "fixing" | "ended"> {
    const i = this.store.issue(a.issue_key)!;
    const p = this.store.project(i.project_id)!;
    if (!a.head_sha) throw new Error(`${a.issue_key} has no commit to check`);
    const sha = a.head_sha;
    const available = await paseoScripts(p.repo, p.base_ref);
    const task = parse<TaskChecks>(i.checks, {});
    const name = reproScript(step, task, available);
    if (!name) {
      this.store.event("check_skipped", { issue: i.key, attempt: a.id, detail: { step: step.name, hint: 'Add a test script of type "script" to paseo.json to reproduce bugs.' } });
      return "skipped";
    }
    this.store.updateAttempt(a.id, { step: "check" });
    const fail = (lines: string[]) => this.fixOrEnd(a, step, sha, { flag: "REPRO_FAILED", what: "bug reproduction", names: [step.name], lines });
    const script = available.find((s) => s.name === name);
    if (!script) return fail([`paseo.json has no script "${name}" on ${p.base_ref} to run the reproducing test.`]);

    const { fork } = await this.forkOf(a, i, p);
    const raw = await git(p.repo, "diff", "--name-status", "--no-renames", fork, sha);
    const changed = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [status, ...rest] = l.split("\t");
        return { status: status!.charAt(0), path: rest.join("\t") };
      });
    const { tests, fix } = splitRepro(changed, task.repro?.files);
    if (!tests.length)
      return fail([
        task.repro?.files?.length
          ? `The change doesn't touch the reproducing test the task names (${task.repro.files.join(", ")}). Add a test there that fails without your fix.`
          : "No test reproduces the bug: the change adds or edits no test file (a file under test/, tests/, __tests__/ or spec/, or named *.test.*, *.spec.*, test_*.py or *_test.go). Add a test that fails without your fix.",
      ]);
    if (!fix.length) return fail([`Only tests changed (${tests.map((t) => t.path).join(", ")}). A bug fix changes the code too.`]);

    const { ws, path } = await this.checkWorkspace(a, i, p, sha);
    const fromBase = await filesFromBase(p.repo, p.base_ref, [script]);
    const timeoutMs = step.timeout_minutes ? step.timeout_minutes * 60_000 : this.settings.checkTimeoutMs;
    const runOnce = async (label: string, expect: "fail" | "pass") => {
      await git(path, "checkout", "-q", p.base_ref, "--", ...fromBase);
      const runId = this.store.startRun("check", { attempt: a.id, sha, detail: { name: label, command: script.command, repro: expect } });
      const r = await this.host.runScript({ workspaceId: ws, script: script.name, env: {}, timeoutMs });
      const ok = expect === "fail" ? r.code !== 0 : r.code === 0;
      this.store.endRun(runId, ok ? "passed" : "failed", { code: r.code, tail: tail(r.output, 4000), terminal: r.terminalId });
      if (a.builder_agent_id)
        void this.host.timeline(a.builder_agent_id, `foundry-check-${runId}`, { step: "check", name: label, status: ok ? "passed" : "failed", code: r.code, sha, tail: tail(r.output, 1200) });
      return { ok, ...r };
    };

    // Without the fix: added files go, everything else goes back to the fork point. The tests stay.
    const added = fix.filter((c) => c.status === "A").map((c) => c.path);
    const reverted = fix.filter((c) => c.status !== "A").map((c) => c.path);
    if (added.length) await git(path, "rm", "-q", "-f", "--", ...added);
    if (reverted.length) await git(path, "checkout", "-q", fork, "--", ...reverted);
    const without = await runOnce(`${step.name}: without the fix (expected to fail)`, "fail");
    await git(path, "checkout", "-q", "--detach", "--force", sha);
    await git(path, "clean", "-fdq");
    const withFix = await runOnce(`${step.name}: with the fix`, "pass");

    const lines: string[] = [];
    const testList = tests.map((t) => t.path).join(", ");
    if (!without.ok) lines.push(`"${name}" passes with your fix reverted (${fix.map((c) => c.path).join(", ")}), so ${testList} doesn't reproduce the bug. Make the test fail on the code as it was.`);
    if (!withFix.ok) lines.push(`"${name}" fails with your fix (exit ${withFix.code}). Last output:\n${tail(withFix.output, 4000)}`);
    if (!lines.length) return "passed";
    return fail(lines);
  }

  /**
   * The app's pages: start the paseo.json service in the check workspace (at the commit, with paseo.json
   * and the page check's files from base), run the page check script against it, keep the screenshots
   * it leaves in FOUNDRY_SCREENSHOTS for the review, then stop the service. The page check owns the
   * browser; Foundry only runs it. A service that doesn't come up or a failing check is a fix round,
   * then PAGE_CHECK_FAILED rework.
   */
  private async runPageStep(a: Attempt, step: Extract<LoopStep, { kind: "page" }>): Promise<"passed" | "skipped" | "fixing" | "ended"> {
    const i = this.store.issue(a.issue_key)!;
    const p = this.store.project(i.project_id)!;
    if (!a.head_sha) throw new Error(`${a.issue_key} has no commit to check`);
    const sha = a.head_sha;
    const resolved = resolvePage(step, await paseoScripts(p.repo, p.base_ref), await paseoServices(p.repo, p.base_ref));
    if (resolved.kind === "skip") {
      this.store.event("check_skipped", { issue: i.key, attempt: a.id, detail: { step: step.name, hint: resolved.hint } });
      return "skipped";
    }
    this.store.updateAttempt(a.id, { step: "check" });
    const fail = (lines: string[]) => this.fixOrEnd(a, step, sha, { flag: "PAGE_CHECK_FAILED", what: "page check", names: [step.name], lines });
    if (resolved.kind === "unknown") return fail([resolved.message]);
    const { service, script } = resolved;

    const { ws, path } = await this.checkWorkspace(a, i, p, sha);
    const fromBase = await filesFromBase(p.repo, p.base_ref, [script]);
    await git(path, "checkout", "-q", p.base_ref, "--", ...fromBase);
    const timeoutMs = step.timeout_minutes ? step.timeout_minutes * 60_000 : this.settings.checkTimeoutMs;

    const svcRun = this.store.startRun("check", { attempt: a.id, sha, detail: { name: `${step.name}: start ${service}`, service } });
    const started = await this.host.startService({ workspaceId: ws, script: service, timeoutMs: Math.min(SERVICE_START_MS, timeoutMs) });
    if (!started.ok) {
      this.store.endRun(svcRun, "failed", { tail: tail(started.output, 4000), terminal: started.terminalId });
      await this.host.stopService(ws, service).catch(() => {});
      return fail([`The "${service}" service didn't come up for the page check. Last output:\n${tail(started.output, 4000)}`]);
    }
    this.store.endRun(svcRun, "passed", { url: started.url, terminal: started.terminalId });

    const runId = this.store.startRun("check", { attempt: a.id, sha, detail: { name: step.name, command: script.command, service, page: true } });
    const dir = join(this.settings.shotsDir ?? join(tmpdir(), "foundry-shots"), i.key, `${a.n}-${runId}`);
    mkdirSync(dir, { recursive: true });
    const task = parse<TaskChecks>(i.checks, {});
    const env = { FOUNDRY_PAGE_URL: started.url, FOUNDRY_PAGES: (task.pages ?? []).join("\n"), FOUNDRY_SCREENSHOTS: dir };
    let r: Awaited<ReturnType<Host["runScript"]>>;
    try {
      r = await this.host.runScript({ workspaceId: ws, script: script.name, env, timeoutMs });
    } finally {
      await this.host.stopService(ws, service).catch(() => {});
    }
    const shots = readdirSync(dir).filter((f) => SHOT_FILE.test(f)).sort().slice(0, 20);
    const status = r.code === 0 ? "passed" : "failed";
    this.store.endRun(runId, status, { code: r.code, tail: tail(r.output, 4000), terminal: r.terminalId, url: started.url, dir, screenshots: shots });
    if (a.builder_agent_id)
      void this.host.timeline(a.builder_agent_id, `foundry-check-${runId}`, { step: "check", name: step.name, status, code: r.code, sha, tail: tail(r.output, 1200), screenshots: shots.map((f) => join(dir, f)) });
    if (r.code === 0) return "passed";
    return fail([
      `The page check "${script.name}" against ${started.url} exited ${r.code}. Last output:\n${tail(r.output, 4000)}`,
      ...(shots.length ? [`Its screenshots (open them to see the page):\n${shots.map((f) => join(dir, f)).join("\n")}`] : []),
    ]);
  }

  private async startReview(a: Attempt, step: Extract<LoopStep, { kind: "review" }>) {
    const i = this.store.issue(a.issue_key)!;
    const p = this.store.project(i.project_id)!;
    const { f, baseRef, fork } = await this.forkOf(a, i, p);
    const diff = await git(p.repo, "diff", `${fork}..${a.head_sha}`).catch((e) => String(e));
    const checkRuns = this.store.runs(a.id).filter((r) => r.kind === "check");
    const checkLines = checkRuns.slice(-12).map((r) => `- ${parse<{ name?: string }>(r.detail, {}).name ?? "check"}: ${r.status}`);
    // The latest page check's screenshots, at this commit: the reviewer opens them to see the pages.
    const pageRun = [...checkRuns].reverse().find((r) => r.sha === a.head_sha && parse<{ page?: boolean }>(r.detail, {}).page);
    const pageDetail = pageRun ? parse<{ dir?: string; screenshots?: string[]; url?: string }>(pageRun.detail, {}) : null;
    const shotLines = pageDetail?.dir && pageDetail.screenshots?.length ? pageDetail.screenshots.map((f) => `- ${join(pageDetail.dir!, f)}`) : [];
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
      shotLines.length ? `Screenshots from the page check (open them to see the pages as a user would):\n${shotLines.join("\n")}` : "",
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
    const i0 = this.store.issue(a.issue_key)!;
    // A failure worth retrying is retried after a backoff while retries are left, then the task is Blocked.
    const retryable = outcome === "failed" && !!o.reason && RETRYABLE.includes(o.reason);
    const maxRetries = this.settings.maxRetries ?? 2;
    const retryLeft = retryable && i0.retries < maxRetries;
    const detail = retryable && !retryLeft && maxRetries > 0 ? `${o.detail ?? o.reason} (gave up after ${i0.retries} automatic retr${i0.retries === 1 ? "y" : "ies"})` : o.detail;
    const issueStatus: IssueStatus = retryable && !retryLeft ? "Blocked" : (o.issueStatus ?? (outcome === "failed" ? "Failed" : "In_Review"));
    this.store.tx(() => {
      this.store.updateAttempt(a.id, { outcome, flag: o.flag ?? a.flag, reason: o.reason ?? null, waiting: null, step: "ended", ended_at: new Date().toISOString() });
      const i = this.store.issue(a.issue_key)!;
      if (["In_Progress", "Awaiting_Human", "Ready"].includes(i.status))
        this.store.setIssueStatus(a.issue_key, issueStatus, "system", o.reason ?? null, { attempt: a.n, outcome, flag: o.flag ?? null, detail: detail ?? null });
      if (retryLeft) {
        const at = new Date(Date.now() + (this.settings.retryBackoffMs ?? 60_000) * 2 ** i.retries).toISOString();
        this.store.updateIssue(a.issue_key, { retry_at: at });
        this.store.event("retry_scheduled", { issue: a.issue_key, attempt: a.id, detail: { retry: i.retries + 1, of: maxRetries, at, reason: o.reason } });
      } else if (!retryable && outcome !== "failed" && (i.retries || i.retry_at)) this.store.updateIssue(a.issue_key, { retries: 0, retry_at: null });
      this.store.event("attempt_ended", { issue: a.issue_key, attempt: a.id, detail: { outcome, reason: o.reason ?? null, flag: o.flag ?? null, detail: detail ?? null, head: a.head_sha } });
    });
    for (const [run, w] of this.watched) if (w.attemptId === a.id) this.watched.delete(run);
    if (o.reason === "INFRA_ERROR") this.tripBreaker();
    if (issueStatus === "In_Review")
      void this.host.notify({ title: `${a.issue_key} is ready for your review`, body: o.flag ? `Flagged ${o.flag}. ${o.detail ?? ""}` : "Checks and review passed.", key: `review:${a.issue_key}`, screen: "board" });
    if (issueStatus === "Blocked" && retryable)
      void this.host.notify({ title: `${a.issue_key} is blocked`, body: detail ?? "", key: `blocked:${a.issue_key}`, screen: "board" });
  }

  // ---------- supervision ----------
  /**
   * Watch every running agent turn of a task: stop one that has been silent for the idle timeout or has
   * run past the turn timeout (time spent waiting on a question or a permission card doesn't count).
   * Stopping interrupts the turn; if it hasn't ended after the grace period, Foundry stops the agent.
   */
  async supervise(now = Date.now()) {
    if (this.supervising) return;
    this.supervising = true;
    try {
      const live = new Set<number>();
      for (const a of this.store.activeAttempts()) {
        if (a.ended_at || !["build", "fix", "review"].includes(a.step)) continue;
        const agentId = a.step === "review" ? a.reviewer_agent_id : a.builder_agent_id;
        if (!agentId) continue;
        const run = this.openRun(a.id, agentId);
        if (!run) continue;
        live.add(run);
        let w = this.watched.get(run);
        if (!w) this.watched.set(run, (w = { attemptId: a.id, agentId, startedAt: now, lastActivity: now, pausedMs: 0, pausedSince: null }));
        if (w.stopping) {
          if (now - w.stopping.at >= (this.settings.stopGraceMs ?? 30_000)) await this.forceStop(a, w);
          continue;
        }
        if (a.waiting || this.store.get("SELECT 1 FROM questions WHERE attempt_id=? AND status='live'", a.id)) {
          w.pausedSince ??= now;
          continue;
        }
        if (w.pausedSince !== null) {
          w.pausedMs += now - w.pausedSince;
          w.pausedSince = null;
          w.lastActivity = now;
        }
        if (w.polledAt === undefined || now - w.polledAt >= (this.settings.activityPollMs ?? 10_000)) {
          w.polledAt = now;
          const marker = await this.activity(a, agentId);
          if (marker !== null && marker !== w.marker) {
            if (w.marker !== undefined) w.lastActivity = now;
            w.marker = marker;
          }
        }
        const idleMs = this.settings.idleTimeoutMs ?? 15 * 60_000;
        const turnMs = this.settings.turnTimeoutMs ?? 60 * 60_000;
        const role = a.step === "review" ? "reviewer" : "builder";
        if (idleMs > 0 && now - w.lastActivity >= idleMs) await this.stopTurn(a, w, `the ${role} was silent for ${minutes(now - w.lastActivity)}`);
        else if (turnMs > 0 && now - w.startedAt - w.pausedMs >= turnMs) await this.stopTurn(a, w, `the ${role}'s turn ran for ${minutes(now - w.startedAt - w.pausedMs)}`);
      }
      for (const run of [...this.watched.keys()]) if (!live.has(run)) this.watched.delete(run);
    } finally {
      this.supervising = false;
    }
  }

  /** What the agent last did, plus the builder's uncommitted changes: either changing is activity. */
  private async activity(a: Attempt, agentId: string) {
    const host = await this.host.agentActivity(agentId).catch(() => null);
    const files = a.step !== "review" && a.worktree_path && existsSync(a.worktree_path) ? await git(a.worktree_path, "status", "--porcelain").catch(() => "") : "";
    return host === null && !files ? null : `${host ?? ""}|${files}`;
  }

  private async stopTurn(a: Attempt, w: Watched, why: string) {
    w.stopping = { at: Date.now(), why };
    this.store.event("turn_timeout", { issue: a.issue_key, attempt: a.id, detail: { agent: w.agentId, step: a.step, why } });
    await this.host.interrupt(w.agentId).catch(() => {});
  }

  /** The interrupted turn didn't end in time: stop the agent and end the attempt. */
  private async forceStop(a: Attempt, w: Watched) {
    await this.locks.with(`attempt:${a.issue_key}`, async () => {
      const fresh = this.store.attempt(a.id)!;
      if (fresh.ended_at) return;
      this.store.event("agent_killed", { issue: a.issue_key, attempt: a.id, detail: { agent: w.agentId, why: w.stopping!.why } });
      this.endStopped(fresh, `${w.stopping!.why}; it didn't stop when interrupted, so Foundry stopped the agent`);
      await this.host.kill(w.agentId).catch((e) => this.store.event("kill_failed", { issue: a.issue_key, attempt: a.id, detail: { agent: w.agentId, error: String(e) } }));
    });
    await this.tick();
  }

  /** The turn that just ended is one Foundry stopped for running too long or going silent. */
  private stoppedTurn(a: Attempt, agentId: string) {
    for (const w of this.watched.values()) if (w.attemptId === a.id && w.agentId === agentId && w.stopping) return w.stopping;
    return null;
  }

  private endStopped(a: Attempt, why: string) {
    for (const r of this.store.runs(a.id).filter((r) => r.status === "running")) this.store.endRun(r.id, "failed", { error: why });
    this.endAttempt(a.id, "failed", { reason: "TIMEOUT", detail: why });
  }

  /** Paseo shows a permission card for a task's agent: its clocks pause and the board says so. */
  onPermission(agentId: string, waiting: boolean) {
    const a = this.store.attemptByAgent(agentId);
    if (!a || a.ended_at) return;
    this.store.updateAttempt(a.id, { waiting: waiting ? "permission" : null });
    this.store.event(waiting ? "permission_waiting" : "permission_answered", { issue: a.issue_key, attempt: a.id, detail: { agent: agentId } });
  }

  /** Retries whose backoff has passed start now. */
  private async startDueRetries() {
    const now = Date.now();
    for (const i of this.store.all<Issue>("SELECT * FROM issues WHERE retry_at IS NOT NULL AND status IN ('Failed','Blocked')")) {
      if (Date.parse(i.retry_at!) > now) continue;
      this.store.tx(() => {
        this.store.updateIssue(i.key, { retries: i.retries + 1, retry_at: null });
        this.store.setIssueStatus(i.key, "Ready", "system", null, { why: `automatic retry ${i.retries + 1}` });
      });
      await this.start(i.key, "system").catch((e) => this.store.event("start_error", { issue: i.key, detail: { error: String(e) } }));
    }
  }

  /** Auto-start is paused after repeated infrastructure failures, until you resume it. */
  autostartPaused(): { at: string; why: string } | null {
    const v = this.store.meta(BREAKER_KEY);
    return v ? (JSON.parse(v) as { at: string; why: string }) : null;
  }

  private tripBreaker() {
    if (this.autostartPaused()) return;
    const threshold = this.settings.breakerThreshold ?? 3;
    const since = new Date(Date.now() - (this.settings.breakerWindowMs ?? 10 * 60_000)).toISOString().replace("T", " ").slice(0, 19);
    const n = this.store.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE kind='attempt_ended' AND json_extract(detail,'$.reason')='INFRA_ERROR' AND at>=?", since)!.n;
    if (threshold <= 0 || n < threshold) return;
    const why = `${n} infrastructure failures in a row`;
    this.store.setMeta(BREAKER_KEY, JSON.stringify({ at: new Date().toISOString(), why }));
    this.store.event("autostart_paused", { detail: { why, failures: n } });
    void this.host.notify({ title: "Foundry paused auto-start", body: `${why}. Check Paseo (workspaces, harnesses), then resume auto-start on the board.`, key: "autostart-paused", screen: "board" });
  }

  resumeAutostart(actor: Actor = "you") {
    if (!this.autostartPaused()) return { paused: false };
    this.store.setMeta(BREAKER_KEY, null);
    this.store.event("autostart_resumed", { actor });
    void this.tick();
    return { paused: false };
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
  /** What the review panel shows: the attempt at the SHAs you would accept, its diff against the feature head, checks and verdicts. */
  async review(key: string) {
    const i = this.store.issue(key);
    if (!i) throw new FoundryError("NOT_FOUND", `No issue ${key}`);
    const a = this.store.latestAttempt(key);
    const runs = a ? this.store.all<{ id: number; kind: string; status: string; sha: string | null; detail: string; started_at: string; ended_at: string | null }>("SELECT id,kind,status,sha,detail,started_at,ended_at FROM runs WHERE attempt_id=? ORDER BY id", a.id) : [];
    const events = this.store.all<{ id: number; at: string; actor: string; kind: string; detail: string }>("SELECT id,at,actor,kind,detail FROM events WHERE issue_key=? ORDER BY id DESC LIMIT 50", key);
    const questions = this.store.all("SELECT * FROM questions WHERE issue_key=? ORDER BY id", key);
    let diff = "";
    let stat = "";
    let tree_sha: string | null = null;
    if (a?.head_sha) {
      const p = this.store.project(i.project_id)!;
      const f = i.feature_id ? target(this.store, i.feature_id, sliceOfIssue(this.store, i)?.id ?? null).view : null;
      const cwd = a.worktree_path && existsSync(a.worktree_path) ? a.worktree_path : p.repo;
      const base = f?.head_sha ? await git(cwd, "merge-base", f.head_sha, a.head_sha).catch(() => "") : "";
      if (base) {
        diff = await git(cwd, "diff", "--no-color", base, a.head_sha).catch(() => "");
        stat = await git(cwd, "diff", "--stat", "--no-color", base, a.head_sha).catch(() => "");
      }
      tree_sha = await treeOf(cwd, a.head_sha).catch(() => null);
    }
    const MAX = 200_000;
    return {
      issue: i,
      attempt: a ?? null,
      head_sha: a?.head_sha ?? null,
      tree_sha,
      stat,
      diff: diff.length > MAX ? diff.slice(0, MAX) + "\n… diff cut at 200 KB" : diff,
      runs: runs.map((r) => ({ ...r, detail: parse(r.detail, {}) })),
      events: events.map((e) => ({ ...e, detail: parse(e.detail, {}) })),
      questions,
    };
  }

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
    const result: { conflict?: string[]; merged?: string; branch?: string } = await this.locks.with(`feature:${pre.feature_id}`, () =>
      this.locks.with(`attempt:${key}`, async () => {
        const { i, a } = await this.assertReviewable(key, headSha, treeSha);
        // A task merges into its slice's branch: the feature's for the front slice.
        const t = target(this.store, i.feature_id!, sliceOfIssue(this.store, i)?.id ?? null);
        const f = t.view;
        if (!f.integration_path) throw new FoundryError("SLICE_ORDER", `${key}'s slice hasn't started yet`, { slice: t.slice?.n ?? null });
        try {
          await assertIntegrationUntouched(this.store, f);
        } catch (e) {
          this.store.setSetting(t.front ? `feature_hold:${f.id}` : `slice_hold:${t.slice!.id}`, "INTEGRATION_MOVED");
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
            return { conflict: conflicts, branch: f.branch };
          }
        }
        merged = await head(path);
        this.store.tx(() => {
          setTargetHead(this.store, t, merged);
          this.store.run("INSERT INTO reviews(attempt_id,actor,decision,head_sha,tree_sha,feedback) VALUES(?,?,?,?,?,?)", a.id, actor, "accept", headSha, treeSha, feedback);
          this.store.setIssueStatus(key, "Done", actor, null, { merged });
          this.store.event("task_merged", { actor, issue: key, attempt: a.id, feature: f.id, detail: { head: headSha, merged } });
          // Accepted as is with the spec changed under it: the flag stays, so its requirements stay not
          // covered and Verify reports them; a stale task cannot ship silently.
          if (i.flag === "SPEC_CHANGED") this.store.event("flag_accepted_as_is", { actor, issue: key, feature: f.id, detail: { refs: parse<string[]>(i.requirement_refs, []) } });
        });
        for (const ws of [a.workspace_id, a.check_workspace_id]) if (ws) void this.host.archiveWorkspace(ws).catch(() => {});
        // The slice building on top of the front takes the front's new work.
        if (t.front) await mergeForward(this.store, this.host, f.id, actor);
        return { merged, branch: f.branch };
      }),
    );
    if (result.conflict) {
      const conflict = result.conflict;
      // The reviewed SHA is kept (never rebased); the task goes back to its agent to merge the feature branch in.
      const branch = result.branch!;
      await this.continueInSession(
        key,
        `Accepting your work hit a merge conflict with ${branch} in: ${conflict.join(", ")}. Merge ${branch} into your branch, resolve the conflicts, and end your turn. Do not commit; Foundry commits for you.`,
        "system",
        "conflict",
      );
      return { conflict };
    }
    await this.tick();
    return { merged: result.merged };
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

  /**
   * A task flagged SPEC_CHANGED at review: the rework Foundry drafts for you, naming the requirements it
   * covers as they read now and what changed in them.
   */
  flagDraft(key: string) {
    const i = this.store.issue(key);
    if (!i) throw new FoundryError("NOT_FOUND", `No issue ${key}`);
    if (i.flag !== "SPEC_CHANGED" || !i.feature_id) throw new FoundryError("NOT_FLAGGED", `${key} is not flagged for a spec change`);
    const refs = parse<string[]>(i.requirement_refs, []);
    const change = this.store.get<{ diff: string }>("SELECT diff FROM spec_changes WHERE feature_id=? AND status='approved' ORDER BY id DESC LIMIT 1", i.feature_id);
    const d = parse<{ changed?: string[]; removed?: string[]; base?: { ref: string; title: string; criteria: string[] }[] }>(change?.diff, {});
    const now = new Map(this.store.requirements(i.feature_id).map((r) => [r.ref, r]));
    const lines = ["The spec changed while you worked on this task. Bring your work in line with the requirements as they read now:", ""];
    for (const ref of refs) {
      const r = now.get(ref);
      if (!r || d.removed?.includes(ref)) {
        lines.push(`- ${ref} was removed from the spec: take out anything you added only for it.`);
        continue;
      }
      lines.push(`- ${ref} ${r.title}${d.changed?.includes(ref) ? " (changed)" : ""}`);
      for (const c of parse<string[]>(r.criteria, [])) lines.push(`  - ${c}`);
      const was = d.changed?.includes(ref) ? d.base?.find((b) => b.ref === ref) : null;
      if (was) lines.push(`  Before the change it read: ${was.title}; ${was.criteria.join("; ")}`);
    }
    return { feedback: lines.join("\n") };
  }

  /** Cancel a flagged task at review, at the SHAs you read: the spec moved on and its work is not wanted. */
  async cancelAtReview(key: string, headSha: string, treeSha: string, actor: Actor = "you") {
    const a = await this.locks.with(`attempt:${key}`, async () => {
      const { i, a } = await this.assertReviewable(key, headSha, treeSha);
      if (i.flag !== "SPEC_CHANGED") throw new FoundryError("NOT_FLAGGED", `${key} is not flagged for a spec change; ask the project manager to cancel it`);
      this.store.tx(() => {
        this.store.run("INSERT INTO reviews(attempt_id,actor,decision,head_sha,tree_sha,feedback) VALUES(?,?,?,?,?,?)", a.id, actor, "cancel", headSha, treeSha, "");
        this.store.setIssueStatus(key, "Cancelled", actor, null, { why: "spec change", head: headSha });
      });
      return a;
    });
    for (const ws of [a.workspace_id, a.check_workspace_id]) if (ws) void this.host.archiveWorkspace(ws).catch(() => {});
    await this.tick();
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
    const loop = resolveLoop(i.loop, project.default_loop, await projectLoops(project.repo, project.base_ref));
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

  /**
   * Cancel an issue (call inside a card's transaction). A running attempt is ended as cancelled; the
   * returned agents should be interrupted once the transaction commits.
   */
  cancel(key: string, actor: Actor): string[] {
    const i = this.store.issue(key);
    if (!i) throw new FoundryError("NOT_FOUND", `No issue ${key}`);
    const stop: string[] = [];
    this.store.tx(() => {
      const a = this.store.activeAttempts().find((x) => x.issue_key === key);
      if (a) {
        this.store.updateAttempt(a.id, { outcome: "failed", flag: "CANCELLED", step: "ended", ended_at: new Date().toISOString() });
        this.store.event("attempt_ended", { actor, issue: key, attempt: a.id, detail: { outcome: "failed", flag: "CANCELLED", detail: "cancelled", head: a.head_sha } });
        for (const id of [a.builder_agent_id, a.reviewer_agent_id]) if (id) stop.push(id);
      }
      this.store.setIssueStatus(key, "Cancelled", actor);
    });
    return stop;
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

function minutes(ms: number) {
  const m = Math.round(ms / 60_000);
  return m >= 1 ? `${m} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}
