// One feature: Clarify answers, the spec, plan and task list with SHA-bound approvals, a spec change and
// its change set, the feature's tasks, then Verify and Ship.
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Loading, Markdown, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { actionRpc } from "../shared/rpc";
import { Badge, Btn, Card, Choice, Empty, Field, go, Page, parseJson, Progress, Row, SCREEN, Section, short, STATUS_TONE, T, Themed, useAct, useFoundry, type State } from "./kit";

export function FeatureScreen(props: PluginScreenProps) {
  return (
    <Themed theme={props.theme}>
      <ScrollView>
        <Feature id={Number(props.params.id)} />
      </ScrollView>
    </Themed>
  );
}

type DocKind = "spec" | "plan" | "tasks";
const STAGES = ["clarify", "spec", "plan", "tasks", "build", "verify", "ship", "done"];
const STAGE_NAME: Record<string, string> = { clarify: "Clarify", spec: "Spec", plan: "Plan", tasks: "Task list", build: "Build", verify: "Verify", ship: "Ship", done: "Done" };

function Feature({ id }: { id: number }) {
  const q = useFoundry();
  if (!q.data) return <Loading />;
  const s = q.data;
  const f = s.features.find((x) => x.id === id);
  if (!f) return <Page><T>No feature {id}.</T></Page>;
  const p = s.projects.find((x) => x.id === f.project_id)!;
  const row = (s.overview.rows as any[]).find((r) => r.id === id);
  return (
    <Page crumbs={[{ label: "Foundry", onPress: () => go(SCREEN.home, { project: p.key }) }, { label: p.name, onPress: () => go(SCREEN.home, { project: p.key }) }, { label: f.title }]}>
      <Header s={s} f={f} row={row} projectKey={p.key} />
      <SpecChange s={s} f={f} />
      <Questions s={s} f={f} />
      <Docs s={s} f={f} />
      <Requirements s={s} f={f} />
      <Proposal s={s} f={f} />
      <Tasks s={s} f={f} />
      <Delivery s={s} f={f} />
    </Page>
  );
}

function Header({ s, f, row, projectKey }: { s: State; f: any; row: any; projectKey: string }) {
  const act = useAct();
  const idx = STAGES.indexOf(f.stage);
  return (
    <Card>
      <Row wrap>
        <T bold size={18}>{f.title}</T>
        <Badge label={STAGE_NAME[f.stage] ?? f.stage} tone="info" />
        {f.status !== "active" ? <Badge label={f.status} tone="warning" /> : null}
        {f.planning_busy ? <Badge label="project manager is working" tone="info" /> : null}
      </Row>
      <T muted size={13}>
        {STAGES.map((st, i) => `${i < idx ? "✓" : i === idx ? "●" : "○"} ${STAGE_NAME[st]}`).join("   ")}
      </T>
      <T muted size={12} mono>{f.branch} · head {short(f.head_sha)}</T>
      {row ? <Progress split={row.progress.split} total={row.progress.total} /> : null}
      {f.planning_error ? (
        <Card style={{ borderColor: "#dc2626" }}>
          <T>{f.planning_error}</T>
          <Row><Btn label="Retry the planning turn" kind="primary" onPress={() => void act.run("feature.retry", { id: f.id })} /></Row>
        </Card>
      ) : null}
      <Row wrap>
        {f.status === "active" && f.stage !== "done" ? <Btn label="Pause" onPress={() => void act.run("feature.pause", { id: f.id })} /> : null}
        {f.status === "paused" ? <Btn label="Resume" kind="primary" onPress={() => void act.run("feature.resume", { id: f.id })} /> : null}
        {f.status !== "cancelled" && f.stage !== "done" ? <Btn label="Cancel feature" kind="danger" onPress={() => void act.run("feature.cancel", { id: f.id })} /> : null}
        <Btn label="Ask the project manager" onPress={() => go(SCREEN.chat, { project: projectKey, feature: String(f.id) })} />
      </Row>
    </Card>
  );
}

