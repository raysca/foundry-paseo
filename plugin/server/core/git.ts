// Foundry core: git helpers. Host-independent.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function sh(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = { cwd: "." },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await pexec(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? ""),
    };
  }
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitEnv(cwd, undefined, ...args);
}

export async function gitEnv(cwd: string, env: NodeJS.ProcessEnv | undefined, ...args: string[]): Promise<string> {
  const r = await sh("git", args, { cwd, env });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export const FOUNDRY_IDENT = ["-c", "user.name=Foundry", "-c", "user.email=foundry@localhost"];
export const HOST_IDENT = ["-c", "user.name=Host user (untracked)", "-c", "user.email=host@localhost"];
export const PM_IDENT = ["-c", "user.name=Foundry PM", "-c", "user.email=foundry-pm@localhost"];

/**
 * The process env with an identity's author and committer set. GIT_AUTHOR_* in the daemon's env would
 * otherwise win over `-c user.name`, and Foundry's commits must say who made them.
 */
export function identEnv(ident: string[]): NodeJS.ProcessEnv {
  const get = (k: string) => ident.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
  const name = get("user.name");
  const email = get("user.email");
  return { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

export async function head(cwd: string) {
  return git(cwd, "rev-parse", "HEAD");
}
export async function treeOf(cwd: string, rev: string) {
  return git(cwd, "rev-parse", `${rev}^{tree}`);
}
export async function statusPorcelain(cwd: string) {
  // Not trimmed: the first line's leading space is part of the status code.
  const r = await sh("git", ["status", "--porcelain", "--untracked-files=all"], { cwd });
  if (r.code !== 0) throw new Error(`git status (in ${cwd}) failed: ${r.stderr.trim()}`);
  return r.stdout;
}
export async function changedPaths(cwd: string): Promise<string[]> {
  const out = await statusPorcelain(cwd);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1]! : p));
}

/** Commit everything in the worktree except `exclude` paths. Returns new HEAD or null if nothing to commit. */
export async function commitAll(cwd: string, message: string, ident = FOUNDRY_IDENT, exclude: string[] = []) {
  const pathspec = [".", ...exclude.map((p) => `:(exclude)${p}`)];
  await git(cwd, "add", "-A", "--", ...pathspec);
  const staged = await sh("git", ["diff", "--cached", "--quiet"], { cwd });
  if (staged.code === 0) return null;
  await gitEnv(cwd, identEnv(ident), ...ident, "commit", "-q", "-m", message);
  return head(cwd);
}

/** The branch checked out in a worktree ("" when detached). */
export async function currentBranch(cwd: string): Promise<string> {
  const b = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  return b === "HEAD" ? "" : b;
}
