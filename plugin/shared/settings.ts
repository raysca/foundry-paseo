import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Foundry's own settings (Settings → Plugins → Foundry). Deliberately few: roles come from Paseo agent
 * profiles named foundry-builder, foundry-reviewer, foundry-planner and foundry-pm; checks and setup
 * come from paseo.json; concurrency is Paseo's.
 */
export const foundrySettings = defineSettings({
  id: "foundry",
  scope: "host",
  version: 1,
  schema: z.object({
    /** How the plugin reaches its own daemon for calls the plugin SDK lacks (paseo.json scripts). */
    daemonUrl: z.string().default("ws://127.0.0.1:6767/ws"),
    /** Fix rounds per check step when neither the loop nor the issue sets one. */
    maxFixRounds: z.number().int().min(0).max(10).default(2),
    /** How long ask_human waits live before the agent is told to end its turn. */
    questionWindowSeconds: z.number().int().min(10).max(600).default(600),
  }),
});
export type FoundrySettings = z.infer<(typeof foundrySettings)["schema"]>;
