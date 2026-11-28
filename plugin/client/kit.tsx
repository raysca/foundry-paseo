// Shared pieces for Foundry's screens: state polling, actions with their error codes, navigation and
// a few plain building blocks drawn in Paseo's theme.
import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { actionRpc, stateRpc } from "../shared/rpc";

// ---------- navigation ----------
let opener: ((input: PluginOpenScreenInput) => void) | null = null;
export const setOpener = (fn: (input: PluginOpenScreenInput) => void) => (opener = fn);
export const SCREEN = { home: "foundry", feature: "foundry-feature", issue: "foundry-issue", chat: "foundry-chat" } as const;
export const go = (screenId: string, params: Record<string, string> = {}) => opener?.({ screenId, params });

// ---------- theme ----------
export const ThemeCtx = createContext<PluginTheme["colors"] | null>(null);
const FALLBACK: PluginTheme["colors"] = {
  surface0: "#fff", surface1: "#f6f6f6", surface2: "#eee", border: "#ddd", foreground: "#111", foregroundMuted: "#666",
  accent: "#2563eb", accentForeground: "#fff", statusSuccess: "#16a34a", statusWarning: "#d97706", statusDanger: "#dc2626",
};
export const useColors = () => useContext(ThemeCtx) ?? FALLBACK;
export function Themed({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return <ThemeCtx.Provider value={theme.colors}>{children}</ThemeCtx.Provider>;
}

// ---------- data ----------
export type State = Record<string, any> & {
  projects: any[];
  overview: { buckets: Record<string, number>; rows: any[] } | any;
  features: any[];
  issues: any[];
  attempts: any[];
  docs: any[];
  requirements: any[];
  proposals: any[];
  slices: any[];
  questions: any[];
  verifications: any[];
  chat: any[];
  cards: any[];
  ships: { key: string; value: string }[];
  holds?: { key: string; value: string }[];
  events: any[];
};

export function useFoundry() {
  const state = useRpc(stateRpc);
  return useQuery({ queryKey: ["foundry-state"], queryFn: () => state({}) as Promise<State>, refetchInterval: 2000 });
}

export interface ActError {
  code: string;
  message: string;
  details?: unknown;
}

/** Run one Foundry action. Refusals come back as `{error:{code,message}}` and are shown as a toast. */
export function useAct() {
  const action = useRpc(actionRpc);
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: async ({ name, args }: { name: string; args: Record<string, unknown> }) => {
      const r = (await action({ action: name, args })) as any;
      if (r && typeof r === "object" && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, details: r.error.detail });
      return r;
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["foundry-state"] }),
  });
  return {
    pending: m.isPending,
    /** Like run, but hands a refusal back instead of showing it. */
    attempt: async (name: string, args: Record<string, unknown> = {}): Promise<{ result?: any; error?: ActError }> => {
      try {
        return { result: await m.mutateAsync({ name, args }) };
      } catch (e: any) {
        return { error: { code: e?.code ?? "ERROR", message: String(e?.message ?? e), details: e?.details } };
      }
    },
    /** Resolves to the result, or null after showing the refusal. */
    run: async (name: string, args: Record<string, unknown> = {}, done?: string): Promise<any | null> => {
      try {
        const r = await m.mutateAsync({ name, args });
        if (done) toast.show(done);
        return r;
      } catch (e: any) {
        toast.error(e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e));
        return null;
      }
    },
  };
}

export const parseJson = <T,>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
export const short = (sha?: string | null) => (sha ? sha.slice(0, 7) : "none");

