// POC test double: a scripted "harness" that behaves like a builder/reviewer/PM would, so Foundry's
// loop can be exercised headlessly. It calls tools through the MCP servers Paseo hands it.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { negotiateProviderCapabilities } from "@getpaseo/plugin/server/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

const CAPS = ["prompt.message", "session.persistence", "permission"] as const;
const LOG = process.env.FOUNDRY_SCRIPTED_LOG ?? "/tmp/foundry-scripted.log";
const log = (m: string) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

interface Session {
  config: ProviderSessionConfig;
  turn: number;
  mcp: Client[] | null;
  tools: Map<string, Client>;
  /** The feature folder a planning session may write in, from its first prompt. */
  featureDir?: string;
  pm?: boolean;
}

export default function contribute(server: PluginServerContext) {
  server.registerProvider(provider());
  return () => {};
}

function provider(): ProviderRegistration {
  return {
    id: "scripted",
    label: "Scripted (Foundry POC)",
    description: "Test double harness",
    async connect(req) {
      return connection(negotiateProviderCapabilities(req.capabilities, CAPS));
    },
  };
}

function connection(capabilities: readonly string[]): ProviderConnection {
  const listeners = new Set<(e: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  const emit = (e: ProviderEvent) => listeners.forEach((l) => l(e));
  return {
    version: 1,
    capabilities,
    async send(input) {
      queueMicrotask(() => void dispatch(input).catch((e) => log(`dispatch error ${e?.stack ?? e}`)));
    },
    onEvent(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async close() {
      for (const s of sessions.values()) for (const c of s.mcp ?? []) await c.close().catch(() => {});
      sessions.clear();
    },
  };

  async function dispatch(input: ProviderInput) {
    switch (input.type) {
      case "catalog":
        return emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: { models: [{ id: "script-1", label: "Script 1" }], modes: [{ id: "default", label: "Default" }], defaultModel: "script-1", defaultMode: "default" },
        });
      case "sessions":
        return emit({ type: "sessions", requestId: input.requestId, sessions: [] });
      case "session.open": {
        const persistence = input.persistence ?? { version: 1, data: { id: input.sessionId } };
        sessions.set(input.sessionId, { config: input.config, turn: 0, mcp: null, tools: new Map() });
        log(`open ${input.sessionId} cwd=${input.config.cwd} mcp=${JSON.stringify(Object.keys(input.config.mcpServers))}`);
        emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities, restoration: "core", persistence, title: input.config.title, cwd: input.config.cwd });
        emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: { model: "script-1", mode: "default", models: [{ id: "script-1", label: "Script 1" }], modes: [{ id: "default", label: "Default" }], thinkingOptions: [], controls: [], providerOptions: {} },
        });
        return emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
      }
      case "session.prompt": {
        const s = sessions.get(input.sessionId)!;
        if (input.prompt.input.type !== "message") return;
        const text = input.prompt.input.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
        s.turn++;
        log(`turn ${input.sessionId} #${s.turn} cwd=${s.config.cwd}: ${text.slice(0, 120).replace(/\n/g, " ")}`);
        const turnId = `${input.sessionId}-t${s.turn}`;
        emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "user_message", id: `u${s.turn}`, text, clientMessageId: input.prompt.clientMessageId } });
        emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
        emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
        let reply = "";
        try {
          reply = await script(s, text);
        } catch (e) {
          reply = `script error: ${(e as Error).message}`;
          log(reply);
        }
        emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "assistant_message", id: `a${s.turn}`, text: reply } });
        return emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
      }
      case "session.close": {
        const s = sessions.get(input.sessionId);
        for (const c of s?.mcp ?? []) await c.close().catch(() => {});
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        return emit({ type: "request.completed", requestId: input.requestId });
      }
      default:
        if ("requestId" in input) emit({ type: "request.completed", requestId: (input as { requestId: string }).requestId });
    }
  }
}

async function tools(s: Session) {
  if (s.mcp) return;
  s.mcp = [];
  for (const [name, cfg] of Object.entries(s.config.mcpServers)) {
    const client = new Client({ name: "scripted", version: "0.0.0" });
    const transport =
      cfg.type === "stdio"
        ? new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) } })
        : new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } });
    await client.connect(transport);
    s.mcp.push(client);
    const list = await client.listTools();
    for (const t of list.tools) s.tools.set(t.name, client);
    log(`mcp ${name}: ${list.tools.map((t) => t.name).join(",")}`);
  }
}

async function call(s: Session, name: string, args: Record<string, unknown>) {
  await tools(s);
  const c = s.tools.get(name);
  if (!c) return `tool ${name} not available`;
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 11 * 60_000 });
  const text = (r.content as { type: string; text?: string }[]).map((x) => x.text ?? "").join("");
  log(`call ${name} -> ${text.slice(0, 200)}`);
  return text;
}

