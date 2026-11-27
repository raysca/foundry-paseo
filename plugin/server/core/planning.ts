// Loop 1: the feature workflow. The PM writes the docs in one session per feature, in the feature's
// integration worktree; Foundry validates, commits, guards and moves stages. Every approval names the
// exact commit you read.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureIntegration, featureDir, steering, uniqueSlug } from "./features";
import { changedPaths, commitAll, FOUNDRY_IDENT, git, head, HOST_IDENT, PM_IDENT, sh } from "./git";
import { lintRequirements, renderTasks, validateTasks, type GraphResult, type ProposedRequirement, type ProposedTask } from "./graph";
import type { Host } from "./host";
import type { Locks } from "./locks";
import { FoundryError, TERMINAL_STATUSES, type Actor, type DocKind, type FeatureStage } from "./model";
import { parse, type Feature, type Question, type Store } from "./store";

export interface PlanningSettings {
  questionWindowMs: number;
  turnTimeoutMs: number;
}

export interface ClarifyQuestion {
  id: string;
  text: string;
  recommended: string;
  choices?: string[];
}

const GRILL_ROUNDS: Record<string, number> = { none: 0, light: 1, normal: 2 };
const MAX_QUESTIONS = 7;
const DOC_FILES: Record<DocKind, string> = { spec: "spec.md", plan: "plan.md", tasks: "tasks.md" };
const END_TURN =
  "The developer hasn't answered yet. End your turn now without writing the spec; the answers will arrive as your next message.";

interface Turn {
  agentId: string;
  runId: number;
  stage: FeatureStage;
  timer: NodeJS.Timeout | null;
}

export class Planning {
  private turns = new Map<number, Turn>();
  private liveRounds = new Map<number, (answers: Record<string, string> | null) => void>();

  constructor(
    private store: Store,
    private host: Host,
    private locks: Locks,
    private settings: PlanningSettings,
    private beforeStart: () => Promise<void> = async () => {},
    private onBuild: () => Promise<void> = async () => {},
  ) {}

  isBusy(featureId: number) {
    return this.turns.has(featureId);
  }

  // ---------- create ----------
  async createFeature(o: { projectId: number; idea: string; title?: string; flow?: "standard" | "quick"; grill?: string | null }, actor: Actor = "you") {
    const p = this.store.project(o.projectId);
    if (!p) throw new FoundryError("NOT_FOUND", `No project ${o.projectId}`);
    const idea = o.idea?.trim() ?? "";
    if (!idea) throw new FoundryError("IDEA_REQUIRED", "Describe the feature in a few sentences.");
    if (o.flow === "quick") throw new FoundryError("NOT_SUPPORTED_YET", "The Quick flow arrives in M2.");
    if (o.grill && !(o.grill in GRILL_ROUNDS)) throw new FoundryError("INVALID_GRILL", "Grill level is none, light or normal.");
    const title = (o.title?.trim() || idea.split("\n")[0]!).slice(0, 80);
    const slug = await uniqueSlug(this.store, p.id, p.repo, title);
    const f0 = this.store.createFeature({ projectId: p.id, slug, title, idea, flow: "standard", branch: `foundry/feature/${slug}` });
    if (o.grill) this.store.updateFeature(f0.id, { grill: o.grill });
    let f: Feature;
    try {
      f = await ensureIntegration(this.store, this.host, f0.id);
    } catch (e) {
      // Nothing is left behind: no worktree, no branch, no feature.
      const half = this.store.feature(f0.id)!;
      if (half.integration_workspace_id) await this.host.archiveWorkspace(half.integration_workspace_id).catch(() => {});
      await sh("git", ["branch", "-D", f0.branch], { cwd: p.repo });
      this.store.tx(() => {
        this.store.run("DELETE FROM feature_docs WHERE feature_id=?", f0.id);
        this.store.run("DELETE FROM events WHERE feature_id=?", f0.id);
        this.store.run("DELETE FROM features WHERE id=?", f0.id);
      });
      throw new FoundryError("CREATE_FAILED", `Could not create the feature: ${String(e instanceof Error ? e.message : e)}`);
    }
    this.store.event("feature_ready", { actor, project: p.id, feature: f.id, detail: { slug, branch: f.branch } });
    await this.runTurn(f.id, "clarify", this.clarifySteps(f)).catch((e) => this.failTurn(f.id, String(e instanceof Error ? e.message : e)));
    return this.store.feature(f.id)!;
  }

