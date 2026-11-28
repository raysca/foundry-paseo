// What a check step runs. Checks are the project's own paseo.json scripts, read from base so a builder
// can't change what runs; Foundry keeps no check list of its own. A task's own checks add to its loop's.
import { git } from "./git";
import type { LoopStep } from "./loops";

export interface PaseoScript {
  name: string;
  command: string;
}

export interface TaskChecks {
  scripts?: string[];
  paths?: string[];
}

/** paseo.json scripts of type "script" at a ref. */
export async function paseoScripts(repo: string, ref: string): Promise<PaseoScript[]> {
  const raw = await git(repo, "show", `${ref}:paseo.json`).catch(() => null);
  if (!raw) return [];
  try {
    const cfg = JSON.parse(raw) as { scripts?: Record<string, { type?: string; command?: string }> };
    return Object.entries(cfg.scripts ?? {})
      .filter(([, s]) => s && s.type === "script" && typeof s.command === "string")
      .map(([name, s]) => ({ name, command: s.command as string }));
  } catch {
    return [];
  }
}

export interface ResolvedChecks {
  scripts: PaseoScript[];
  paths: string[];
  /** Script names the loop or task asked for that paseo.json doesn't have. */
  unknown: string[];
}

/** The scripts and required paths one check step runs for one task: the step's, plus the task's own. */
export function resolveChecks(step: Extract<LoopStep, { kind: "check" }>, task: TaskChecks, available: PaseoScript[]): ResolvedChecks {
  const byName = new Map(available.map((s) => [s.name, s]));
  // No scripts named: every paseo.json script; an empty list: none (only the task's own checks).
  const wanted = step.scripts ? [...step.scripts] : available.map((s) => s.name);
  for (const s of task.scripts ?? []) if (!wanted.includes(s)) wanted.push(s);
  const scripts: PaseoScript[] = [];
  const unknown: string[] = [];
  for (const n of wanted) {
    const s = byName.get(n);
    if (s) scripts.push(s);
    else unknown.push(n);
  }
  return { scripts, paths: [...new Set([...(step.paths ?? []), ...(task.paths ?? [])])], unknown };
}

/** Files a check must see as they are on base: paseo.json and any file its commands name. */
export async function filesFromBase(repo: string, baseRef: string, scripts: PaseoScript[]): Promise<string[]> {
  const out = new Set(["paseo.json"]);
  for (const s of scripts)
    for (const t of s.command.split(/\s+/))
      if (t && !t.startsWith("-") && /[/.]/.test(t) && (await git(repo, "cat-file", "-e", `${baseRef}:${t}`).then(() => true, () => false))) out.add(t);
  return [...out];
}

export function tail(text: string, chars = 4000) {
  return text.length > chars ? text.slice(-chars) : text;
}
