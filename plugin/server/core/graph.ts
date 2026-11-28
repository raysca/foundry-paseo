// Loop 1 validation that needs no LLM: EARS acceptance criteria and the task graph the PM proposes.
import { FoundryError, SIZE_WEIGHT, type Size } from "./model";

// ---------- requirements ----------

export interface ProposedRequirement {
  ref: string;
  title: string;
  acceptance_criteria: string[];
}

const EARS = [
  /^(?:(?:WHEN|WHILE|WHERE)\s.+?,?\s+)*(?:IF\s.+?,?\s+THEN\s+)?THE\s.+\sSHALL\s.+/i,
  /\sSHALL\s+CONTINUE\s+TO\s.+/i,
];

export function earsOk(criterion: string) {
  const c = criterion.trim();
  return EARS.some((re) => re.test(c));
}

/** Errors for a proposed requirement list (empty means it passes). */
export function lintRequirements(reqs: ProposedRequirement[]): string[] {
  const errors: string[] = [];
  if (!reqs.length) errors.push("No requirements: a spec needs at least one.");
  const seen = new Set<string>();
  for (const r of reqs) {
    if (!/^R\d+(\.\d+)*$/.test(r.ref)) errors.push(`${r.ref}: a ref looks like R1 or R1.1.`);
    if (seen.has(r.ref)) errors.push(`${r.ref}: used twice.`);
    seen.add(r.ref);
    if (!r.title.trim()) errors.push(`${r.ref}: needs a title.`);
    if (!r.acceptance_criteria.length) errors.push(`${r.ref}: needs at least one acceptance criterion.`);
    r.acceptance_criteria.forEach((c, n) => {
      if (!earsOk(c))
        errors.push(`${r.ref} criterion ${n + 1} is not EARS ("${c.slice(0, 80)}"). Use THE … SHALL, WHEN … THE … SHALL, WHILE …, IF … THEN THE … SHALL, WHERE …, or … SHALL CONTINUE TO ….`);
    });
  }
  return errors;
}

// ---------- tasks ----------

export interface TaskChecksInput {
  scripts?: string[];
  paths?: string[];
  repro?: { script?: string; files?: string[] };
  pages?: string[];
}

export interface ProposedTask {
  ref: string;
  title: string;
  description?: string;
  exit_criteria?: string;
  requirement_refs: string[];
  depends_on?: { ref: string; reason: string }[];
  touches?: string[];
  size?: Size;
  loop?: string | null;
  checks?: TaskChecksInput;
  profile?: string | null;
  /** Change sets only: the existing issue this entry is about, and what happens to it. */
  issue?: string;
  tag?: ChangeTag;
  /** The slice (1, 2, ...) this task ships in; absent means slice 1. */
  slice?: number;
}

// ---------- slices ----------

/** A group of a feature's tasks that is built, verified and shipped together as one PR, in order. */
export interface ProposedSlice {
  n: number;
  title: string;
  goal?: string;
}

/** A slice as validated: its requirements are the ones its tasks finish (the last slice covering each). */
export interface SliceResult extends ProposedSlice {
  requirement_refs: string[];
  tasks: string[];
  weight: number;
}

/** Plan smaller: a slice or a feature over these gets a warning (sizes weigh S=1, M=2, L=3, unsized M). */
export const SLICE_BUDGET = { tasks: 8, weight: 12, featureSlices: 4, featureTasks: 25 };
export const sizeWeight = (s?: string | null) => SIZE_WEIGHT[(s ?? "M") as Size] ?? SIZE_WEIGHT.M;

/**
 * Validate the slices of a task graph (live tasks only). A task without a slice is in slice 1; no
 * slices at all means one slice named after the feature. Slices are numbered 1..k with no gaps, each
 * holds at least one task, and no task depends on a task in a later slice. A requirement belongs to the
 * last slice that has a task covering it: that is when it ships. Throws SLICE_INVALID with every error.
 */