  // ---------- turns ----------
  private rounds(f: Feature) {
    return GRILL_ROUNDS[f.grill ?? "light"] ?? 1;
  }

  private preamble(f: Feature) {
    const dir = featureDir(f.slug);
    return [
      `You are Foundry's project manager, planning the feature "${f.title}". You work in the feature's integration worktree on ${f.branch}.`,
      `Write only under ${dir}/. Anything else you change is undone after your turn. Do not commit: Foundry commits your docs.`,
      "Your Foundry tools: ask_questions (a Clarify round), propose_requirements (the spec's requirements), propose_tasks (the task graph).",
    ].join("\n");
  }

  private clarifySteps(f: Feature) {
    const dir = featureDir(f.slug);
    const left = this.rounds(f) - f.clarify_rounds;
    return [
      left > 0
        ? `Step 1, Clarify: if anything important is unclear, call ask_questions once with at most ${MAX_QUESTIONS} questions, each with an id, the question and your recommended answer. If the reply tells you to end your turn, do that; the answers arrive as your next message. Decide anything else with sensible defaults and list them under Decisions.`
        : "Step 1: do not ask questions. Decide with sensible defaults and list them under Decisions.",
      this.specSteps(dir),
    ].join("\n\n");
  }

  private specSteps(dir: string) {
    return [
      `Step 2, Spec: write ${dir}/spec.md with ## Goal, ## User stories, ## Requirements (numbered R1, R2, … each with EARS acceptance criteria, one per line), ## Out of scope and ## Decisions (include the developer's answers).`,
      "Call propose_requirements with the same requirements. If it returns errors, fix them and call it again.",
      "Then analyse the requirements for ambiguity, conflicts and gaps, and put the findings under ## Analysis. End your turn.",
    ].join("\n");
  }

  private planSteps(f: Feature) {
    const dir = featureDir(f.slug);
    return `The spec is approved. Re-read ${dir}/spec.md and write ${dir}/plan.md with ## Approach, ## Files and components, ## Data and API changes, ## Risks and ## Test strategy. End your turn.`;
  }

  private tasksSteps(f: Feature) {
    const dir = featureDir(f.slug);
    return [
      `The plan is approved. Read ${dir}/spec.md and plan.md, then call propose_tasks with the task graph.`,
      "Each task has a ref (T1, T2, …), title, description, exit_criteria, requirement_refs (together they must cover every requirement), depends_on (task refs, each with a reason), touches (paths from the plan), size (S, M or L) and checks.scripts (names of paseo.json scripts).",
      "Do not write tasks.md; Foundry writes it. If propose_tasks returns errors, fix them and call it again. End your turn.",
    ].join("\n");
  }

  /** Start (or continue) the feature's planning session. Refused while a turn runs. */
  private async runTurn(featureId: number, stage: FeatureStage, message: string) {
    await this.locks.with(`feature:${featureId}`, async () => {
      if (this.turns.has(featureId)) throw new FoundryError("FEATURE_BUSY", "The project manager is working on this feature");
      await this.beforeStart();
      const f = this.store.feature(featureId)!;
      const agentId = f.planner_agent_id ?? randomUUID();
      const runId = this.store.startRun("plan", { feature: f.id, agent: agentId, sha: f.head_sha, detail: { stage } });
      const timer = this.settings.turnTimeoutMs > 0 ? setTimeout(() => void this.host.interrupt(agentId).catch(() => {}), this.settings.turnTimeoutMs) : null;
      timer?.unref?.();
      this.turns.set(f.id, { agentId, runId, stage, timer });
      this.store.updateFeature(f.id, { planning_error: null });
      this.store.event("planning_started", { actor: "system", project: f.project_id, feature: f.id, detail: { stage } });
      try {
        if (!f.planner_agent_id) {
          this.store.updateFeature(f.id, { planner_agent_id: agentId });
          const p = this.store.project(f.project_id)!;
          const prompt = [this.preamble(f), await steering(p.repo, p.base_ref), `The idea:\n${f.idea}`, message].filter(Boolean).join("\n\n");
          await this.host.startAgent({
            agentId,
            role: "planner",
            place: { kind: "workspace", workspaceId: f.integration_workspace_id! },
            prompt,
            title: `${f.title} · planning`,
            featureId: f.id,
            projectId: f.project_id,
          });
        } else {
          await this.host.send(agentId, message);
        }
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.turns.delete(f.id);
        this.store.endRun(runId, "failed", { error: String(e) });
        throw e;
      }
    });
  }