function SpecChange({ s, f }: { s: State; f: any }) {
  const act = useAct();
  if (!f.spec_change_open) return null;
  const spec = s.docs.find((d) => d.feature_id === f.id && d.kind === "spec");
  const change = s.proposals.find((p) => p.feature_id === f.id && p.kind === "change" && p.status === "proposed");
  const step = change ? "The project manager proposed one change set below. Approve it all or nothing." : spec?.status === "in_review" ? "Approve the changed spec below, then the project manager proposes a change set for the tasks." : "The project manager is restating the requirements.";
  return (
    <Card>
      <Row><Badge label="spec changed" tone="warning" /><T bold>A spec change is open</T></Row>
      <T size={13}>The plan and task list are stale and new tasks don't start until the change is settled. {step}</T>
      <Row><Btn label="Discard the change" onPress={() => void act.run("feature.discard_change", { id: f.id })} /></Row>
    </Card>
  );
}

function Questions({ s, f }: { s: State; f: any }) {
  const act = useAct();
  const open = s.questions.filter((x) => x.feature_id === f.id && !x.issue_key);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (!open.length) return null;
  return (
    <Section title={`Clarify: ${open.length} question${open.length === 1 ? "" : "s"}`}>
      {open.map((x) => {
        const k = x.qkey ?? String(x.id);
        const choices = parseJson<string[]>(x.choices, []);
        return (
          <Card key={x.id}>
            <T bold>{x.text}</T>
            {choices.length ? <Choice value={answers[k] ?? ""} onChange={(v) => setAnswers((a) => ({ ...a, [k]: v }))} options={choices.map((c) => ({ value: c, label: c }))} /> : null}
            <Field value={answers[k] ?? ""} onChange={(t) => setAnswers((a) => ({ ...a, [k]: t }))} placeholder={x.recommended ? `Leave blank for the recommendation: ${x.recommended}` : "Your answer"} multiline />
          </Card>
        );
      })}
      <Row>
        <Btn
          label="Send answers"
          kind="primary"
          disabled={act.pending}
          onPress={async () => {
            if (await act.run("feature.answer", { id: f.id, answers })) setAnswers({});
          }}
        />
      </Row>
    </Section>
  );
}

function Docs({ s, f }: { s: State; f: any }) {
  const docs = s.docs.filter((d) => d.feature_id === f.id && d.head_sha);
  const inReview = docs.find((d) => d.status === "in_review");
  const [kind, setKind] = useState<DocKind | null>(null);
  if (!docs.length) return f.stage === "clarify" ? null : <Section title="Documents"><Empty text="The project manager is writing the spec." /></Section>;
  const shown = (kind && docs.some((d) => d.kind === kind) ? kind : (inReview?.kind ?? docs[docs.length - 1]!.kind)) as DocKind;
  const order: DocKind[] = ["spec", "plan", "tasks"];
  return (
    <Section title="Documents">
      <Choice
        value={shown}
        onChange={setKind}
        options={order.filter((k) => docs.some((d) => d.kind === k)).map((k) => {
          const d = docs.find((x) => x.kind === k)!;
          return { value: k, label: `${k}.md · ${d.status.replace("_", " ")}` };
        })}
      />
      <DocView key={shown} s={s} f={f} kind={shown} />
    </Section>
  );
}