// ---------- building blocks ----------
export function Page({ children, crumbs }: { children: ReactNode; crumbs?: { label: string; onPress?: () => void }[] }) {
  const c = useColors();
  return (
    <View style={{ padding: 16, gap: 16, maxWidth: 1100, width: "100%", alignSelf: "center" }}>
      {crumbs?.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {crumbs.map((x, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 6 }}>
              {i ? <Text style={{ color: c.foregroundMuted }}>›</Text> : null}
              <Text onPress={x.onPress} style={{ color: x.onPress ? c.accent : c.foregroundMuted }}>
                {x.label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Section({ title, trailing, children }: { title: string; trailing?: ReactNode; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

export function Card({ children, onPress, style }: { children: ReactNode; onPress?: () => void; style?: ViewStyle }) {
  const c = useColors();
  const box: ViewStyle = { backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 12, gap: 6, ...style };
  return onPress ? (
    <Pressable onPress={onPress} style={box}>
      {children}
    </Pressable>
  ) : (
    <View style={box}>{children}</View>
  );
}

export function T({ children, muted, bold, size, mono, style }: { children: ReactNode; muted?: boolean; bold?: boolean; size?: number; mono?: boolean; style?: TextStyle }) {
  const c = useColors();
  return (
    <Text
      selectable
      style={{ color: muted ? c.foregroundMuted : c.foreground, fontWeight: bold ? "600" : "400", fontSize: size ?? 14, fontFamily: mono ? "monospace" : undefined, ...style }}
    >
      {children}
    </Text>
  );
}

export function Row({ children, gap = 8, wrap }: { children: ReactNode; gap?: number; wrap?: boolean }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap, flexWrap: wrap ? "wrap" : "nowrap" }}>{children}</View>;
}

type Tone = "muted" | "success" | "warning" | "danger" | "info";
export function Badge({ label, tone = "muted" }: { label: string; tone?: Tone }) {
  const c = useColors();
  const color = { muted: c.foregroundMuted, success: c.statusSuccess, warning: c.statusWarning, danger: c.statusDanger, info: c.accent }[tone];
  return (
    <View style={{ borderColor: color, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 1 }}>
      <Text style={{ color, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

export function Btn({ label, onPress, kind = "secondary", disabled }: { label: string; onPress: () => void; kind?: "primary" | "secondary" | "danger"; disabled?: boolean }) {
  const c = useColors();
  const bg = kind === "primary" ? c.accent : kind === "danger" ? c.statusDanger : c.surface2;
  const fg = kind === "secondary" ? c.foreground : c.accentForeground;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={disabled ? undefined : onPress}
      style={{ backgroundColor: bg, opacity: disabled ? 0.5 : 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 }}
    >
      <Text style={{ color: fg, fontSize: 13, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export function Field({ value, onChange, placeholder, multiline, mono }: { value: string; onChange: (t: string) => void; placeholder?: string; multiline?: boolean; mono?: boolean }) {
  const c = useColors();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={c.foregroundMuted}
      multiline={multiline}
      style={{
        color: c.foreground,
        backgroundColor: c.surface0,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 6,
        padding: 8,
        minHeight: multiline ? 80 : undefined,
        fontFamily: mono ? "monospace" : undefined,
        textAlignVertical: multiline ? "top" : undefined,
      }}
    />
  );
}

/** A choice between a few labelled options, as a row of toggles. */
export function Choice<V extends string>({ value, options, onChange }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  const c = useColors();
  return (
    <Row wrap>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          style={{ borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: o.value === value ? c.accent : c.border, backgroundColor: o.value === value ? c.surface2 : "transparent" }}
        >
          <Text style={{ color: o.value === value ? c.accent : c.foreground, fontSize: 13 }}>{o.label}</Text>
        </Pressable>
      ))}
    </Row>
  );
}

/** A horizontal bar split by task status. */
export function Progress({ split, total }: { split: Record<string, number>; total: number }) {
  const c = useColors();
  if (!total) return null;
  const parts: [string, number][] = [
    [c.statusSuccess, split.done ?? 0],
    [c.accent, (split.in_review ?? 0) + (split.in_progress ?? 0)],
    [c.statusWarning, split.waiting ?? 0],
    [c.statusDanger, split.failed_or_blocked ?? 0],
    [c.surface2, split.not_started ?? 0],
  ];
  return (
    <View style={{ flexDirection: "row", height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: c.surface2 }}>
      {parts.map(([color, n], i) => (n ? <View key={i} style={{ flex: n, backgroundColor: color }} /> : null))}
    </View>
  );
}

export function useDraft<T>(initial: T) {
  return useState<T>(initial);
}

export const STATUS_TONE: Record<string, Tone> = {
  Done: "success",
  In_Review: "info",
  In_Progress: "info",
  Awaiting_Human: "warning",
  Failed: "danger",
  Blocked: "danger",
  Cancelled: "muted",
  Ready: "muted",
  Backlog: "muted",
};

export function Empty({ text }: { text: string }) {
  return <T muted>{text}</T>;
}

/** A unified diff, coloured line by line. */
export function DiffLines({ diff, max = 4000 }: { diff: string; max?: number }) {
  const c = useColors();
  return (
    <View style={{ backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: 6, padding: 8 }}>
      {diff.split("\n").slice(0, max).map((line, n) => {
        const color = line.startsWith("+") && !line.startsWith("+++") ? c.statusSuccess : line.startsWith("-") && !line.startsWith("---") ? c.statusDanger : line.startsWith("@@") ? c.accent : line.startsWith("diff ") ? c.foreground : c.foregroundMuted;
        return (
          <Text key={n} selectable style={{ color, fontFamily: "monospace", fontSize: 12, fontWeight: line.startsWith("diff ") ? "600" : "400" }}>
            {line || " "}
          </Text>
        );
      })}
    </View>
  );
}

/** The loops a project can use (built-ins and its own .foundry/loops on base), with invalid loop files. */
export function useLoops(projectId: number | undefined) {
  const action = useRpc(actionRpc);
  return useQuery({
    queryKey: ["foundry-loops", projectId],
    enabled: projectId !== undefined,
    queryFn: () => action({ action: "project.loops", args: { id: projectId } }) as Promise<{ default: string; loops: { name: string; source: string; steps: { kind: string; name: string }[] }[]; invalid: { name: string; errors: string[] }[] }>,
  });
}

/** Pick a loop: the project's default (empty value) or a named one. */
export function LoopPick({ projectId, value, onChange }: { projectId: number; value: string | null | undefined; onChange: (loop: string | null) => void }) {
  const loops = useLoops(projectId);
  if (!loops.data?.loops) return null;
  return (
    <Choice
      value={value ?? ""}
      onChange={(v) => onChange(v || null)}
      options={[{ value: "", label: `default (${loops.data.default})` }, ...loops.data.loops.map((l) => ({ value: l.name, label: l.source === "project" ? `${l.name} (project)` : l.name }))]}
    />
  );
}
