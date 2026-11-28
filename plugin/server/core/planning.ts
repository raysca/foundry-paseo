// Loop 1: the feature workflow. The PM writes the docs in one session per feature, in the feature's
// integration worktree; Foundry validates, commits, guards and moves stages. Every approval names the
// exact commit you read.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureIntegration, featureDir, reopenOnBase, steering, uniqueSlug, type Reopened } from "./features";
import { activeSlices, setTargetStage, target } from "./slices";
import { loopNames, projectLoops, type ProjectLoops } from "./loops";
import { firstRemote } from "./github";
import { changedPaths, commitAll, FOUNDRY_IDENT, git, head, HOST_IDENT, PM_IDENT, sh } from "./git";
import { checkLoops, diffRequirements, lintRequirements, renumbered, validateChangeSet, type RequirementDiff, renderRequirements, withRequirements, renderTasks, validateTasks, validateSlices, type GraphResult, type ProposedRequirement, type ProposedSlice, type ProposedTask, type SliceResult } from "./graph";
import type { Host } from "./host";
import type { Locks } from "./locks";
import { FoundryError, TERMINAL_STATUSES, type Actor, type DocKind, type FeatureStage } from "./model";
import { parse, type DocComment, type Feature, type Question, type Store } from "./store";

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

/** What a planning turn is for: a stage's step, or one of the two turns of a spec change. */
/** "quick" is a Quick-flow turn: spec, plan and the task proposal together. */
type TurnKind = FeatureStage | "spec_change" | "change_set" | "quick";

