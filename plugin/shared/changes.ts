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
    version: "0.4.0",
    notes: [
      "Ship by GitHub pull request: Prepare pushes the feature branch and opens a PR with gh when the repo has a remote. Foundry checks the PR every 5 minutes, moves the feature to Done when it merges, and verifies again when new commits arrive. Projects you already had keep merging locally; change it on the project page.",
      "Edit the spec of a feature in Verify, Ship or Done. In Verify or Ship, approving the change set sends the feature back to Build when tasks changed, or straight to Verify. A Done feature reopens on a new branch from base (shout-mode-r2), and only what changed becomes new tasks.",
      "A task the spec changed under is flagged at review: accept it as is, rework it with a drafted message naming the new requirements, or cancel it.",
      "Filter the features list by bucket, status and spec changed.",
      "Slices: the project manager can group a bigger feature's tasks into slices that ship in order. The task list shows them, and you can move tasks between slices, reorder them or merge them before you approve. A slice or feature over the size budget gets a warning. Features you already have become one-slice features.",
    ],
  },
  {
    version: "0.3.0",
    notes: [
      "Quick flow: pick it when you create a feature, and the project manager writes the spec, plan and task list in one turn. You approve all three at once.",
      "Comment on lines of a spec, plan or task list, then send your comments with a revision request. The project manager can comment back, you resolve comments when they are dealt with, and a comment follows its line to the next revision when that line is unchanged. Approve warns you while comments are still open.",
      "Each doc lists its revisions and shows the diff between any two.",
      "Paseo now names the branches of Foundry's workspaces (for example shout-mode or sht-1) instead of Foundry's own foundry/... names.",
    ],
  },
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
