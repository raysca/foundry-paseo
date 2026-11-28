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
    version: "0.5.0",
    notes: [
      "Task loops for each kind of work: backend, frontend, bugfix (reproduce the bug with a test first) and docs (no project checks, only the task's own). The project manager picks one for each task; change it on the proposed task list, or on a task that isn't running. Set the project's default loop on the project page.",
      "Your own loops: a .foundry/loops/<name>.yaml file on base adds a loop with the same steps and rules as the built-ins. A file that doesn't validate is listed on the project page with what's wrong.",
      "Bug fixes are reproduced: on the bugfix loop Foundry runs the new test with the fix reverted (it must fail) and with it (it must pass), and shows both runs at review. A fix without a test, or with a test that passes anyway, goes back to the builder, then comes to you flagged REPRO_FAILED.",
      "Page checks: on the frontend loop Foundry starts your paseo.json service, runs your \"page-check\" script against it (it gets FOUNDRY_PAGE_URL, FOUNDRY_PAGES and FOUNDRY_SCREENSHOTS) and shows the screenshots it saves at review. Your script owns the browser. A project without a service or a page-check script skips the step; a failing page check goes back to the builder, then comes to you flagged PAGE_CHECK_FAILED.",
      "Supervision: a builder or reviewer turn that goes silent for 15 minutes, or runs for an hour, is interrupted (and stopped if it doesn't end). Time spent waiting on your answer or on a Paseo permission card doesn't count, and the board shows \"waiting on permission in Paseo\". A timeout, an infrastructure error or a failed turn is retried automatically, twice by default with a growing wait, then the task is Blocked. Change the limits in Foundry's settings.",
      "After repeated infrastructure failures Foundry pauses auto-start and says so on the project page; resume it there once Paseo is fixed. You can still start tasks yourself.",
    ],
  },
  {
    version: "0.4.0",
    notes: [
      "Ship by GitHub pull request: Prepare pushes the feature branch and opens a PR with gh when the repo has a remote. Foundry checks the PR every 5 minutes, moves the feature to Done when it merges, and verifies again when new commits arrive. Projects you already had keep merging locally; change it on the project page.",
      "Edit the spec of a feature in Verify, Ship or Done. In Verify or Ship, approving the change set sends the feature back to Build when tasks changed, or straight to Verify. A Done feature reopens on a new branch from base (shout-mode-r2), and only what changed becomes new tasks.",
      "A task the spec changed under is flagged at review: accept it as is, rework it with a drafted message naming the new requirements, or cancel it.",
      "Filter the features list by bucket, status and spec changed.",
      "Slices: the project manager can group a bigger feature's tasks into slices that ship in order. The task list shows them, and you can move tasks between slices, reorder them or merge them before you approve. A slice or feature over the size budget gets a warning. Features you already have become one-slice features.",
      "Each slice builds, verifies and ships on its own: when a slice reaches Ship the next one starts building on top of it, its PR is stacked on the one before and retargeted at base when that merges, and the Merge order panel on the feature shows where every slice stands. A spec change puts new work in an open slice, or a new one at the end.",
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
