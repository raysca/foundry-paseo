// Settings → Foundry → Before you uninstall: what Foundry left behind, each with its own action. Paseo
// doesn't tell a plugin it is being uninstalled, so nothing here happens by itself.
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { actionRpc } from "../shared/rpc";

type Leftovers = {
  workspaces: string[];
  profiles: { id: string; state: "unedited" | "edited" | "gone"; model: string | null }[];
  providers: string[];
  branches: { project: string; repo: string; branches: string[] }[];
  data: { home: string; files: { name: string; bytes: number }[] };
};

const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1e3)} KB`);
const folderName = (home: string) => home.split(/[\\/]/).filter(Boolean).pop() ?? home;

export function BeforeUninstall() {
  const action = useRpc(actionRpc);
  const qc = useQueryClient();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await action({ action: name, args })) as any;
    if (r?.error) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r;
  };
  const q = useQuery({ queryKey: ["foundry-leftovers"], queryFn: () => call("uninstall.leftovers") as Promise<Leftovers> });
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState("");
  const [keepBackup, setKeepBackup] = useState(true);
  const run = (key: string, name: string, args: Record<string, unknown>, done: (r: any) => string) => {
    setMsg((m) => ({ ...m, [key]: "Working…" }));
    void call(name, args)
      .then((r) => setMsg((m) => ({ ...m, [key]: done(r) })))
      .catch((e) => setMsg((m) => ({ ...m, [key]: String(e?.message ?? e) })))
      .finally(() => void qc.invalidateQueries({ queryKey: ["foundry-leftovers"] }));
  };
  const l = q.data;
  if (!l) return <SettingsSection title="Before you uninstall"><Text>{q.error ? String(q.error) : "Looking at what Foundry left behind…"}</Text></SettingsSection>;
  const removable = l.profiles.filter((p) => p.state === "unedited");
  const edited = l.profiles.filter((p) => p.state === "edited");
  const total = l.data.files.reduce((n, f) => n + f.bytes, 0);
  const name = folderName(l.data.home);
  return (
    <SettingsSection title="Before you uninstall">
      <Text style={{ paddingVertical: 6 }}>
        Uninstalling Foundry deletes nothing by itself, so reinstalling picks up where you left off. To clean up, use these first, in order.
      </Text>
      <SettingsAction
        label={msg.stop ?? (l.workspaces.length ? `${l.workspaces.length} Paseo workspaces made by Foundry. Stopping archives them; Paseo removes their worktrees.` : "No Foundry workspaces.")}
        actionLabel="Stop all Foundry work"
        disabled={!l.workspaces.length}
        onPress={() => run("stop", "uninstall.stop_work", {}, (r) => `Archived ${r.archived.length} workspaces${r.failed.length ? `; ${r.failed.length} couldn't be archived` : ""}.`)}
      />
      <SettingsAction
        label={
          msg.profiles ??
          (removable.length
            ? `Profiles Foundry added and nobody changed: ${removable.map((p) => p.id).join(", ")}.${edited.length ? ` Changed since, so kept: ${edited.map((p) => p.id).join(", ")}.` : ""}`
            : edited.length
              ? `Foundry's profiles were changed since it added them, so they stay: ${edited.map((p) => p.id).join(", ")}.`
              : "No profiles added by Foundry.")
        }
        actionLabel={`Remove ${removable.length} profiles`}
        disabled={!removable.length}
        onPress={() => run("profiles", "uninstall.remove_profiles", { ids: removable.map((p) => p.id) }, (r) => `Removed ${r.removed.join(", ") || "nothing"}.`)}
      />
      {l.providers.length ? (
        <Text style={{ paddingVertical: 6, opacity: 0.7 }}>
          Providers Foundry added stay in Paseo's settings ({l.providers.join(", ")}); a plugin can't delete them. Remove them there if you like.
        </Text>
      ) : null}
      <View style={{ paddingVertical: 6, gap: 4 }}>
        <Text>Branches in your repos are yours: Foundry never deletes them.</Text>
        {l.branches.map((b) => (
          <Text key={b.project} style={{ opacity: 0.7, fontFamily: "monospace", fontSize: 12 }}>
            {b.project}: git -C {b.repo} branch -D {b.branches.join(" ")}
          </Text>
        ))}
      </View>
      <SettingsAction
        label={keepBackup ? "A final copy of the database is kept beside the folder." : "No final copy will be kept."}
        actionLabel={keepBackup ? "Don't keep a copy" : "Keep a final copy"}
        onPress={() => setKeepBackup((k) => !k)}
      />
      <SettingsInput label={`Type ${name} to confirm deleting Foundry's data`} placeholder={name} onChangeText={setTyped} />
      <SettingsAction
        label={msg.data ?? `Foundry's data: ${l.data.home} (${l.data.files.length} files, ${size(total)}).`}
        actionLabel="Delete Foundry's data"
        disabled={typed !== name}
        onPress={() => run("data", "uninstall.delete_data", { confirm: typed, keepBackup }, (r) => `Deleted.${r.backup ? ` Final copy: ${r.backup}.` : ""} Now uninstall Foundry in Paseo's plugin settings.`)}
      />
    </SettingsSection>
  );
}
