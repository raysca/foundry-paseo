// The review panel for one task: the diff against the feature head at the SHAs you accept, the check
// and review runs, the agents' verdicts, questions waiting on you, then Accept or Rework.
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { actionRpc } from "../shared/rpc";
import { Badge, Btn, Card, Choice, Field, go, Page, parseJson, Row, SCREEN, Section, short, STATUS_TONE, T, Themed, useAct, useFoundry, DiffLines } from "./kit";

export function IssueScreen(props: PluginScreenProps) {
  return (
    <Themed theme={props.theme}>
      <ScrollView>
        <Issue issueKey={props.params.key ?? ""} openAgent={props.navigation ? (agentId) => props.navigation!.openAgent({ agentId }) : undefined} />
      </ScrollView>
    </Themed>
  );
}

function Issue({ issueKey, openAgent }: { issueKey: string; openAgent?: (agentId: string) => void }) {
  const q = useFoundry();
  const action = useRpc(actionRpc);
  const i = q.data?.issues.find((x) => x.key === issueKey);
  const a = q.data?.attempts.find((x) => x.issue_key === issueKey);
  // Re-read the review whenever the status or the attempt's head moves.
  const review = useQuery({
    queryKey: ["foundry-review", issueKey, i?.status, a?.head_sha, a?.step],
    queryFn: () => action({ action: "issue.review", args: { key: issueKey } }) as Promise<any>,
    enabled: !!i,
  });
  if (!q.data) return <Loading />;
  if (!i) return <Page><T>No task {issueKey}.</T></Page>;
  const s = q.data;
  const p = s.projects.find((x) => x.id === i.project_id)!;
  const f = i.feature_id ? s.features.find((x) => x.id === i.feature_id) : null;
  const r = review.data && !review.data.error ? review.data : null;
  const crumbs = [
    { label: "Foundry", onPress: () => go(SCREEN.home, { project: p.key }) },
    { label: p.name, onPress: () => go(SCREEN.home, { project: p.key }) },
    ...(f ? [{ label: f.title, onPress: () => go(SCREEN.feature, { id: String(f.id) }) }] : []),
    { label: i.key },
  ];
  return (
    <Page crumbs={crumbs}>
      <Card>
        <Row wrap>
          <T bold size={18}>{i.key}</T>
          <T size={16}>{i.title}</T>
          <Badge label={i.status.replace("_", " ")} tone={STATUS_TONE[i.status]} />
          {i.flag ? <Badge label={i.flag} tone="warning" /> : null}
        </Row>
        {i.reason ? <T muted size={13}>{i.reason}</T> : null}
        {i.description ? <T size={13}>{i.description}</T> : null}
        {i.acceptance ? <T muted size={13}>Exit criteria: {i.acceptance}</T> : null}
        {parseJson<string[]>(i.requirement_refs, []).length ? <T muted size={12}>Covers {parseJson<string[]>(i.requirement_refs, []).join(", ")}</T> : null}
        {a ? (
          <Row wrap>
            <T muted size={12} mono>attempt {a.n} · {a.branch} · step {a.step}{a.head_sha ? ` · head ${short(a.head_sha)}` : ""}</T>
            {openAgent && a.builder_agent_id ? <Btn label="Open the builder" onPress={() => openAgent(a.builder_agent_id)} /> : null}
            {openAgent && a.reviewer_agent_id ? <Btn label="Open the reviewer" onPress={() => openAgent(a.reviewer_agent_id)} /> : null}
          </Row>
        ) : null}
      </Card>
      <Questions questions={(r?.questions ?? []).filter((x: any) => x.status === "live" || x.status === "waiting")} />
      {i.status === "In_Review" && r ? <Decide issueKey={i.key} head={r.head_sha} tree={r.tree_sha} flagged={i.flag === "SPEC_CHANGED"} /> : null}
      {i.status === "Done" && i.flag === "SPEC_CHANGED" ? <T muted size={13}>Accepted as is after the spec changed: the requirements it covers stay not covered until another task covers them, and Verify reports them.</T> : null}
      {i.status === "Failed" || i.status === "Blocked" ? <Retry issueKey={i.key} projectKey={p.key} /> : null}
      {r ? <Verdicts events={r.events} /> : null}
      {r ? <Runs runs={r.runs} /> : null}
      {i.status === "Done" ? <T muted>Merged into the feature branch.</T> : r ? <Diff stat={r.stat} diff={r.diff} /> : review.isLoading ? <Loading /> : null}
    </Page>
  );
}

