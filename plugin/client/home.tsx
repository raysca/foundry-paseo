// The project's first screen: features in Pending, In progress and Completed, each with a progress bar
// computed from its tasks, what waits on you, and a form for a new feature.
import type { PluginScreenProps, ProjectRef } from "@getpaseo/plugin/client";
import { useProject, useProjects, useRpc } from "@getpaseo/plugin/client";
import { Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { Badge, Btn, Card, Choice, Empty, Field, go, Page, Progress, Row, SCREEN, Section, T, Themed, useAct, useColors, useFoundry, type State } from "./kit";
import { actionRpc } from "../shared/rpc";
import { PROFILE_ROLES } from "../shared/roles";

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
  if (s.deleted) return <DataDeleted home={s.deleted} />;
  if (s.safe_mode) return <SafeMode info={s.safe_mode} />;
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
      <WhatsNew ob={s.onboarding} />
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
  const missing = bad.some((f: any) => f.code === "PROFILE_MISSING");
  return (
    <Card>
      <T bold>Setup needs attention</T>
      {missing ? (
        <Row>
          <Btn label="Set up Foundry's agents" kind="primary" onPress={() => go(SCREEN.home)} />
        </Row>
      ) : null}
      {bad
        .filter((f: any) => f.code !== "PROFILE_MISSING")
        .map((f: any) => (
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

/** Foundry's first screen: the git projects registered in Paseo, as cards. One already used with Foundry
 * opens its features; any other starts with one tap (key, name and base branch come from the repo). */
function Projects({ hostId }: { hostId: string }) {
  const q = useFoundry();
  const refs = useProjects({ hosts: [hostId], where: (p) => p.kind === "git", orderBy: "displayName" });
  if (!q.data) return q.error ? <Page><T>Foundry isn't reachable: {String(q.error)}</T></Page> : <Loading />;
  const s = q.data;
  if (s.deleted) return <DataDeleted home={s.deleted} />;
  if (s.safe_mode) return <SafeMode info={s.safe_mode} />;
  const ob = s.onboarding;
  const profilesMissing = (s.setup?.findings ?? []).some((f: any) => f.code === "PROFILE_MISSING");
  const wizard = ob && !ob.welcome_dismissed && (profilesMissing || !s.projects.length || !s.features.length);
  const cards = refs.length ? (
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
  );
  if (wizard) return <Welcome s={s} cards={cards} profilesMissing={profilesMissing} />;
  return (
    <Page crumbs={[{ label: "Foundry" }]}>
      <WhatsNew ob={ob} />
      <Setup setup={s.setup} />
      <T muted size={13}>Your Paseo projects. Pick one to plan and build features in it.</T>
      {cards}
      <Orphans s={s} hostId={hostId} />
    </Page>
  );
}

/** First open: set up the agents (required), pick a project, start a first feature. */
function Welcome({ s, cards, profilesMissing }: { s: State; cards: React.ReactNode; profilesMissing: boolean }) {
  const act = useAct();
  const others = (s.setup?.findings ?? []).filter((f: any) => (f.level === "error" || f.level === "warn") && f.code !== "PROFILE_MISSING");
  return (
    <Page crumbs={[{ label: "Foundry" }]}>
      <T bold size={18}>Welcome to Foundry</T>
      <T muted size={13}>Three steps: choose the agents Foundry works with, pick a project, and start a first feature.</T>
      <Step n={1} title="Set up your agents" done={!profilesMissing}>
        {profilesMissing ? <AgentsStep setup={s.setup} /> : <T size={13}>Foundry's agent profiles are set up. Change their models any time in Paseo's settings.</T>}
        {others.map((f: any) => (
          <T key={f.code} size={13}>
            {f.message}
            {f.fix ? ` ${f.fix}` : ""}
          </T>
        ))}
      </Step>
      <Step n={2} title="Pick a project" done={s.projects.length > 0} locked={profilesMissing}>
        {profilesMissing ? <T muted size={13}>Finish step 1 first.</T> : cards}
      </Step>
      <Step n={3} title="Start a first feature" done={s.features.length > 0} locked={profilesMissing || !s.projects.length}>
        {s.projects.length && !profilesMissing ? (
          <>
            <T size={13}>Open your project and press New feature. Foundry clarifies the idea with you, writes a spec and a plan for your approval, then builds it task by task.</T>
            <Row wrap>
              {s.projects.map((p: any) => (
                <Btn key={p.key} label={`Open ${p.name}`} kind="primary" onPress={() => go(SCREEN.home, { project: p.key })} />
              ))}
            </Row>
          </>
        ) : (
          <T muted size={13}>After you pick a project.</T>
        )}
      </Step>
      <Row>
        <Btn label="Skip the guide" onPress={() => void act.run("onboarding.dismiss_welcome")} />
      </Row>
    </Page>
  );
}

function Step({ n, title, done, locked, children }: { n: number; title: string; done: boolean; locked?: boolean; children: React.ReactNode }) {
  const c = useColors();
  return (
    <Card style={{ opacity: locked ? 0.6 : 1 }}>
      <Row>
        <T bold style={{ color: done ? c.statusSuccess : c.foreground }}>{done ? "✓" : `${n}.`} {title}</T>
        {n === 1 && !done ? <Badge label="required" tone="warning" /> : null}
      </Row>
      {children}
    </Card>
  );
}

type Harness = { id: string; label: string; status: string; models: { id: string; label: string; isDefault?: boolean }[] };

/** Each missing profile gets a harness and a model from what Paseo has here. Nothing is written until Continue. */
function AgentsStep({ setup }: { setup: any }) {
  const action = useRpc(actionRpc);
  const act = useAct();
  const h = useQuery({
    queryKey: ["foundry-harnesses"],
    queryFn: async () => {
      const r = (await action({ action: "setup.harnesses", args: {} })) as any;
      if (r?.error) throw new Error(r.error.message);
      return r as Harness[];
    },
  });
  const missing = new Set(
    (setup?.findings ?? [])
      .filter((f: any) => f.code === "PROFILE_MISSING")
      .map((f: any) => /"(foundry-[a-z]+)"/.exec(f.message)?.[1])
      .filter(Boolean),
  );
  const [picked, setPicked] = useState<Record<string, { harness?: string; model?: string }>>({});
  if (h.isLoading) return <T muted size={13}>Asking Paseo which agents are available…</T>;
  if (h.error) return <T size={13}>Couldn't read Paseo's agents: {String(h.error)}</T>;
  const ready = (h.data ?? []).filter((x) => x.status === "ready");
  if (!ready.length)
    return (
      <>
        <T size={13}>Paseo reports no ready agent harness on this machine. Install or enable one (Claude Code, Codex, OpenCode or another) in Paseo's settings, then refresh.</T>
        <Row>
          <Btn label="Refresh" onPress={() => void h.refetch()} />
        </Row>
      </>
    );
  const choiceFor = (id: string) => {
    const p = picked[id] ?? {};
    const harness = ready.find((x) => x.id === p.harness) ?? ready[0]!;
    const model = harness.models.find((m) => m.id === p.model) ?? harness.models.find((m) => m.isDefault) ?? harness.models[0];
    return { harness, model };
  };
  const roles = PROFILE_ROLES.filter((r) => missing.has(r.id));
  const complete = roles.every((r) => choiceFor(r.id).model);
  return (
    <>
      <T size={13}>Foundry runs four kinds of agent, each as a Paseo agent profile. Choose the harness and model for each. Foundry suggests the harness's default model; models change often, so check it.</T>
      {PROFILE_ROLES.map((r) => {
        if (!missing.has(r.id))
          return (
            <View key={r.id} style={{ gap: 2 }}>
              <T bold size={13}>{r.name} ✓</T>
              <T muted size={12}>{r.does} Already set up as {r.id}; change it in Paseo's settings.</T>
            </View>
          );
        const { harness, model } = choiceFor(r.id);
        return (
          <View key={r.id} style={{ gap: 4, paddingVertical: 4 }}>
            <T bold size={13}>{r.name}</T>
            <T muted size={12}>{r.does}</T>
            <Choice value={harness.id} options={ready.map((x) => ({ value: x.id, label: x.label }))} onChange={(v) => setPicked((o) => ({ ...o, [r.id]: { harness: v } }))} />
            {harness.models.length ? (
              <Choice
                value={model?.id ?? ""}
                options={harness.models.map((m) => ({ value: m.id, label: m.label }))}
                onChange={(v) => setPicked((o) => ({ ...o, [r.id]: { harness: harness.id, model: v } }))}
              />
            ) : (
              <T muted size={12}>Paseo lists no models for {harness.label}.</T>
            )}
          </View>
        );
      })}
      <T muted size={12}>Continue adds only these profiles to Paseo's settings, plus a foundry-&lt;harness&gt; provider that hides Paseo's own agent tools from Foundry's agents. Profiles you already have are never changed.</T>
      <Row>
        <Btn
          label={act.pending ? "Saving…" : "Continue"}
          kind="primary"
          disabled={!complete || act.pending}
          onPress={() =>
            void act.run("setup.create_profiles", {
              choices: roles.map((r) => {
                const { harness, model } = choiceFor(r.id);
                return { role: r.role, harness: harness.id, model: model!.id };
              }),
            })
          }
        />
      </Row>
    </>
  );
}

/** After an update: what changed since you last looked, and any change you must acknowledge. */
function WhatsNew({ ob }: { ob: any }) {
  const act = useAct();
  if (!ob || (!ob.whats_new?.length && !ob.gates?.length)) return null;
  return (
    <Card>
      <T bold>What's new in Foundry {ob.version}</T>
      {(ob.whats_new ?? []).map((c: any) => (
        <View key={c.version} style={{ gap: 2 }}>
          {ob.whats_new.length > 1 ? <T muted size={12}>{c.version}</T> : null}
          {c.notes.map((n: string, i: number) => (
            <T key={i} size={13}>• {n}</T>
          ))}
        </View>
      ))}
      {(ob.gates ?? []).map((g: any) => (
        <View key={g.id} style={{ gap: 4 }}>
          <Badge label="changes how Foundry acts on your code" tone="warning" />
          <T size={13}>{g.text}</T>
          <Row>
            <Btn label="Got it" kind="primary" onPress={() => void act.run("onboarding.ack_gate", { id: g.id })} />
          </Row>
        </View>
      ))}
      {ob.whats_new?.length ? (
        <Row>
          <Btn label="Dismiss" onPress={() => void act.run("onboarding.ack_whats_new")} />
        </Row>
      ) : null}
    </Card>
  );
}

function DataDeleted({ home }: { home: string }) {
  return (
    <Page crumbs={[{ label: "Foundry" }]}>
      <Card>
        <T bold>Foundry's data was deleted.</T>
        <T size={13}>{home} is gone. Uninstall Foundry in Paseo's plugin settings, or reload it there to start fresh.</T>
      </Card>
    </Page>
  );
}

/** Foundry couldn't open its database; nothing was changed. */
function SafeMode({ info }: { info: any }) {
  return (
    <Page crumbs={[{ label: "Foundry" }]}>
      <Card>
        <Badge label="safe mode" tone="danger" />
        <T bold>Foundry couldn't open its data, so it changed nothing and is paused.</T>
        <T size={13}>{info.message}</T>
        <T size={13}>Your data is untouched in {info.home}.</T>
        {info.backup ? <T size={13}>The copy taken before the last upgrade is {info.backup}.</T> : null}
        <T muted size={12}>
          {info.code === "STORE_TOO_NEW"
            ? "A newer Foundry wrote this data. Install that version again to use it."
            : "Reinstall the previous Foundry version to keep working, or report the message above."}
        </T>
      </Card>
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
  const [confirming, setConfirming] = useState(false);
  if (!p) return null;
  const f = s.projects.find((x: any) => x.repo === p.rootPath);
  const adopt = async () => {
    const r = await act.run("project.adopt", { repo: p.rootPath, name: p.displayName, acknowledged: true });
    if (r?.key) go(SCREEN.home, { project: r.key });
  };
  const st = f ? projectStats(s, f.id) : null;
  return (
    <Card onPress={confirming ? undefined : () => (f ? go(SCREEN.home, { project: f.key }) : setConfirming(true))} style={{ width: 300 }}>
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
      ) : confirming ? (
        <>
          <T size={13}>
            Foundry's agents will work in this repo in their own Paseo workspaces: one per feature, one per task, and one for the project
            manager. Foundry never pushes, and never merges into your base branch without your OK.
          </T>
          <Row wrap>
            <Btn label={act.pending ? "Setting up…" : "Start using Foundry here"} kind="primary" disabled={act.pending} onPress={() => void adopt()} />
            <Btn label="Cancel" onPress={() => setConfirming(false)} />
          </Row>
        </>
      ) : (
        <T muted size={13}>Not used with Foundry yet. Tap to start.</T>
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