function DocView({ s, f, kind }: { s: State; f: any; kind: DocKind }) {
  const action = useRpc(actionRpc);
  const act = useAct();
  const d = s.docs.find((x) => x.feature_id === f.id && x.kind === kind)!;
  const doc = useQuery({ queryKey: ["foundry-doc", f.id, kind, d.head_sha], queryFn: () => action({ action: "feature.doc", args: { id: f.id, kind } }) as Promise<any> });
  const [mode, setMode] = useState<"read" | "revise" | "edit">("read");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const proposal = s.proposals.find((p) => p.feature_id === f.id && p.status === "proposed");
  const data = doc.data && !doc.data.error ? doc.data : null;
  const approve = async () => {
    if (!data) return;
    if (kind === "spec") await act.run("feature.approve_spec", { id: f.id, sha: data.sha });
    else if (kind === "plan") await act.run("feature.approve_plan", { id: f.id, sha: data.sha });
    else if (proposal) await act.run("feature.approve_tasks", { id: f.id, proposal: proposal.id, sha: data.sha });
  };
  const canApprove = d.status === "in_review" && !f.planning_busy && (kind !== "tasks" || (proposal && proposal.tasks_sha));
  return (
    <Card>
      <Row wrap>
        <Badge label={d.status.replace("_", " ")} tone={d.status === "in_review" ? "info" : d.status === "approved" ? "success" : d.status === "stale" ? "warning" : "muted"} />
        <T muted size={12} mono>at {short(d.head_sha)}{d.approved_sha ? ` · approved ${short(d.approved_sha)}` : ""}</T>
      </Row>
      {mode === "edit" ? (
        <>
          <Field value={text} onChange={setText} multiline mono />
          <Row>
            <Btn
              label="Save edit"
              kind="primary"
              disabled={act.pending}
              onPress={async () => {
                if (await act.run("feature.edit_doc", { id: f.id, kind, text, base_sha: data?.sha ?? "" })) setMode("read");
              }}
            />
            <Btn label="Cancel" onPress={() => setMode("read")} />
          </Row>
          <T muted size={12}>Editing an approved spec opens a spec change: the plan and tasks go stale until you approve a change set.</T>
        </>
      ) : !data ? (
        <Loading />
      ) : (
        <Markdown>{data.text || "_Empty._"}</Markdown>
      )}
      {mode === "revise" ? (
        <>
          <Field value={note} onChange={setNote} placeholder={`What should change in ${kind}.md?`} multiline />
          <Row>
            <Btn
              label="Send revision request"
              kind="primary"
              disabled={!note.trim() || act.pending}
              onPress={async () => {
                if (await act.run("feature.revise", { id: f.id, kind, note })) {
                  setNote("");
                  setMode("read");
                }
              }}
            />
            <Btn label="Cancel" onPress={() => setMode("read")} />
          </Row>
        </>
      ) : null}
      {mode === "read" ? (
        <Row wrap>
          {d.status === "in_review" ? <Btn label={`Approve ${kind}.md at ${short(data?.sha)}`} kind="primary" disabled={!canApprove || !data || act.pending} onPress={() => void approve()} /> : null}
          {d.status === "in_review" ? <Btn label="Request a revision" onPress={() => setMode("revise")} /> : null}
          {kind !== "tasks" && data ? (
            <Btn
              label="Edit"
              onPress={() => {
                setText(data.text);
                setMode("edit");
              }}
            />
          ) : null}
        </Row>
      ) : null}
      {f.planning_busy && d.status === "in_review" ? <T muted size={12}>The project manager is still working; approval opens when its turn ends.</T> : null}
    </Card>
  );
}

function Requirements({ s, f }: { s: State; f: any }) {
  const reqs = s.requirements.filter((r) => r.feature_id === f.id);
  if (!reqs.length) return null;
  const issues = s.issues.filter((i) => i.feature_id === f.id && i.status !== "Cancelled");
  return (
    <Section title={`Requirements (${reqs.length})`}>
      {reqs.map((r) => {
        const covering = issues.filter((i) => parseJson<string[]>(i.requirement_refs, []).includes(r.ref));
        return (
          <Card key={r.ref}>
            <Row wrap>
              <T bold>{r.ref}</T>
              <T>{r.title}</T>
              {covering.length ? covering.map((i) => <Badge key={i.key} label={`${i.key} ${i.status.replace("_", " ")}`} tone={STATUS_TONE[i.status]} />) : null}
            </Row>
            {parseJson<string[]>(r.criteria, []).map((c, n) => (
              <T key={n} muted size={13}>• {c}</T>
            ))}
          </Card>
        );
      })}
    </Section>
  );
}

