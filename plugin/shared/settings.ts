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
    /** A builder or reviewer turn with no activity this long is stopped (Paseo has no turn timeout). 0 turns it off. */
    idleMinutes: z.number().int().min(0).max(240).default(15),
    /** A turn running this long is stopped, not counting time waiting on you. 0 turns it off. */
    turnMinutes: z.number().int().min(0).max(1440).default(60),
    /** Automatic retries after a timeout, an infrastructure error or a failed turn, before the task is Blocked. */
    retries: z.number().int().min(0).max(5).default(2),
    /** The first retry's delay; each later retry waits twice as long. */
    retryBackoffSeconds: z.number().int().min(5).max(3600).default(60),
  }),
});
export type FoundrySettings = z.infer<(typeof foundrySettings)["schema"]>;
