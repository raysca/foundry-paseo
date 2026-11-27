#!/usr/bin/env node
// Drive Foundry over Paseo plugin RPC (no side ports). Used by the e2e kit and for poking at a daemon.
//   foundry.mjs state | setup | act <action> '<json args>'
// FOUNDRY_DAEMON_URL selects the daemon (default ws://127.0.0.1:6767/ws).
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const [cmd, action, raw] = process.argv.slice(2);
const url = process.env.FOUNDRY_DAEMON_URL ?? "ws://127.0.0.1:6767/ws";
const client = new DaemonClient({ url, clientId: `foundry-cli-${process.pid}`, clientType: "cli", password: process.env.FOUNDRY_DAEMON_PASSWORD });
await client.connect();
try {
  let out;
  if (cmd === "state") out = await client.invokePluginRpc("foundry", "foundry.state", {});
  else if (cmd === "setup") out = await client.invokePluginRpc("foundry", "foundry.setup", {});
  else if (cmd === "act") out = await client.invokePluginRpc("foundry", "foundry.action", { action, args: raw ? JSON.parse(raw) : {} });
  else throw new Error("usage: foundry.mjs state | setup | act <action> '<json>'");
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
} finally {
  await client.close();
}
