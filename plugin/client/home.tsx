// The project's first screen: features in Pending, In progress and Completed, each with a progress bar
// computed from its tasks, what waits on you, and a form for a new feature.
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Badge, Btn, Card, Choice, Empty, Field, go, Page, Progress, Row, SCREEN, Section, T, Themed, useAct, useFoundry } from "./kit";

export function HomeScreen(props: PluginScreenProps) {
  return (
    <Themed theme={props.theme}>
      <ScrollView>
        <Home projectKey={props.params.project} />
      </ScrollView>
    </Themed>
  );
}

const BUCKETS = [
  ["pending", "Pending"],
  ["in_progress", "In progress"],
  ["completed", "Completed"],
] as const;

function Home({ projectKey }: { projectKey?: string }) {
  const q = useFoundry();
  if (!q.data) return q.error ? <Page><T>Foundry isn't reachable: {String(q.error)}</T></Page> : <Loading />;
  const s = q.data;
  const project = s.projects.find((p) => p.key === projectKey) ?? s.projects[0];
  if (!project) return <NewProject first />;
  const rows = (s.overview.rows as any[]).filter((r) => r.project_id === project.id);
  const live = rows.filter((r) => r.status === "active");
  const other = rows.filter((r) => r.status !== "active");
  const proposedCards = s.cards.filter((c: any) => c.project_id === project.id && c.status === "proposed").length;
  return (
    <Page crumbs={[{ label: "Foundry" }, { label: project.name }]}>
      <Row wrap>
        {s.projects.length > 1
          ? s.projects.map((p: any) => <Btn key={p.key} label={p.key} kind={p.id === project.id ? "primary" : "secondary"} onPress={() => go(SCREEN.home, { project: p.key })} />)
          : null}
        <Btn label={proposedCards ? `Project manager (${proposedCards} card${proposedCards === 1 ? "" : "s"})` : "Project manager"} onPress={() => go(SCREEN.chat, { project: project.key })} />
      </Row>
      <Setup setup={s.setup} />
      <NewFeature projectKey={project.key} />
      {BUCKETS.map(([b, name]) => {
        const list = live.filter((r) => r.bucket === b);
        return (
          <Section key={b} title={`${name} (${list.length})`}>
            {list.length ? list.map((r) => <FeatureCard key={r.id} r={r} />) : <Empty text={b === "completed" ? "Nothing shipped yet." : "None."} />}
          </Section>
        );
      })}
      {other.length ? (
        <Section title={`Paused or cancelled (${other.length})`}>
          {other.map((r) => (
            <FeatureCard key={r.id} r={r} />
          ))}
        </Section>
      ) : null}
      <NewProject />
    </Page>
  );
}

function FeatureCard({ r }: { r: any }) {
  const label = r.delivery_label ?? r.planning_label ?? (r.progress.percent != null ? `${r.progress.percent}% · ${r.progress.done} of ${r.progress.total} tasks done` : r.stage);
  return (
    <Card onPress={() => go(SCREEN.feature, { id: String(r.id) })}>
      <Row wrap>
        <T bold>{r.title}</T>
        {r.spec_changed ? <Badge label="spec changed" tone="warning" /> : null}
        {r.waiting_on_you ? <Badge label={`${r.waiting_on_you} waiting on you`} tone="info" /> : null}
        {r.planning_error ? <Badge label="planning failed" tone="danger" /> : null}
        {r.status !== "active" ? <Badge label={r.status} /> : null}
      </Row>
      <T muted size={13}>
        {label}
        {r.coverage.total ? ` · ${r.coverage.covered} of ${r.coverage.total} requirements covered` : ""}
      </T>
      <Progress split={r.progress.split} total={r.progress.total} />
    </Card>
  );
}

function Setup({ setup }: { setup: any }) {
  const bad = (setup?.findings ?? []).filter((f: any) => f.level === "error" || f.level === "warn");
  if (!bad.length) return null;
  return (
    <Card>
      <T bold>Setup needs attention</T>
      {bad.map((f: any) => (
        <T key={f.code} size={13}>
          {f.message}
          {f.fix ? ` ${f.fix}` : ""}
        </T>
      ))}
      <T muted size={12}>Settings → Foundry runs the check again.</T>
    </Card>
  );
}

function NewFeature({ projectKey }: { projectKey: string }) {
  const act = useAct();
  const [open, setOpen] = useState(false);
  const [idea, setIdea] = useState("");
  const [grill, setGrill] = useState<"none" | "light" | "normal">("light");
  if (!open) return <Row><Btn label="New feature" kind="primary" onPress={() => setOpen(true)} /></Row>;
  return (
    <Card>
      <T bold>New feature</T>
      <T muted size={13}>The first line is the title. The project manager can ask you Clarify questions before it writes the spec.</T>
      <Field value={idea} onChange={setIdea} placeholder={"Shout mode\nLet the CLI print its input in upper case."} multiline />
      <Row wrap>
        <T muted size={13}>Questions:</T>
        <Choice value={grill} onChange={setGrill} options={[{ value: "none", label: "None" }, { value: "light", label: "One round" }, { value: "normal", label: "Up to two rounds" }]} />
      </Row>
      <Row>
        <Btn
          label={act.pending ? "Creating" : "Create"}
          kind="primary"
          disabled={!idea.trim() || act.pending}
          onPress={async () => {
            const r = await act.run("feature.create", { project: projectKey, idea, grill });
            if (r?.id) {
              setIdea("");
              setOpen(false);
              go(SCREEN.feature, { id: String(r.id) });
            }
          }}
        />
        <Btn label="Cancel" onPress={() => setOpen(false)} />
      </Row>
    </Card>
  );
}

function NewProject({ first }: { first?: boolean }) {
  const act = useAct();
  const [open, setOpen] = useState(!!first);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [base, setBase] = useState("main");
  const body = !open ? (
    <Row><Btn label="Add a project" onPress={() => setOpen(true)} /></Row>
  ) : (
    <Card>
      <T bold>{first ? "Add your first project" : "Add a project"}</T>
      <T muted size={13}>A project is one git repository on this machine. Foundry merges finished features into its base branch.</T>
      <Field value={key} onChange={(t) => setKey(t.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5))} placeholder="Key: 2 to 5 capital letters, e.g. SHT (task ids become SHT-1)" />
      <Field value={name} onChange={setName} placeholder="Name" />
      <Field value={repo} onChange={setRepo} placeholder="Repository path, e.g. /Users/you/code/app" mono />
      <Field value={base} onChange={setBase} placeholder="Base branch" mono />
      <Row>
        <Btn
          label="Add"
          kind="primary"
          disabled={!key || !repo.trim() || act.pending}
          onPress={async () => {
            const r = await act.run("project.create", { key, name: name || key, repo: repo.trim(), baseRef: base || "main" });
            if (r) go(SCREEN.home, { project: key });
          }}
        />
        {first ? null : <Btn label="Cancel" onPress={() => setOpen(false)} />}
      </Row>
    </Card>
  );
  return first ? <Page crumbs={[{ label: "Foundry" }]}>{body}</Page> : body;
}