export function validateSlices(title: string, slices: ProposedSlice[] | undefined, tasks: ProposedTask[], cut: string[] = []): { slices: SliceResult[]; warnings: string[] } {
  const errors: string[] = [];
  const live = tasks.filter((t) => !cut.includes(t.ref) && !t.issue);
  const declared = slices?.length ? [...slices].sort((a, b) => a.n - b.n) : [{ n: 1, title }];
  declared.forEach((sl, i) => {
    if (sl.n !== i + 1) errors.push(`Slices are numbered 1, 2, 3 … in merge order; found ${declared.map((x) => x.n).join(", ")}.`);
    if (!sl.title?.trim()) errors.push(`Slice ${sl.n} needs a title.`);
  });
  const known = new Set(declared.map((x) => x.n));
  const sliceOf = new Map(live.map((t) => [t.ref, t.slice ?? 1]));
  for (const t of live) if (!known.has(sliceOf.get(t.ref)!)) errors.push(`${t.ref} is in slice ${t.slice}, which is not one of the slices.`);
  const out: SliceResult[] = declared.map((sl) => ({ n: sl.n, title: sl.title, goal: sl.goal ?? "", requirement_refs: [], tasks: [], weight: 0 }));
  for (const t of live) {
    const sl = out.find((x) => x.n === sliceOf.get(t.ref));
    if (!sl) continue;
    sl.tasks.push(t.ref);
    sl.weight += sizeWeight(t.size);
  }
  for (const sl of out) if (!sl.tasks.length) errors.push(`Slice ${sl.n} (${sl.title}) has no tasks.`);
  for (const t of live)
    for (const d of t.depends_on ?? []) {
      const ds = sliceOf.get(d.ref);
      if (ds !== undefined && ds > sliceOf.get(t.ref)!) errors.push(`${t.ref} (slice ${sliceOf.get(t.ref)}) depends on ${d.ref} in a later slice (${ds}); a slice only depends on itself and earlier slices.`);
    }
  const last = new Map<string, number>();
  for (const t of live) for (const r of t.requirement_refs ?? []) last.set(r, Math.max(last.get(r) ?? 0, sliceOf.get(t.ref)!));
  for (const [r, n] of last) out.find((x) => x.n === n)?.requirement_refs.push(r);
  if (errors.length) throw new FoundryError("SLICE_INVALID", `The slices were not recorded. Fix and resend:\n- ${errors.join("\n- ")}`, { errors });
  const warnings: string[] = [];
  for (const sl of out)
    if (sl.tasks.length > SLICE_BUDGET.tasks || sl.weight > SLICE_BUDGET.weight)
      warnings.push(`Slice ${sl.n} (${sl.title}) is big: ${sl.tasks.length} tasks, size weight ${sl.weight} (budget ${SLICE_BUDGET.tasks} tasks or ${SLICE_BUDGET.weight}). Consider splitting it.`);
  if (out.length > SLICE_BUDGET.featureSlices || live.length > SLICE_BUDGET.featureTasks)
    warnings.push(`This feature is big: ${live.length} tasks in ${out.length} slices (budget ${SLICE_BUDGET.featureTasks} tasks or ${SLICE_BUDGET.featureSlices} slices). Consider splitting it into separate features.`);
  return { slices: out, warnings };
}

export type ChangeTag = "keep" | "update" | "flag" | "cancel" | "new" | "followup" | "removal";

export interface RequirementDiff {
  unchanged: string[];
  changed: string[];
  added: string[];
  removed: string[];
}

type Req = { ref: string; title: string; criteria: string[] };

/** Compare the current requirements with the last approved ones, by ref. */
export function diffRequirements(before: Req[], after: Req[]): RequirementDiff {
  const b = new Map(before.map((r) => [r.ref, r]));
  const a = new Map(after.map((r) => [r.ref, r]));
  const same = (x: Req, y: Req) => x.title === y.title && JSON.stringify(x.criteria) === JSON.stringify(y.criteria);
  const d: RequirementDiff = { unchanged: [], changed: [], added: [], removed: [] };
  for (const r of after) {
    const old = b.get(r.ref);
    if (!old) d.added.push(r.ref);
    else (same(old, r) ? d.unchanged : d.changed).push(r.ref);
  }
  for (const r of before) if (!a.has(r.ref)) d.removed.push(r.ref);
  return d;
}

