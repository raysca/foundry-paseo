// What changed in each Foundry version, newest first. Foundry shows the entries newer than what you last
// saw in a one-time What's new card after an update. An entry with a `gate` changes how actions that
// touch your code behave: those actions are refused (ACK_REQUIRED) until you press Got it.
export interface Change {
  version: string;
  notes: string[];
  gate?: { id: string; text: string; actions: string[] };
}

export const CHANGES: Change[] = [
  {
    version: "0.2.0",
    notes: [
      "A welcome wizard sets Foundry up: pick the harness and model for each of Foundry's agent profiles, then a project.",
      "Foundry shows what it will do in a repo the first time you use it there.",
      "Updates now show this card once, and Foundry starts in safe mode instead of failing if its database can't be upgraded.",
    ],
  },
  {
    version: "0.1.0",
    notes: ["Milestone 1: features, specs, plans, the task loop, verify and ship, and the project manager."],
  },
];

/** The running Foundry version: the newest entry above. Paseo's bundler can't read package.json, so a test
 *  keeps the two in step. */
export const VERSION = CHANGES[0]!.version;
