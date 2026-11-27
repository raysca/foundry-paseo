// Setup check, run on start and on demand. Pure: it judges the host's facts and returns findings.
// Foundry refuses to start work while any finding is an error, and says how to fix it.
import type { HostFacts, HostProfile } from "./host";
import type { Role } from "./model";

export type FindingLevel = "ok" | "info" | "warn" | "error";

export interface Finding {
  level: FindingLevel;
  code: string;
  message: string;
  fix?: string;
}

/** Paseo's own orchestration tools. A Foundry agent must have none of them (it could start agents or answer permissions). */
export const PASEO_ORCHESTRATION_TOOLS = [
  "archive_agent",
  "archive_workspace",
  "cancel_agent",
  "create_agent",
  "create_heartbeat",
  "create_schedule",
  "create_terminal",
  "create_workspace",
  "kill_agent",
  "kill_terminal",
  "respond_to_permission",
  "send_agent_prompt",
  "send_terminal_keys",
  "set_agent_mode",
  "start_workspace_script",
  "stop_workspace_script",
  "update_agent",
];

export const REQUIRED_ROLES: Role[] = ["builder", "reviewer", "pm"];

export function profileId(role: Role) {
  return `foundry-${role}`;
}

/** The profile a role runs on: its own, or for the planner the PM's when it has none. */
export function roleProfile(profiles: HostProfile[], role: Role): HostProfile | null {
  const own = profiles.find((p) => p.id === profileId(role));
  if (own) return own;
  if (role === "planner") return profiles.find((p) => p.id === profileId("pm")) ?? null;
  return null;
}

export function checkSetup(facts: HostFacts): Finding[] {
  const out: Finding[] = [];

  // Script exit codes reach Paseo only through its zsh shell integration (scorecard: upstream ask).
  if (facts.shell === null) {
    out.push({ level: "warn", code: "SHELL_UNKNOWN", message: "Could not tell which shell the Paseo daemon uses." });
  } else if (!/(^|\/)zsh$/.test(facts.shell)) {
    out.push({
      level: "error",
      code: "SHELL_NOT_ZSH",
      message: `The Paseo daemon runs with SHELL=${facts.shell}. Paseo reports a script's exit code only under zsh, so checks would never finish.`,
      fix: "Start the Paseo daemon with SHELL set to zsh (the macOS default).",
    });
  } else {
    out.push({ level: "ok", code: "SHELL_OK", message: "The daemon shell is zsh." });
  }

  // Foundry's tools reach agents through Paseo's MCP injection.
  if (facts.mcpInjectIntoAgents === false) {
    out.push({
      level: "error",
      code: "MCP_INJECTION_OFF",
      message: "Paseo's MCP injection is off, so Foundry's tools (ask_human, report_verdict, ...) can't reach its agents.",
      fix: 'Set daemon.mcp.enabled and daemon.mcp.injectIntoAgents to true in Paseo\'s config.',
    });
  } else if (facts.mcpInjectIntoAgents === null) {
    out.push({ level: "warn", code: "MCP_INJECTION_UNKNOWN", message: "Could not read whether Paseo injects MCP tools into agents." });
  }

  if (facts.profiles === null) {
    out.push({ level: "error", code: "PROFILES_UNREADABLE", message: "Could not read Paseo's agent profiles." });
    return out;
  }

  for (const role of [...REQUIRED_ROLES, "planner" as Role]) {
    const own = facts.profiles.find((p) => p.id === profileId(role));
    const used = roleProfile(facts.profiles, role);
    if (!used) {
      out.push({
        level: "error",
        code: "PROFILE_MISSING",
        message: `No Paseo agent profile "${profileId(role)}". Foundry's ${role} runs on it.`,
        fix: `Add an agent profile with id "${profileId(role)}" in Paseo's settings.`,
      });
      continue;
    }
    if (!own && role === "planner") {
      out.push({
        level: "info",
        code: "PLANNER_FALLBACK",
        message: `No "${profileId("planner")}" profile; planning turns use "${used.id}".`,
      });
    }
    if (!own) continue;
    if (!used.model && !used.provider.includes("/")) {
      out.push({
        level: "error",
        code: "PROFILE_NO_MODEL",
        message: `Profile "${used.id}" names provider "${used.provider}" with no model. Paseo needs provider/model and fails silently without it.`,
        fix: `Set a model on "${used.id}".`,
      });
    }
    const providerId = used.provider.split("/")[0]!;
    const provider = facts.providers?.[providerId];
    if (facts.providers && provider) {
      const disabled = new Set(provider.disabledTools ?? []);
      const open = PASEO_ORCHESTRATION_TOOLS.filter((t) => !disabled.has(t));
      if (open.length) {
        out.push({
          level: "error",
          code: "PROVIDER_TOOLS_OPEN",
          message: `Provider "${providerId}" (used by "${used.id}") gives agents Paseo's ${open.slice(0, 3).join(", ")}${open.length > 3 ? ` and ${open.length - 3} more` : ""}. A Foundry agent could start agents or answer permissions.`,
          fix: `Use a provider like foundry-claude that extends the harness with paseoTools.disabledTools listing Paseo's orchestration tools.`,
        });
      }
    } else if (facts.providers && !provider && !providerId.startsWith("foundry-")) {
      out.push({
        level: "warn",
        code: "PROVIDER_NOT_FOUNDRY",
        message: `Profile "${used.id}" uses provider "${providerId}", which isn't one of Foundry's providers, so its agents may get Paseo's own tools.`,
        fix: `Point "${used.id}" at a foundry-<harness> provider.`,
      });
    }
  }

  if (!out.some((f) => f.level === "error")) out.push({ level: "ok", code: "READY", message: "Foundry is ready to run work." });
  return out;
}

export function setupReady(findings: Finding[]) {
  return !findings.some((f) => f.level === "error");
}