/** Refs a revision renumbered: an approved requirement that reappears unchanged under another ref. */
export function renumbered(before: Req[], after: Req[]): string[] {
  const out: string[] = [];
  const afterRefs = new Set(after.map((r) => r.ref));
  for (const old of before) {
    if (afterRefs.has(old.ref)) continue;
    const moved = after.find((r) => r.ref !== old.ref && r.title === old.title && JSON.stringify(r.criteria) === JSON.stringify(old.criteria));
    if (moved) out.push(`${old.ref} reappears unchanged as ${moved.ref}; keep ${old.ref}`);
  }
  return out;
}

export interface ExistingIssue {
  key: string;
  status: string;
  requirement_refs: string[];
  touches: string[];
}

const NOT_STARTED = ["Backlog", "Ready", "Failed", "Blocked"];
const RUNNING = ["In_Progress", "Awaiting_Human", "In_Review"];

/** The tags a change set may give an existing task (spec: Cascade on tasks). */
export function allowedTags(i: ExistingIssue, d: RequirementDiff): ChangeTag[] {
  const covers = i.requirement_refs;
  const kind = covers.some((r) => d.changed.includes(r)) ? "changed" : covers.length && covers.every((r) => d.removed.includes(r)) ? "removed" : "unchanged";
  if (kind === "unchanged") return ["keep"];
  if (NOT_STARTED.includes(i.status)) return kind === "changed" ? ["update"] : ["cancel"];
  if (RUNNING.includes(i.status)) return ["flag"];
  return ["keep"]; // Done stays Done; a follow-up or removal task brings the code in line
}

/**
 * Validate a change set: every existing task of the feature tagged by the cascade rules, new tasks
 * tagged new, followup or removal, every current requirement covered, and the usual graph rules.
 */
export function validateChangeSet(entries: ProposedTask[], d: RequirementDiff, existing: ExistingIssue[], others: { key: string; touches: string[] }[] = []): GraphResult {
  const errors: string[] = [];
  const live = existing.filter((i) => i.status !== "Cancelled");
  const byKey = new Map(live.map((i) => [i.key, i]));
  const seen = new Set<string>();
  const fresh: ProposedTask[] = [];
  for (const e of entries) {
    if (e.issue) {
      const i = byKey.get(e.issue);
      if (!i) {
        errors.push(`${e.issue} is not a live task of this feature.`);
        continue;
      }
      if (seen.has(e.issue)) errors.push(`${e.issue} appears twice.`);
      seen.add(e.issue);
      const ok = allowedTags(i, d);
      if (!e.tag || !ok.includes(e.tag)) errors.push(`${e.issue} (${i.status}) must be tagged ${ok.join(" or ")}, not ${e.tag ?? "untagged"}.`);
    } else {
      if (!e.tag || !["new", "followup", "removal"].includes(e.tag)) errors.push(`${e.ref}: a new task is tagged new, followup or removal.`);
      if (e.tag === "followup" && !(e.depends_on ?? []).some((x) => byKey.get(x.ref)?.status === "Done"))
        errors.push(`${e.ref}: a follow-up depends on the Done task it brings in line.`);
      fresh.push(e);
    }
  }
  for (const i of live) if (!seen.has(i.key)) errors.push(`${i.key} (${i.status}) is missing from the change set; tag it ${allowedTags(i, d).join(" or ")}.`);

  const current = [...d.unchanged, ...d.changed, ...d.added];
  const covered = new Set<string>();
  for (const e of entries) {
    if (e.tag === "cancel") continue;
    const i = e.issue ? byKey.get(e.issue) : null;
    const refs = e.issue && e.tag !== "update" ? (i?.requirement_refs ?? []) : (e.requirement_refs ?? []);
    for (const r of refs) if (!(i?.status === "Done" && d.changed.includes(r))) covered.add(r);
  }
  for (const r of current) if (!covered.has(r)) errors.push(`Requirement ${r} is not covered by any task${d.changed.includes(r) ? " (a Done task covering a changed requirement needs a follow-up)" : ""}.`);
  for (const e of entries) for (const r of e.requirement_refs ?? []) if (!current.includes(r)) errors.push(`${e.issue ?? e.ref} covers ${r}, which is not a current requirement.`);
  if (errors.length) throw new FoundryError("TASKS_INVALID", `The change set was not recorded. Fix and resend:\n- ${errors.join("\n- ")}`, { errors });

  const deps = [...live.map((i) => ({ key: i.key, touches: i.touches })), ...others];
  return validateTasks(fresh, current, deps, [], { coverage: false });
}

