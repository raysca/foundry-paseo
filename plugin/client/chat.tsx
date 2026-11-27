// The project manager's chat: threads (Main, Updates and any you start), messages, and the cards it
// proposes. A card that touches active work waits with its warnings for your yes.
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Loading, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import { Badge, Btn, Card, Choice, Field, go, Page, parseJson, Row, SCREEN, T, Themed, useAct, useColors, useFoundry, type State } from "./kit";

export function ChatScreen(props: PluginScreenProps) {
  return (
    <Themed theme={props.theme}>
      <ScrollView>
        <Chat projectKey={props.params.project} feature={props.params.feature} issue={props.params.issue} />
      </ScrollView>
    </Themed>
  );
}

const UPDATES = "updates";

function Chat({ projectKey, feature, issue }: { projectKey?: string; feature?: string; issue?: string }) {
  const q = useFoundry();
  const act = useAct();
  const [thread, setThread] = useState("main");
  const [text, setText] = useState("");
  const [newThread, setNewThread] = useState("");
  if (!q.data) return <Loading />;
  const s = q.data;
  const p = s.projects.find((x) => x.key === projectKey) ?? s.projects[0];
  if (!p) return <Page><T>Add a project first.</T></Page>;
  const threads = Array.from(new Set(["main", UPDATES, ...s.chat.filter((m) => m.project_id === p.id).map((m) => m.thread), thread]));
  const msgs = s.chat.filter((m) => m.project_id === p.id && m.thread === thread);
  const busy = !!(s as any).pm_threads?.find((t: any) => t.project_id === p.id && t.thread === thread)?.busy;
  const f = feature ? s.features.find((x) => x.id === Number(feature)) : null;
  const context = { ...(f ? { feature: f.id } : {}), ...(issue ? { issue } : {}) };
  const send = async () => {
    if (await act.run("pm.send", { project: p.key, text, thread, ...context })) setText("");
  };
  return (
    <Page crumbs={[{ label: "Foundry", onPress: () => go(SCREEN.home, { project: p.key }) }, { label: p.name, onPress: () => go(SCREEN.home, { project: p.key }) }, { label: "Project manager" }]}>
      <Row wrap>
        <Choice value={thread} onChange={setThread} options={threads.map((t) => ({ value: t, label: t === "main" ? "Main" : t === UPDATES ? "Updates" : t }))} />
        <Field value={newThread} onChange={(t) => setNewThread(t.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="new thread" />
        <Btn
          label="Start thread"
          disabled={!newThread}
          onPress={() => {
            setThread(newThread);
            setNewThread("");
          }}
        />
      </Row>
      {thread === UPDATES ? <T muted size={13}>Foundry posts failed and flagged tasks here, and the project manager proposes what to do.</T> : null}
      {msgs.length ? msgs.map((m) => <Message key={m.id} m={m} s={s} />) : <T muted>No messages in this thread yet.</T>}
      {busy ? <T muted>The project manager is replying…</T> : null}
      {thread !== UPDATES ? (
        <Card>
          {f || issue ? <T muted size={12}>About {f ? f.title : ""}{f && issue ? ", " : ""}{issue ?? ""}</T> : null}
          <Field value={text} onChange={setText} placeholder="Ask about progress, or ask it to reprioritise, retry or cancel a task" multiline />
          <Row>
            <Btn label="Send" kind="primary" disabled={!text.trim() || act.pending} onPress={() => void send()} />
          </Row>
        </Card>
      ) : null}
    </Page>
  );
}

function Message({ m, s }: { m: any; s: State }) {
  const c = useColors();
  const mine = m.role === "you";
  const card = m.card_id ? s.cards.find((x) => x.id === m.card_id) : null;
  return (
    <View style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "85%", gap: 6 }}>
      <T muted size={11}>{mine ? "You" : m.role === "pm" ? "Project manager" : "Foundry"} · {m.created_at}</T>
      <View style={{ backgroundColor: mine ? c.surface2 : c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 10 }}>
        {mine ? <T>{m.text}</T> : <Markdown>{m.text}</Markdown>}
      </View>
      {card ? <ActionCard card={card} /> : null}
    </View>
  );
}

const ACTION_TEXT: Record<string, (a: any) => string> = {
  set_priority: (a) => `Set ${a.issue} to priority ${a.priority}`,
  retry: (a) => `Retry ${a.issue}`,
  cancel: (a) => `Cancel ${a.issue}`,
};

function ActionCard({ card }: { card: any }) {
  const act = useAct();
  const actions = parseJson<any[]>(card.actions, []);
  const warnings = parseJson<string[]>(card.warnings, []);
  const tone = card.status === "applied" || card.status === "accepted" ? "success" : card.status === "rejected" ? "muted" : card.status === "proposed" ? "warning" : "info";
  return (
    <Card>
      <Row wrap>
        <T bold>Card</T>
        <Badge label={card.status} tone={tone} />
        {card.decided_by ? <T muted size={12}>by {card.decided_by}</T> : null}
      </Row>
      {actions.map((a, i) => (
        <T key={i}>• {(ACTION_TEXT[a.action] ?? ((x: any) => JSON.stringify(x)))(a)}{a.reason ? `: ${a.reason}` : ""}</T>
      ))}
      {card.reason ? <T muted size={13}>{card.reason}</T> : null}
      {warnings.map((w, i) => (
        <T key={i} size={13}>⚠ {w}</T>
      ))}
      {card.status === "proposed" ? (
        <Row>
          <Btn label="Yes, apply" kind="primary" disabled={act.pending} onPress={() => void act.run("card.accept", { id: card.id })} />
          <Btn label="No" disabled={act.pending} onPress={() => void act.run("card.reject", { id: card.id })} />
        </Row>
      ) : null}
    </Card>
  );
}