  private failTurn(featureId: number, why: string) {
    const f = this.store.feature(featureId)!;
    this.store.updateFeature(featureId, { planning_error: why });
    this.store.event("planning_failed", { actor: "system", project: f.project_id, feature: f.id, detail: { error: why, stage: f.stage } });
  }

  async onTurnEnd(agentId: string, outcome: { kind: string; message?: string }, tracked: boolean) {
    const f0 = this.store.get<Feature>("SELECT * FROM features WHERE planner_agent_id=?", agentId);
    if (!f0) return;
    await this.locks.with(`feature:${f0.id}`, async () => {
      const turn = this.turns.get(f0.id);
      if (!tracked || !turn) {
        // A turn someone started in Paseo: the write guard still applies, but it never moves a stage.
        const r = await this.guardAndCommit(this.store.feature(f0.id)!, HOST_IDENT, "edit from a turn Foundry did not start");
        this.store.event("untracked_planning_turn", { actor: "host-user", project: f0.project_id, feature: f0.id, detail: { reverted: r.reverted, commit: r.commit } });
        return;
      }
      if (turn.timer) clearTimeout(turn.timer);
      this.turns.delete(f0.id);
      this.store.endRun(turn.runId, outcome.kind === "completed" ? "completed" : "failed", { outcome: outcome.kind, message: outcome.message });
      const f = this.store.feature(f0.id)!;
      const r = await this.guardAndCommit(f, PM_IDENT, `planning turn (${turn.stage})`);
      if (r.reverted.length) this.store.event("write_guard", { actor: "system", project: f.project_id, feature: f.id, detail: { reverted: r.reverted } });
      if (outcome.kind !== "completed") return this.failTurn(f.id, `The project manager's last turn ${outcome.kind}${outcome.message ? `: ${outcome.message}` : ""}`);
      this.store.event("planning_done", { actor: "system", project: f.project_id, feature: f.id, detail: { stage: turn.stage, commit: r.commit } });
      await this.afterTurn(this.store.feature(f.id)!, turn.stage);
    });
  }

  /** Undo the PM's own commits, keep only the feature folder, restore everything else, commit the docs. */
  private async guardAndCommit(f: Feature, ident: string[], what: string) {
    const path = f.integration_path!;
    const base = f.head_sha!;
    const dir = featureDir(f.slug) + "/";
    if ((await head(path)) !== base) await git(path, "reset", "-q", base);
    else await git(path, "reset", "-q");
    const reverted: string[] = [];
    for (const p of await changedPaths(path)) {
      if (p.startsWith(dir)) continue;
      const tracked = await git(path, "cat-file", "-e", `${base}:${p}`).then(
        () => true,
        () => false,
      );
      if (tracked) await git(path, "checkout", "-q", base, "--", p);
      else rmSync(join(path, p), { force: true, recursive: true });
      reverted.push(p);
    }
    const commit = await commitAll(path, `${f.slug}: ${what}`, ident);
    if (commit) {
      this.store.updateFeature(f.id, { head_sha: commit });
      await this.trackDocs(f.id, base, commit);
    }
    return { reverted, commit };
  }

  /** A doc's head_sha is the commit where its file last changed; that is the SHA an approval names. */
  private async trackDocs(featureId: number, from: string, to: string) {
    const f = this.store.feature(featureId)!;
    for (const kind of ["spec", "plan", "tasks"] as DocKind[]) {
      const file = `${featureDir(f.slug)}/${DOC_FILES[kind]}`;
      const changed = (await sh("git", ["diff", "--quiet", from, to, "--", file], { cwd: f.integration_path! })).code !== 0;
      if (changed) {
        const d = this.store.doc(featureId, kind)!;
        this.store.updateDoc(featureId, kind, { head_sha: to, status: d.status === "approved" ? "in_review" : d.status });
        this.store.event("doc_revised", { actor: "system", project: f.project_id, feature: f.id, detail: { doc: kind, sha: to } });
      }
    }
  }

  private docExists(f: Feature, kind: DocKind) {
    return existsSync(join(f.integration_path!, featureDir(f.slug), DOC_FILES[kind]));
  }