function Questions({ questions }: { questions: any[] }) {
  const act = useAct();
  const [text, setText] = useState<Record<number, string>>({});
  if (!questions.length) return null;
  return (
    <Section title="Waiting on your answer">
      {questions.map((x) => {
        const choices = parseJson<string[]>(x.choices, []);
        return (
          <Card key={x.id}>
            <T bold>{x.text}</T>
            {choices.length ? <Choice value={text[x.id] ?? ""} onChange={(v) => setText((t) => ({ ...t, [x.id]: v }))} options={choices.map((c) => ({ value: c, label: c }))} /> : null}
            <Field value={text[x.id] ?? ""} onChange={(v) => setText((t) => ({ ...t, [x.id]: v }))} placeholder="Your answer" multiline />
            <Row>
              <Btn label="Answer" kind="primary" disabled={!(text[x.id] ?? "").trim() || act.pending} onPress={() => void act.run("question.answer", { id: x.id, text: text[x.id] })} />
            </Row>
          </Card>
        );
      })}
    </Section>
  );
}

function Decide({ issueKey, head, tree, flagged }: { issueKey: string; head: string | null; tree: string | null; flagged: boolean }) {
  const act = useAct();
  const action = useRpc(actionRpc);
  const [feedback, setFeedback] = useState("");
  if (!head || !tree) return null;
  const draft = async () => {
    const r = (await action({ action: "issue.flag_draft", args: { key: issueKey } })) as any;
    if (r?.feedback) setFeedback(r.feedback);
  };
  return (
    <Card>
      <T bold>Your review</T>
      {flagged ? (
        <>
          <T size={13}>⚠ The spec changed while this task ran. Accept it as is (the requirements it covers stay not covered, and Verify reports them), rework it against the new requirements, or cancel it.</T>
          <Row wrap>
            <Btn label="Draft the rework for the new requirements" onPress={() => void draft()} />
            <Btn label="Cancel this task" kind="danger" disabled={act.pending} onPress={() => void act.run("issue.cancel_flagged", { key: issueKey, head_sha: head, tree_sha: tree })} />
          </Row>
        </>
      ) : null}
      <T muted size={13}>Accept merges this task into the feature branch at {short(head)}. If it moved since this page loaded, Foundry refuses and shows the new head.</T>
      <Field value={feedback} onChange={setFeedback} placeholder="Feedback (needed for rework, optional for accept)" multiline />
      <Row wrap>
        <Btn label={flagged ? `Accept ${short(head)} as is` : `Accept ${short(head)}`} kind="primary" disabled={act.pending} onPress={() => void act.run("issue.accept", { key: issueKey, head_sha: head, tree_sha: tree, feedback })} />
        <Btn label="Send back for rework" disabled={!feedback.trim() || act.pending} onPress={async () => (await act.run("issue.rework", { key: issueKey, head_sha: head, tree_sha: tree, feedback })) && setFeedback("")} />
      </Row>
    </Card>
  );
}

function Retry({ issueKey, projectKey }: { issueKey: string; projectKey: string }) {
  return (
    <Card>
      <T size={13}>This task stopped. Ask the project manager to retry or cancel it; it proposes a card and warns first if other work is affected.</T>
      <Row><Btn label="Ask the project manager" onPress={() => go(SCREEN.chat, { project: projectKey, issue: issueKey })} /></Row>
    </Card>
  );
}

function Verdicts({ events }: { events: any[] }) {
  const v = events.filter((e) => e.kind === "verdict");
  if (!v.length) return null;
  return (
    <Section title="Verdicts">
      {v.map((e) => (
        <Card key={e.id}>
          <Row wrap>
            <Badge label={`${e.detail.role}: ${e.detail.decision}`} tone={e.detail.decision === "pass" ? "success" : e.detail.decision === "human" ? "warning" : "danger"} />
            <T muted size={12} mono>{short(e.detail.head)} · {e.at}</T>
          </Row>
          {e.detail.reason ? <T size={13}>{e.detail.reason}</T> : null}
        </Card>
      ))}
    </Section>
  );
}

function Runs({ runs }: { runs: any[] }) {
  if (!runs.length) return null;
  return (
    <Section title="Runs">
      {runs.map((x) => (
        <Row key={x.id} wrap>
          <Badge label={x.status} tone={x.status === "passed" || x.status === "completed" ? "success" : x.status === "running" ? "info" : x.status === "failed" ? "danger" : "muted"} />
          <T size={13}>{x.kind}{x.detail?.name ? ` ${x.detail.name}` : ""}{x.detail?.round ? ` (fix round ${x.detail.round})` : ""}{x.detail?.rework ? ` (rework ${x.detail.rework})` : ""}</T>
          <T muted size={12} mono>{short(x.sha)}</T>
        </Row>
      ))}
    </Section>
  );
}

function Diff({ stat, diff }: { stat: string; diff: string }) {
  if (!diff) return <Section title="Changes"><T muted>No changes against the feature branch yet.</T></Section>;
  return (
    <Section title="Changes against the feature branch">
      <T mono size={12} muted>{stat}</T>
      <DiffLines diff={diff} />
    </Section>
  );
}