export interface GraphResult {
  waves: string[][];
  critical_path: string[];
  priority: Record<string, number>;
  warnings: string[];
  /** Edges implied by longer paths; dropped on approval. */
  redundant: { from: string; to: string }[];
}

/**
 * Validate a task graph. `existing` are keys of unfinished issues a task may depend on; `requirements`
 * are the refs every task list must cover. Throws TASKS_INVALID with every error, else returns the
 * waves, critical path, priorities and warnings.
 */
export function validateTasks(
  tasks: ProposedTask[],
  requirements: string[],
  existing: { key: string; touches: string[] }[] = [],
  cut: string[] = [],
  opts: { coverage?: boolean } = {},
): GraphResult {
  const errors: string[] = [];
  const live = tasks.filter((t) => !cut.includes(t.ref));
  const refs = new Set<string>();
  for (const t of tasks) {
    if (!t.ref?.trim()) errors.push(`A task has no ref ("${t.title}").`);
    else if (refs.has(t.ref)) errors.push(`${t.ref}: used twice.`);
    refs.add(t.ref);
    if (!t.title?.trim()) errors.push(`${t.ref}: needs a title.`);
  }
  const existingKeys = new Set(existing.map((e) => e.key));
  const reqSet = new Set(requirements);
  for (const t of tasks) {
    for (const d of t.depends_on ?? []) {
      if (d.ref === t.ref) errors.push(`${t.ref} depends on itself.`);
      else if (!refs.has(d.ref) && !existingKeys.has(d.ref)) errors.push(`${t.ref} depends on ${d.ref}, which is not a task here or an unfinished issue.`);
      else if (cut.includes(d.ref)) errors.push(`${t.ref} depends on ${d.ref}, which is cut.`);
    }
    for (const r of t.requirement_refs ?? []) if (!reqSet.has(r)) errors.push(`${t.ref} covers ${r}, which is not a requirement of this spec.`);
  }
  if (opts.coverage !== false)
  for (const r of requirements)
    if (!live.some((t) => (t.requirement_refs ?? []).includes(r))) errors.push(`Requirement ${r} is not covered by any task.`);

  // In-proposal edges only; dependencies on existing issues don't affect waves.
  const deps = new Map(live.map((t) => [t.ref, (t.depends_on ?? []).map((d) => d.ref).filter((r) => refs.has(r) && !cut.includes(r))]));
  const cycle = findCycle(deps);
  if (cycle) errors.push(`Cycle: ${cycle.join(" → ")}.`);
  if (errors.length) throw new FoundryError("TASKS_INVALID", `The task list was not recorded. Fix and resend:\n- ${errors.join("\n- ")}`, { errors });

  const wave = new Map<string, number>();
  const waveOf = (r: string): number => {
    if (wave.has(r)) return wave.get(r)!;
    const w = Math.max(-1, ...deps.get(r)!.map(waveOf)) + 1;
    wave.set(r, w);
    return w;
  };
  live.forEach((t) => waveOf(t.ref));
  const waves: string[][] = [];
  for (const t of live) (waves[wave.get(t.ref)!] ??= []).push(t.ref);

  const dependents = new Map(live.map((t) => [t.ref, [] as string[]]));
  for (const [r, ds] of deps) for (const d of ds) dependents.get(d)!.push(r);
  const height = new Map<string, number>();
  const heightOf = (r: string): number => {
    if (height.has(r)) return height.get(r)!;
    const h = Math.max(-1, ...dependents.get(r)!.map(heightOf)) + 1;
    height.set(r, h);
    return h;
  };
  const priority: Record<string, number> = {};
  for (const t of live) priority[t.ref] = Math.min(100, 50 + 10 * heightOf(t.ref));

  // Critical path: from the root with the greatest height, follow the tallest dependent.
  const critical: string[] = [];
  let cur = live.filter((t) => deps.get(t.ref)!.length === 0).sort((a, b) => heightOf(b.ref) - heightOf(a.ref))[0]?.ref;
  while (cur) {
    critical.push(cur);
    cur = dependents.get(cur)!.sort((a, b) => heightOf(b) - heightOf(a))[0];
  }

  const reach = (from: string, to: string, skipDirect: boolean): boolean => {
    const stack = deps.get(from)!.filter((d) => !(skipDirect && d === to));
    const seen = new Set<string>();
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...deps.get(n)!);
    }
    return false;
  };
  const warnings: string[] = [];
  const redundant: { from: string; to: string }[] = [];
  for (const [r, ds] of deps)
    for (const d of ds)
      if (reach(r, d, true)) {
        redundant.push({ from: r, to: d });
        warnings.push(`${r} → ${d} is implied by a longer path and will be dropped.`);
      }
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      const shared = (a.touches ?? []).filter((p) => (b.touches ?? []).includes(p));
      if (shared.length && !reach(a.ref, b.ref, false) && !reach(b.ref, a.ref, false))
        warnings.push(`${a.ref} and ${b.ref} both touch ${shared.join(", ")} with no order between them.`);
    }
  for (const t of live)
    for (const e of existing) {
      const shared = (t.touches ?? []).filter((p) => e.touches.includes(p));
      if (shared.length && !(t.depends_on ?? []).some((d) => d.ref === e.key)) warnings.push(`${t.ref} and unfinished ${e.key} both touch ${shared.join(", ")}.`);
    }
  if (critical.length > 3) warnings.push(`One chain is ${critical.length} tasks long (${critical.join(" → ")}).`);
  for (const t of live) if (t.size === "L") warnings.push(`${t.ref} is size L; consider splitting it.`);
  return { waves, critical_path: critical, priority, warnings, redundant };
}

