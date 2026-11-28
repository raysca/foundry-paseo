// Quick tasks: one task, no feature. It builds on its own branch from base through its loop, you review
// and accept it at the SHA you read, and it ships on its own: a GitHub PR into base when the project
// ships by PR and the repo has a remote, else a local merge into base. Discovered work (a builder or
// reviewer reporting something outside its task) lands in Backlog as a task for you to triage.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkedOutAt, mergeInto, real } from "./delivery";
import { changedPaths, git, sh } from "./git";
import { createPr, firstRemote, pushBranch, redact, viewPr, type PrInfo } from "./github";
import type { Host } from "./host";
import type { Locks } from "./locks";
import { FoundryError, TERMINAL_STATUSES, type Actor } from "./model";
import { parse, type Issue, type Store } from "./store";
import type { TaskLoop } from "./taskloop";

/** A quick task shipped by PR: what was accepted and the PR that carries it. */
export interface QuickShip {
  sha: string;
  tree: string;
  pr: { number: number; url: string; remote: string };
}

export const quickShipKey = (key: string) => `ship:issue:${key}`;

export class QuickTasks {
  constructor(
    private store: Store,
    private host: Host,
    private locks: Locks,
    private tasks: TaskLoop,
  ) {}

  /** A quick task from the board (started at once) or from the project manager (left in Backlog for you). */
  async create(o: { projectId: number; title: string; description?: string; loop?: string | null; checks?: Record<string, unknown>; start?: boolean }, actor: Actor = "you") {
    const p = this.store.project(o.projectId);
    if (!p) throw new FoundryError("NOT_FOUND", `No project ${o.projectId}`);
    const title = o.title.trim();
    if (!title) throw new FoundryError("TITLE_REQUIRED", "A quick task needs a title");
    if (o.loop) await this.tasks.assertLoop(p.id, o.loop);
    const i = this.store.createIssue({ projectId: p.id, featureId: null, origin: "quick", title, description: o.description ?? "", status: "Backlog", loop: o.loop || null, checks: o.checks ?? {}, actor });
    this.store.event("quick_created", { actor, project: p.id, issue: i.key, detail: { title } });
    if (o.start) await this.tasks.start(i.key, actor);
    return this.store.issue(i.key)!;
  }

  /**
   * report_discovered_work: something a builder or reviewer found outside its task. It lands in Backlog
   * (never auto-started) in the same project, remembering where it was found.
   */
  discover(agentId: string, o: { title: string; description: string; why?: string }) {
    const rec = this.store.agent(agentId);
    const a = this.store.attemptByAgent(agentId);
    if (!rec || !["builder", "reviewer"].includes(rec.role) || !a) throw new FoundryError("TOOL_REFUSED", "report_discovered_work is for the builder or reviewer of a task");
    const src = this.store.issue(a.issue_key)!;
    const title = o.title.trim();
    if (!title) throw new FoundryError("TITLE_REQUIRED", "Discovered work needs a title");
    // The same agent reporting the same thing twice gets the first task back.
    const dup = this.store.get<Issue>("SELECT * FROM issues WHERE origin='discovered' AND found_in=? AND title=? AND status NOT IN ('Cancelled')", src.key, title);
    if (dup) return { key: dup.key, status: dup.status, duplicate: true };
    const description = [o.description.trim(), o.why ? `Why it matters: ${o.why.trim()}` : "", `Found by the ${rec.role} of ${src.key} (${src.title}).`].filter(Boolean).join("\n\n");
    const i = this.store.createIssue({ projectId: src.project_id, featureId: null, origin: "discovered", title, description, status: "Backlog", foundIn: src.key, actor: "agent" });
    this.store.event("discovered_work", { actor: "agent", project: src.project_id, issue: i.key, detail: { found_in: src.key, role: rec.role, title } });
    void this.host.notify({ title: `Discovered: ${title}`, body: `The ${rec.role} of ${src.key} found work outside its task. It's in Backlog for you to triage.`, key: `discovered:${i.key}`, screen: "board" });
    return { key: i.key, status: i.status, note: "It's in Backlog for the developer to triage. Carry on with your own task." };
  }

