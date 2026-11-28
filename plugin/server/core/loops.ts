// Task loops: the ordered steps an attempt runs (agent, check, repro, page, review). Loops are data from day one,
// validated by the same rules the runner and (later) the designer use, and frozen onto the attempt
// when it starts, so a change to a loop affects the next attempt only. Borrows Playbooks' patterns
// (frozen definition from base, validation, bounded rework) without depending on Playbooks.
import { parse as parseYaml } from "yaml";
import { git } from "./git";
import { FoundryError } from "./model";

export type LoopStep =
  | { kind: "agent"; name: string; prompt?: string }
  | { kind: "check"; name: string; scripts?: string[]; paths?: string[]; max_fix_rounds?: number; timeout_minutes?: number }
  /** A bug's reproduction: the test script fails with the fix reverted and passes with it. */
  | { kind: "repro"; name: string; script?: string; max_fix_rounds?: number; timeout_minutes?: number }
  /** The app's pages: start a paseo.json service, run the page check script against it, keep its screenshots. */
  | { kind: "page"; name: string; service?: string; script?: string; max_fix_rounds?: number; timeout_minutes?: number }
  | { kind: "review"; name: string; prompt?: string; back_to?: string; max_reworks?: number };

export interface LoopDef {
  name: string;
  source: "built-in" | "project";
  steps: LoopStep[];
}

/**
 * Built-in loops, one per kind of work (after LoopForge's built-in SOPs). Each step's prompt is the
 * work domain its agent gets on top of the task. A check step that names no scripts runs every
 * paseo.json script of type "script"; `scripts: []` runs none (the task's own checks still run).
 */
const DOMAIN = {
  frontend: "Work domain: what the user sees. Pages, interaction, accessibility (labels, focus, keyboard) and responsive layout.",
  bugfix: "Work domain: a bug. Find the root cause before changing code, add a test that reproduces the bug, then fix it. Never invent a reproduction or claim a fix you didn't make; if you can't reproduce it, report_verdict human with what is missing.",
  docs: "Work domain: documentation. Write or update the documents the task names. Don't change source code.",
};
export const BUILTIN_LOOPS: Record<string, LoopDef> = {
  backend: {
    name: "backend",
    source: "built-in",
    steps: [
      { kind: "agent", name: "build" },
      { kind: "check", name: "check" },
      { kind: "review", name: "review", back_to: "build", max_reworks: 1 },
    ],
  },
  frontend: {
    name: "frontend",
    source: "built-in",
    steps: [
      { kind: "agent", name: "build", prompt: DOMAIN.frontend },
      { kind: "check", name: "check" },
      { kind: "page", name: "pages" },
      { kind: "review", name: "review", back_to: "build", max_reworks: 1, prompt: `${DOMAIN.frontend} Check the change from the user's side as well as the code: open the page check's screenshots when there are any.` },
    ],
  },
  bugfix: {
    name: "bugfix",
    source: "built-in",
    steps: [
      { kind: "agent", name: "fix", prompt: DOMAIN.bugfix },
      { kind: "repro", name: "repro" },
      { kind: "check", name: "check" },
      { kind: "review", name: "review", back_to: "fix", max_reworks: 1, prompt: "Work domain: a bug fix. Check that the root cause is fixed (not only the symptom) and that a test reproduces the bug and now passes." },
    ],
  },
  docs: {
    name: "docs",
    source: "built-in",
    steps: [
      { kind: "agent", name: "write", prompt: DOMAIN.docs },
      { kind: "check", name: "check", scripts: [] },
      { kind: "review", name: "review", back_to: "write", max_reworks: 1, prompt: "Work domain: documentation. Check it is complete, consistent with the code and covers the edge cases. Ask for rework on anything blocking." },
    ],
  },
};

export const DEFAULT_LOOP = "backend";

export function validateLoop(def: LoopDef): string[] {
  const errors: string[] = [];
  if (!def.steps.length) errors.push("A loop needs at least one step.");
  if (def.steps[0] && def.steps[0].kind !== "agent") errors.push("The first step must be the agent (the builder's turn).");
  const names = new Set<string>();
  def.steps.forEach((s, i) => {
    if (!["agent", "check", "repro", "page", "review"].includes(s.kind)) errors.push(`Step ${i + 1} has unknown kind "${(s as { kind: string }).kind}".`);
    if (!s.name) errors.push(`Step ${i + 1} needs a name.`);
    if (names.has(s.name)) errors.push(`Step name "${s.name}" is used twice.`);
    if (s.kind === "review" && s.back_to !== undefined) {
      const target = def.steps.findIndex((x) => x.name === s.back_to);
      if (target < 0 || target >= i) errors.push(`Step "${s.name}" goes back to "${s.back_to}", which is not an earlier step.`);
      else if (def.steps[target]!.kind !== "agent") errors.push(`Step "${s.name}" must go back to an agent step.`);
    }
    for (const cap of ["max_fix_rounds", "max_reworks", "timeout_minutes"] as const) {
      const v = (s as Record<string, unknown>)[cap];
      if (v !== undefined && (typeof v !== "number" || v < 0 || !Number.isInteger(v))) errors.push(`Step "${s.name}": ${cap} must be zero or more.`);
    }
    names.add(s.name);
  });
  return errors;
}

