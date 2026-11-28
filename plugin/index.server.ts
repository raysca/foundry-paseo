// Foundry's server entry: wires the store, the Paseo adapter, settings, hooks and plugin RPC.
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { Store } from "./server/core/store";
import { Foundry } from "./server/core/foundry";
import { featuresOverview } from "./server/core/overview";
import { adoptRepo } from "./server/core/projects";
import { FoundryError } from "./server/core/model";
import { PaseoAdapter, type AdapterConfig } from "./server/adapter/paseo";
import { buildTools } from "./server/adapter/tools";
import { actionRpc, bootstrapRpc, setupRpc, stateRpc } from "./shared/rpc";
import { Install } from "./server/core/install";
import { CHANGES, VERSION } from "./shared/changes";
import { foundrySettings, type FoundrySettings } from "./shared/settings";

type PaseoApi = PluginHandlerContext["paseo"];
const PLUGIN_ID = "foundry";

export default function contribute(server: PluginServerContext) {
  // Not ~/.foundry: the earlier Go Foundry and the prototype kept their own databases there.
  const home = process.env.FOUNDRY_HOME ?? join(homedir(), ".foundry-paseo");
  let store: Store;
  try {
    store = new Store(join(home, "foundry.db"));
  } catch (e) {
    // The database couldn't be opened or upgraded. It is left exactly as it was; Foundry starts in safe
    // mode so the screens can say what happened instead of the plugin failing to load.
    if (e instanceof FoundryError) return safeMode(server, home, e);
    throw e;
  }
  const install = new Install(store, VERSION, CHANGES);
  install.onStart();
  // Development helpers (dev reset): with FOUNDRY_DEV=1, or a dev-mode file that scripts/install-local.sh writes.
  const devMode = process.env.FOUNDRY_DEV === "1" || existsSync(join(home, "dev-mode"));

  // Effective settings: Paseo plugin settings, then an optional overlay file (the e2e kit writes one).
  const settings: FoundrySettings = foundrySettings.schema.parse({}) as FoundrySettings;
  const adapterCfg: AdapterConfig = { daemonUrl: process.env.FOUNDRY_DAEMON_URL ?? settings.daemonUrl };
  const overlayPath = join(home, "config.json");
  const apply = (v: FoundrySettings) => {
    Object.assign(settings, v);
    if (existsSync(overlayPath)) Object.assign(settings, JSON.parse(readFileSync(overlayPath, "utf8")));
    adapterCfg.daemonUrl = process.env.FOUNDRY_DAEMON_URL ?? settings.daemonUrl;
  };
  apply(settings);
  const registered = server.registerSettings(foundrySettings);
  const loadSettings = async () => {
    const s = await registered.read();
    if (s.status === "ready") apply(s.values as FoundrySettings);
  };
  void loadSettings();
  const unsubSettings = registered.subscribe(() => void loadSettings());

  // Paseo hands server code its SDK only inside hook and handler contexts. Foundry must run with no
  // client open and right after a restart, so at start it calls its own foundry.bootstrap RPC over a
  // short-lived loopback connection; from then on everything goes through that SDK.
  let current: PaseoApi | null = null;
  const paseo = new Proxy({} as PaseoApi, {
    get(_t, k) {
      if (!current) throw new Error("Paseo SDK not attached yet");
      return (current as any)[k];
    },
  });
  const adapter = new PaseoAdapter(server, paseo, store, adapterCfg);
  const foundry = new Foundry(store, adapter, {
    home,
    loop: () => ({ maxFixRounds: settings.maxFixRounds, questionWindowMs: settings.questionWindowSeconds * 1000, checkTimeoutMs: 10 * 60_000 }),
  });
  let started = false;
  const attach = (p: PaseoApi, via: string) => {
    current = p;
    if (started) return;
    started = true;
    store.event("sdk_attached", { detail: { via } });
    void foundry.recover().catch((e) => store.event("recover_error", { detail: { error: String(e?.stack ?? e) } }));
  };
  const removeHooks = adapter.install(foundry, buildTools(foundry), (p) => attach(p, "hook"));

  const handle = server.handle.bind(server) as (c: unknown, h: (i: any, ctx: PluginHandlerContext) => unknown) => void;
  // Set once you delete Foundry's data before uninstalling: from then on Foundry only says so.
  let deleted: string | null = null;
  const withSdk = <I, O>(fn: (input: I) => Promise<O> | O) => async (input: I, ctx: PluginHandlerContext) => {
    if (deleted)
      return { deleted, error: { code: "DATA_DELETED", message: `Foundry's data was deleted. Uninstall Foundry in Paseo's settings, or reload it to start fresh.` } };
    attach(ctx.paseo, "rpc");
    try {
      return await fn(input);
    } catch (e) {
      // FoundryError codes are part of what screens and agents react to: keep them on the wire.
      if (e instanceof FoundryError) return { error: { code: e.code, message: e.message, detail: e.detail } };
      throw e;
    }
  };

  handle(bootstrapRpc, withSdk(() => ({ ok: true })));
  handle(setupRpc, withSdk(() => foundry.runSetupCheck()));
  handle(
    stateRpc,
    withSdk(() => ({
      setup: foundry.setupStatus(),
      projects: store.projects(),
      overview: featuresOverview(store),
      features: store.features().map((f) => ({ ...f, planning_busy: foundry.planning.isBusy(f.id) })),
      issues: store.issues(),
      attempts: store.all("SELECT * FROM attempts ORDER BY id DESC LIMIT 200"),
      runs: store.all("SELECT * FROM runs ORDER BY id DESC LIMIT 200"),
      comments: store.all("SELECT * FROM doc_comments ORDER BY id"),
      docs: store.all("SELECT * FROM feature_docs ORDER BY feature_id, kind"),
      requirements: store.all("SELECT * FROM requirements WHERE retired=0 ORDER BY feature_id, ref"),
      proposals: store.all("SELECT * FROM task_proposals WHERE status IN ('proposed','approved') ORDER BY id DESC LIMIT 50"),
      questions: store.all("SELECT * FROM questions WHERE status IN ('live','waiting') ORDER BY id"),
      verifications: store.all("SELECT * FROM verifications WHERE id IN (SELECT MAX(id) FROM verifications GROUP BY feature_id)"),
      chat: store.all("SELECT * FROM (SELECT * FROM chat ORDER BY id DESC LIMIT 300) ORDER BY id"),
      cards: store.all("SELECT * FROM cards ORDER BY id DESC LIMIT 100"),
      pm_threads: store.all("SELECT project_id, thread, busy, last_turn_at FROM pm_threads"),
      ships: store.all("SELECT key, value FROM settings WHERE key LIKE 'ship:%' AND value<>''"),
      events: store.events({ limit: 200 }),
      onboarding: install.status(),
      dev: devMode,
      safe_mode: null,
    })),
  );
  handle(
    actionRpc,
    withSdk(async ({ action, args }: { action: string; args: Record<string, any> }) => {
      install.requireGates(action);
      switch (action) {
        case "project.create":
          return store.createProject({ key: String(args.key), name: String(args.name ?? args.key), repo: String(args.repo), baseRef: String(args.baseRef ?? "main") });
        case "project.adopt": {
          // The first time a repo is used, the screen shows what Foundry will do there; adopting confirms it.
          if (args.acknowledged !== true)
            throw new FoundryError("ACK_REQUIRED", "Confirm what Foundry will do in this repo first.", { notice: "project" });
          const p = await adoptRepo(store, { repo: String(args.repo ?? ""), name: args.name ? String(args.name) : undefined });
          if (p.created) install.ackProject(p.id);
          return p;
        }
        case "onboarding.dismiss_welcome":
          return install.dismissWelcome();
        case "onboarding.ack_whats_new":
          return install.ackWhatsNew();
        case "onboarding.ack_gate":
          return install.ackGate(String(args.id ?? ""));
        case "setup.check":
          return foundry.runSetupCheck();
        case "setup.harnesses":
          return foundry.harnesses();
        case "setup.create_profiles":
          return foundry.createProfiles(Array.isArray(args.choices) ? args.choices : []);
        case "uninstall.leftovers":
          return foundry.leftovers();
        case "uninstall.stop_work":
          return foundry.stopAllWork();
        case "uninstall.remove_profiles":
          return foundry.removeOwnProfiles(Array.isArray(args.ids) ? args.ids.map(String) : []);
        case "uninstall.delete_data": {
          // Typed confirmation: the data folder's name. A final copy is kept beside the folder unless you say not to.
          if (args.confirm !== basename(home))
            throw new FoundryError("CONFIRM_REQUIRED", `Type ${basename(home)} to confirm deleting Foundry's data in ${home}.`);
          let backup: string | null = null;
          if (args.keepBackup !== false) {
            const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
            backup = join(dirname(home), `${basename(home)}-final-backup-${stamp}.db`);
            store.copyTo(backup);
          }
          foundry.stop();
          store.close();
          rmSync(home, { recursive: true, force: true });
          deleted = home;
          return { deleted: home, backup };
        }
        case "dev.reset_plan":
          if (!devMode) throw new FoundryError("UNKNOWN_ACTION", `Unknown action ${action}`);
          return foundry.devResetPlan();
        case "dev.reset": {
          if (!devMode) throw new FoundryError("UNKNOWN_ACTION", `Unknown action ${action}`);
          if (args.confirm !== "reset") throw new FoundryError("CONFIRM_REQUIRED", 'Pass {"confirm":"reset"} to wipe Foundry back to a fresh install.');
          const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
          const r = await foundry.devReset(join(tmpdir(), `foundry-reset-${stamp}.db`));
          // Reload so every part of Foundry starts again from the empty database, as on a first install.
          setTimeout(() => void adapter.reloadSelf().catch(() => {}), 300);
          return r;
        }
        case "issue.start":
          return foundry.startIssue(String(args.key));
        case "issue.accept":
          return foundry.accept(String(args.key), String(args.head_sha), String(args.tree_sha), "you", String(args.feedback ?? ""));
        case "issue.rework":
          return foundry.tasks.rework(String(args.key), String(args.head_sha), String(args.tree_sha), String(args.feedback ?? ""));
        case "issue.review":
          return foundry.tasks.review(String(args.key));
        case "issue.followup":
          return foundry.tasks.followUp(String(args.key), String(args.text ?? ""));
        case "feature.create":
          return foundry.planning.createFeature({
            projectId: Number(args.project_id ?? store.projectByKey(String(args.project))?.id),
            idea: String(args.idea ?? ""),
            title: args.title ? String(args.title) : undefined,
            flow: args.flow,
            grill: args.grill ?? null,
          });
        case "feature.doc":
          return foundry.planning.readDoc(Number(args.id), args.kind);
        case "feature.answer":
          return foundry.planning.answer(Number(args.id), args.answers ?? {});
        case "feature.approve_spec":
          return foundry.planning.approveSpec(Number(args.id), String(args.sha));
        case "feature.approve_plan":
          return foundry.planning.approvePlan(Number(args.id), String(args.sha));
        case "feature.approve_tasks":
          return foundry.planning.approveTasks(Number(args.id), Number(args.proposal), String(args.sha), "you", { spec: args.spec_sha, plan: args.plan_sha });
        case "feature.cut_task":
          return foundry.planning.cutTask(Number(args.id), String(args.ref), args.cut !== false);
        case "feature.revise":
          return foundry.planning.revise(Number(args.id), args.kind, String(args.note ?? ""), "you", (args.comments ?? []).map(Number));
        case "feature.comment":
          return foundry.planning.comment(Number(args.id), args.kind, String(args.sha ?? ""), Number(args.line), String(args.body ?? ""));
        case "feature.delete_comment":
          return foundry.planning.deleteComment(Number(args.comment));
        case "feature.revisions":
          return { revisions: await foundry.planning.revisions(Number(args.id), args.kind) };
        case "feature.doc_diff":
          return foundry.planning.docDiff(Number(args.id), args.kind, String(args.from ?? ""), String(args.to ?? ""));
        case "feature.edit_doc":
          return foundry.planning.editDoc(Number(args.id), args.kind, String(args.text ?? ""), String(args.base_sha ?? ""));
        case "feature.discard_change":
          return foundry.planning.discardChange(Number(args.id));
        case "feature.retry":
          return foundry.planning.retry(Number(args.id));
        case "feature.pause":
          return foundry.planning.setStatus(Number(args.id), "paused");
        case "feature.resume":
          return foundry.planning.setStatus(Number(args.id), "active");
        case "feature.cancel":
          return foundry.planning.setStatus(Number(args.id), "cancelled");
        case "feature.verify":
          return foundry.delivery.verify(Number(args.id), "you", args.force === true);
        case "feature.ship_with_gaps":
          return foundry.delivery.shipWithGaps(Number(args.id));
        case "feature.task_from_failure":
          return foundry.delivery.taskFromFailure(Number(args.id), String(args.title ?? ""), String(args.description ?? ""), Array.isArray(args.requirement_refs) ? args.requirement_refs.map(String) : []);
        case "feature.prepare_ship":
          return foundry.delivery.prepare(Number(args.id));
        case "feature.accept_ship":
          return foundry.delivery.acceptShip(Number(args.id), String(args.head_sha), String(args.tree_sha), { confirmCheckedOut: args.confirm === true });
        case "pm.send": {
          const p = typeof args.project === "string" && isNaN(Number(args.project)) ? store.projectByKey(args.project) : store.project(Number(args.project));
          if (!p) throw new FoundryError("NOT_FOUND", `No project ${args.project}`);
          return foundry.pm.send(p.id, String(args.text ?? ""), String(args.thread ?? "main"), {
            ...(args.feature ? { feature: Number(args.feature) } : {}),
            ...(args.issue ? { issue: String(args.issue) } : {}),
          });
        }
        case "card.accept":
          return foundry.pm.accept(Number(args.id));
        case "card.reject":
          return foundry.pm.reject(Number(args.id));
        case "question.answer":
          return foundry.tasks.answer(Number(args.id), String(args.text ?? ""));
        case "dev.seed_feature":
          // Test-only until Loop 1 lands: a feature already planned and approved, with its tasks.
          if (process.env.FOUNDRY_DEV !== "1") throw new FoundryError("UNKNOWN_ACTION", `Unknown action ${action}`);
          return seedFeature(foundry, args as SeedArgs);
        default:
          throw new FoundryError("UNKNOWN_ACTION", `Unknown action ${action}`);
      }
    }),
  );

  let kickTimer: NodeJS.Timeout | null = null;
  const kick = async (attempt = 0): Promise<void> => {
    if (started) return;
    const client = new DaemonClient({
      url: adapterCfg.daemonUrl,
      clientId: `${PLUGIN_ID}-bootstrap-${Date.now()}`,
      clientType: "cli",
      password: process.env.FOUNDRY_DAEMON_PASSWORD,
    } as never);
    try {
      await client.connect();
      await client.invokePluginRpc(PLUGIN_ID, bootstrapRpc.name, {});
    } catch (e) {
      store.event("bootstrap_retry", { detail: { error: String(e), attempt } });
      if (attempt < 40) kickTimer = setTimeout(() => void kick(attempt + 1), 1500);
    } finally {
      await client.close().catch(() => {});
    }
  };
  kickTimer = setTimeout(() => void kick(), 500);

  return async () => {
    if (kickTimer) clearTimeout(kickTimer);
    foundry.stop();
    unsubSettings();
    removeHooks();
    await adapter.close();
    store.close();
  };
}