const TAG_TONE: Record<string, "muted" | "success" | "warning" | "danger" | "info"> = { keep: "muted", update: "info", new: "success", cancel: "danger", flag: "warning", followup: "info", removal: "warning" };

function Proposal({ s, f }: { s: State; f: any }) {
  const act = useAct();
  const p = s.proposals.find((x) => x.feature_id === f.id && x.status === "proposed");
  if (!p) return null;
  const tasks = parseJson<any[]>(p.tasks, []);
  const result = parseJson<any>(p.result, {});
  const cut = parseJson<string[]>(p.cut, []);
  const change = p.kind === "change";
  return (
    <Section title={change ? "Change set (approve it on the task list)" : "Proposed tasks (approve them on the task list)"}>
      {(result.warnings ?? []).map((w: string, i: number) => (
        <T key={i} size={13}>⚠ {w}</T>
      ))}
      {tasks.map((t, i) => {
        const id = t.issue ?? t.ref;
        const isCut = cut.includes(t.ref);
        return (
          <Card key={i} style={{ opacity: isCut ? 0.5 : 1 }}>
            <Row wrap>
              {t.tag ? <Badge label={t.tag} tone={TAG_TONE[t.tag]} /> : null}
              <T bold>{id}</T>
              <T>{t.title || s.issues.find((x) => x.key === t.issue)?.title || ""}</T>
              {t.size ? <Badge label={t.size} /> : null}
              {isCut ? <Badge label="cut" tone="warning" /> : null}
            </Row>
            {t.description ? <T muted size={13}>{t.description}</T> : null}
            <T muted size={12}>
              {(t.requirement_refs ?? []).length ? `Covers ${(t.requirement_refs ?? []).join(", ")}` : ""}
              {(t.depends_on ?? []).length ? ` · after ${(t.depends_on ?? []).map((d: any) => d.ref).join(", ")}` : ""}
            </T>
            {!change && f.stage === "tasks" ? (
              <Row><Btn label={isCut ? "Put back" : "Cut"} onPress={() => void act.run("feature.cut_task", { id: f.id, ref: t.ref, cut: !isCut })} /></Row>
            ) : null}
          </Card>
        );
      })}
    </Section>
  );
}

function Tasks({ s, f }: { s: State; f: any }) {
  const issues = s.issues.filter((i) => i.feature_id === f.id);
  if (!issues.length) return null;
  return (
    <Section title={`Tasks (${issues.length})`}>
      {issues.map((i) => (
        <Card key={i.key} onPress={() => go(SCREEN.issue, { key: i.key })}>
          <Row wrap>
            <T bold>{i.key}</T>
            <T>{i.title}</T>
            <Badge label={i.status.replace("_", " ")} tone={STATUS_TONE[i.status]} />
            {i.flag ? <Badge label={i.flag} tone="warning" /> : null}
            {i.status === "In_Review" ? <Badge label="review it" tone="info" /> : null}
          </Row>
          {i.reason ? <T muted size={12}>{i.reason}</T> : null}
        </Card>
      ))}
    </Section>
  );
}