/**
 * The loop an issue runs: its own, else the project's default, else backend. Project loops (from
 * .foundry/loops on base) come before built-ins of the same name. Unknown names are LOOP_MISSING.
 */
export function resolveLoop(issueLoop: string | null, projectDefault: string | null, project: ProjectLoops = { loops: {}, invalid: {} }): LoopDef {
  const name = issueLoop || projectDefault || DEFAULT_LOOP;
  if (project.invalid[name]) throw new FoundryError("LOOP_INVALID", `Loop "${name}" in .foundry/loops is invalid: ${project.invalid[name]!.join(" ")}`, { loop: name, errors: project.invalid[name] });
  const def = project.loops[name] ?? BUILTIN_LOOPS[name];
  const available = loopNames(project);
  if (!def) throw new FoundryError("LOOP_MISSING", `Loop "${name}" is not on base. Pick one of: ${available.join(", ")}.`, { loop: name, available });
  const errors = validateLoop(def);
  if (errors.length) throw new FoundryError("LOOP_INVALID", `Loop "${name}" is invalid: ${errors.join(" ")}`, { loop: name, errors });
  return structuredClone(def);
}

export function stepIndex(def: LoopDef, name: string) {
  return def.steps.findIndex((s) => s.name === name);
}

/** Loops a project defines in .foundry/loops/<name>.yaml on base; files that don't validate are kept with their errors. */
export interface ProjectLoops {
  loops: Record<string, LoopDef>;
  invalid: Record<string, string[]>;
}

export function loopNames(project: ProjectLoops = { loops: {}, invalid: {} }) {
  return [...new Set([...Object.keys(BUILTIN_LOOPS), ...Object.keys(project.loops)])];
}

/** Parse one loop file (YAML: name optional, steps required). The file name is the loop's name. */
export function parseLoopFile(name: string, doc: unknown): { def: LoopDef | null; errors: string[] } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { def: null, errors: [`"${name}" is not a loop name: use lower case letters, digits and dashes.`] };
  if (!doc || typeof doc !== "object" || !Array.isArray((doc as { steps?: unknown }).steps)) return { def: null, errors: ["The file needs a list of steps."] };
  const d = doc as { name?: unknown; steps: unknown[] };
  if (d.name !== undefined && d.name !== name) return { def: null, errors: [`Its name "${String(d.name)}" doesn't match the file name "${name}".`] };
  const allowed: Record<string, string[]> = {
    agent: ["kind", "name", "prompt"],
    check: ["kind", "name", "scripts", "paths", "max_fix_rounds", "timeout_minutes"],
    repro: ["kind", "name", "script", "max_fix_rounds", "timeout_minutes"],
    page: ["kind", "name", "service", "script", "max_fix_rounds", "timeout_minutes"],
    review: ["kind", "name", "prompt", "back_to", "max_reworks"],
  };
  const errors: string[] = [];
  d.steps.forEach((st, i) => {
    if (!st || typeof st !== "object") return errors.push(`Step ${i + 1} is not a mapping.`);
    const kind = (st as { kind?: unknown }).kind;
    const keys = allowed[String(kind)];
    if (!keys) return; // validateLoop reports the unknown kind
    for (const k of Object.keys(st)) if (!keys.includes(k)) errors.push(`Step ${i + 1} (${String(kind)}) has an unknown field "${k}".`);
    for (const k of ["scripts", "paths"]) {
      const v = (st as Record<string, unknown>)[k];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) errors.push(`Step ${i + 1}: ${k} must be a list of names.`);
    }
    for (const k of ["script", "service"]) {
      const v = (st as Record<string, unknown>)[k];
      if (v !== undefined && typeof v !== "string") errors.push(`Step ${i + 1}: ${k} must be a script name.`);
    }
  });
  const def: LoopDef = { name, source: "project", steps: d.steps as LoopStep[] };
  errors.push(...validateLoop(def));
  return errors.length ? { def: null, errors } : { def, errors: [] };
}

/** Read every .foundry/loops/*.yaml (or .yml) from base. A file that doesn't parse or validate is listed with its errors. */
export async function projectLoops(repo: string, baseRef: string): Promise<ProjectLoops> {
  const out: ProjectLoops = { loops: {}, invalid: {} };
  const list = await git(repo, "ls-tree", "--name-only", `${baseRef}:.foundry/loops`).catch(() => "");
  for (const file of list.split("\n").filter((f) => /\.ya?ml$/.test(f))) {
    const name = file.replace(/\.ya?ml$/, "");
    let doc: unknown;
    try {
      doc = parseYaml(await git(repo, "show", `${baseRef}:.foundry/loops/${file}`));
    } catch (e) {
      out.invalid[name] = [`It isn't valid YAML: ${(e as Error).message.split("\n")[0]}`];
      continue;
    }
    const r = parseLoopFile(name, doc);
    if (r.def) out.loops[name] = r.def;
    else out.invalid[name] = r.errors;
  }
  return out;
}
