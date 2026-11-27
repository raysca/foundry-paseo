// Onboarding: the Paseo config patch that adds Foundry's missing agent profiles and provider. Pure, so it
// is tested directly. Paseo merges `providers` by key but replaces `agentProfiles` as a whole, so the
// patch carries every existing profile untouched followed by the new ones. Nothing existing is changed.
import PASEO_TOOLS_OFF from "./paseo-tools.json";
import type { Role } from "../core/model";
import { profileId } from "../core/setup";

export type ProfileOptions = { harness: string; workModel: string; pmModel: string };
type Config = { providers?: Record<string, unknown> | null; agentProfiles?: readonly { id: string }[] | null };

export function missingProfilesPatch(config: Config, o: ProfileOptions): { patch: Record<string, unknown>; added: string[] } {
  const added: string[] = [];
  const patch: Record<string, unknown> = {};
  const provider = `foundry-${o.harness}`;
  if (!(config.providers ?? {})[provider]) {
    // Paseo's own orchestration tools off, so Foundry's agents can't start agents or answer permissions.
    patch.providers = { [provider]: { extends: o.harness, label: `Foundry ${o.harness}`, paseoTools: { disabledTools: [...PASEO_TOOLS_OFF] } } };
    added.push(`provider ${provider}`);
  }
  const existing = [...(config.agentProfiles ?? [])];
  const missing = (["builder", "reviewer", "planner", "pm"] as Role[])
    .filter((r) => !existing.some((p) => p.id === profileId(r)))
    .map((r) => ({ id: profileId(r), name: `Foundry ${r}`, provider, model: r === "pm" || r === "planner" ? o.pmModel : o.workModel }));
  if (missing.length) {
    patch.agentProfiles = [...existing, ...missing];
    added.push(...missing.map((p) => `${p.id} (${p.model})`));
  }
  return { patch, added };
}
