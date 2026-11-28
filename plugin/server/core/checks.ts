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
  /** For a repro step: the script that runs the reproducing test, and the files that hold it. */
  repro?: { script?: string; files?: string[] };
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

/** Test files by name: tests/, test/, __tests__/, spec/ folders, *.test.* and *.spec.* files, test_*.py. */
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;

/**
 * The script a repro step runs: the step's, else the task's repro script, else the task's first check,
 * else paseo.json's "test", else its first script. Null when paseo.json has no scripts.
 */
export function reproScript(step: Extract<LoopStep, { kind: "repro" }>, task: TaskChecks, available: PaseoScript[]): string | null {
  return step.script ?? task.repro?.script ?? task.scripts?.[0] ?? (available.some((s) => s.name === "test") ? "test" : (available[0]?.name ?? null));
}

/** Split a change into the test that reproduces the bug and the fix. Deleted files never count as tests. */
export function splitRepro(changed: { status: string; path: string }[], files?: string[]) {
  const isTest = (c: { status: string; path: string }) => c.status !== "D" && (files?.length ? files.includes(c.path) : TEST_FILE.test(c.path));
  return { tests: changed.filter(isTest), fix: changed.filter((c) => !isTest(c)) };
}
