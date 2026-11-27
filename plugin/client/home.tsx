// The project's first screen: features in Pending, In progress and Completed, each with a progress bar
// computed from its tasks, what waits on you, and a form for a new feature.
import type { PluginScreenProps, ProjectRef } from "@getpaseo/plugin/client";
import { useProject, useProjects } from "@getpaseo/plugin/client";
import { Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import { Badge, Btn, Card, Choice, Empty, Field, go, Page, Progress, Row, SCREEN, Section, T, Themed, useAct, useFoundry, type State } from "./kit";

export function HomeScreen(props: PluginScreenProps) {
  return (
    <Themed theme={props.theme}>
      <ScrollView>
        {props.params.project ? <Home projectKey={props.params.project} /> : <Projects hostId={props.host.id} />}
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
  const project = s.projects.find((p) => p.key === projectKey);
  if (!project) return <Page crumbs={[{ label: "Foundry", onPress: () => go(SCREEN.home) }]}><T>No Foundry project {projectKey}.</T></Page>;
  const rows = (s.overview.rows as any[]).filter((r) => r.project_id === project.id);
  const live = rows.filter((r) => r.status === "active");
  const other = rows.filter((r) => r.status !== "active");
  const proposedCards = s.cards.filter((c: any) => c.project_id === project.id && c.status === "proposed").length;
  return (
    <Page crumbs={[{ label: "Foundry", onPress: () => go(SCREEN.home) }, { label: project.name }]}>
      <T muted size={12} mono>{project.key} · {project.repo} · base {project.base_ref}</T>
      <Row wrap>
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
  const missing = bad.filter((f: any) => f.code === "PROFILE_MISSING");
  const rest = bad.filter((f: any) => f.code !== "PROFILE_MISSING");
  return (
    <Card>
      <T bold>{missing.length ? "Finish setting up Foundry" : "Setup needs attention"}</T>
      {missing.length ? <CreateProfiles /> : null}
      {rest.map((f: any) => (
        <T key={f.code} size={13}>
          {f.message}
          {f.fix ? ` ${f.fix}` : ""}
        </T>
      ))}
      <T muted size={12}>Settings → Foundry runs the check again.</T>
    </Card>
  );
}

/** Onboarding: one tap adds the Paseo agent profiles Foundry's roles run on. */
export function CreateProfiles() {
  const act = useAct();
  const toast = useToast();
  return (
    <>
      <T size={13}>
        Foundry's roles run on Paseo agent profiles: foundry-builder and foundry-reviewer (Claude Sonnet), foundry-planner
        and foundry-pm (Claude Opus), on a foundry-claude provider that hides Paseo's own agent tools from them. Only the
        missing ones are added; profiles you already have are never changed. You can change models later in Paseo's settings.
      </T>
      <Row>
        <Btn
          label={act.pending ? "Creating…" : "Create Foundry's profiles"}
          kind="primary"
          disabled={act.pending}
          onPress={async () => {
            const r = await act.run("setup.create_profiles");
            if (r) toast.show(r.added?.length ? `Added ${r.added.length}: ${r.added.join(", ")}` : "Nothing to add; all profiles exist.");
          }}
        />
      </Row>
    </>
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

/** Foundry's first screen: the git projects registered in Paseo, as cards. One already used with Foundry
 * opens its features; any other starts with one tap (key, name and base branch come from the repo). */
function Projects({ hostId }: { hostId: string }) {
  const q = useFoundry();
  const refs = useProjects({ hosts: [hostId], where: (p) => p.kind === "git", orderBy: "displayName" });
  if (!q.data) return q.error ? <Page><T>Foundry isn't reachable: {String(q.error)}</T></Page> : <Loading />;
  const s = q.data;
  return (
    <Page crumbs={[{ label: "Foundry" }]}>
      <Setup setup={s.setup} />
      <T muted size={13}>Your Paseo projects. Pick one to plan and build features in it.</T>
      {refs.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {refs.map((ref) => (
            <ProjectCard key={ref.id} projectRef={ref} s={s} />
          ))}
        </View>
      ) : (
        <Card>
          <T>Paseo has no git projects yet.</T>
          <T muted size={13}>Add one with "Add project" in Paseo's sidebar, then come back here.</T>
        </Card>
      )}
      <Orphans s={s} hostId={hostId} />
    </Page>
  );
}

const projectStats = (s: State, id: number) => {
  const rows = (s.overview.rows as any[]).filter((r) => r.project_id === id && r.status === "active");
  return {
    inProgress: rows.filter((r) => r.bucket === "in_progress").length,
    pending: rows.filter((r) => r.bucket === "pending").length,
    done: rows.filter((r) => r.bucket === "completed").length,
    waiting: rows.reduce((n, r) => n + (r.waiting_on_you ?? 0), 0),
  };
};

function ProjectCard({ projectRef, s }: { projectRef: ProjectRef; s: State }) {
  const p = useProject(projectRef);
  const act = useAct();
  if (!p) return null;
  const f = s.projects.find((x: any) => x.repo === p.rootPath);
  const open = async () => {
    if (f) return go(SCREEN.home, { project: f.key });
    const r = await act.run("project.adopt", { repo: p.rootPath, name: p.displayName });
    if (r?.key) go(SCREEN.home, { project: r.key });
  };
  const st = f ? projectStats(s, f.id) : null;
  return (
    <Card onPress={() => void open()} style={{ width: 300 }}>
      <Row wrap>
        <T bold>{p.displayName}</T>
        {f ? <Badge label={f.key} tone="info" /> : null}
      </Row>
      <T muted size={12} mono>{p.rootPath}</T>
      {st ? (
        <Row wrap>
          <T size={13}>{st.inProgress} in progress · {st.pending} pending · {st.done} done</T>
          {st.waiting ? <Badge label={`${st.waiting} waiting on you`} tone="warning" /> : null}
        </Row>
      ) : (
        <T muted size={13}>{act.pending ? "Setting up…" : "Not used with Foundry yet. Tap to start."}</T>
      )}
    </Card>
  );
}

/** Foundry projects whose repo isn't (or is no longer) a Paseo project, so they stay reachable. */
function Orphans({ s, hostId }: { s: State; hostId: string }) {
  // Grouping by root path is the way to read every project's path from one hook.
  const roots = new Set(useProjects({ hosts: [hostId], groupBy: (p) => p.rootPath }).map((g) => g.key));
  const orphans = s.projects.filter((p: any) => !roots.has(p.repo));
  if (!orphans.length) return null;
  return (
    <Section title="Other Foundry projects">
      {orphans.map((p: any) => (
        <Card key={p.key} onPress={() => go(SCREEN.home, { project: p.key })}>
          <Row wrap>
            <T bold>{p.name}</T>
            <Badge label={p.key} tone="info" />
          </Row>
          <T muted size={12} mono>{p.repo} (not a Paseo project)</T>
        </Card>
      ))}
    </Section>
  );
}
