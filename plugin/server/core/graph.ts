// Loop 1 validation that needs no LLM: EARS acceptance criteria and the task graph the PM proposes.
import { FoundryError, type Size } from "./model";

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
export function validateTasks(tasks: ProposedTask[], requirements: string[], existing: { key: string; touches: string[] }[] = [], cut: string[] = []): GraphResult {
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
export function renderTasks(title: string, tasks: ProposedTask[], g: GraphResult, cut: string[] = []): string {
  const byRef = new Map(tasks.map((t) => [t.ref, t]));
  const lines = [`# Tasks: ${title}`, "", "Written by Foundry from the PM's proposal. Edit tasks in Foundry, not here.", ""];
  g.waves.forEach((w, i) => {
    lines.push(`## Wave ${i + 1}`, "", "| Ref | Task | Covers | Depends on | Size | Checks |", "|---|---|---|---|---|---|");
    for (const r of w) {
      const t = byRef.get(r)!;
      const dep = (t.depends_on ?? []).map((d) => `${d.ref}${d.reason ? ` (${d.reason})` : ""}`).join("; ");
      const checks = [...(t.checks?.scripts ?? []), ...(t.checks?.paths ?? []).map((p) => `path ${p}`)].join(", ");
      lines.push(`| ${r} | ${esc(t.title)} | ${(t.requirement_refs ?? []).join(", ")} | ${esc(dep)} | ${t.size ?? ""} | ${esc(checks)} |`);
    }
    lines.push("");
  });
  if (cut.length) lines.push("## Cut", "", ...cut.map((r) => `- ${r}: ${esc(byRef.get(r)?.title ?? "")}`), "");
  if (g.critical_path.length) lines.push(`Critical path: ${g.critical_path.join(" → ")}`, "");
  if (g.warnings.length) lines.push("## Warnings", "", ...g.warnings.map((w) => `- ${w}`), "");
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