function findCycle(deps: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    path.push(n);
    for (const d of deps.get(n) ?? []) {
      if (state.get(d) === 1) return [...path.slice(path.indexOf(d)), d];
      if (!state.has(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    path.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of deps.keys()) if (!state.has(n)) {
    const c = visit(n);
    if (c) return c.reverse();
  }
  return null;
}

/** tasks.md, written by Foundry from the proposal (the PM never writes it). */
export function renderTasks(title: string, tasks: ProposedTask[], g: GraphResult, cut: string[] = [], slices: SliceResult[] = []): string {
  const byRef = new Map(tasks.map((t) => [t.ref, t]));
  const lines = [`# Tasks: ${title}`, "", "Written by Foundry from the PM's proposal. Edit tasks in Foundry, not here.", ""];
  const existing = tasks.filter((t) => t.issue);
  if (existing.length) {
    lines.push("## Existing tasks", "", "| Task | Change | Covers |", "|---|---|---|");
    for (const t of existing) lines.push(`| ${t.issue} | ${t.tag} | ${(t.requirement_refs ?? []).join(", ")} |`);
    lines.push("");
  }
  const row = (r: string) => {
    const t = byRef.get(r)!;
    const dep = (t.depends_on ?? []).map((d) => `${d.ref}${d.reason ? ` (${d.reason})` : ""}`).join("; ");
    const checks = [...(t.checks?.scripts ?? []), ...(t.checks?.paths ?? []).map((p) => `path ${p}`), ...(t.checks?.pages ?? []).map((p) => `page ${p}`)].join(", ");
    // A change set's new task says which slice it joins.
    const where = existing.length && t.slice ? ` (slice ${t.slice})` : "";
    return `| ${r} | ${esc(t.title)}${where} | ${(t.requirement_refs ?? []).join(", ")} | ${esc(dep)} | ${t.size ?? ""} | ${t.loop ?? "default"} | ${esc(checks)} |`;
  };
  const head = ["| Ref | Task | Covers | Depends on | Size | Loop | Checks |", "|---|---|---|---|---|---|---|"];
  if (slices.length > 1)
    // One section per slice, in merge order; inside it the slice's tasks by wave.
    for (const sl of slices) {
      lines.push(`## Slice ${sl.n}: ${sl.title}`, "", ...(sl.goal ? [sl.goal, ""] : []), `Delivers ${sl.requirement_refs.join(", ") || "no requirement of its own"}. Merges ${sl.n === 1 ? "first" : `after slice ${sl.n - 1}`}.`, "", ...head);
      for (const w of g.waves) for (const r of w) if (sl.tasks.includes(r)) lines.push(row(r));
      lines.push("");
    }
  else
    g.waves.forEach((w, i) => {
      lines.push(`## Wave ${i + 1}`, "", ...head, ...w.map(row), "");
    });
  if (cut.length) lines.push("## Cut", "", ...cut.map((r) => `- ${r}: ${esc(byRef.get(r)?.title ?? "")}`), "");
  if (g.critical_path.length) lines.push(`Critical path: ${g.critical_path.join(" → ")}`, "");
  if (g.warnings.length) lines.push("## Warnings", "", ...g.warnings.map((w) => `- ${w}`), "");
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

// ---------- spec.md's Requirements section ----------

const REQ_START = "<!-- foundry:requirements (written by Foundry from the requirements it holds; edit them through Foundry) -->";
const REQ_END = "<!-- /foundry:requirements -->";

export function renderRequirements(reqs: { ref: string; title: string; criteria: string[] }[]): string {
  const body = reqs.map((r) => [`### ${r.ref} ${r.title}`, "", ...r.criteria.map((c) => `- ${c}`)].join("\n")).join("\n\n");
  return `${REQ_START}\n${body}\n${REQ_END}`;
}

/**
 * Put Foundry's requirements into spec.md. Foundry owns the block between its markers; the first
 * time, it takes over the ## Requirements section (to the next ## heading), or adds one. Write-only:
 * nothing is read back from the doc.
 */
export function withRequirements(doc: string, block: string): string {
  const s = doc.indexOf(REQ_START);
  const e = doc.indexOf(REQ_END);
  if (s >= 0 && e > s) return doc.slice(0, s) + block + doc.slice(e + REQ_END.length);
  const lines = doc.split("\n");
  const h = lines.findIndex((l) => /^##\s+Requirements\b/i.test(l));
  if (h >= 0) {
    let end = lines.findIndex((l, i) => i > h && /^##\s/.test(l));
    if (end < 0) end = lines.length;
    return [...lines.slice(0, h + 1), "", block, "", ...lines.slice(end)].join("\n");
  }
  const oos = lines.findIndex((l) => /^##\s+Out of scope\b/i.test(l));
  const at = oos >= 0 ? oos : lines.length;
  return [...lines.slice(0, at), "## Requirements", "", block, "", ...lines.slice(at)].join("\n");
}

const DOC_PATH = /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|txt|adoc)$|(^|\/)(README|CHANGELOG|LICENSE)[^/]*$/i;

/**
 * The loop each task names must exist (a built-in or a valid loop in .foundry/loops on base). Warns when
 * a pick looks wrong for what the task touches.
 */
export function checkLoops(tasks: ProposedTask[], available: string[], invalid: Record<string, string[]> = {}): string[] {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const t of tasks) {
    if (!t.loop) continue;
    const ref = t.issue ?? t.ref;
    if (invalid[t.loop]) errors.push(`${ref} names loop "${t.loop}", whose file in .foundry/loops is invalid: ${invalid[t.loop]!.join(" ")}`);
    else if (!available.includes(t.loop)) errors.push(`${ref} names loop "${t.loop}", which doesn't exist. Pick one of: ${available.join(", ")}.`);
    const code = (t.touches ?? []).filter((p) => !DOC_PATH.test(p));
    if (t.loop === "docs" && code.length) warnings.push(`${ref} is on the docs loop but touches ${code.join(", ")}; the docs loop runs no project checks.`);
    if (t.loop !== "docs" && (t.touches ?? []).length && !code.length) warnings.push(`${ref} only touches docs; the docs loop fits it.`);
  }
  if (errors.length) throw new FoundryError("TASKS_INVALID", `The task list was not recorded. Fix and resend:\n- ${errors.join("\n- ")}`, { errors });
  return warnings;
}
