// Task Flows, part 3: page checks. The frontend loop starts the project's paseo.json service, runs its
// page check script against it (the script owns the browser), keeps the screenshots for the review, and
// stops the service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, parse } from "../server/core/store";
import { Locks } from "../server/core/locks";
import { TaskLoop } from "../server/core/taskloop";
import { ensureIntegration } from "../server/core/features";
import { BUILTIN_LOOPS, parseLoopFile } from "../server/core/loops";
import { resolveChecks, resolvePage } from "../server/core/checks";
import { FakeHost, fixtureRepo, run, type Behaviour, type Turn } from "./fake-host";

// A tiny app: serves index.html on PASEO_PORT. The page check fetches each page, saves a "screenshot"
// (the page's HTML in a .png, enough for the test) and fails unless the page says Shout.
const SERVER = `require("http").createServer((q, r) => { try { r.end(require("fs").readFileSync("index.html")); } catch { r.statusCode = 404; r.end("none"); } }).listen(Number(process.env.PASEO_PORT), process.env.HOST);\n`;
const PAGE_CHECK = `const fs = require("fs"), path = require("path");
(async () => {
  const pages = (process.env.FOUNDRY_PAGES || "/").split("\\n").filter(Boolean);
  let bad = 0;
  for (const p of pages) {
    const html = await (await fetch(process.env.FOUNDRY_PAGE_URL + p)).text();
    fs.writeFileSync(path.join(process.env.FOUNDRY_SCREENSHOTS, (p.replace(/\\W+/g, "-").replace(/^-|-$/g, "") || "home") + ".png"), html);
    if (!html.includes("Shout")) { console.log(p + " has no Shout button: " + html); bad++; }
  }
  process.exit(bad ? 1 : 0);
})();
`;

function appRepo(o: { service?: string } = {}) {
  const repo = fixtureRepo();
  writeFileSync(join(repo, "server.js"), SERVER);
  writeFileSync(join(repo, "page-check.js"), PAGE_CHECK);
  writeFileSync(join(repo, "index.html"), "<h1>Home</h1>\n");
  const scripts: Record<string, unknown> = {
    test: { type: "script", command: "sh check.sh" },
    "page-check": { type: "script", command: "node page-check.js" },
  };
  if (o.service !== "none") scripts.web = { type: "service", command: o.service ?? "node server.js" };
  writeFileSync(join(repo, "paseo.json"), JSON.stringify({ scripts }, null, 2));
  run(repo, "git", "add", "-A");
  run(repo, "git", "commit", "-q", "-m", "app");
  return repo;
}

const loopOf = new Map<string, TaskLoop>();

async function setup(builder: Behaviour, o: { service?: string; maxFixRounds?: number; pages?: string[] } = {}) {
  const repo = appRepo(o);
  const store = new Store(":memory:");
  const host = new FakeHost(store);
  const shotsDir = mkdtempSync(join(tmpdir(), "foundry-shots-"));
  const loop = new TaskLoop(store, host, new Locks(), { maxFixRounds: o.maxFixRounds ?? 2, questionWindowMs: 50, checkTimeoutMs: 30_000, shotsDir });
  host.loop = loop;
  const origStart = host.startAgent.bind(host);
  host.startAgent = async (spec) => {
    loopOf.set(spec.agentId, loop);
    return origStart(spec);
  };
  const prompts: string[] = [];
  host.behaviours.builder = builder;
  host.behaviours.reviewer = (t) => {
    prompts.push(t.text);
    void loopOf.get(t.agentId)!.reportVerdict(t.agentId, { decision: "pass", reason: "looks right" });
  };
  const p = store.createProject({ key: "SHT", name: "Shout", repo, baseRef: "main" });
  const f0 = store.createFeature({ projectId: p.id, slug: "shout", title: "Shout", idea: "louder", flow: "standard", branch: "foundry/feature/shout" });
  for (const d of store.docs(f0.id)) store.updateDoc(f0.id, d.kind, { status: "approved" });
  store.setStage(f0.id, "build");
  const f = await ensureIntegration(store, host, f0.id);
  const i = store.createIssue({ projectId: p.id, featureId: f.id, origin: "feature", title: "Add a Shout button", status: "Backlog", loop: "frontend", checks: o.pages ? { pages: o.pages } : {} });
  const runs = () =>
    store
      .runs(store.latestAttempt(i.key)!.id)
      .filter((r) => r.kind === "check")
      .map((r) => ({ ...r, d: parse<{ name: string; screenshots?: string[]; dir?: string; url?: string }>(r.detail, { name: "" }) }));
  return { store, host, loop, i, runs, prompts, shotsDir };
}

const button = (t: Turn) => {
  t.write("done.txt", "ok\n");
  t.write("index.html", '<h1>Home</h1><button>Shout</button>\n');
};