  private openQuestions(featureId: number) {
    return this.store.all<Question>("SELECT * FROM questions WHERE feature_id=? AND issue_key IS NULL AND status IN ('live','waiting') ORDER BY id", featureId);
  }

  private async afterTurn(f: Feature, stage: FeatureStage) {
    if (stage === "clarify" || stage === "spec") {
      if (this.openQuestions(f.id).length) {
        this.store.event("awaiting_answers", { actor: "system", project: f.project_id, feature: f.id });
        return;
      }
      if (!this.docExists(f, "spec")) return this.failTurn(f.id, `The project manager ended its turn without writing ${featureDir(f.slug)}/spec.md.`);
      if (!this.store.requirements(f.id).length) return this.failTurn(f.id, "The project manager ended its turn without calling propose_requirements.");
      this.store.updateDoc(f.id, "spec", { status: "in_review" });
      this.store.setStage(f.id, "spec");
      return;
    }
    if (stage === "plan") {
      if (!this.docExists(f, "plan")) return this.failTurn(f.id, `The project manager ended its turn without writing ${featureDir(f.slug)}/plan.md.`);
      this.store.updateDoc(f.id, "plan", { status: "in_review" });
      return;
    }
    if (stage === "tasks") {
      const prop = this.store.proposal(f.id);
      if (!prop) return this.failTurn(f.id, "The project manager ended its turn without calling propose_tasks.");
      await this.writeTasksDoc(f, prop.id);
    }
  }

