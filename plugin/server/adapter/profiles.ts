// Onboarding: the Paseo config patches that add Foundry's agent profiles and providers, and that take
// them away again. Pure, so they are tested directly. Paseo merges `providers` by key but replaces
// `agentProfiles` as a whole, so a patch carries every existing profile untouched. Nothing existing is
// changed: a profile or provider that is already there is left as it is.
import PASEO_TOOLS_OFF from "./paseo-tools.json";
import type { ProfileChoice } from "../core/host";
import { profileId } from "../core/setup";

type Config = { providers?: Record<string, unknown> | null; agentProfiles?: readonly { id: string }[] | null };
export type Created = { kind: "profile" | "provider"; id: string; value: unknown };

export const providerFor = (harness: string) => `foundry-${harness}`;

export function profilesPatch(config: Config, choices: readonly ProfileChoice[]): { patch: Record<string, unknown>; added: string[]; created: Created[] } {
  const created: Created[] = [];
  const providers: Record<string, unknown> = {};
  const existing = [...(config.agentProfiles ?? [])];
  const fresh: { id: string; name: string; provider: string; model: string }[] = [];
  for (const c of choices) {
    const id = profileId(c.role);
    if (existing.some((p) => p.id === id) || fresh.some((p) => p.id === id)) continue;
    const provider = providerFor(c.harness);
    if (!(config.providers ?? {})[provider] && !providers[provider]) {
      // Paseo's own orchestration tools off, so Foundry's agents can't start agents or answer permissions.
      providers[provider] = { extends: c.harness, label: `Foundry ${c.harness}`, paseoTools: { disabledTools: [...PASEO_TOOLS_OFF] } };
      created.push({ kind: "provider", id: provider, value: providers[provider] });
    }
    const profile = { id, name: `Foundry ${c.role}`, provider, model: c.model };
    fresh.push(profile);
    created.push({ kind: "profile", id, value: profile });
  }
  const patch: Record<string, unknown> = {};
  if (Object.keys(providers).length) patch.providers = providers;
  if (fresh.length) patch.agentProfiles = [...existing, ...fresh];
  const added = created.map((c) => (c.kind === "provider" ? `provider ${c.id}` : `${c.id} (${(c.value as { model: string }).model})`));
  return { patch, added, created };
}

/** Removes the named profiles, keeping every other profile untouched. (Paseo can't delete a provider entry
 *  through a patch; Foundry's providers stay and are reused. Upstream ask.) */
export function removeProfilesPatch(config: Config, ids: readonly string[]): { patch: Record<string, unknown>; removed: string[] } {
  const existing = [...(config.agentProfiles ?? [])];
  const removed = existing.filter((p) => ids.includes(p.id)).map((p) => p.id);
  return removed.length ? { patch: { agentProfiles: existing.filter((p) => !ids.includes(p.id)) }, removed } : { patch: {}, removed };
}