function write(cwd: string, rel: string, body: string) {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

async function script(s: Session, text: string): Promise<string> {
  const cwd = s.config.cwd;
  // Probe hooks: a prompt can carry explicit directives.
  const probe = /PROBE:(\w+)/.exec(text)?.[1];
  if (probe === "write_file") {
    write(cwd, "PROBE_WRITE.txt", "written by a turn the host user started\n");
    return "wrote PROBE_WRITE.txt";
  }
  if (probe === "verdict_for_other") return call(s, "report_verdict", { decision: "fail", reason: "cross-task", issue_key: /ISSUE:(\S+)/.exec(text)?.[1] });

  // The project manager: answers from the board, and proposes cards.
  if (text.includes("You are Foundry's project manager for ")) s.pm = true;
  if (s.pm) {
    if (/Where are we/.test(text)) {
      const board = JSON.parse(await call(s, "get_board", {})) as { key: string; status: string }[];
      return `Where we are: ${board.map((i) => `${i.key} is ${i.status}`).join("; ")}.`;
    }
    const cancel = /Cancel (\S+-\d+)/.exec(text);
    if (cancel) return `Proposed: ${await call(s, "propose_actions", { reason: `You asked to cancel ${cancel[1]}.`, actions: [{ action: "cancel", issue: cancel[1] }] })}`;
    return "Noted.";
  }

  // Verify: the reviewer reports on every requirement listed in its prompt.
  if (text.includes("reviewer verifying the feature")) {
    const refs = [...text.matchAll(/^- (R[\d.]+) /gm)].map((m) => m[1]!);
    // FAKE_FAIL_REQ_ONCE=R3 fails that requirement the first time a Verify lists it (the M2 exit test).
    const failRef = process.env.FAKE_FAIL_REQ_ONCE;
    const fail = (ref: string) => ref === failRef && !failedOnce.has(ref) && (failedOnce.add(ref), true);
    const r = await call(s, "report_requirements", {
      results: refs.map((ref) => (fail(ref) ? { requirement_ref: ref, passed: false, evidence: `${ref}: --loud is not in the README.` } : { requirement_ref: ref, passed: true, evidence: `Read the code and tests for ${ref}.` })),
    });
    return `Reported ${refs.length} requirements. ${r}`;
  }

  // Loop 1 planner (the PM in a feature's integration worktree).
  const dir = /Write only under (\S+)\//.exec(text)?.[1];
  if (dir) s.featureDir = dir;
  if (s.featureDir) return plan(s, s.featureDir, text);

  // Loop 2 builder. Task titles decide what the scripted builder does.
  const task = /Foundry builder working on (\S+): (.*)/.exec(text);
  // The supervision e2e test: the first builder of a task titled "... (silent once)" never answers.
  if (task && /\(silent once\)/.test(task[2]!) && !silenced.has(task[1]!)) {
    silenced.add(task[1]!);
    log(`going silent on ${task[1]}`);
    return new Promise<string>(() => {});
  }
  // The quick tasks e2e test: a builder that also reports work outside its task.
  if (task && /\(report discovered work\)/.test(task[2]!) && !reported.has(task[1]!)) {
    reported.add(task[1]!);
    await call(s, "report_discovered_work", { title: "poc/fail_once.sh leaves a marker file behind", description: "It writes .fail_once in the worktree and never cleans it up.", why: "A stale marker makes the check pass on the first run." });
  }
  if (task && /shout\(\)/.test(task[2]!)) {
    write(cwd, "shout/core.py", "def shout(text):\n    return text.upper() + \"!\"\n");
    write(cwd, "tests/test_core.py", "import unittest\n\nfrom shout.core import shout\n\n\nclass ShoutTest(unittest.TestCase):\n    def test_shout(self):\n        self.assertEqual(shout(\"hi\"), \"HI!\")\n");
    return "Added shout() with a test.";
  }
  // The page checks e2e test: a button on the home page the page check looks for.
  if (task && /Shout button/.test(task[2]!)) {
    write(cwd, "site/index.html", "<h1>Shout</h1>\n<button>Shout</button>\n");
    return "Added the Shout button to the home page.";
  }
  if (text.startsWith("Foundry's page check failed")) return "Looked at the page check; ending turn.";
  if (task && /^Document/.test(task[2]!)) {
    write(cwd, "docs/loud.md", "# --loud\n\nAn alias of --shout.\n");
    return "Documented --loud.";
  }
  if (task && /--loud/.test(task[2]!)) return implementLoud(cwd);
  if ((task && /flag/.test(task[2]!)) || text.includes("ask me again")) {
    const ans = await call(s, "ask_human", { question: "Should the --shout flag also accept -s?" });
    if (ans.startsWith("Your question is waiting")) return "Stopped: waiting for the developer on -s.";
    return implementB(cwd, ans);
  }
  if (text.startsWith("Answer to your earlier question")) return implementB(cwd, text);
  if (text.startsWith("Foundry's checks failed")) return "Looked at the failing check; nothing in my change causes it. Ending turn.";
  if (text.includes("merge conflict")) return "Nothing to merge by hand.";
  if (text.includes("Foundry's reviewer for")) {
    const key = /reviewer for (\S+):/.exec(text)?.[1];
    return call(s, "report_verdict", { decision: "pass", reason: `Looks right for ${key}.` });
  }
  return `echo: ${text.slice(0, 80)}`;
}

async function plan(s: Session, dir: string, text: string): Promise<string> {
  const cwd = s.config.cwd;
  // A spec change during Build: first the requirements as they now stand, then one change set.
  if (text.includes("The developer edited")) {
    const r = await call(s, "propose_requirements", { requirements: [...SHOUT_REQS, LOUD_REQ] });
    return `Requirements updated. ${r}`;
  }
  if (text.includes("approved a changed spec")) {
    const keys = [...text.matchAll(/^- (\S+-\d+) \[(\w+)\]/gm)].map((m) => m[1]!);
    const last = keys[keys.length - 1]!;
    // With slices, the new task joins the last open slice (FAKE_SLICES, the slices e2e test).
    const open = [...text.matchAll(/^- slice (\d+) "[^"]*" \((\w+)\)/gm)].filter((m) => !["shipped", "cancelled"].includes(m[2]!)).map((m) => Number(m[1]));
    const r = await call(s, "propose_tasks", {
      tasks: [
        ...keys.map((issue) => ({ issue, tag: "keep" })),
        { ref: "N1", tag: "new", title: "Add --loud alias to the CLI with a test", requirement_refs: ["R3"], depends_on: [{ ref: last, reason: "extends its flag handling" }], touches: ["shout/cli.py"], size: "S", ...(open.length ? { slice: open[open.length - 1] } : {}) },
      ],
    });
    return `Proposed the change set. ${r}`;
  }
  // The Quick flow: Clarify (if a round is allowed), spec, plan and the task graph in one turn.
  if (text.includes("Step 4, Tasks")) {
    if (text.includes("Step 1, Clarify")) {
      const ans = await call(s, "ask_questions", { questions: [{ id: "short_flag", text: "Should --shout also accept -s?", recommended: "yes" }] });
      if (ans.startsWith("The developer hasn't answered")) return "Waiting for the developer's answers.";
    }
    return [await plan(s, dir, "Step 2"), await plan(s, dir, "plan.md with"), await plan(s, dir, "call propose_tasks")].join(" ");
  }
  if (text.includes("call propose_tasks") && FLOWS) {
    // FAKE_FLOWS: the M3 exit test's three tasks. The page task comes back as backend, so the test picks
    // frontend for it before approving; the bug fix is on bugfix; the docs task is on a project loop.
    const r = await call(s, "propose_tasks", {
      tasks: [
        { ref: "T1", title: "Add a Shout button to the home page", requirement_refs: ["R2"], touches: ["site/index.html"], size: "S", loop: "backend", checks: { pages: ["/"] } },
        { ref: "T2", title: "Fix shout() dropping the exclamation mark", requirement_refs: ["R1"], touches: ["shout/core.py", "tests/test_core.py"], size: "S", loop: "bugfix", checks: { scripts: ["unittest"] } },
        { ref: "T3", title: "Document the CLI (silent once)", requirement_refs: ["R2"], touches: ["docs/loud.md"], size: "S", loop: "careful" },
      ],
    });
    return `Proposed the task graph. ${r}`;
  }
  if (text.includes("call propose_tasks")) {
    const r = await call(s, "propose_tasks", {
      tasks: [
        { ref: "T1", title: "Add shout() to shout/core.py with tests", requirement_refs: ["R1"], touches: ["shout/core.py"], size: "S", checks: { scripts: ["unittest"] }, ...(SLICED ? { slice: 1 } : {}) },
        {
          ref: "T2",
          title: "Add --shout flag to the CLI with a test",
          requirement_refs: ["R2"],
          depends_on: [{ ref: "T1", reason: "the flag calls shout()" }],
          touches: ["shout/cli.py"],
          size: "S",
          ...(SLICED ? { slice: 2 } : {}),
        },
        // FAKE_SLICES: a third slice documents the CLI (the slices e2e test).
        ...(SLICED ? [{ ref: "T3", title: "Document the CLI", requirement_refs: ["R2"], depends_on: [{ ref: "T2", reason: "documents the flag" }], touches: ["docs/loud.md"], size: "S", slice: 3 }] : []),
      ],
      ...(SLICED ? { slices: [{ n: 1, title: "Shout core", goal: "shout() works" }, { n: 2, title: "CLI flag" }, { n: 3, title: "Docs" }] } : {}),
    });
    return `Proposed the task graph. ${r}`;
  }
  if (text.includes("plan.md with")) {
    write(cwd, `${dir}/plan.md`, "# Plan\n\n## Approach\nshout() in core, a flag in the CLI.\n\n## Files and components\n- shout/core.py\n- shout/cli.py\n\n## Data and API changes\nNone.\n\n## Risks\nNone.\n\n## Test strategy\nunittest.\n");
    return "Wrote plan.md.";
  }
  if (text.includes("Step 1, Clarify")) {
    const ans = await call(s, "ask_questions", { questions: [{ id: "short_flag", text: "Should --shout also accept -s?", recommended: "yes" }] });
    if (ans.startsWith("The developer hasn't answered")) return "Waiting for the developer's answers.";
  }
  if (text.includes("Step 2")) {
    write(
      cwd,
      `${dir}/spec.md`,
      "# Shout mode\n\n## Goal\nLet the CLI shout.\n\n## User stories\nAs a user I can shout.\n\n## Requirements\n\nR1 Shout\n- WHEN shout(text) is called THE library SHALL return text upper-cased with ! appended\n\nR2 CLI flag\n- WHERE --shout is given THE CLI SHALL print the shouted text\n\n## Out of scope\nWhispering.\n\n## Decisions\n- See the answers.\n",
    );
    const r = await call(s, "propose_requirements", { requirements: SHOUT_REQS });
    return `Wrote spec.md. ${r}`;
  }
  return `planner echo: ${text.slice(0, 80)}`;
}

const SHOUT_REQS = [
  { ref: "R1", title: "Shout", acceptance_criteria: ["WHEN shout(text) is called THE library SHALL return text upper-cased with ! appended"] },
  { ref: "R2", title: "CLI flag", acceptance_criteria: ["WHERE --shout is given THE CLI SHALL print the shouted text"] },
];
const LOUD_REQ = { ref: "R3", title: "Loud alias", acceptance_criteria: ["WHERE --loud is given THE CLI SHALL behave as with --shout"] };

const failedOnce = new Set<string>();
const silenced = new Set<string>();
const reported = new Set<string>();
const SLICED = process.env.FAKE_SLICES === "1";
const FLOWS = process.env.FAKE_FLOWS === "1";

function implementLoud(cwd: string) {
  const p = join(cwd, "shout/cli.py");
  const src = readFileSync(p, "utf8").replace(/\("--shout"/g, '("--shout", "--loud"');
  writeFileSync(p, src);
  write(cwd, "tests/test_cli_loud.py", `import io\nimport unittest\nfrom contextlib import redirect_stdout\n\nfrom shout import cli\n\n\nclass LoudTest(unittest.TestCase):\n    def test_loud(self):\n        buf = io.StringIO()\n        with redirect_stdout(buf):\n            cli.main(["--loud", "hi"])\n        self.assertEqual(buf.getvalue().strip(), "HI!")\n`);
  return "Added --loud as an alias of --shout, with a test.";
}

function implementB(cwd: string, answer: string) {
  const short = /\byes\b/i.test(answer);
  const flags = short ? `("--shout", "-s")` : `("--shout",)`;
  write(
    cwd,
    "shout/cli.py",
    `import sys\n\nfrom shout.core import shout\n\n\ndef main(argv=None):\n    argv = sys.argv[1:] if argv is None else argv\n    loud = any(a in ${flags} for a in argv)\n    words = [a for a in argv if a not in ${flags}]\n    text = " ".join(words)\n    print(shout(text) if loud else text)\n    return 0\n\n\nif __name__ == "__main__":\n    raise SystemExit(main())\n`,
  );
  write(cwd, "tests/test_cli_shout.py", `import io\nimport unittest\nfrom contextlib import redirect_stdout\n\nfrom shout import cli\n\n\nclass ShoutFlagTest(unittest.TestCase):\n    def test_flag(self):\n        buf = io.StringIO()\n        with redirect_stdout(buf):\n            cli.main(["--shout", "hi"])\n        self.assertEqual(buf.getvalue().strip(), "HI!")\n`);
  return `Added --shout${short ? " and -s" : ""} with a test.`;
}