  /** The PR a quick task ships in, while it is open. */
  shipped(key: string): QuickShip | null {
    const v = this.store.setting(quickShipKey(key));
    return v ? parse<QuickShip | null>(v, null) : null;
  }

  /**
   * Accept a quick task at the SHAs you read. By PR: its branch is pushed and a PR into base opened (or
   * updated with the new head); it moves to Done when the PR merges. Locally: merged into base now.
   */
  async accept(key: string, headSha: string, treeSha: string, o: { confirmCheckedOut?: boolean; feedback?: string } = {}, actor: Actor = "you") {
    const pre = this.store.issue(key);
    if (!pre) throw new FoundryError("NOT_FOUND", `No issue ${key}`);
    if (pre.feature_id) throw new FoundryError("NOT_QUICK", `${key} belongs to a feature`);
    const p = this.store.project(pre.project_id)!;
    const r = await this.locks.with(`base:${p.id}`, () =>
      this.locks.with(`attempt:${key}`, async () => {
        const { i, a } = await this.tasks.assertReviewable(key, headSha, treeSha);
        const remote = p.ship_mode === "pr" ? await firstRemote(p.repo) : null;
        if (remote) {
          const before = this.shipped(key);
          if (before && before.sha === headSha) throw new FoundryError("PR_OPEN", "Merge the PR on GitHub; Foundry sees it at its next check", { url: before.pr.url });
          await pushBranch(p.repo, remote, a.branch);
          const open = await viewPr(p.repo, a.branch).catch(() => null);
          const pr = open?.state === "OPEN" ? open : await createPr(p.repo, { base: p.base_ref, branch: a.branch, title: `${i.key}: ${i.title}`, body: this.prBody(i, headSha) });
          const ship: QuickShip = { sha: headSha, tree: treeSha, pr: { number: pr.number, url: pr.url, remote } };
          this.store.tx(() => {
            this.store.run("INSERT INTO reviews(attempt_id,actor,decision,head_sha,tree_sha,feedback) VALUES(?,?,?,?,?,?)", a.id, actor, "accept", headSha, treeSha, o.feedback ?? "");
            this.store.setSetting(quickShipKey(key), JSON.stringify(ship));
            this.store.event("quick_pr_opened", { actor, project: p.id, issue: key, attempt: a.id, detail: { url: pr.url, head: headSha, updated: open?.state === "OPEN" } });
          });
          return { pr: ship.pr };
        }
        // Local merge into base, in a temporary worktree unless base is checked out somewhere.
        const msg = `merge ${key}: ${i.title}`;
        const where = await checkedOutAt(p.repo, p.base_ref);
        let merged: string;
        try {
          if (!where) {
            const tmp = mkdtempSync(join(tmpdir(), "foundry-quick-"));
            await git(p.repo, "worktree", "add", "-q", join(tmp, "wt"), p.base_ref);
            try {
              merged = await mergeInto(join(tmp, "wt"), headSha, msg);
            } finally {
              await sh("git", ["worktree", "remove", "--force", join(tmp, "wt")], { cwd: p.repo });
            }
          } else {
            if ((await changedPaths(where)).length) throw new FoundryError("BASE_DIRTY", `${p.base_ref} is checked out at ${where} with uncommitted changes`, { path: where });
            const owned = this.store.ownedPaths().some((x) => real(x) === real(where));
            if (!owned && !o.confirmCheckedOut) throw new FoundryError("BASE_CHECKED_OUT", `${p.base_ref} is checked out at ${where}. Confirm to merge there.`, { path: where });
            merged = await mergeInto(where, headSha, msg);
          }
        } catch (e) {
          if (e instanceof FoundryError && e.code === "MERGE_CONFLICT") {
            this.store.event("merge_conflict", { actor: "system", issue: key, attempt: a.id, detail: { paths: e.detail?.paths, reviewed: headSha, base: p.base_ref } });
            return { conflict: (e.detail?.paths as string[]) ?? [] };
          }
          throw e;
        }
        this.store.tx(() => {
          this.store.run("INSERT INTO reviews(attempt_id,actor,decision,head_sha,tree_sha,feedback) VALUES(?,?,?,?,?,?)", a.id, actor, "accept", headSha, treeSha, o.feedback ?? "");
          this.store.setIssueStatus(key, "Done", actor, null, { merged });
          this.store.event("task_merged", { actor, project: p.id, issue: key, attempt: a.id, detail: { head: headSha, merged, base: p.base_ref } });
        });
        for (const ws of [a.workspace_id, a.check_workspace_id]) if (ws) void this.host.archiveWorkspace(ws).catch(() => {});
        return { merged };
      }),
    );
    if ("conflict" in r && r.conflict) {
      // The reviewed SHA is kept; the task goes back to its builder to merge base in.
      await this.tasks.followUpSystem(key, `Accepting your work hit a merge conflict with ${p.base_ref} in: ${r.conflict.join(", ")}. Merge ${p.base_ref} into your branch, resolve the conflicts, and end your turn. Do not commit; Foundry commits for you.`);
      return { conflict: r.conflict };
    }
    await this.tasks.tick();
    return r;
  }