  /** Foundry writes tasks.md from the current proposal and commits it; its SHA is what approval names. */
  private async writeTasksDoc(f: Feature, proposalId: number) {
    const prop = this.store.get<{ tasks: string; result: string; cut: string }>("SELECT tasks,result,cut FROM task_proposals WHERE id=?", proposalId)!;
    const file = join(f.integration_path!, featureDir(f.slug), DOC_FILES.tasks);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderTasks(f.title, parse<ProposedTask[]>(prop.tasks, []), parse<GraphResult>(prop.result, {} as GraphResult), parse<string[]>(prop.cut, [])));
    const before = f.head_sha!;
    const commit = await commitAll(f.integration_path!, `${f.slug}: tasks.md from proposal ${proposalId}`, FOUNDRY_IDENT);
    const sha = commit ?? before;
    if (commit) this.store.updateFeature(f.id, { head_sha: commit });
    this.store.run("UPDATE task_proposals SET tasks_sha=? WHERE id=?", sha, proposalId);
    this.store.updateDoc(f.id, "tasks", { head_sha: sha, status: "in_review" });
  }

  // ---------- tools ----------
  private plannerFeature(agentId: string) {
    const rec = this.store.agent(agentId);
    const f = this.store.get<Feature>("SELECT * FROM features WHERE planner_agent_id=?", agentId);
    if (!rec || rec.role !== "planner" || !f) throw new FoundryError("TOOL_REFUSED", "This tool is for a feature's planning turn");
    if (!this.turns.has(f.id)) throw new FoundryError("TOOL_REFUSED", "This tool works only during a planning turn Foundry started");
    return f;
  }

  /** ask_questions: one Clarify round. Waits live for the answers up to the question window. */
  async askQuestions(agentId: string, questions: ClarifyQuestion[], signal?: AbortSignal): Promise<string> {
    const f = this.plannerFeature(agentId);
    if (!["clarify", "spec"].includes(f.stage)) throw new FoundryError("TOOL_REFUSED", "Clarify questions are asked before the spec is approved");
    const limit = this.rounds(f);
    if (f.clarify_rounds >= limit)
      throw new FoundryError("ROUNDS_USED", `No Clarify round is left (grill ${f.grill ?? "light"} allows ${limit}). Decide with sensible defaults and list them under Decisions.`);
    const errors: string[] = [];
    if (!questions.length) errors.push("Ask at least one question, or don't call ask_questions.");
    if (questions.length > MAX_QUESTIONS) errors.push(`At most ${MAX_QUESTIONS} questions in a round; trim to the ones that matter.`);
    const ids = new Set<string>();
    for (const q of questions) {
      if (!q.id?.trim() || ids.has(q.id)) errors.push(`Question ids must be unique and non-empty ("${q.id}").`);
      ids.add(q.id);
      if (!q.text?.trim()) errors.push(`${q.id}: needs the question text.`);
      if (!q.recommended?.trim()) errors.push(`${q.id}: needs a recommended answer.`);
    }
    if (errors.length) throw new FoundryError("QUESTIONS_INVALID", errors.join("\n"));
    const round = f.clarify_rounds + 1;
    this.store.tx(() => {
      this.store.updateFeature(f.id, { clarify_rounds: round });
      for (const q of questions)
        this.store.run(
          "INSERT INTO questions(feature_id,agent_id,text,choices,status,qkey,recommended,round) VALUES(?,?,?,?,'live',?,?,?)",
          f.id,
          agentId,
          q.text,
          JSON.stringify(q.choices ?? []),
          q.id,
          q.recommended,
          round,
        );
      this.store.event("questions_asked", { actor: "pm", project: f.project_id, feature: f.id, detail: { round, ids: questions.map((q) => q.id) } });
    });
    void this.host.notify({ title: `${f.title}: the project manager has ${questions.length} question(s)`, body: questions[0]!.text, key: `clarify:${f.id}:${round}`, screen: "feature" });
    const answers = await new Promise<Record<string, string> | null>((resolve) => {
      const t = setTimeout(() => resolve(null), this.settings.questionWindowMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve(null);
      });
      this.liveRounds.set(f.id, (a) => {
        clearTimeout(t);
        resolve(a);
      });
    });
    this.liveRounds.delete(f.id);
    if (!answers) {
      this.store.run("UPDATE questions SET status='waiting' WHERE feature_id=? AND round=? AND status='live'", f.id, round);
      return END_TURN;
    }
    return `The developer's answers:\n${formatAnswers(answers)}\n\nContinue with Step 2.`;
  }

  /** Your answers to a Clarify round. A blank answer takes the recommendation. */
  async answer(featureId: number, given: Record<string, string>, actor: Actor = "you") {
    const f = this.store.feature(featureId);
    if (!f) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
    const open = this.openQuestions(featureId);
    if (!open.length) throw new FoundryError("NO_OPEN_QUESTIONS", "There are no open questions on this feature");
    const answers: Record<string, string> = {};
    for (const q of open) answers[q.qkey ?? String(q.id)] = given[q.qkey ?? String(q.id)]?.trim() || q.recommended || "";
    this.store.tx(() => {
      for (const q of open) this.store.run("UPDATE questions SET status='answered', answer=?, answered_at=datetime('now') WHERE id=?", answers[q.qkey ?? String(q.id)]!, q.id);
      this.store.event("questions_answered", { actor, project: f.project_id, feature: f.id, detail: { answers } });
    });
    const live = this.liveRounds.get(featureId);
    if (live) {
      live(answers);
      return { delivered: "live" };
    }
    await this.runTurn(featureId, f.stage, `Answers to your Clarify questions:\n${formatAnswers(answers)}\n\n${this.specSteps(featureDir(f.slug))}`);
    return { delivered: "turn" };
  }

  /** propose_requirements: replaces the list; refs unique; EARS lint errors come back to fix. */
  proposeRequirements(agentId: string, reqs: ProposedRequirement[]) {
    const f = this.plannerFeature(agentId);
    if (!["clarify", "spec"].includes(f.stage)) throw new FoundryError("TOOL_REFUSED", "Requirements change only with the spec (spec changes after the task list arrive with the spec edit cascade)");
    const errors = lintRequirements(reqs);
    if (errors.length) throw new FoundryError("REQUIREMENTS_INVALID", `Not recorded. Fix and resend:\n- ${errors.join("\n- ")}`, { errors });
    this.store.setRequirements(
      f.id,
      reqs.map((r) => ({ ref: r.ref, title: r.title, criteria: r.acceptance_criteria })),
      null,
    );
    this.store.event("requirements_proposed", { actor: "pm", project: f.project_id, feature: f.id, detail: { refs: reqs.map((r) => r.ref) } });
    return { recorded: reqs.length };
  }

  /** propose_tasks: validates the graph; the list is recorded only when it passes. */
  proposeTasks(agentId: string, tasks: ProposedTask[]) {
    const f = this.plannerFeature(agentId);
    if (f.stage !== "tasks") throw new FoundryError("TOOL_REFUSED", "Tasks are proposed once the plan is approved");
    const reqs = this.store.requirements(f.id).map((r) => r.ref);
    const result = validateTasks(tasks, reqs, this.unfinishedIssues(f));
    const prop = this.store.addProposal(f.id, tasks, result);
    this.store.event("tasks_proposed", { actor: "pm", project: f.project_id, feature: f.id, detail: { proposal: prop.id, tasks: tasks.length, warnings: result.warnings.length } });
    return { recorded: true, proposal: prop.id, waves: result.waves, critical_path: result.critical_path, warnings: result.warnings };
  }

  private unfinishedIssues(f: Feature) {
    return this.store
      .issues({ projectId: f.project_id })
      .filter((i) => !TERMINAL_STATUSES.includes(i.status))
      .map((i) => ({ key: i.key, touches: parse<string[]>(i.touches, []) }));
  }

  // ---------- your actions ----------
  private editable(featureId: number) {
    const f = this.store.feature(featureId);
    if (!f) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
    if (f.status === "cancelled" || f.stage === "done") throw new FoundryError("FEATURE_CLOSED", `This feature is ${f.status === "cancelled" ? "cancelled" : "done"}`);
    if (this.turns.has(f.id)) throw new FoundryError("FEATURE_BUSY", "The project manager is working on this feature");
    return f;
  }

  private assertDoc(f: Feature, kind: DocKind, sha: string) {
    const d = this.store.doc(f.id, kind)!;
    if (d.status !== "in_review") throw new FoundryError("NOT_IN_REVIEW", `The ${kind} is ${d.status}, not waiting for your review`);
    if (d.head_sha !== sha) throw new FoundryError("STALE_APPROVAL", "It changed since you read it", { head_sha: d.head_sha });
  }

  async approveSpec(featureId: number, sha: string, actor: Actor = "you") {
    await this.locks.with(`feature:${featureId}`, async () => {
      const f = this.editable(featureId);
      if (f.stage !== "spec") throw new FoundryError("WRONG_STAGE", `The feature is in ${f.stage}, not Spec`);
      this.assertDoc(f, "spec", sha);
      const reqs = this.store.requirements(f.id);
      if (!reqs.length) throw new FoundryError("REQUIREMENTS_MISSING", "No requirements were proposed for this spec");
      const errors = lintRequirements(reqs.map((r) => ({ ref: r.ref, title: r.title, acceptance_criteria: parse<string[]>(r.criteria, []) })));
      if (errors.length) throw new FoundryError("REQUIREMENTS_INVALID", errors.join("\n"), { errors });
      this.store.tx(() => {
        this.store.updateDoc(f.id, "spec", { status: "approved", approved_sha: sha });
        this.store.run("UPDATE requirements SET spec_sha=? WHERE feature_id=? AND retired=0", sha, f.id);
        this.store.event("doc_approved", { actor, project: f.project_id, feature: f.id, detail: { doc: "spec", sha } });
        this.store.setStage(f.id, "plan", actor);
      });
    });
    await this.runTurn(featureId, "plan", this.planSteps(this.store.feature(featureId)!)).catch((e) => this.failTurn(featureId, String(e)));
    return this.store.feature(featureId)!;
  }

  async approvePlan(featureId: number, sha: string, actor: Actor = "you") {
    await this.locks.with(`feature:${featureId}`, async () => {
      const f = this.editable(featureId);
      if (f.stage !== "plan") throw new FoundryError("WRONG_STAGE", `The feature is in ${f.stage}, not Plan`);
      this.assertDoc(f, "plan", sha);
      this.store.tx(() => {
        this.store.updateDoc(f.id, "plan", { status: "approved", approved_sha: sha });
        this.store.event("doc_approved", { actor, project: f.project_id, feature: f.id, detail: { doc: "plan", sha } });
        this.store.setStage(f.id, "tasks", actor);
      });
    });
    await this.runTurn(featureId, "tasks", this.tasksSteps(this.store.feature(featureId)!)).catch((e) => this.failTurn(featureId, String(e)));
    return this.store.feature(featureId)!;
  }

  /** Cut or restore a task in the current proposal. tasks.md is rewritten, so approval needs its new SHA. */
  async cutTask(featureId: number, ref: string, cut: boolean, actor: Actor = "you") {
    return this.locks.with(`feature:${featureId}`, async () => {
      const f = this.editable(featureId);
      if (f.stage !== "tasks") throw new FoundryError("WRONG_STAGE", `The feature is in ${f.stage}, not Tasks`);
      const prop = this.store.proposal(f.id);
      if (!prop) throw new FoundryError("NO_PROPOSAL", "There is no task list to edit");
      const tasks = parse<ProposedTask[]>(prop.tasks, []);
      if (!tasks.some((t) => t.ref === ref)) throw new FoundryError("NOT_FOUND", `No task ${ref}`);
      const cuts = new Set(parse<string[]>(prop.cut, []));
      if (cut) cuts.add(ref);
      else cuts.delete(ref);
      // Dependents of a cut task lose that edge reason-wise; coverage is checked at approval.
      let result: GraphResult;
      try {
        result = validateTasks(
          tasks.map((t) => ({ ...t, depends_on: (t.depends_on ?? []).filter((d) => !cuts.has(d.ref)) })),
          this.store.requirements(f.id).map((r) => r.ref),
          this.unfinishedIssues(f),
          [...cuts],
        );
      } catch (e) {
        if (!(e instanceof FoundryError)) throw e;
        result = { ...parse<GraphResult>(prop.result, {} as GraphResult), warnings: [...((e.detail.errors as string[]) ?? []).map((x) => `Blocks approval: ${x}`)] };
      }
      this.store.run("UPDATE task_proposals SET cut=?, result=? WHERE id=?", JSON.stringify([...cuts]), JSON.stringify(result), prop.id);
      this.store.event(cut ? "task_cut" : "task_restored", { actor, project: f.project_id, feature: f.id, detail: { proposal: prop.id, ref } });
      await this.writeTasksDoc(this.store.feature(f.id)!, prop.id);
      return { proposal: prop.id, tasks_sha: this.store.doc(f.id, "tasks")!.head_sha };
    });
  }

  /** Approve the task list at the proposal and tasks.md SHA you read: one issue per live task. */
  async approveTasks(featureId: number, proposalId: number, sha: string, actor: Actor = "you") {
    const keys = await this.locks.with(`feature:${featureId}`, async () => {
      const f = this.editable(featureId);
      if (f.stage !== "tasks") throw new FoundryError("WRONG_STAGE", `The feature is in ${f.stage}, not Tasks`);
      const prop = this.store.proposal(f.id);
      if (!prop || prop.id !== proposalId) throw new FoundryError("PROPOSAL_CHANGED", "The task list changed: review the current one", { current: prop?.id ?? null });
      this.assertDoc(f, "tasks", sha);
      const cut = parse<string[]>(prop.cut, []);
      const all = parse<ProposedTask[]>(prop.tasks, []);
      const tasks = all.map((t) => ({ ...t, depends_on: (t.depends_on ?? []).filter((d) => !cut.includes(d.ref)) }));
      const reqs = this.store.requirements(f.id).map((r) => r.ref);
      const g = validateTasks(tasks, reqs, this.unfinishedIssues(f), cut);
      const byRef = new Map(tasks.map((t) => [t.ref, t]));
      return this.store.tx(() => {
        const keyOf = new Map<string, string>();
        for (const wave of g.waves)
          for (const ref of wave) {
            const t = byRef.get(ref)!;
            const deps = (t.depends_on ?? []).filter((d) => !g.redundant.some((r) => r.from === ref && r.to === d.ref));
            const depKeys = deps.map((d) => keyOf.get(d.ref) ?? d.ref);
            const waiting = depKeys.some((k) => this.store.issue(k)?.status !== "Done");
            const i = this.store.createIssue({
              projectId: f.project_id,
              featureId: f.id,
              origin: "feature",
              title: t.title,
              description: t.description ?? "",
              acceptance: t.exit_criteria ?? "",
              status: waiting ? "Backlog" : "Ready",
              priority: g.priority[ref],
              size: t.size ?? null,
              loop: t.loop ?? null,
              checks: t.checks ?? {},
              touches: t.touches ?? [],
              requirementRefs: t.requirement_refs ?? [],
              profile: t.profile ?? null,
              actor,
            });
            deps.forEach((d, n) => this.store.addDep(i.key, depKeys[n]!, d.reason ?? ""));
            keyOf.set(ref, i.key);
          }
        this.store.run("UPDATE task_proposals SET status='approved' WHERE id=?", prop.id);
        this.store.updateDoc(f.id, "tasks", { status: "approved", approved_sha: sha });
        this.store.event("tasks_approved", { actor, project: f.project_id, feature: f.id, detail: { proposal: prop.id, issues: Object.fromEntries(keyOf), cut } });
        this.store.setStage(f.id, "build", actor);
        return Object.fromEntries(keyOf);
      });
    });
    await this.onBuild();
    return { issues: keys };
  }

  /** A revision request: the PM revises the doc in the same stage; it waits for your approval again. */
  async revise(featureId: number, kind: DocKind, note: string, actor: Actor = "you") {
    if (!note.trim()) throw new FoundryError("FEEDBACK_REQUIRED", "A revision request needs a note");
    const f = this.editable(featureId);
    const stageOf: Record<DocKind, FeatureStage> = { spec: "spec", plan: "plan", tasks: "tasks" };
    if (f.stage !== stageOf[kind]) throw new FoundryError("WRONG_STAGE", `The feature is in ${f.stage}; the ${kind} can be revised in ${stageOf[kind]}`);
    const dir = featureDir(f.slug);
    const how: Record<DocKind, string> = {
      spec: `Revise ${dir}/spec.md. Keep the refs of requirements you don't change, and call propose_requirements again if they changed.`,
      plan: `Revise ${dir}/plan.md.`,
      tasks: "Revise the task graph and call propose_tasks again. Do not write tasks.md.",
    };
    this.store.event("revision_requested", { actor, project: f.project_id, feature: f.id, detail: { doc: kind, note } });
    await this.runTurn(
      f.id,
      f.stage,
      `The developer asks for a revision of the ${kind}:\n\n${note}\n\n${how[kind]} Do what the note asks; if it is unclear or conflicts with the doc, say so in your reply instead of reinterpreting it. End your turn.`,
    );
    return { ok: true };
  }

  /** Run the stage's turn again after a failure. */
  async retry(featureId: number) {
    const f = this.editable(featureId);
    const steps: Partial<Record<FeatureStage, string>> = { clarify: this.clarifySteps(f), spec: this.specSteps(featureDir(f.slug)), plan: this.planSteps(f), tasks: this.tasksSteps(f) };
    const s = steps[f.stage];
    if (!s) throw new FoundryError("WRONG_STAGE", `Nothing to plan in ${f.stage}`);
    await this.runTurn(f.id, f.stage, `Your last turn did not finish. Continue:\n\n${s}`);
    return { ok: true };
  }

  async setStatus(featureId: number, status: "active" | "paused" | "cancelled", actor: Actor = "you") {
    const f = this.store.feature(featureId);
    if (!f) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
    if (f.status === "cancelled" || f.stage === "done") throw new FoundryError("FEATURE_CLOSED", "A done or cancelled feature cannot change status");
    if (f.status === status) return f;
    this.store.updateFeature(f.id, { status });
    this.store.event("feature_status", { actor, project: f.project_id, feature: f.id, detail: { from: f.status, to: status } });
    const turn = this.turns.get(f.id);
    if (status === "cancelled" && turn) await this.host.interrupt(turn.agentId).catch(() => {});
    if (status === "active") await this.onBuild();
    return this.store.feature(f.id)!;
  }

  /** A doc's text at its head, for the UI and for approvals. */
  async readDoc(featureId: number, kind: DocKind) {
    const f = this.store.feature(featureId);
    if (!f) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
    const d = this.store.doc(featureId, kind)!;
    const sha = d.head_sha;
    const text = sha ? await git(f.integration_path!, "show", `${sha}:${featureDir(f.slug)}/${DOC_FILES[kind]}`).catch(() => "") : "";
    return { kind, status: d.status, sha, approved_sha: d.approved_sha, text };
  }

  async recover() {
    this.store.run("UPDATE questions SET status='waiting' WHERE feature_id IS NOT NULL AND issue_key IS NULL AND status='live'");
    for (const r of this.store.all<{ id: number; feature_id: number; agent_id: string }>("SELECT id,feature_id,agent_id FROM runs WHERE kind='plan' AND status='running'")) {
      if (this.turns.has(r.feature_id)) continue;
      const status = await this.host.agentStatus(r.agent_id).catch(() => "gone" as const);
      if (status === "running") {
        // Its turn.after will arrive; track it so the guard and stage logic run.
        const f = this.store.feature(r.feature_id)!;
        this.turns.set(r.feature_id, { agentId: r.agent_id, runId: r.id, stage: f.stage, timer: null });
        continue;
      }
      this.store.endRun(r.id, "failed", { reason: "infra: restarted" });
      this.failTurn(r.feature_id, "The project manager's last turn was cut off by a restart");
    }
  }
}

function formatAnswers(a: Record<string, string>) {
  return Object.entries(a)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
}