test("the frontend loop runs the page check against the service, and the reviewer gets its screenshots", async () => {
  assert.deepEqual(BUILTIN_LOOPS.frontend!.steps.map((s) => s.kind), ["agent", "check", "page", "review"]);
  const { store, host, loop, i, runs, prompts, shotsDir } = await setup(button, { pages: ["/", "/settings"] });
  await loop.start(i.key, "you");
  await host.idle();
  const a = store.latestAttempt(i.key)!;
  assert.equal(a.outcome, "passed");
  assert.equal(store.issue(i.key)!.status, "In_Review");
  // The check step leaves the page check out; the page step runs it once, between start and stop.
  assert.deepEqual(host.scripts.map((s) => `${s.script}:${s.code}`), ["test:0", "page-check:0"]);
  assert.deepEqual(host.serviceLog, ["start web", "stop web"]);
  const r = runs();
  assert.deepEqual(r.map((x) => `${x.d.name}: ${x.status}`), ["test: passed", "pages: start web: passed", "pages: passed"]);
  const page = r[2]!.d;
  assert.match(page.url!, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(page.screenshots, ["home.png", "settings.png"]);
  assert.ok(page.dir!.startsWith(join(shotsDir, i.key)));
  assert.ok(existsSync(join(page.dir!, "settings.png")));
  assert.match(prompts[0]!, /Screenshots from the page check/);
  assert.ok(prompts[0]!.includes(join(page.dir!, "home.png")));
  assert.ok(host.timelineRows.some((x) => x.step === "check" && x.name === "pages" && x.screenshots?.length === 2));
});

test("a failing page check goes back to the builder with its output and screenshots, then passes", async () => {
  const { store, host, loop, i, runs } = await setup((t) => (t.n === 1 ? t.write("done.txt", "ok\n") : button(t)));
  await loop.start(i.key, "you");
  await host.idle();
  const a = store.latestAttempt(i.key)!;
  assert.equal([a.outcome, a.fix_rounds].join(), "passed,1");
  const msg = host.agents.get(a.builder_agent_id!)!.messages[1]!;
  assert.match(msg, /page check failed .*\(fix round 1 of 2\)/);
  assert.match(msg, /The page check "page-check" against http:\/\/127\.0\.0\.1:\d+ exited 1/);
  assert.match(msg, /\/ has no Shout button/);
  assert.match(msg, /Its screenshots \(open them to see the page\):\n.*home\.png/);
  assert.deepEqual(host.serviceLog, ["start web", "stop web", "start web", "stop web"], "the service is stopped after every run");
  assert.deepEqual(runs().filter((x) => x.d.name === "pages").map((x) => x.status), ["failed", "passed"]);
});

test("a service that doesn't come up is PAGE_CHECK_FAILED once the budget is spent", async () => {
  const { store, host, loop, i, runs } = await setup(button, { service: "echo 'port in use' && exit 3", maxFixRounds: 0 });
  await loop.start(i.key, "you");
  await host.idle();
  const a = store.latestAttempt(i.key)!;
  assert.equal([a.outcome, a.flag, a.reviewer_agent_id].join(), "rework,PAGE_CHECK_FAILED,");
  assert.deepEqual(runs().map((x) => `${x.d.name}: ${x.status}`), ["test: passed", "pages: start web: failed"]);
  assert.match(store.events({ issue: i.key }).find((e) => e.kind === "attempt_ended")!.detail ?? "", /page check still failing after 0 fix round\(s\): The \\"web\\" service didn't come up/);
  assert.deepEqual(host.scripts.map((s) => s.script), ["test"], "the page check never ran");
});

test("a project without a service or page check script skips the page step with a hint", async () => {
  const { store, host, loop, i } = await setup(button, { service: "none" });
  await loop.start(i.key, "you");
  await host.idle();
  assert.equal(store.latestAttempt(i.key)!.outcome, "passed");
  const skipped = store.events({ issue: i.key }).find((e) => e.kind === "check_skipped")!;
  assert.match(skipped.detail ?? "", /"pages".*FOUNDRY_PAGE_URL/);
  assert.deepEqual(host.serviceLog, []);
});

test("which service and script a page step runs; loop files can use a page step", () => {
  const scripts = [{ name: "test", command: "t" }, { name: "page-check", command: "p" }, { name: "e2e", command: "e" }];
  const step = { kind: "page" as const, name: "pages" };
  const pick = (st: typeof step & { service?: string; script?: string }, services: string[]) => {
    const r = resolvePage(st, scripts, services);
    return r.kind === "run" ? `${r.service}/${r.script.name}` : `${r.kind}`;
  };
  assert.equal(pick(step, ["api"]), "api/page-check");
  assert.equal(pick(step, ["api", "web", "dev"]), "web/page-check");
  assert.equal(pick(step, ["api", "worker"]), "api/page-check");
  assert.equal(pick({ ...step, service: "api", script: "e2e" }, ["api", "web"]), "api/e2e");
  assert.equal(pick(step, []), "skip");
  assert.equal(pick({ ...step, script: "nope" }, ["web"]), "unknown");
  assert.equal(pick({ ...step, service: "nope" }, ["web"]), "unknown");
  // Check steps that name no scripts leave the page check to the page step; naming it still runs it.
  assert.deepEqual(resolveChecks({ kind: "check", name: "check" }, {}, scripts).scripts.map((s) => s.name), ["test", "e2e"]);
  assert.deepEqual(resolveChecks({ kind: "check", name: "check" }, { scripts: ["page-check"] }, scripts).scripts.map((s) => s.name), ["test", "e2e", "page-check"]);

  assert.deepEqual(parseLoopFile("ui", { steps: [{ kind: "agent", name: "build" }, { kind: "page", name: "pages", service: "web", script: "e2e", timeout_minutes: 5 }] }).errors, []);
  assert.deepEqual(parseLoopFile("ui", { steps: [{ kind: "agent", name: "build" }, { kind: "page", name: "pages", service: 1, paths: [] }] }).errors, [
    'Step 2 (page) has an unknown field "paths".',
    "Step 2: service must be a script name.",
  ]);
});
