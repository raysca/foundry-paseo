// Foundry's plugin RPC. The client screens, the e2e kit and Foundry itself (loopback bootstrap) all
// drive Foundry through these; the plugin opens no port of its own.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const anyJson = z.any();

/** Foundry calls this on itself at start so the handler hands it the plugin SDK (scorecard: SDK outside handlers). */
export const bootstrapRpc = defineRpc({ name: "foundry.bootstrap", input: z.object({}), output: anyJson });
/** Run the setup check now and return its findings. */
export const setupRpc = defineRpc({ name: "foundry.setup", input: z.object({}), output: anyJson });
/** A snapshot of Foundry's state, for screens and tests. */
export const stateRpc = defineRpc({ name: "foundry.state", input: z.object({}), output: anyJson });
/** One named action with arguments. Every action re-checks its own rules. */
export const actionRpc = defineRpc({
  name: "foundry.action",
  input: z.object({ action: z.string(), args: z.record(z.string(), z.any()) }),
  output: anyJson,
});
