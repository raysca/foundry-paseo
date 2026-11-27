// Using a repository Paseo already knows as a Foundry project: the key, name and base branch come
// from the repo, so you pick a project card instead of filling in a form.
import { realpathSync } from "node:fs";
import { git } from "./git";
import { FoundryError } from "./model";
import type { Project, Store } from "./store";

/** 2 to 5 capital letters from a name ("shout-cli" -> "SC", "paseo" -> "PAS"), unique among `taken`. */
export function suggestKey(name: string, taken: Set<string>): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
  const letters = words.join("") || "PRJ";
  const candidates: string[] = [];
  if (words.length >= 2) candidates.push(words.map((w) => w[0]).join("").slice(0, 5));
  for (let n = 3; n <= 5; n++) candidates.push(letters.slice(0, n));
  for (const c of candidates) if (c.length >= 2 && !taken.has(c)) return c;
  const base = (letters + "XXX").slice(0, 3);
  for (const a of "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    for (const b of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!taken.has(base + a + b)) return base + a + b;
  throw new FoundryError("KEY_TAKEN", "No free project key; create the project with a key of your choice");
}

/** The repo's default branch: origin's HEAD, else the checked-out branch, else main. */
export async function defaultBranch(repo: string): Promise<string> {
  const remote = await git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").catch(() => "");
  if (remote.trim()) return remote.trim().replace(/^origin\//, "");
  const current = await git(repo, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "");
  return current.trim() || "main";
}

const same = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

/** The Foundry project for a repository, creating it on first use. */
export async function adoptRepo(store: Store, o: { repo: string; name?: string }): Promise<Project & { created: boolean }> {
  const existing = store.projects().find((p) => same(p.repo, o.repo));
  if (existing) return { ...existing, created: false };
  const top = (await git(o.repo, "rev-parse", "--show-toplevel").catch(() => "")).trim();
  if (!top) throw new FoundryError("NOT_A_REPO", `${o.repo} is not a git repository`);
  const name = o.name?.trim() || top.split("/").pop() || "Project";
  const key = suggestKey(name, new Set(store.projects().map((p) => p.key)));
  const p = store.createProject({ key, name, repo: top, baseRef: await defaultBranch(top) });
  return { ...p, created: true };
}