interface Turn {
  agentId: string;
  runId: number;
  stage: TurnKind;
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
    if (o.flow && !["standard", "quick"].includes(o.flow)) throw new FoundryError("INVALID_FLOW", "Flow is standard or quick.");
    if (o.grill && !(o.grill in GRILL_ROUNDS)) throw new FoundryError("INVALID_GRILL", "Grill level is none, light or normal.");
    const title = (o.title?.trim() || idea.split("\n")[0]!).slice(0, 80);
    const slug = await uniqueSlug(this.store, p.id, p.repo, title);
    const f0 = this.store.createFeature({ projectId: p.id, slug, title, idea, flow: o.flow ?? "standard", branch: "" });
    if (o.grill) this.store.updateFeature(f0.id, { grill: o.grill });
    let f: Feature;
    try {
      f = await ensureIntegration(this.store, this.host, f0.id);
    } catch (e) {
      // Nothing is left behind: no worktree, no branch, no feature.
      const half = this.store.feature(f0.id)!;
      if (half.integration_workspace_id) await this.host.archiveWorkspace(half.integration_workspace_id).catch(() => {});
      if (half.branch) await sh("git", ["branch", "-D", half.branch], { cwd: p.repo });
      this.store.tx(() => {
        this.store.run("DELETE FROM feature_docs WHERE feature_id=?", f0.id);
        this.store.run("DELETE FROM events WHERE feature_id=?", f0.id);
        this.store.run("DELETE FROM features WHERE id=?", f0.id);
      });
      throw new FoundryError("CREATE_FAILED", `Could not create the feature: ${String(e instanceof Error ? e.message : e)}`);
    }
    this.store.event("feature_ready", { actor, project: p.id, feature: f.id, detail: { slug, branch: f.branch } });
    await this.runTurn(f.id, this.quick(f) ? "quick" : "clarify", this.clarifySteps(f)).catch((e) => this.failTurn(f.id, String(e instanceof Error ? e.message : e)));
    return this.store.feature(f.id)!;
  }

  // ---------- turns ----------
  private rounds(f: Feature) {
    const n = GRILL_ROUNDS[f.grill ?? "light"] ?? 1;
    return this.quick(f) ? Math.min(n, 1) : n; // a Quick-flow feature gets at most one round
  }

  private quick(f: Feature) {
    return f.flow === "quick";
  }

  /** What follows Clarify: the spec steps, or in the Quick flow spec, plan and tasks in the same turn. */
  private afterClarify(f: Feature) {
    const dir = featureDir(f.slug);
    if (!this.quick(f)) return this.specSteps(dir);
    return [
      this.specSteps(dir, false),
      `Step 3, Plan: write ${dir}/plan.md with ## Approach, ## Files and components, ## Data and API changes, ## Risks and ## Test strategy.`,
      `Step 4, Tasks: ${this.taskRules()} End your turn.`,
      "This is the Quick flow: the developer approves all three at once, at the task list.",
    ].join("\n\n");
  }

  private preamble(f: Feature) {
    const dir = featureDir(f.slug);
    return [
      `You are Foundry's project manager, planning the feature "${f.title}". You work in the feature's integration worktree on ${f.branch}.`,
      `Write only under ${dir}/. Anything else you change is undone after your turn. Do not commit: Foundry commits your docs.`,
      "Your Foundry tools: ask_questions (a Clarify round), propose_requirements (the spec's requirements), propose_tasks (the task graph), comment_on_doc (a comment on a line of spec.md, plan.md or tasks.md for the developer).",
    ].join("\n");
  }

  private clarifySteps(f: Feature) {
    const dir = featureDir(f.slug);
    const left = this.rounds(f) - f.clarify_rounds;
    return [
      left > 0
        ? `Step 1, Clarify: if anything important is unclear, call ask_questions once with at most ${MAX_QUESTIONS} questions, each with an id, the question and your recommended answer. If the reply tells you to end your turn, do that; the answers arrive as your next message. Decide anything else with sensible defaults and list them under Decisions.`
        : "Step 1: do not ask questions. Decide with sensible defaults and list them under Decisions.",
      this.afterClarify(f),
    ].join("\n\n");
  }

  private specSteps(dir: string, end = true) {
    return [
      `Step 2, Spec: write ${dir}/spec.md with ## Goal, ## User stories, ## Requirements, ## Out of scope and ## Decisions (include the developer's answers).`,
      "Call propose_requirements with the requirements (refs R1, R2, …, each with EARS acceptance criteria). If it returns errors, fix them and call it again. Foundry writes the ## Requirements section of spec.md from them, so leave that section to Foundry.",
      "Then analyse the requirements for ambiguity, conflicts and gaps, and put the findings under ## Analysis. Where a line of the spec clashes with work already in flight in this project, leave a comment_on_doc on that line saying what it clashes with.",
      end ? "End your turn." : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private planSteps(f: Feature) {
    const dir = featureDir(f.slug);
    return `The spec is approved. Re-read ${dir}/spec.md and write ${dir}/plan.md with ## Approach, ## Files and components, ## Data and API changes, ## Risks and ## Test strategy. End your turn.`;
  }

  private tasksSteps(f: Feature) {
    const dir = featureDir(f.slug);
    return [
      `The plan is approved. Read ${dir}/spec.md and plan.md, then ${this.taskRules()} End your turn.`,
    ].join("\n");
  }

  private taskRules() {
    return [
      "call propose_tasks with the task graph.",
      "Each task has a ref (T1, T2, …), title, description, exit_criteria, requirement_refs (together they must cover every requirement), depends_on (task refs, each with a reason), touches (paths from the plan), size (S, M or L) and checks.scripts (names of paseo.json scripts).",
      "Group the tasks into slices when the feature is more than a handful of tasks: slices: [{n, title, goal}] and a slice number on each task. Slices ship in order (1 first), each as its own PR with its own Verify, so each slice must deliver working behaviour on its own (thin and end to end, not all the backend first). A task depends only on tasks in its own or an earlier slice. Aim for at most 8 tasks per slice and 4 slices per feature; a feature bigger than that should be split into separate features. A small feature is one slice: leave slices out.",
      "Give each task a loop, the steps it runs through: bugfix for a task that fixes a defect (it reproduces the bug with a test first), docs for a task that only touches documentation, frontend for a task that changes what a user sees, backend for everything else. A project loop in .foundry/loops/<name>.yaml can be named too. Leave loop out for the project's default.",
      "Do not write tasks.md; Foundry writes it. If propose_tasks returns errors, fix them and call it again.",
    ].join("\n");
  }

  /** Start (or continue) the feature's planning session. Refused while a turn runs. */
  private async runTurn(featureId: number, stage: TurnKind, message: string) {
    await this.locks.with(`feature:${featureId}`, async () => {
      if (this.turns.has(featureId)) throw new FoundryError("FEATURE_BUSY", "The project manager is working on this feature");
      await this.beforeStart();
      const f = this.store.feature(featureId)!;
      const proj = this.store.project(f.project_id)!;
      this.loops.set(f.project_id, await projectLoops(proj.repo, proj.base_ref).catch(() => ({ loops: {}, invalid: {} })));
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
    this.syncRequirements(f);
    const commit = await commitAll(path, `${f.slug}: ${what}`, ident);
    if (commit) {
      this.store.updateFeature(f.id, { head_sha: commit });
      await this.trackDocs(f.id, base, commit);
    }
    for (const kind of ["spec", "plan", "tasks"] as DocKind[]) {
      const at = this.store.doc(f.id, kind)?.head_sha;
      if (at) this.store.run("UPDATE doc_comments SET sha=? WHERE feature_id=? AND doc=? AND sha=?", at, f.id, kind, PENDING);
    }
    await this.carryComments(f.id);
    return { reverted, commit };
  }

  /** Rewrite spec.md's Requirements section from the requirements Foundry holds (the database is the source of truth). */
  private syncRequirements(f: Feature) {
    const file = join(f.integration_path!, featureDir(f.slug), DOC_FILES.spec);
    const reqs = this.store.requirements(f.id);
    if (!existsSync(file) || !reqs.length) return;
    const doc = readFileSync(file, "utf8");
    const next = withRequirements(doc, renderRequirements(reqs.map((r) => ({ ref: r.ref, title: r.title, criteria: parse<string[]>(r.criteria, []) }))));
    if (next !== doc) writeFileSync(file, next);
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

  private async afterTurn(f: Feature, stage: TurnKind) {
    if (stage === "spec_change") {
      if (!this.store.requirements(f.id).length) return this.failTurn(f.id, "The project manager ended its spec-change turn without requirements.");
      this.store.updateDoc(f.id, "spec", { status: "in_review" });
      return;
    }
    if (stage === "change_set") {
      const prop = this.store.proposal(f.id);
      if (!prop || prop.kind !== "change") return this.failTurn(f.id, "The project manager ended its change turn without calling propose_tasks.");
      await this.writeTasksDoc(f, prop.id);
      return;
    }
    if (stage === "quick") return this.afterQuickTurn(f);
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

  /** A Quick-flow turn ends in Tasks once spec, requirements, plan and a task proposal all exist and no question is open. */
  private async afterQuickTurn(f: Feature) {
    if (this.openQuestions(f.id).length) {
      this.store.event("awaiting_answers", { actor: "system", project: f.project_id, feature: f.id });
      return;
    }
    const dir = featureDir(f.slug);
    if (!this.docExists(f, "spec")) return this.failTurn(f.id, `The project manager ended its turn without writing ${dir}/spec.md.`);
    if (!this.store.requirements(f.id).length) return this.failTurn(f.id, "The project manager ended its turn without calling propose_requirements.");
    if (!this.docExists(f, "plan")) return this.failTurn(f.id, `The project manager ended its turn without writing ${dir}/plan.md.`);
    const prop = this.store.proposal(f.id);
    if (!prop || prop.status !== "proposed") return this.failTurn(f.id, "The project manager ended its turn without calling propose_tasks.");
    this.store.updateDoc(f.id, "spec", { status: "in_review" });
    this.store.updateDoc(f.id, "plan", { status: "in_review" });
    await this.writeTasksDoc(this.store.feature(f.id)!, prop.id);
    if (f.stage !== "tasks") this.store.setStage(f.id, "tasks");
  }

  /** Foundry writes tasks.md from the current proposal and commits it; its SHA is what approval names. */
  private async writeTasksDoc(f: Feature, proposalId: number) {
    const prop = this.store.get<{ tasks: string; result: string; cut: string; slices: string; kind: string }>("SELECT tasks,result,cut,slices,kind FROM task_proposals WHERE id=?", proposalId)!;
    const file = join(f.integration_path!, featureDir(f.slug), DOC_FILES.tasks);
    mkdirSync(dirname(file), { recursive: true });
    const slices = prop.kind === "change" ? [] : (this.proposalSlices(f, prop) ?? []);
    writeFileSync(file, renderTasks(f.title, parse<ProposedTask[]>(prop.tasks, []), parse<GraphResult>(prop.result, {} as GraphResult), parse<string[]>(prop.cut, []), slices));
    const before = f.head_sha!;
    const commit = await commitAll(f.integration_path!, `${f.slug}: tasks.md from proposal ${proposalId}`, FOUNDRY_IDENT);
    const sha = commit ?? before;
    if (commit) this.store.updateFeature(f.id, { head_sha: commit });
    this.store.run("UPDATE task_proposals SET tasks_sha=? WHERE id=?", sha, proposalId);
    this.store.updateDoc(f.id, "tasks", { head_sha: sha, status: "in_review" });
    await this.carryComments(f.id);
  }

  /**
   * Open comments follow a doc to its new revision when their line is unchanged (same text, the diff
   * only moved it). A comment whose line changed stays on the revision it was written on.
   */
  private async carryComments(featureId: number) {
    const f = this.store.feature(featureId)!;
    for (const kind of ["spec", "plan", "tasks"] as DocKind[]) {
      const now = this.store.doc(f.id, kind)?.head_sha;
      if (!now) continue;
      const rel = `${featureDir(f.slug)}/${DOC_FILES[kind]}`;
      const open = this.store.all<DocComment>("SELECT * FROM doc_comments WHERE feature_id=? AND doc=? AND status!='resolved' AND sha!=? AND sha!=?", f.id, kind, now, PENDING);
      if (!open.length) continue;
      const lines = (await this.docAt(f, kind, now)).split("\n");
      const diffs = new Map<string, string | null>();
      for (const c of open) {
        if (!diffs.has(c.sha)) diffs.set(c.sha, await git(f.integration_path!, "diff", "-U0", c.sha, now, "--", rel).catch(() => null));
        const diff = diffs.get(c.sha);
        if (diff === null || diff === undefined) continue;
        const to = mapLine(diff, c.line);
        if (to === null || (lines[to - 1] ?? "").slice(0, 200) !== c.quote) continue;
        this.store.run("UPDATE doc_comments SET sha=?, line=? WHERE id=?", now, to, c.id);
      }
    }
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
    if (this.quick(f) && this.turns.get(f.id)!.stage !== "quick") throw new FoundryError("TOOL_REFUSED", "Clarify questions are asked in the first turn of a Quick-flow feature");
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
    await this.runTurn(featureId, this.quick(f) ? "quick" : f.stage, `Answers to your Clarify questions:\n${formatAnswers(answers)}\n\n${this.afterClarify(f)}`);
    return { delivered: "turn" };
  }

  /** propose_requirements: replaces the list; refs unique; EARS lint errors come back to fix. */
  proposeRequirements(agentId: string, reqs: ProposedRequirement[]) {
    const f = this.plannerFeature(agentId);
    const kind = this.turns.get(f.id)!.stage;
    if (!["clarify", "spec"].includes(f.stage) && kind !== "spec_change" && kind !== "quick") throw new FoundryError("TOOL_REFUSED", "Requirements change with the spec: in Clarify or Spec, or in a spec-change turn");
    const errors = lintRequirements(reqs);
    const approved = this.store.approvedRequirements(f.id).map((r) => ({ ref: r.ref, title: r.title, criteria: parse<string[]>(r.criteria, []) }));
    errors.push(...renumbered(approved, reqs.map((r) => ({ ref: r.ref, title: r.title, criteria: r.acceptance_criteria }))));
    const retired = new Set(this.store.requirements(f.id, true).filter((r) => r.retired).map((r) => r.ref));
    for (const r of reqs) if (retired.has(r.ref)) errors.push(`${r.ref} was removed earlier and is never reused; use a new ref.`);
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
  proposeTasks(agentId: string, tasks: ProposedTask[], slices: ProposedSlice[] = []) {
    const f = this.plannerFeature(agentId);
    if (this.turns.get(f.id)!.stage === "change_set") return this.proposeChangeSet(f, tasks);
    if (f.stage !== "tasks" && this.turns.get(f.id)!.stage !== "quick") throw new FoundryError("TOOL_REFUSED", "Tasks are proposed once the plan is approved, or in a change turn");
    const reqs = this.store.requirements(f.id).map((r) => r.ref);
    const loopWarnings = this.checkTaskLoops(f, tasks);
    const graph = validateTasks(tasks, reqs, this.unfinishedIssues(f));
    const sl = validateSlices(f.title, slices, tasks);
    const result = { ...graph, warnings: [...graph.warnings, ...sl.warnings, ...loopWarnings] };
    const declared = sl.slices.map(({ n, title, goal }) => ({ n, title, goal }));
    const prop = this.store.addProposal(f.id, tasks, result, "initial", declared);
    this.store.event("tasks_proposed", { actor: "pm", project: f.project_id, feature: f.id, detail: { proposal: prop.id, tasks: tasks.length, slices: declared.length, warnings: result.warnings.length } });
    return { recorded: true, proposal: prop.id, waves: result.waves, critical_path: result.critical_path, slices: sl.slices.map((x) => ({ n: x.n, title: x.title, tasks: x.tasks, requirements: x.requirement_refs })), warnings: result.warnings };
  }

  /** Loops read from base when the planning turn started (built-ins only until then). */
  private loops = new Map<number, ProjectLoops>();
  private checkTaskLoops(f: Feature, tasks: ProposedTask[]) {
    const pl = this.loops.get(f.project_id) ?? { loops: {}, invalid: {} };
    return checkLoops(tasks, loopNames(pl), pl.invalid);
  }

  /** The slices of a proposal as they stand (with your edits and cuts), or null when they don't validate. */
  private proposalSlices(f: Feature, prop: { tasks: string; cut: string; slices: string }): SliceResult[] | null {
    try {
      return validateSlices(f.title, parse<ProposedSlice[]>(prop.slices, []), parse<ProposedTask[]>(prop.tasks, []), parse<string[]>(prop.cut, [])).slices;
    } catch {
      return null;
    }
  }

  /**
   * Your edits to the slices of the task list before you approve it: move a task to another slice (one
   * past the last makes a new slice), move a slice to another place in the merge order, merge one slice
   * into another, or rename one. Empty slices go and the rest are renumbered; tasks.md is rewritten.
   */
  async editSlices(
    featureId: number,
    op: { kind: "move_task"; ref: string; slice: number } | { kind: "move_slice"; from: number; to: number } | { kind: "merge"; from: number; into: number } | { kind: "rename"; slice: number; title: string; goal?: string } | { kind: "set_loop"; ref: string; loop: string | null },
    actor: Actor = "you",
  ) {
    return this.locks.with(`feature:${featureId}`, async () => {
      const f = this.editable(featureId);
      if (f.stage !== "tasks") throw new FoundryError("WRONG_STAGE", `The feature is in ${f.stage}, not Tasks`);
      const prop = this.store.proposal(f.id);
      if (!prop || prop.kind === "change") throw new FoundryError("NO_PROPOSAL", "There is no task list to edit");
      const tasks = parse<ProposedTask[]>(prop.tasks, []);
      let slices = parse<ProposedSlice[]>(prop.slices, []);
      if (!slices.length) slices = [{ n: 1, title: f.title }];
      const has = (n: number) => slices.some((x) => x.n === n);
      if (op.kind === "set_loop") {
        // Pick a task's loop before you approve: a built-in or a valid loop in .foundry/loops on base.
        const t = tasks.find((x) => x.ref === op.ref);
        if (!t) throw new FoundryError("NOT_FOUND", `No task ${op.ref}`);
        const p = this.store.project(f.project_id)!;
        const pl = await projectLoops(p.repo, p.base_ref);
        this.loops.set(f.project_id, pl);
        if (op.loop) checkLoops([{ ...t, loop: op.loop }], loopNames(pl), pl.invalid);
        if (op.loop) t.loop = op.loop;
        else delete t.loop;
      } else if (op.kind === "move_task") {
        const t = tasks.find((x) => x.ref === op.ref);
        if (!t) throw new FoundryError("NOT_FOUND", `No task ${op.ref}`);
        if (op.slice === slices.length + 1) slices.push({ n: op.slice, title: `Slice ${op.slice}` });
        else if (!has(op.slice)) throw new FoundryError("SLICE_INVALID", `There is no slice ${op.slice}`);
        t.slice = op.slice;
      } else if (op.kind === "move_slice") {
        if (!has(op.from) || !has(op.to)) throw new FoundryError("SLICE_INVALID", "No such slice");
        const order = slices.map((x) => x.n);
        order.splice(order.indexOf(op.from), 1);
        order.splice(op.to - 1, 0, op.from);
        const to = new Map(order.map((n, i) => [n, i + 1]));
        for (const t of tasks) t.slice = to.get(t.slice ?? 1);
        slices = slices.map((x) => ({ ...x, n: to.get(x.n)! }));
      } else if (op.kind === "merge") {
        if (!has(op.from) || !has(op.into) || op.from === op.into) throw new FoundryError("SLICE_INVALID", "Merge one slice into another");
        for (const t of tasks) if ((t.slice ?? 1) === op.from) t.slice = op.into;
      } else {
        const sl = slices.find((x) => x.n === op.slice);
        if (!sl || !op.title.trim()) throw new FoundryError("SLICE_INVALID", "Name an existing slice and give it a title");
        sl.title = op.title.trim();
        if (op.goal !== undefined) sl.goal = op.goal;
      }
      // Drop empty slices and renumber 1..k in order.
      const cut = parse<string[]>(prop.cut, []);
      const used = new Set(tasks.filter((t) => !cut.includes(t.ref)).map((t) => t.slice ?? 1));
      const kept = slices.filter((x) => used.has(x.n)).sort((a, b) => a.n - b.n);
      const renum = new Map(kept.map((x, i) => [x.n, i + 1]));
      for (const t of tasks) if (renum.has(t.slice ?? 1)) t.slice = renum.get(t.slice ?? 1);
      slices = kept.map((x) => ({ ...x, n: renum.get(x.n)! }));
      let result = parse<GraphResult>(prop.result, {} as GraphResult);
      try {
        const graph = validateTasks(tasks.map((t) => ({ ...t, depends_on: (t.depends_on ?? []).filter((d) => !cut.includes(d.ref)) })), this.store.requirements(f.id).map((r) => r.ref), this.unfinishedIssues(f), cut);
        result = { ...graph, warnings: [...graph.warnings, ...validateSlices(f.title, slices, tasks, cut).warnings, ...this.checkTaskLoops(f, tasks.filter((t) => !cut.includes(t.ref)))] };
      } catch (e) {
        if (!(e instanceof FoundryError)) throw e;
        result = { ...result, warnings: ((e.detail.errors as string[]) ?? [e.message]).map((x) => `Blocks approval: ${x}`) };
      }
      this.store.run("UPDATE task_proposals SET tasks=?, slices=?, result=? WHERE id=?", JSON.stringify(tasks), JSON.stringify(slices), JSON.stringify(result), prop.id);
      this.store.event("slices_edited", { actor, project: f.project_id, feature: f.id, detail: { proposal: prop.id, ...op } });
      await this.writeTasksDoc(this.store.feature(f.id)!, prop.id);
      return { proposal: prop.id, tasks_sha: this.store.doc(f.id, "tasks")!.head_sha, slices };
    });
  }

  private unfinishedIssues(f: Feature) {
    return this.store
      .issues({ projectId: f.project_id })
      .filter((i) => !TERMINAL_STATUSES.includes(i.status))
      .map((i) => ({ key: i.key, touches: parse<string[]>(i.touches, []) }));
  }

  // ---------- your actions ----------
  private editable(featureId: number, o: { done?: boolean } = {}) {
    const f = this.store.feature(featureId);
    if (!f) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
    if (f.status === "cancelled" || (f.stage === "done" && !o.done)) throw new FoundryError("FEATURE_CLOSED", `This feature is ${f.status === "cancelled" ? "cancelled" : "done"}`);
    if (this.turns.has(f.id)) throw new FoundryError("FEATURE_BUSY", "The project manager is working on this feature");
    return f;
  }

  private notQuick(f: Feature) {
    if (this.quick(f)) throw new FoundryError("QUICK_FLOW", "A Quick-flow feature is approved once, at the task list");
  }

  private assertDoc(f: Feature, kind: DocKind, sha: string) {
    const d = this.store.doc(f.id, kind)!;
    if (d.status !== "in_review") throw new FoundryError("NOT_IN_REVIEW", `The ${kind} is ${d.status}, not waiting for your review`);
    if (d.head_sha !== sha) throw new FoundryError("STALE_APPROVAL", "It changed since you read it", { head_sha: d.head_sha });
  }

  async approveSpec(featureId: number, sha: string, actor: Actor = "you") {
    if (this.store.feature(featureId)?.spec_change_open) return this.approveChangedSpec(featureId, sha, actor);
    await this.locks.with(`feature:${featureId}`, async () => {
      const f = this.editable(featureId);
      this.notQuick(f);
      if (f.stage !== "spec") throw new FoundryError("WRONG_STAGE", `The feature is in ${f.stage}, not Spec`);
      this.assertDoc(f, "spec", sha);
      const reqs = this.store.requirements(f.id);
      if (!reqs.length) throw new FoundryError("REQUIREMENTS_MISSING", "No requirements were proposed for this spec");
      const errors = lintRequirements(reqs.map((r) => ({ ref: r.ref, title: r.title, acceptance_criteria: parse<string[]>(r.criteria, []) })));
      if (errors.length) throw new FoundryError("REQUIREMENTS_INVALID", errors.join("\n"), { errors });
      this.store.tx(() => {
        this.store.updateDoc(f.id, "spec", { status: "approved", approved_sha: sha });
        this.store.run("UPDATE requirements SET spec_sha=? WHERE feature_id=? AND retired=0", sha, f.id);
        this.store.approveRequirements(f.id);
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
      this.notQuick(f);
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
        const graph = validateTasks(
          tasks.map((t) => ({ ...t, depends_on: (t.depends_on ?? []).filter((d) => !cuts.has(d.ref)) })),
          this.store.requirements(f.id).map((r) => r.ref),
          this.unfinishedIssues(f),
          [...cuts],
        );
        result = { ...graph, warnings: [...graph.warnings, ...validateSlices(f.title, parse<ProposedSlice[]>(prop.slices, []), tasks, [...cuts]).warnings] };
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
  async approveTasks(featureId: number, proposalId: number, sha: string, actor: Actor = "you", docs: { spec?: string; plan?: string } = {}) {
    if (this.store.proposal(featureId)?.kind === "change") return this.approveChangeSet(featureId, proposalId, sha, actor);
    const keys = await this.locks.with(`feature:${featureId}`, async () => {
      const f = this.editable(featureId);
      if (f.stage !== "tasks") throw new FoundryError("WRONG_STAGE", `The feature is in ${f.stage}, not Tasks`);
      const prop = this.store.proposal(f.id);
      if (!prop || prop.id !== proposalId) throw new FoundryError("PROPOSAL_CHANGED", "The task list changed: review the current one", { current: prop?.id ?? null });
      this.assertDoc(f, "tasks", sha);
      if (this.quick(f)) {
        // One approval for all three: it names the spec and plan SHAs you read too.
        if (!docs.spec || !docs.plan) throw new FoundryError("SHA_REQUIRED", "A Quick-flow approval names the spec and plan SHAs you read");
        this.assertDoc(f, "spec", docs.spec);
        this.assertDoc(f, "plan", docs.plan);
        const reqs = this.store.requirements(f.id);
        const errors = lintRequirements(reqs.map((r) => ({ ref: r.ref, title: r.title, acceptance_criteria: parse<string[]>(r.criteria, []) })));
        if (errors.length) throw new FoundryError("REQUIREMENTS_INVALID", errors.join("\n"), { errors });
      }
      const cut = parse<string[]>(prop.cut, []);
      const all = parse<ProposedTask[]>(prop.tasks, []);
      const tasks = all.map((t) => ({ ...t, depends_on: (t.depends_on ?? []).filter((d) => !cut.includes(d.ref)) }));
      const reqs = this.store.requirements(f.id).map((r) => r.ref);
      const g = validateTasks(tasks, reqs, this.unfinishedIssues(f), cut);
      const sl = validateSlices(f.title, parse<ProposedSlice[]>(prop.slices, []), all, cut).slices;
      const byRef = new Map(tasks.map((t) => [t.ref, t]));
      return this.store.tx(() => {
        const keyOf = new Map<string, string>();
        // The slices, in merge order. Slice 1 builds on the feature branch; later slices wait their turn.
        const sliceId = new Map<number, number>();
        for (const x of sl)
          sliceId.set(
            x.n,
            this.store.addSlice(f.id, {
              n: x.n,
              title: x.title,
              goal: x.goal,
              requirementRefs: x.requirement_refs,
              status: x.n === 1 ? "building" : "planned",
              ...(x.n === 1 ? { branch: f.branch, workspaceId: f.integration_workspace_id, path: f.integration_path, headSha: f.head_sha } : {}),
            }).id,
          );
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
              sliceId: sliceId.get(t.slice ?? 1) ?? null,
              actor,
            });
            deps.forEach((d, n) => this.store.addDep(i.key, depKeys[n]!, d.reason ?? ""));
            keyOf.set(ref, i.key);
          }
        this.store.run("UPDATE task_proposals SET status='approved' WHERE id=?", prop.id);
        if (this.quick(f)) {
          this.store.updateDoc(f.id, "spec", { status: "approved", approved_sha: docs.spec! });
          this.store.updateDoc(f.id, "plan", { status: "approved", approved_sha: docs.plan! });
          this.store.run("UPDATE requirements SET spec_sha=? WHERE feature_id=? AND retired=0", docs.spec!, f.id);
          this.store.approveRequirements(f.id);
          for (const k of ["spec", "plan"] as const) this.store.event("doc_approved", { actor, project: f.project_id, feature: f.id, detail: { doc: k, sha: docs[k] } });
        }
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
  async revise(featureId: number, kind: DocKind, note: string, actor: Actor = "you", commentIds: number[] = []) {
    const f = this.editable(featureId);
    const picked = this.pickComments(f, kind, commentIds);
    if (!note.trim() && !picked.length) throw new FoundryError("FEEDBACK_REQUIRED", "A revision request needs a note or at least one comment");
    note = revisionText(kind, note, picked);
    if (this.quick(f) && f.stage === "tasks") return this.reviseQuick(f, kind, note, actor, picked);
    const stageOf: Record<DocKind, FeatureStage> = { spec: "spec", plan: "plan", tasks: "tasks" };
    if (f.stage !== stageOf[kind]) throw new FoundryError("WRONG_STAGE", `The feature is in ${f.stage}; the ${kind} can be revised in ${stageOf[kind]}`);
    const dir = featureDir(f.slug);
    const how: Record<DocKind, string> = {
      spec: `Revise ${dir}/spec.md. Keep the refs of requirements you don't change, and call propose_requirements again if they changed.`,
      plan: `Revise ${dir}/plan.md.`,
      tasks: "Revise the task graph and call propose_tasks again. Do not write tasks.md.",
    };
    this.store.tx(() => {
      this.markSent(picked);
      this.store.event("revision_requested", { actor, project: f.project_id, feature: f.id, detail: { doc: kind, note, comments: picked.map((c) => c.id) } });
    });
    await this.runTurn(f.id, f.stage, `${note}\n\n${how[kind]} ${DO_WHAT_IT_ASKS} End your turn.`);
    return { ok: true, sent: picked.map((c) => c.id) };
  }

  /** Your saved comments on this doc, picked for a revision request. */
  private pickComments(f: Feature, kind: DocKind, ids: number[]) {
    const out: DocComment[] = [];
    for (const id of ids) {
      const c = this.store.comment(Number(id));
      if (!c || c.feature_id !== f.id || c.doc !== kind) throw new FoundryError("NOT_FOUND", `No comment ${id} on this ${kind}`);
      if (c.author !== "you" || c.status !== "saved") throw new FoundryError("COMMENT_SENT", `Comment ${id} was already sent`);
      out.push(c);
    }
    return out;
  }

  private markSent(cs: DocComment[]) {
    for (const c of cs) this.store.run("UPDATE doc_comments SET status='sent', sent_at=datetime('now') WHERE id=?", c.id);
  }

  /** A comment on a line of a doc at the SHA you read. It is saved, not sent, until a revision request takes it. */
  async comment(featureId: number, kind: DocKind, sha: string, line: number, body: string, actor: Actor = "you") {
    const f = this.store.feature(featureId);
    if (!f) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
    if (f.status === "cancelled" || f.stage === "done") throw new FoundryError("FEATURE_CLOSED", `This feature is ${f.status === "cancelled" ? "cancelled" : "done"}`);
    if (!body.trim()) throw new FoundryError("FEEDBACK_REQUIRED", "A comment needs some text");
    const d = this.store.doc(f.id, kind)!;
    if (!d.head_sha) throw new FoundryError("NOT_FOUND", `There is no ${kind} yet`);
    if (d.head_sha !== sha) throw new FoundryError("STALE_REVIEW", "It changed since you read it", { head_sha: d.head_sha });
    const lines = (await this.docAt(f, kind, sha)).split("\n");
    if (!Number.isInteger(line) || line < 1 || line > lines.length) throw new FoundryError("LINE_INVALID", `Line ${line} is not in ${DOC_FILES[kind]} (it has ${lines.length})`);
    const c = this.store.addComment({ featureId: f.id, doc: kind, sha, line, quote: lines[line - 1]!.slice(0, 200), body: body.trim(), author: "you" });
    this.store.event("comment_saved", { actor, project: f.project_id, feature: f.id, detail: { doc: kind, line, comment: c.id } });
    return c;
  }

  /** Resolve a sent comment or one of the PM's: it stays in the list, marked resolved, and stops counting as open. */
  resolveComment(id: number, actor: Actor = "you") {
    const c = this.store.comment(id);
    if (!c) throw new FoundryError("NOT_FOUND", `No comment ${id}`);
    if (c.status === "saved") throw new FoundryError("COMMENT_NOT_SENT", "Send or delete a comment you haven't sent; there's nothing to resolve yet");
    if (c.status === "resolved") return c;
    this.store.run("UPDATE doc_comments SET status='resolved', resolved_at=datetime('now') WHERE id=?", id);
    this.store.event("comment_resolved", { actor, feature: c.feature_id, detail: { comment: id, doc: c.doc } });
    return this.store.comment(id)!;
  }

  /** What approving now would leave open on a doc: your unsent comments and the PM's unresolved ones. Approval is not blocked by them. */
  openComments(featureId: number, kind: DocKind) {
    const all = this.store.comments(featureId, kind);
    return { drafts: all.filter((c) => c.author === "you" && c.status === "saved").length, pm: all.filter((c) => c.author === "pm" && c.status === "sent").length };
  }

  /** Delete one of your comments that has not been sent. */
  deleteComment(id: number, actor: Actor = "you") {
    const c = this.store.comment(id);
    if (!c) throw new FoundryError("NOT_FOUND", `No comment ${id}`);
    if (c.author !== "you" || c.status !== "saved") throw new FoundryError("COMMENT_SENT", "Only a comment you saved and haven't sent can be deleted");
    this.store.run("DELETE FROM doc_comments WHERE id=?", id);
    this.store.event("comment_deleted", { actor, feature: c.feature_id, detail: { comment: id } });
    return { deleted: id };
  }

  /** comment_on_doc: the PM's comment on a line of a doc (a clash it found, or a reply to your comment). */
  async pmComment(agentId: string, kind: DocKind, line: number, body: string) {
    const f = this.plannerFeature(agentId);
    if (!body.trim()) throw new FoundryError("FEEDBACK_REQUIRED", "A comment needs some text");
    const file = join(f.integration_path!, featureDir(f.slug), DOC_FILES[kind]);
    if (!existsSync(file)) throw new FoundryError("NOT_FOUND", `There is no ${DOC_FILES[kind]} yet; write it first`);
    const lines = readFileSync(file, "utf8").split("\n");
    if (!Number.isInteger(line) || line < 1 || line > lines.length) throw new FoundryError("LINE_INVALID", `Line ${line} is not in ${DOC_FILES[kind]} (it has ${lines.length})`);
    // Pinned to the commit that ends this turn (the line names the file as written now).
    const c = this.store.addComment({ featureId: f.id, doc: kind, sha: PENDING, line, quote: lines[line - 1]!.slice(0, 200), body: body.trim(), author: "pm", status: "sent" });
    this.store.event("pm_commented", { actor: "pm", project: f.project_id, feature: f.id, detail: { doc: kind, line, comment: c.id } });
    return { recorded: c.id };
  }

  /** Every commit that changed the doc, newest first. */
  async revisions(featureId: number, kind: DocKind) {
    const f = this.store.feature(featureId);
    if (!f) throw new FoundryError("NOT_FOUND", `No feature ${featureId}`);
    const d = this.store.doc(f.id, kind)!;
    if (!d.head_sha || !f.integration_path) return [];
    const rel = `${featureDir(f.slug)}/${DOC_FILES[kind]}`;
    const out = await git(f.integration_path, "log", "--format=%H%x09%an%x09%cI%x09%s", d.head_sha, "--", rel).catch(() => "");
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, author, at, subject] = l.split("\t");
        return { sha: sha!, author: author!, at: at!, subject: subject ?? "", approved: sha === d.approved_sha, head: sha === d.head_sha };
      });
  }

  /** The diff of a doc between two of its revisions (older first). */
  async docDiff(featureId: number, kind: DocKind, from: string, to: string) {
    const revs = await this.revisions(featureId, kind);
    const known = new Set(revs.map((r) => r.sha));
    for (const x of [from, to]) if (!known.has(x)) throw new FoundryError("NOT_FOUND", `${x.slice(0, 10)} is not a revision of the ${kind}`);
    const f = this.store.feature(featureId)!;
    const rel = `${featureDir(f.slug)}/${DOC_FILES[kind]}`;
    const diff = await git(f.integration_path!, "diff", from, to, "--", rel);
    return { kind, from, to, diff };
  }

  private async docAt(f: Feature, kind: DocKind, sha: string) {
    return git(f.integration_path!, "show", `${sha}:${featureDir(f.slug)}/${DOC_FILES[kind]}`).catch(() => "");
  }

  /** Quick flow: a revision of any doc is one turn that keeps all three consistent and re-proposes the tasks. */
  private async reviseQuick(f: Feature, kind: DocKind, note: string, actor: Actor, picked: DocComment[]) {
    const dir = featureDir(f.slug);
    this.store.tx(() => {
      // The revised list must come from this turn.
      this.store.run("UPDATE task_proposals SET status='superseded' WHERE feature_id=? AND status='proposed'", f.id);
      this.markSent(picked);
      this.store.event("revision_requested", { actor, project: f.project_id, feature: f.id, detail: { doc: kind, note, comments: picked.map((c) => c.id) } });
    });
    await this.runTurn(
      f.id,
      "quick",
      [
        note,
        `${DO_WHAT_IT_ASKS} Keep ${dir}/spec.md (call propose_requirements again if requirements change, keeping unchanged refs) and ${dir}/plan.md consistent with the change, then call propose_tasks again with the full task graph. Do not write tasks.md. End your turn.`,
      ].join("\n\n"),
    );
    return { ok: true, sent: picked.map((c) => c.id) };
  }

  /** Run the stage's turn again after a failure. */
  async retry(featureId: number) {
    const f = this.editable(featureId);
    const steps: Partial<Record<FeatureStage, string>> = { clarify: this.clarifySteps(f), spec: this.specSteps(featureDir(f.slug)), plan: this.planSteps(f), tasks: this.tasksSteps(f) };
    if (this.quick(f) && ["clarify", "tasks"].includes(f.stage)) {
      await this.runTurn(f.id, "quick", `Your last turn did not finish. Continue:\n\n${this.clarifySteps(f)}`);
      return { ok: true };
    }
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

  // ---------- your edits and spec changes ----------
  /**
   * Your edit to the spec or plan, committed in the integration worktree. Before Build it sends the
   * feature back to that doc's stage. From Build on, an edit to the spec opens a spec change, which pauses
   * auto-start (and Prepare and Accept in Ship) until you approve its change set or discard it. A Done
   * feature reopens: a new branch from base, back to Spec, and only the delta becomes new tasks.
   */
  async editDoc(featureId: number, kind: "spec" | "plan", text: string, baseSha: string, actor: Actor = "you") {
    const r = await this.locks.with(`feature:${featureId}`, async () => {
      let f = this.editable(featureId, { done: kind === "spec" });
      const d0 = this.store.doc(f.id, kind)!;
      if (!d0.head_sha) throw new FoundryError("NOT_FOUND", `There is no ${kind} to edit yet`);
      if (d0.head_sha !== baseSha) throw new FoundryError("STALE_EDIT", "It changed since you read it", { head_sha: d0.head_sha });
      // From Build on, tasks exist: a spec edit is a spec change and is answered with a change set.
      const afterTasks = ["build", "verify", "ship", "done"].includes(f.stage);
      if (["verify", "ship"].includes(f.stage) && this.store.get<{ status: string }>("SELECT status FROM verifications WHERE feature_id=? ORDER BY id DESC LIMIT 1", f.id)?.status === "running")
        throw new FoundryError("FEATURE_BUSY", "Verify is running on this feature; edit once it reports");
      if (kind === "spec" && f.stage === "clarify") throw new FoundryError("WRONG_STAGE", "The spec is still being written");
      if (kind === "plan" && !["plan", "tasks"].includes(f.stage)) throw new FoundryError(afterTasks ? "NOT_SUPPORTED_YET" : "WRONG_STAGE", afterTasks ? "Plan edits after the task list is approved arrive later; edit the spec instead." : "There is no plan to edit yet");
      let reopened: Reopened | null = null;
      if (f.stage === "done") {
        const text0 = await git(f.integration_path!, "show", `${d0.head_sha}:${featureDir(f.slug)}/${DOC_FILES.spec}`).catch(() => null);
        if (text0 !== null && text0.replace(/\n$/, "") === text.replace(/\n$/, "")) return { changed: false } as const;
        const out = await reopenOnBase(this.store, this.host, f.id, firstRemote);
        f = out.feature;
        reopened = out.previous;
      }
      const d = this.store.doc(f.id, kind)!;
      const rel = `${featureDir(f.slug)}/${DOC_FILES[kind]}`;
      const file = join(f.integration_path!, rel);
      const before = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (before === text) return { changed: false } as const;
      writeFileSync(file, text);
      if (kind === "spec") this.syncRequirements(f);
      const commit = await this.commitAsYou(f.integration_path!, rel, `${f.slug}: ${kind} edited by the developer`);
      this.store.updateFeature(f.id, { head_sha: commit });
      const wasApproved = d.status === "approved";
      this.store.tx(() => {
        this.store.updateDoc(f.id, kind, { head_sha: commit, status: "in_review" });
        this.store.event("doc_edited", { actor, project: f.project_id, feature: f.id, detail: { doc: kind, sha: commit } });
        const later: DocKind[] = kind === "spec" ? ["plan", "tasks"] : ["tasks"];
        if (wasApproved || d.status === "in_review")
          for (const k of later) if (["approved", "in_review"].includes(this.store.doc(f.id, k)!.status)) this.store.updateDoc(f.id, k, { status: "stale" });
        if (!afterTasks) {
          this.store.run("UPDATE task_proposals SET status='superseded' WHERE feature_id=? AND status='proposed'", f.id);
          // The Quick flow has no Spec or Plan stage to go back to: it stays in Tasks and re-proposes.
          if (!this.quick(f) && kind === "spec" && f.stage !== "spec") this.store.setStage(f.id, "spec", actor);
          if (!this.quick(f) && kind === "plan" && f.stage === "tasks") this.store.setStage(f.id, "plan", actor);
        } else if (!this.store.openSpecChange(f.id)) {
          this.store.run("INSERT INTO spec_changes(feature_id,base_spec_sha,diff) VALUES(?,?,?)", f.id, d.approved_sha, JSON.stringify({ base: this.approvedList(f.id), from_stage: f.stage, ...(reopened ? { reopened } : {}) }));
          this.store.updateFeature(f.id, { spec_change_open: 1 });
          // A reopened feature is back in Spec; Verify and Ship keep their stage until the change set is approved.
          if (reopened) this.store.setStage(f.id, "spec", actor);
          this.store.event("spec_change_opened", { actor, project: f.project_id, feature: f.id, detail: { base: d.approved_sha, from_stage: f.stage, round: f.round } });
        }
      });
      await this.carryComments(f.id);
      return { changed: true, sha: commit, building: afterTasks, quick: this.quick(f) && !afterTasks } as const;
    });
    if (r.changed && r.quick) {
      const dir = featureDir(this.store.feature(featureId)!.slug);
      const msg = `The developer edited ${dir}/${DOC_FILES[kind]}. Re-read the docs. ${kind === "spec" ? "Call propose_requirements with the requirements as they now stand (keep unchanged refs, never reuse a removed ref), bring plan.md in line, " : "Bring the task graph in line with the plan: "}then call propose_tasks again with the full task graph. Do not write tasks.md. End your turn.`;
      await this.runTurn(featureId, "quick", msg).catch((e) => this.failTurn(featureId, String(e)));
    } else if (r.changed && kind === "spec") {
      const msg = `The developer edited ${featureDir(this.store.feature(featureId)!.slug)}/spec.md. Re-read it and call propose_requirements with the requirements as they now stand. Keep the ref of every requirement you don't change and never reuse a removed ref. Change nothing else, then end your turn.`;
      await this.runTurn(featureId, r.building ? "spec_change" : "spec", msg).catch((e) => this.failTurn(featureId, String(e)));
    }
    return r;
  }

  /** The slice a task added after approval joins: the one it names if that hasn't shipped, else the last open slice. */
  private sliceFor(featureId: number, n?: number) {
    const named = n ? this.store.slices(featureId).find((x) => x.n === n && !["shipped", "cancelled"].includes(x.status)) : undefined;
    const lastN = this.store.slices(featureId).at(-1)?.n ?? 0;
    // The next number names a new slice at the end; it starts in its turn, like any planned slice.
    if (!named && n === lastN + 1 && this.store.openSlice(featureId))
      return this.store.addSlice(featureId, { n, title: `${this.store.feature(featureId)!.title}, slice ${n}`, status: "planned" }).id;
    const open = named ?? this.store.openSlice(featureId);
    if (open) return open.id;
    // Every slice has shipped (a reopened Done feature): the new work is a new slice at the end, on the feature's new branch.
    const all = this.store.slices(featureId);
    if (!all.length) return null;
    const f = this.store.feature(featureId)!;
    const k = all.at(-1)!.n + 1;
    return this.store.addSlice(featureId, { n: k, title: `${f.title}, round ${f.round}`, status: "building", branch: f.branch, workspaceId: f.integration_workspace_id, path: f.integration_path, headSha: f.head_sha }).id;
  }

  private approvedList(featureId: number) {
    return this.store.approvedRequirements(featureId).map((r) => ({ ref: r.ref, title: r.title, criteria: parse<string[]>(r.criteria, []) }));
  }

  private async commitAsYou(path: string, rel: string, message: string): Promise<string> {
    await git(path, "add", "-A", "--", rel);
    // Your own git identity; Foundry's fallback only if the repo has none.
    const r = await sh("git", ["commit", "-q", "-m", message], { cwd: path });
    if (r.code !== 0) await git(path, "-c", "user.name=Developer", "-c", "user.email=developer@localhost", "commit", "-q", "-m", message);
    return head(path);
  }

  /** Approving a changed spec: Foundry diffs its requirements against the last approved ones and asks the PM for one change set. */
  private async approveChangedSpec(featureId: number, sha: string, actor: Actor) {
    const diff = await this.locks.with(`feature:${featureId}`, async () => {
      const f = this.editable(featureId);
      const change = this.store.openSpecChange(f.id)!;
      this.assertDoc(f, "spec", sha);
      const live = this.store.requirements(f.id).map((r) => ({ ref: r.ref, title: r.title, criteria: parse<string[]>(r.criteria, []) }));
      const errors = lintRequirements(live.map((r) => ({ ref: r.ref, title: r.title, acceptance_criteria: r.criteria })));
      if (errors.length) throw new FoundryError("REQUIREMENTS_INVALID", errors.join("\n"), { errors });
      const base = parse<{ base?: typeof live }>(change.diff, {}).base ?? this.approvedList(f.id);
      const moved = renumbered(base, live);
      if (moved.length) throw new FoundryError("REQUIREMENTS_RENUMBERED", `Refs were renumbered: ${moved.join("; ")}`, { refs: moved });
      const diff = diffRequirements(base, live);
      this.store.tx(() => {
        this.store.updateDoc(f.id, "spec", { status: "approved", approved_sha: sha });
        // "Plan unchanged": the current plan is re-approved at its SHA.
        const plan = this.store.doc(f.id, "plan")!;
        this.store.updateDoc(f.id, "plan", { status: "approved", approved_sha: plan.head_sha });
        this.store.run("UPDATE requirements SET spec_sha=? WHERE feature_id=? AND retired=0", sha, f.id);
        this.store.approveRequirements(f.id);
        this.store.run("UPDATE spec_changes SET diff=? WHERE id=?", JSON.stringify({ ...parse<object>(change.diff, {}), base, ...diff }), change.id);
        this.store.event("doc_approved", { actor, project: f.project_id, feature: f.id, detail: { doc: "spec", sha, change: change.id, diff } });
      });
      return diff;
    });
    const f = this.store.feature(featureId)!;
    const slices = this.store.slices(featureId);
    const sliceN = new Map(slices.map((x) => [x.id, x.n]));
    const front = slices.find((x) => x.status !== "shipped" && x.status !== "cancelled");
    const tasks = this.store
      .issues({ featureId })
      .map((i) => `- ${i.key} [${i.status}] ${i.title} (${slices.length ? `slice ${sliceN.get(i.slice_id ?? front?.id ?? -1) ?? 1}; ` : ""}covers ${parse<string[]>(i.requirement_refs, []).join(", ") || "nothing"})`);
    const sliceLines = slices.length
      ? [
          "",
          "Slices, in merge order:",
          ...slices.map((x) => `- slice ${x.n} "${x.title}" (${x.status})`),
          "Give every new task a slice: the open slice (not shipped or cancelled) its work belongs with, or the next number after the last slice for a new slice at the end. A task may depend only on tasks in its own or an earlier slice. Never put a task in a shipped slice: a follow-up to shipped work goes in an open slice. Tasks you keep, update or flag stay in their slice.",
        ]
      : [];
    const msg = [
      "The developer approved a changed spec. Requirement diff against the last approved spec:",
      `- unchanged: ${diff.unchanged.join(", ") || "none"}`,
      `- changed: ${diff.changed.join(", ") || "none"}`,
      `- added: ${diff.added.join(", ") || "none"}`,
      `- removed: ${diff.removed.join(", ") || "none"}`,
      "",
      "Every task of the feature:",
      ...tasks,
      ...sliceLines,
      "",
      "Call propose_tasks once with one change set. List every task above that isn't Cancelled with its issue key and a tag:",
      "keep (covers only unchanged requirements, or is Done); update (not started and covers a changed requirement: give the new description, requirement_refs and checks); flag (running or in review and covers a changed or removed requirement); cancel (not started and covers only removed requirements).",
      "Then add new tasks (ref, tag new) for added requirements, a followup task (depends on the Done task) for each Done task covering a changed requirement, and optionally a removal task for Done work on a removed requirement.",
      "Every current requirement must be covered. Do not write tasks.md. End your turn.",
    ].join("\n");
    await this.runTurn(featureId, "change_set", msg).catch((e) => this.failTurn(featureId, String(e)));
    return this.store.feature(f.id)!;
  }

  private proposeChangeSet(f: Feature, tasks: ProposedTask[]) {
    const change = this.store.openSpecChange(f.id);
    if (!change) throw new FoundryError("TOOL_REFUSED", "There is no open spec change");
    const diff = parse<RequirementDiff>(change.diff, { unchanged: [], changed: [], added: [], removed: [] });
    const existing = this.store.issues({ featureId: f.id }).map((i) => ({ key: i.key, status: i.status, requirement_refs: parse<string[]>(i.requirement_refs, []), touches: parse<string[]>(i.touches, []) }));
    const others = this.unfinishedIssues(f).filter((o) => !existing.some((e) => e.key === o.key));
    this.checkChangeSlices(f, tasks);
    const loopWarnings = this.checkTaskLoops(f, tasks.filter((t) => !t.issue || t.tag === "update"));
    const g = validateChangeSet(tasks, diff, existing, others);
    const result = { ...g, warnings: [...g.warnings, ...loopWarnings] };
    const prop = this.store.addProposal(f.id, tasks, result, "change");
    this.store.event("change_set_proposed", { actor: "pm", project: f.project_id, feature: f.id, detail: { proposal: prop.id, entries: tasks.length } });
    return { recorded: true, proposal: prop.id, waves: result.waves, warnings: result.warnings };
  }

  /**
   * New tasks of a change set name their slice: an open one, or the next number for a new slice at the
   * end. A shipped slice is refused (SLICE_SHIPPED), and so is a dependency on a task in a later slice.
   */
  private checkChangeSlices(f: Feature, tasks: ProposedTask[]) {
    const slices = this.store.slices(f.id);
    if (!slices.length) return;
    const last = slices.at(-1)!.n;
    const front = slices.find((x) => x.status !== "shipped" && x.status !== "cancelled");
    const nOf = (sliceId: number | null) => slices.find((x) => x.id === (sliceId ?? front?.id))?.n ?? 1;
    const fresh = tasks.filter((t) => !t.issue);
    const target = (t: ProposedTask) => t.slice ?? (this.store.openSlice(f.id)?.n ?? last + 1);
    const shipped = fresh.filter((t) => t.slice && ["shipped", "cancelled"].includes(slices.find((x) => x.n === t.slice)?.status ?? ""));
    if (shipped.length)
      throw new FoundryError("SLICE_SHIPPED", `The change set was not recorded: ${shipped.map((t) => `${t.ref} names slice ${t.slice}, which has ${slices.find((x) => x.n === t.slice)!.status}`).join("; ")}. Put the work in an open slice or slice ${last + 1}, then resend.`, { refs: shipped.map((t) => t.ref) });
    const errors: string[] = [];
    for (const t of fresh) {
      if (t.slice && (t.slice < 1 || t.slice > last + 1)) errors.push(`${t.ref} names slice ${t.slice}; slices are 1 to ${last}, or ${last + 1} for a new one.`);
      for (const d of t.depends_on ?? []) {
        const dep = this.store.issue(d.ref);
        const other = dep ? nOf(dep.slice_id) : fresh.find((x) => x.ref === d.ref) ? target(fresh.find((x) => x.ref === d.ref)!) : null;
        if (other !== null && other > target(t)) errors.push(`${t.ref} (slice ${target(t)}) depends on ${d.ref} in a later slice (${other}).`);
      }
    }
    if (errors.length) throw new FoundryError("SLICE_INVALID", `The change set was not recorded. Fix and resend:\n- ${errors.join("\n- ")}`, { errors });
  }

  /** Apply a change set in one step, all or nothing; auto-start resumes. */
  private async approveChangeSet(featureId: number, proposalId: number, sha: string, actor: Actor) {
    const out = await this.locks.with(`feature:${featureId}`, async () => {
      const f = this.editable(featureId);
      const change = this.store.openSpecChange(f.id);
      const prop = this.store.proposal(f.id);
      if (!change || !prop || prop.kind !== "change" || prop.id !== proposalId) throw new FoundryError("PROPOSAL_CHANGED", "The change set changed: review the current one", { current: prop?.id ?? null });
      this.assertDoc(f, "tasks", sha);
      const diff = parse<RequirementDiff & { base?: { ref: string; title: string; criteria: string[] }[]; reopened?: Reopened }>(change.diff, { unchanged: [], changed: [], added: [], removed: [] });
      const entries = parse<ProposedTask[]>(prop.tasks, []);
      const existing = this.store.issues({ featureId: f.id }).map((i) => ({ key: i.key, status: i.status, requirement_refs: parse<string[]>(i.requirement_refs, []), touches: parse<string[]>(i.touches, []) }));
      const g = validateChangeSet(entries, diff, existing, this.unfinishedIssues(f).filter((o) => !existing.some((e) => e.key === o.key)));
      return this.store.tx(() => {
        const keyOf = new Map<string, string>();
        const applied: Record<string, string> = {};
        for (const e of entries.filter((x) => x.issue)) {
          const key = e.issue!;
          applied[key] = e.tag!;
          if (e.tag === "update")
            this.store.updateIssue(key, { title: e.title || this.store.issue(key)!.title, description: e.description ?? "", acceptance: e.exit_criteria ?? "", checks: JSON.stringify(e.checks ?? {}), requirement_refs: JSON.stringify(e.requirement_refs ?? []), touches: JSON.stringify(e.touches ?? []), ...(e.loop !== undefined ? { loop: e.loop || null } : {}) }, actor);
          else if (e.tag === "flag") this.store.updateIssue(key, { flag: "SPEC_CHANGED" }, actor);
          else if (e.tag === "cancel") this.store.setIssueStatus(key, "Cancelled", actor, null, { why: "spec change", change: change.id });
        }
        const fresh = entries.filter((x) => !x.issue);
        const byRef = new Map(fresh.map((t) => [t.ref, t]));
        for (const wave of g.waves)
          for (const ref of wave) {
            const t = byRef.get(ref)!;
            const deps = t.depends_on ?? [];
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
              sliceId: this.sliceFor(f.id, t.slice),
              actor,
            });
            deps.forEach((d, n) => this.store.addDep(i.key, depKeys[n]!, d.reason ?? ""));
            keyOf.set(ref, i.key);
            applied[i.key] = t.tag ?? "new";
          }
        for (const ref of diff.removed) {
          const old = diff.base?.find((r) => r.ref === ref);
          this.store.run("INSERT OR REPLACE INTO requirements(feature_id,ref,title,criteria,spec_sha,retired) VALUES(?,?,?,?,?,1)", f.id, ref, old?.title ?? ref, JSON.stringify(old?.criteria ?? []), sha);
        }
        this.store.run("UPDATE task_proposals SET status='approved' WHERE id=?", prop.id);
        // Done before the change: such tasks never count toward a changed or added requirement's coverage.
        const doneBefore = existing.filter((i) => i.status === "Done").map((i) => i.key);
        this.store.run("UPDATE spec_changes SET status='approved', decided_at=datetime('now'), diff=? WHERE id=?", JSON.stringify({ ...diff, done_before: doneBefore }), change.id);
        this.store.updateDoc(f.id, "tasks", { status: "approved", approved_sha: sha });
        this.store.updateFeature(f.id, { spec_change_open: 0 });
        this.store.event("change_set_approved", { actor, project: f.project_id, feature: f.id, detail: { change: change.id, proposal: prop.id, applied } });
        // From Verify, Ship or a reopened Done: back to Build. With no task to build, Build ends at once
        // and Verify runs again, because the requirement set moved on. A prepared local merge is dropped;
        // an open PR stays open and gets the new commits at the next Prepare.
        if (f.stage !== "build") {
          this.store.setSetting(`ship:${f.id}`, "");
          this.store.setStage(f.id, "build", actor);
        }
        // The same for a slice building behind the front: it is checked again against the new requirements.
        for (const sl of activeSlices(this.store, f.id).slice(1))
          if (sl.status !== "building") setTargetStage(this.store, target(this.store, f.id, sl.id), "build", actor);
        for (const sl of activeSlices(this.store, f.id).slice(1)) {
          const prepared = parse<{ pr?: unknown } | null>(this.store.setting(`ship:slice:${sl.id}`), null);
          if (prepared && !prepared.pr) this.store.setSetting(`ship:slice:${sl.id}`, "");
        }
        return { applied, retire: diff.reopened?.workspace_id ?? null };
      });
    });
    if (out.retire) void this.host.archiveWorkspace(out.retire).catch(() => {});
    await this.onBuild();
    return { applied: out.applied };
  }

  /** Discard an open spec change: the approved spec comes back as a new commit and everything resumes. */
  async discardChange(featureId: number, actor: Actor = "you") {
    await this.locks.with(`feature:${featureId}`, async () => {
      const f = this.editable(featureId);
      const change = this.store.openSpecChange(f.id);
      if (!change) throw new FoundryError("NO_SPEC_CHANGE", "There is no open spec change");
      const meta = parse<{ base?: { ref: string; title: string; criteria: string[] }[]; reopened?: Reopened }>(change.diff, {});
      if (meta.reopened) return this.discardReopen(f, change.id, change.base_spec_sha, meta.base ?? [], meta.reopened, actor);
      const rel = `${featureDir(f.slug)}/${DOC_FILES.spec}`;
      const text = await git(f.integration_path!, "show", `${change.base_spec_sha}:${rel}`);
      writeFileSync(join(f.integration_path!, rel), text + "\n");
      const base = parse<{ base?: { ref: string; title: string; criteria: string[] }[] }>(change.diff, {}).base ?? [];
      this.store.setRequirements(f.id, base, change.base_spec_sha);
      this.syncRequirements(f);
      const tasksDoc = this.store.doc(f.id, "tasks")!;
      if (tasksDoc.approved_sha) {
        const tRel = `${featureDir(f.slug)}/${DOC_FILES.tasks}`;
        const t = await git(f.integration_path!, "show", `${tasksDoc.approved_sha}:${tRel}`).catch(() => null);
        if (t !== null) writeFileSync(join(f.integration_path!, tRel), t + "\n");
      }
      const commit = (await commitAll(f.integration_path!, `${f.slug}: discard spec change`, FOUNDRY_IDENT)) ?? (await head(f.integration_path!));
      this.store.tx(() => {
        this.store.updateFeature(f.id, { head_sha: commit, spec_change_open: 0 });
        this.store.approveRequirements(f.id);
        this.store.updateDoc(f.id, "spec", { status: "approved", head_sha: commit, approved_sha: commit });
        for (const k of ["plan", "tasks"] as DocKind[]) {
          const d = this.store.doc(f.id, k)!;
          if (d.approved_sha) this.store.updateDoc(f.id, k, { status: "approved", head_sha: commit, approved_sha: commit });
        }
        this.store.run("UPDATE task_proposals SET status='superseded' WHERE feature_id=? AND status='proposed' AND kind='change'", f.id);
        this.store.run("UPDATE spec_changes SET status='discarded', decided_at=datetime('now') WHERE id=?", change.id);
        this.store.event("spec_change_discarded", { actor, project: f.project_id, feature: f.id, detail: { change: change.id, commit } });
      });
    });
    await this.onBuild();
    return this.store.feature(featureId)!;
  }

  /** Discarding the change that reopened a Done feature: back to Done on its shipped branch; the new branch's workspace is archived. */
  private discardReopen(f: Feature, changeId: number, baseSpecSha: string | null, base: { ref: string; title: string; criteria: string[] }[], prev: Reopened, actor: Actor) {
    const dropped = f.integration_workspace_id;
    this.store.tx(() => {
      this.store.updateFeature(f.id, { branch: prev.branch, integration_workspace_id: prev.workspace_id, integration_path: prev.path, head_sha: prev.head_sha, round: prev.round, planner_agent_id: prev.planner_agent_id ?? null, spec_change_open: 0 });
      this.store.setRequirements(f.id, base, baseSpecSha);
      this.store.approveRequirements(f.id);
      for (const k of ["spec", "plan", "tasks"] as DocKind[]) {
        const d = this.store.doc(f.id, k)!;
        if (d.approved_sha) this.store.updateDoc(f.id, k, { status: "approved", head_sha: d.approved_sha });
      }
      this.store.run("UPDATE task_proposals SET status='superseded' WHERE feature_id=? AND status='proposed' AND kind='change'", f.id);
      this.store.run("UPDATE spec_changes SET status='discarded', decided_at=datetime('now') WHERE id=?", changeId);
      this.store.setStage(f.id, "done", actor);
      this.store.event("spec_change_discarded", { actor, project: f.project_id, feature: f.id, detail: { change: changeId, reopen: true, branch: prev.branch } });
    });
    if (dropped && dropped !== prev.workspace_id) void this.host.archiveWorkspace(dropped).catch(() => {});
  }

  async recover() {
    this.store.run("UPDATE questions SET status='waiting' WHERE feature_id IS NOT NULL AND issue_key IS NULL AND status='live'");
    for (const r of this.store.all<{ id: number; feature_id: number; agent_id: string }>("SELECT id,feature_id,agent_id FROM runs WHERE kind='plan' AND status='running'")) {
      if (this.turns.has(r.feature_id)) continue;
      const status = await this.host.agentStatus(r.agent_id).catch(() => "gone" as const);
      if (status === "running") {
        // Its turn.after will arrive; track it so the guard and stage logic run.
        const f = this.store.feature(r.feature_id)!;
        const stage = (parse<{ stage?: TurnKind }>(this.store.get<{ detail: string }>("SELECT detail FROM runs WHERE id=?", r.id)?.detail ?? "{}", {}).stage ?? f.stage) as TurnKind;
        this.turns.set(r.feature_id, { agentId: r.agent_id, runId: r.id, stage, timer: null });
        continue;
      }
      this.store.endRun(r.id, "failed", { reason: "infra: restarted" });
      this.failTurn(r.feature_id, "The project manager's last turn was cut off by a restart");
    }
  }
}

const PENDING = "pending";

/**
 * Where line `n` of the old side of a zero-context unified diff lands on the new side, or null when the
 * line itself was changed or removed.
 */
export function mapLine(diff: string, n: number): number | null {
  let delta = 0;
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(m[1]);
    const oldLen = m[2] === undefined ? 1 : Number(m[2]);
    const newLen = m[4] === undefined ? 1 : Number(m[4]);
    // With oldLen 0 the hunk inserts after oldStart; otherwise it replaces oldStart..oldStart+oldLen-1.
    const firstAfter = oldLen === 0 ? oldStart + 1 : oldStart + oldLen;
    if (n < (oldLen === 0 ? oldStart + 1 : oldStart)) break;
    if (oldLen > 0 && n < firstAfter) return null;
    delta += newLen - oldLen;
  }
  return n + delta;
}

const DO_WHAT_IT_ASKS =
  "Do what the note and each comment ask. If one is unclear or conflicts with the doc, reply to it with comment_on_doc on that line instead of reinterpreting it.";

/** A revision request as the PM reads it: the note, then each comment with its line. */
function revisionText(kind: DocKind, note: string, comments: DocComment[]) {
  const parts = [`The developer asks for a revision of the ${kind}${DOC_FILES[kind] ? ` (${DOC_FILES[kind]})` : ""}.`];
  if (note.trim()) parts.push(`Note:\n${note.trim()}`);
  if (comments.length)
    parts.push(`Comments on lines of the version they read:\n${comments.map((c) => `- line ${c.line} ("${c.quote.trim()}"): ${c.body}`).join("\n")}`);
  return parts.join("\n\n");
}

function formatAnswers(a: Record<string, string>) {
  return Object.entries(a)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
}