function Delivery({ s, f }: { s: State; f: any }) {
  const act = useAct();
  const toast = useToast();
  const v = s.verifications.find((x) => x.feature_id === f.id);
  const ship = parseJson<any>(s.ships.find((x) => x.key === `ship:${f.id}`)?.value, null);
  const [needConfirm, setNeedConfirm] = useState<string | null>(null);
  const [form, setForm] = useState<{ title: string; description: string; refs: string } | null>(null);
  if (!["build", "verify", "ship", "done"].includes(f.stage) && !v) return null;
  const checks = parseJson<any[]>(v?.checks, []);
  const reqs = parseJson<any[]>(v?.requirements, []);
  const accept = async (confirm: boolean) => {
    const r = await act.attempt("feature.accept_ship", { id: f.id, head_sha: ship.sha, tree_sha: ship.tree, confirm });
    if (r.error?.code === "BASE_CHECKED_OUT") setNeedConfirm(r.error.message);
    else {
      setNeedConfirm(null);
      if (r.error) toast.error(`${r.error.code}: ${r.error.message}`);
    }
  };
  return (
    <Section title="Verify and Ship">
      {v ? (
        <Card>
          <Row wrap>
            <T bold>Verify</T>
            <Badge label={v.status} tone={v.status === "passed" ? "success" : v.status === "running" ? "info" : "danger"} />
            {v.failure ? <Badge label={v.failure} tone="danger" /> : null}
            <T muted size={12} mono>on {short(v.head_sha)}</T>
          </Row>
          {checks.map((c, i) => (
            <T key={i} size={13}>{c.status === "passed" ? "✓" : "✗"} check {c.name}{c.status !== "passed" && c.tail ? `: ${String(c.tail).slice(-300)}` : ""}</T>
          ))}
          {reqs.map((r, i) => (
            <T key={i} size={13}>{r.passed ? "✓" : "✗"} {r.requirement_ref}: {r.evidence}</T>
          ))}
        </Card>
      ) : (
        <T muted>Verify runs when every task is Done.</T>
      )}
      <Row wrap>
        {f.stage === "verify" && v?.status === "failed" ? <Btn label="Ship with the gaps" onPress={() => void act.run("feature.ship_with_gaps", { id: f.id })} /> : null}
        {f.stage === "verify" && v?.status === "failed" ? <Btn label="Turn a failure into a task" onPress={() => setForm({ title: "", description: "", refs: reqs.filter((r) => !r.passed).map((r) => r.requirement_ref).join(", ") })} /> : null}
        {f.stage === "verify" && v?.status !== "running" ? <Btn label="Run Verify again" onPress={() => void act.run("feature.verify", { id: f.id, force: true })} /> : null}
        {f.stage === "ship" && !ship ? <Btn label="Prepare the ship" kind="primary" onPress={() => void act.run("feature.prepare_ship", { id: f.id })} /> : null}
      </Row>
      {form ? (
        <Card>
          <T bold>New task from the failure</T>
          <Field value={form.title} onChange={(t) => setForm({ ...form, title: t })} placeholder="Title" />
          <Field value={form.description} onChange={(t) => setForm({ ...form, description: t })} placeholder="What to fix" multiline />
          <Field value={form.refs} onChange={(t) => setForm({ ...form, refs: t })} placeholder="Requirements, e.g. R2, R3" />
          <Row>
            <Btn
              label="Create task"
              kind="primary"
              disabled={!form.title.trim() || act.pending}
              onPress={async () => {
                const refs = form.refs.split(/[\s,]+/).filter(Boolean);
                if (await act.run("feature.task_from_failure", { id: f.id, title: form.title, description: form.description, requirement_refs: refs })) setForm(null);
              }}
            />
            <Btn label="Cancel" onPress={() => setForm(null)} />
          </Row>
        </Card>
      ) : null}
      {f.stage === "ship" && ship ? (
        <Card>
          <T bold>Ship by local merge</T>
          <T size={13}>Merges {f.branch} at {short(ship.sha)} into the project's base branch.</T>
          {needConfirm ? <T size={13}>⚠ {needConfirm}</T> : null}
          <Row wrap>
            <Btn label={`Ship ${short(ship.sha)}`} kind="primary" disabled={act.pending} onPress={() => void accept(false)} />
            {needConfirm ? <Btn label="Merge there anyway" kind="danger" disabled={act.pending} onPress={() => void accept(true)} /> : null}
          </Row>
        </Card>
      ) : null}
      {f.stage === "done" ? <T>Shipped.</T> : null}
    </Section>
  );
}
