// Settings → Foundry: the setup check first (what is missing and how to fix it), then Foundry's few settings.
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { actionRpc, setupRpc, stateRpc } from "../shared/rpc";
import { foundrySettings } from "../shared/settings";
import { BeforeUninstall } from "./uninstall";

type Finding = { level: "ok" | "info" | "warn" | "error"; code: string; message: string; fix?: string };
const MARK: Record<Finding["level"], string> = { ok: "OK", info: "Note", warn: "Check", error: "Fix" };

export function FoundrySettingsScreen(_: PluginSurfaceProps) {
  const setup = useRpc(setupRpc);
  const action = useRpc(actionRpc);
  const state = useRpc(stateRpc);
  const dev = useQuery({ queryKey: ["foundry-dev"], queryFn: async () => Boolean(((await state({})) as any)?.dev) });
  const [reset, setReset] = useState<"idle" | "confirm" | "running" | string>("idle");
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
          <Text style={{ paddingVertical: 6 }}>Missing profiles are set up in the welcome guide on Foundry's home screen (Foundry in the sidebar).</Text>
        ) : null}
        <SettingsAction
          label={check.isFetching ? "Checking" : "Roles come from Paseo agent profiles named foundry-builder, foundry-reviewer, foundry-planner and foundry-pm"}
          actionLabel="Check again"
          onPress={() => void qc.invalidateQueries({ queryKey: ["foundry-setup"] })}
        />
      </SettingsSection>
      {dev.data ? (
        <SettingsSection title="Development">
          <SettingsAction
            label={
              reset === "idle"
                ? "Reset Foundry to a fresh install: archive its workspaces, remove the foundry-* profiles, back up and empty its data, reload."
                : reset === "confirm"
                  ? "Press again to reset. The data is copied to /tmp first."
                  : reset === "running"
                    ? "Resetting…"
                    : reset
            }
            actionLabel={reset === "confirm" ? "Really reset" : "Reset Foundry"}
            disabled={reset === "running"}
            onPress={() => {
              if (reset !== "confirm") return setReset("confirm");
              setReset("running");
              void (action({ action: "dev.reset", args: { confirm: "reset" } }) as Promise<any>)
                .then((r) => setReset(r?.error ? `${r.error.code}: ${r.error.message}` : `Reset. Backup: ${r.backup}. Foundry is reloading.`))
                .catch((e) => setReset(String(e?.message ?? e)));
            }}
          />
        </SettingsSection>
      ) : null}
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
          <SettingsInput
            label="Stop a silent agent turn after (minutes, 0 = never)"
            initialValue={String(st.values.idleMinutes)}
            onChangeText={(t) => setDraft((d) => ({ ...d, idleMinutes: Number(t) }))}
          />
          <SettingsInput
            label="Stop an agent turn running longer than (minutes, 0 = never)"
            initialValue={String(st.values.turnMinutes)}
            onChangeText={(t) => setDraft((d) => ({ ...d, turnMinutes: Number(t) }))}
          />
          <SettingsInput
            label="Automatic retries before a task is Blocked"
            initialValue={String(st.values.retries)}
            onChangeText={(t) => setDraft((d) => ({ ...d, retries: Number(t) }))}
          />
          <SettingsInput
            label="First retry after (seconds, doubles each time)"
            initialValue={String(st.values.retryBackoffSeconds)}
            onChangeText={(t) => setDraft((d) => ({ ...d, retryBackoffSeconds: Number(t) }))}
          />
          <SettingsAction
            label={st.saveError ?? "Applies to new attempts"}
            actionLabel={st.saving ? "Saving" : "Save"}
            disabled={st.saving}
            onPress={() => void st.save({ ...st.values, ...draft } as never, st.revision).then((ok) => ok && setDraft({}))}
          />
        </SettingsSection>
      ) : null}
      <BeforeUninstall />
    </View>
  );
}
