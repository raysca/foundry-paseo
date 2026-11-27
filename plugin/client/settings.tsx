// Settings → Foundry: the setup check first (what is missing and how to fix it), then Foundry's few settings.
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { actionRpc, setupRpc } from "../shared/rpc";
import { foundrySettings } from "../shared/settings";

type Finding = { level: "ok" | "info" | "warn" | "error"; code: string; message: string; fix?: string };
const MARK: Record<Finding["level"], string> = { ok: "OK", info: "Note", warn: "Check", error: "Fix" };

export function FoundrySettingsScreen(_: PluginSurfaceProps) {
  const setup = useRpc(setupRpc);
  const action = useRpc(actionRpc);
  const [creating, setCreating] = useState<string | null>(null);
  const qc = useQueryClient();
  const check = useQuery({ queryKey: ["foundry-setup"], queryFn: () => setup({}) as Promise<{ findings: Finding[] }> });
  const st = useSettings(foundrySettings);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const findings = check.data?.findings ?? [];
  return (
    <View>
      <SettingsSection title="Setup check">
        {findings.map((f) => (
          <View key={f.code} style={{ paddingVertical: 6 }}>
            <Text>
              {MARK[f.level]}: {f.message}
            </Text>
            {f.fix ? <Text style={{ opacity: 0.7 }}>{f.fix}</Text> : null}
          </View>
        ))}
        {findings.some((f) => f.code === "PROFILE_MISSING") ? (
          <SettingsAction
            label={creating ?? "Adds only the missing foundry-* profiles and the foundry-claude provider. Existing profiles are never changed."}
            actionLabel="Create Foundry's profiles"
            disabled={creating === "Creating…"}
            onPress={() => {
              setCreating("Creating…");
              void (action({ action: "setup.create_profiles", args: {} }) as Promise<any>)
                .then((r) => setCreating(r?.error ? `${r.error.code}: ${r.error.message}` : `Added: ${(r?.added ?? []).join(", ") || "nothing"}`))
                .catch((e) => setCreating(String(e?.message ?? e)))
                .finally(() => void qc.invalidateQueries({ queryKey: ["foundry-setup"] }));
            }}
          />
        ) : null}
        <SettingsAction
          label={check.isFetching ? "Checking" : "Roles come from Paseo agent profiles named foundry-builder, foundry-reviewer, foundry-planner and foundry-pm"}
          actionLabel="Check again"
          onPress={() => void qc.invalidateQueries({ queryKey: ["foundry-setup"] })}
        />
      </SettingsSection>
      {st.status === "ready" ? (
        <SettingsSection title="Task loop">
          <SettingsInput
            label="Fix rounds per check step (default)"
            initialValue={String(st.values.maxFixRounds)}
            onChangeText={(t) => setDraft((d) => ({ ...d, maxFixRounds: Number(t) }))}
          />
          <SettingsInput
            label="Live question window (seconds)"
            initialValue={String(st.values.questionWindowSeconds)}
            onChangeText={(t) => setDraft((d) => ({ ...d, questionWindowSeconds: Number(t) }))}
          />
          <SettingsAction
            label={st.saveError ?? "Applies to new attempts"}
            actionLabel={st.saving ? "Saving" : "Save"}
            disabled={st.saving}
            onPress={() => void st.save({ ...st.values, ...draft } as never, st.revision).then((ok) => ok && setDraft({}))}
          />
        </SettingsSection>
      ) : null}
    </View>
  );
}