  private prBody(i: Issue, sha: string) {
    const runs = this.store.all<{ detail: string; status: string }>(
      "SELECT r.detail, r.status FROM runs r JOIN attempts a ON a.id=r.attempt_id WHERE a.issue_key=? AND r.kind='check' AND r.sha=? ORDER BY r.id",
      i.key,
      sha,
    );
    const checks = runs.map((r) => `- ${r.status === "passed" ? "✅" : "❌"} ${parse<{ name?: string }>(r.detail, {}).name ?? "check"}`);
    const body = [
      i.description ? `## Summary\n\n${i.description}` : "",
      checks.length ? `## Checks\n\n${checks.join("\n")}` : "",
      `---\n_Shipped by Foundry: quick task ${i.key} at ${sha.slice(0, 10)}, reviewed and accepted._`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return redact(body);
  }

  /** Follow quick tasks' open PRs: merged moves the task to Done; closed unmerged leaves it in review to accept again. */
  async refreshPrs(only?: string, actor: Actor = "system") {
    const out: { issue: string; result: string }[] = [];
    for (const row of this.store.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'ship:issue:%' AND value<>''")) {
      const key = row.key.slice("ship:issue:".length);
      if (only && key !== only) continue;
      const ship = parse<QuickShip | null>(row.value, null);
      const i = this.store.issue(key);
      if (!ship || !i) continue;
      const p = this.store.project(i.project_id)!;
      let pr: PrInfo;
      try {
        pr = await viewPr(p.repo, ship.pr.number);
      } catch (e) {
        this.store.event("pr_check_failed", { actor, project: p.id, issue: key, detail: { error: String(e instanceof Error ? e.message : e) } });
        if (only) throw e;
        continue;
      }
      const result = await this.locks.with(`attempt:${key}`, async () => {
        const cur = this.store.issue(key)!;
        if (TERMINAL_STATUSES.includes(cur.status)) {
          this.store.setSetting(quickShipKey(key), "");
          return "closed";
        }
        if (pr.state === "MERGED") {
          const a = this.store.latestAttempt(key);
          this.store.tx(() => {
            this.store.setSetting(quickShipKey(key), "");
            if (cur.status === "In_Review") this.store.setIssueStatus(key, "Done", actor, null, { pr: pr.url });
            this.store.event("pr_merged", { actor, project: p.id, issue: key, detail: { url: pr.url, head: pr.headRefOid } });
          });
          for (const ws of [a?.workspace_id, a?.check_workspace_id]) if (ws) void this.host.archiveWorkspace(ws).catch(() => {});
          return "merged";
        }
        if (pr.state === "CLOSED") {
          this.store.tx(() => {
            this.store.setSetting(quickShipKey(key), "");
            this.store.event("pr_closed", { actor, project: p.id, issue: key, detail: { url: pr.url } });
          });
          void this.host.notify({ title: `${key}: the PR was closed without merging`, body: "It's back in review: accept it again to open a new PR.", key: `pr-closed:${key}`, screen: "board" });
          return "closed";
        }
        return "open";
      });
      out.push({ issue: key, result });
    }
    return out;
  }
}
