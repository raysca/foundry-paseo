// Ship in PR mode: push the feature branch and open a GitHub PR with the gh CLI, then follow it. gh runs
// with your own login, in the project's repo; Foundry never stores a token.
import { sh } from "./git";
import { FoundryError } from "./model";

export interface PrInfo {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
}

/** The first git remote of the repo, if any. */
export async function firstRemote(repo: string): Promise<string | null> {
  const r = await sh("git", ["remote"], { cwd: repo });
  return r.stdout.trim().split("\n").filter(Boolean)[0] ?? null;
}

export async function pushBranch(repo: string, remote: string, branch: string) {
  const r = await sh("git", ["push", "-q", "-u", remote, `${branch}:${branch}`], { cwd: repo });
  if (r.code !== 0) throw new FoundryError("PUSH_FAILED", `Pushing ${branch} to ${remote} failed: ${r.stderr.trim() || r.stdout.trim()}`);
}

async function gh(repo: string, args: string[], timeoutMs = 60_000) {
  const r = await sh("gh", args, { cwd: repo, timeoutMs });
  if (r.code === 127 || /ENOENT/.test(r.stderr)) throw new FoundryError("GH_MISSING", "The gh CLI isn't installed on the daemon's machine. Install it and run gh auth login, or set the project to merge locally.");
  return r;
}

/** Open a PR from branch into base. Refused with GH_FAILED (gh's own message) when gh can't. */
export async function createPr(repo: string, o: { base: string; branch: string; title: string; body: string }): Promise<PrInfo> {
  const r = await gh(repo, ["pr", "create", "--base", o.base, "--head", o.branch, "--title", o.title, "--body", o.body]);
  if (r.code !== 0) throw new FoundryError("GH_FAILED", `gh pr create failed: ${r.stderr.trim() || r.stdout.trim()}`);
  const url = r.stdout.trim().split("\n").filter(Boolean).pop()!;
  return viewPr(repo, url);
}

export async function viewPr(repo: string, ref: string | number): Promise<PrInfo> {
  const r = await gh(repo, ["pr", "view", String(ref), "--json", "number,url,state,headRefOid"]);
  if (r.code !== 0) throw new FoundryError("GH_FAILED", `gh pr view failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return JSON.parse(r.stdout) as PrInfo;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi,
];

/** Blank out anything that looks like a secret before text leaves the machine (a PR body). */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, keep) => (typeof keep === "string" && m.startsWith(keep) ? `${keep}[redacted]` : "[redacted]"));
  return out;
}
