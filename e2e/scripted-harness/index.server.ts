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
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

const CAPS = ["prompt.message", "session.persistence", "permission"] as const;
const LOG = process.env.FOUNDRY_SCRIPTED_LOG ?? "/tmp/foundry-scripted.log";
const log = (m: string) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

interface Session {
  config: ProviderSessionConfig;
  turn: number;
  mcp: Client[] | null;
  tools: Map<string, Client>;
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
  if (probe === "verdict_for_other") return call(s, "report_verdict", { verdict: "pass", summary: "cross-task", issue_key: /ISSUE:(\S+)/.exec(text)?.[1] });

  if (text.includes("planning a Quick-flow feature")) {
    const dir = /(\.foundry\/features\/[\w-]+)\/spec\.md/.exec(text)![1]!;
    write(cwd, `${dir}/spec.md`, "# Shout mode\n\nshout(text) upper-cases and adds !; CLI gets --shout.\n");
    write(cwd, `${dir}/plan.md`, "# Plan\n\n1. core.shout\n2. CLI flag\n");
    write(cwd, `${dir}/tasks.md`, "| key | title | depends on |\n|---|---|---|\n| A | Add shout() | |\n| B | Add --shout flag | A |\n");
    if (existsSync(join(cwd, ".foundry/PROBE_P10"))) write(cwd, "STRAY.md", "planner wrote outside the feature folder\n");
    const r = await call(s, "propose_tasks", {
      tasks: [
        { key: "A", title: "Add shout(text) to shout/core.py with tests", body: "shout(text) returns text.upper() + '!'", depends_on: [] },
        { key: "B", title: "Add --shout flag to the CLI with a test", body: "Use shout(). Ask the human whether -s should also work.", depends_on: ["A"] },
      ],
    });
    return `Planned. ${r}`;
  }
  if (text.includes("Foundry builder working on") && /-A:/.test(text)) {
    write(cwd, "shout/core.py", "def shout(text):\n    return text.upper() + \"!\"\n");
    write(cwd, "tests/test_core.py", "import unittest\n\nfrom shout.core import shout\n\n\nclass ShoutTest(unittest.TestCase):\n    def test_shout(self):\n        self.assertEqual(shout(\"hi\"), \"HI!\")\n");
    if (existsSync(join(cwd, "poc/PROBE_P7"))) write(cwd, "poc/fail_once.sh", "#!/bin/sh\nexit 0\n");
    return "Added shout() with a test.";
  }
  if (text.includes("Foundry builder working on") && /-B:/.test(text) || text.includes("ask me again")) {
    const ans = await call(s, "ask_human", { question: "Should the --shout flag also accept -s?" });
    if (ans.startsWith("No answer")) return "Stopped: waiting for the human on -s.";
    return implementB(cwd, ans);
  }
  if (text.startsWith("Answer to your earlier question")) return implementB(cwd, text);
  if (text.includes("Foundry check")) return "Looked at the failing check; nothing in my change causes it. Ending turn.";
  if (text.includes("Foundry's reviewer")) {
    const key = /reviewer for (\S+):/.exec(text)?.[1];
    return call(s, "report_verdict", { verdict: "pass", summary: `Looks right for ${key}.` });
  }
  if (text.includes("Foundry's PM for this project")) return "ready";
  if (/blocking B/i.test(text)) {
    const board = await call(s, "foundry_board", {});
    const b = JSON.parse(board).issues?.find((i: { key: string }) => i.key.endsWith("-B"));
    const card = await call(s, "propose_card", { kind: "set_priority", issue_key: b?.key ?? "X-B", priority: 5, reason: "B was blocked on the -s question; finish it next." });
    return `B (${b?.key}) was blocked by its dependency on A and then by your answer about -s. Next: ${b?.key}. ${card}`;
  }
  return `echo: ${text.slice(0, 80)}`;
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
// keep readFileSync referenced for future scripted reads
void readFileSync;
