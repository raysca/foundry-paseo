// Foundry's server entry: wires the store, the Paseo adapter, settings, hooks and plugin RPC.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { Store } from "./server/core/store";
import { Foundry } from "./server/core/foundry";
import { FoundryError } from "./server/core/model";
import { PaseoAdapter, type AdapterConfig } from "./server/adapter/paseo";
import { buildTools } from "./server/adapter/tools";
import { actionRpc, bootstrapRpc, setupRpc, stateRpc } from "./shared/rpc";
import { foundrySettings, type FoundrySettings } from "./shared/settings";

type PaseoApi = PluginHandlerContext["paseo"];
const PLUGIN_ID = "foundry";

export default function contribute(server: PluginServerContext) {
  const home = process.env.FOUNDRY_HOME ?? join(homedir(), ".foundry");
  const store = new Store(join(home, "foundry.db"));

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
  const foundry = new Foundry(store, adapter, { home });
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
  const withSdk = <I, O>(fn: (input: I) => Promise<O> | O) => async (input: I, ctx: PluginHandlerContext) => {
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
      features: store.features(),
      issues: store.issues(),
      events: store.events({ limit: 200 }),
    })),
  );
  handle(
    actionRpc,
    withSdk(async ({ action, args }: { action: string; args: Record<string, any> }) => {
      switch (action) {
        case "project.create":
          return store.createProject({ key: String(args.key), name: String(args.name ?? args.key), repo: String(args.repo), baseRef: String(args.baseRef ?? "main") });
        case "setup.check":
          return foundry.runSetupCheck();
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
    unsubSettings();
    removeHooks();
    await adapter.close();
    store.close();
  };
}