interface SeedArgs {
  project: string;
  slug: string;
  title: string;
  tasks: { title: string; description?: string; depends_on?: number[] }[];
}

async function seedFeature(foundry: Foundry, a: SeedArgs) {
  const store = foundry.store;
  const p = store.projectByKey(a.project);
  if (!p) throw new FoundryError("NOT_FOUND", `No project ${a.project}`);
  const f = store.createFeature({ projectId: p.id, slug: a.slug, title: a.title, idea: a.title, flow: "standard", branch: "" });
  for (const d of store.docs(f.id)) store.updateDoc(f.id, d.kind, { status: "approved" });
  await foundry.ensureIntegration(f.id);
  const keys = store.tx(() => {
    const keys: string[] = [];
    for (const t of a.tasks) {
      const deps = (t.depends_on ?? []).map((n) => keys[n]!);
      const i = store.createIssue({ projectId: p.id, featureId: f.id, origin: "feature", title: t.title, description: t.description ?? "", status: deps.length ? "Backlog" : "Ready" });
      for (const d of deps) store.addDep(i.key, d);
      keys.push(i.key);
    }
    store.setStage(f.id, "build", "you");
    return keys;
  });
  return { feature: store.feature(f.id), issues: keys };
}

/** Foundry couldn't open its database. Nothing was changed; the screens show why and how to recover. */
function safeMode(server: PluginServerContext, home: string, e: FoundryError) {
  let backups: string[] = [];
  try {
    backups = readdirSync(home).filter((f) => f.startsWith("foundry.db.backup-")).sort().reverse();
  } catch {}
  const info = { code: e.code, message: e.message, home, backup: backups[0] ? join(home, backups[0]) : null };
  const refuse = { error: { code: "STORE_SAFE_MODE", message: `Foundry is in safe mode: ${e.message}`, detail: info } };
  const handle = server.handle.bind(server) as (c: unknown, h: (i: any, ctx: PluginHandlerContext) => unknown) => void;
  handle(bootstrapRpc, () => ({ ok: true }));
  handle(setupRpc, () => ({ at: new Date().toISOString(), findings: [{ level: "error", code: "STORE_SAFE_MODE", message: e.message }] }));
  handle(stateRpc, () => ({ safe_mode: info, projects: [], features: [], issues: [], overview: { buckets: {}, rows: [] } }));
  handle(actionRpc, () => refuse);
  return () => {};
}
