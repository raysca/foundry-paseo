// Task loops: the ordered steps an attempt runs (agent, check, review). Loops are data from day one,
// validated by the same rules the runner and (later) the designer use, and frozen onto the attempt
// when it starts, so a change to a loop affects the next attempt only. Borrows Playbooks' patterns
// (frozen definition from base, validation, bounded rework) without depending on Playbooks.
import { FoundryError } from "./model";

export type LoopStep =
  | { kind: "agent"; name: string; prompt?: string }
  | { kind: "check"; name: string; scripts?: string[]; paths?: string[]; max_fix_rounds?: number; timeout_minutes?: number }
  | { kind: "review"; name: string; prompt?: string; back_to?: string; max_reworks?: number };

export interface LoopDef {
  name: string;
  source: "built-in" | "project";
  steps: LoopStep[];
}

/**
 * Built-in loops. M1 ships backend only; frontend, bugfix and docs arrive with Task Flows (M3).
 * A check step that names no scripts runs every paseo.json script of type "script".
 */
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
};

export const DEFAULT_LOOP = "backend";

export function validateLoop(def: LoopDef): string[] {
  const errors: string[] = [];
  if (!def.steps.length) errors.push("A loop needs at least one step.");
  if (def.steps[0] && def.steps[0].kind !== "agent") errors.push("The first step must be the agent (the builder's turn).");
  const names = new Set<string>();
  def.steps.forEach((s, i) => {
    if (!["agent", "check", "review"].includes(s.kind)) errors.push(`Step ${i + 1} has unknown kind "${(s as { kind: string }).kind}".`);
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

/** The loop an issue runs: its own, else the project's default, else backend. Unknown names are LOOP_MISSING. */
export function resolveLoop(issueLoop: string | null, projectDefault: string | null): LoopDef {
  const name = issueLoop || projectDefault || DEFAULT_LOOP;
  const def = BUILTIN_LOOPS[name];
  if (!def) throw new FoundryError("LOOP_MISSING", `Loop "${name}" is not on base. Pick one of: ${Object.keys(BUILTIN_LOOPS).join(", ")}.`, { loop: name, available: Object.keys(BUILTIN_LOOPS) });
  const errors = validateLoop(def);
  if (errors.length) throw new FoundryError("LOOP_INVALID", `Loop "${name}" is invalid: ${errors.join(" ")}`, { loop: name, errors });
  return structuredClone(def);
}

export function stepIndex(def: LoopDef, name: string) {
  return def.steps.findIndex((s) => s.name === name);
}
