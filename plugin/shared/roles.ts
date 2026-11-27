// Foundry's agent profiles as the onboarding wizard shows them.
export const PROFILE_ROLES = [
  { role: "builder", id: "foundry-builder", name: "Builder", does: "Writes the code for one task in its own workspace, then runs the project's checks." },
  { role: "reviewer", id: "foundry-reviewer", name: "Reviewer", does: "Reads each task's change against the spec and passes it or sends it back with feedback." },
  { role: "planner", id: "foundry-planner", name: "Planner", does: "Turns your idea into a spec, a plan and a task list, asking you questions on the way." },
  { role: "pm", id: "foundry-pm", name: "Project manager", does: "Answers questions about the board in the project chat and suggests what to do next." },
] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number]["role"];
