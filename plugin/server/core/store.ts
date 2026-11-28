// Foundry's durable store: SQLite in the plugin process (node:sqlite). Host-independent.
// The schema follows the behaviour spec's domain model. Migrations are numbered and only ever appended.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  assertTransition,
  FoundryError,
  type Actor,
  type AttemptOutcome,
  type AttemptStep,
  type CardStatus,
  type DocKind,
  type DocStatus,
  type FeatureFlow,
  type FeatureStage,
  type FeatureStatus,
  type IssueOrigin,
  type IssueStatus,
  type ReasonCode,
  type Role,
  type RunKind,
  type RunStatus,
  type Size,
} from "./model";

// ---------- Row types ----------

export interface Project {
  id: number;
  key: string;
  name: string;
  repo: string;
  base_ref: string;
  default_loop: string | null;
  next_issue_n: number;
  ship_mode: ShipMode;
  created_at: string;
}

/** pr: push the feature branch and open a GitHub PR with gh (a local merge when the repo has no remote). */
export type ShipMode = "pr" | "local_merge";
export const SHIP_MODES: readonly ShipMode[] = ["pr", "local_merge"];

export interface Feature {
  id: number;
  project_id: number;
  slug: string;
  title: string;
  idea: string;
  flow: FeatureFlow;
  stage: FeatureStage;
  status: FeatureStatus;
  branch: string;
  integration_workspace_id: string | null;
  integration_path: string | null;
  planner_agent_id: string | null;
  spec_change_open: number;
  /** The feature branch head Foundry last wrote; anything else at accept means a merge outside Foundry. */
  head_sha: string | null;
  /** none | light | normal; null means light. */
  grill: string | null;
  clarify_rounds: number;
  /** Why the PM's last planning turn failed, until a turn succeeds. */
  planning_error: string | null;
  /** 1 for the first delivery; a reopened Done feature is on round 2, 3, ... (its branch gets -r<round>). */
  round: number;
  created_at: string;
  updated_at: string;
}

export type SliceStatus = "planned" | "building" | "verify" | "ship" | "shipped" | "cancelled";

export interface Slice {
  id: number;
  feature_id: number;
  /** Its place in the merge order: 1 merges first. */
  n: number;
  title: string;
  goal: string;
  requirement_refs: string; // JSON string[]
  status: SliceStatus;
  branch: string | null;
  workspace_id: string | null;
  path: string | null;
  head_sha: string | null;
  pr: string | null;
  shipped_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeatureDoc {
  feature_id: number;
  kind: DocKind;
  status: DocStatus;
  head_sha: string | null;
  approved_sha: string | null;
}

export interface Requirement {
  feature_id: number;
  ref: string;
  title: string;
  criteria: string; // JSON string[]
  spec_sha: string | null;
  retired: number;
}

export interface Issue {
  key: string;
  project_id: number;
  feature_id: number | null;
  origin: IssueOrigin;
  title: string;
  description: string;
  acceptance: string;
  status: IssueStatus;
  reason: ReasonCode | null;
  priority: number;
  size: Size | null;
  loop: string | null;
  checks: string; // JSON
  touches: string; // JSON string[]
  requirement_refs: string; // JSON string[]
  profile: string | null;
  max_fix_rounds: number | null;
  flag: string | null;
  /** The slice of its feature it ships in (null for quick tasks). */
  slice_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface IssueDep {
  issue_key: string;
  depends_on: string;
  reason: string;
}

export interface Attempt {
  id: number;
  issue_key: string;
  n: number;
  branch: string;
  workspace_id: string | null;
  worktree_path: string | null;
  builder_agent_id: string | null;
  reviewer_agent_id: string | null;
  check_workspace_id: string | null;
  check_path: string | null;
  loop: string | null; // JSON: the loop definition frozen from base at start
  step: AttemptStep;
  step_index: number;
  outcome: AttemptOutcome | null;
  flag: string | null;
  fix_rounds: number;
  reworks: number;
  head_sha: string | null;
  tree_sha: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface Run {
  id: number;
  attempt_id: number | null;
  feature_id: number | null;
  kind: RunKind;
  agent_id: string | null;
  status: RunStatus;
  sha: string | null;
  detail: string; // JSON
  started_at: string;
  ended_at: string | null;
}

export interface AgentRecord {
  agent_id: string;
  role: Role;
  project_id: number | null;
  feature_id: number | null;
  issue_key: string | null;
  attempt_id: number | null;
  workspace_id: string | null;
  created_at: string;
}

export type CommentStatus = "saved" | "sent" | "resolved";
export interface DocComment {
  id: number;
  feature_id: number;
  doc: DocKind;
  sha: string;
  line: number;
  quote: string;
  body: string;
  author: "you" | "pm";
  status: CommentStatus;
  created_at: string;
  sent_at: string | null;
  resolved_at: string | null;
}

export interface Question {
  id: number;
  issue_key: string | null;
  attempt_id: number | null;
  feature_id: number | null;
  agent_id: string;
  text: string;
  choices: string; // JSON
  status: "live" | "waiting" | "answered" | "closed";
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
  /** Clarify questions: the PM's id for the question, its recommended answer and the round. */
  qkey: string | null;
  recommended: string | null;
  round: number | null;
}

export interface SpecChange {
  id: number;
  feature_id: number;
  status: "open" | "approved" | "discarded";
  base_spec_sha: string | null;
  diff: string; // JSON RequirementDiff, set when the changed spec is approved
  created_at: string;
  decided_at: string | null;
}

export interface TaskProposal {
  id: number;
  feature_id: number;
  kind: string;
  tasks: string; // JSON ProposedTask[]
  tasks_sha: string | null;
  status: "proposed" | "superseded" | "approved";
  result: string; // JSON: waves, critical path, warnings
  cut: string; // JSON string[] of cut refs
  slices: string; // JSON ProposedSlice[] (as the PM proposed them, then as you edited them)
  created_at: string;
}

export interface Card {
  id: number;
  project_id: number;
  kind: string;
  actions: string; // JSON
  reason: string;
  warnings: string; // JSON string[]
  status: CardStatus;
  result: string | null;
  created_at: string;
  decided_at: string | null;
  thread: string;
  decided_by: Actor | null;
}

export interface ChatMessage {
  id: number;
  project_id: number;
  thread: string;
  /** you | pm | system (Foundry's own reports, such as triage) | card */
  role: string;
  text: string;
  card_id: number | null;
  context: string | null;
  created_at: string;
}

export interface PmThread {
  project_id: number;
  thread: string;
  agent_id: string | null;
  busy: number;
  /** The last chat message id the PM's session has received. */
  delivered_id: number;
  last_turn_at: string | null;
}

export interface EventRow {
  id: number;
  at: string;
  actor: Actor;
  kind: string;
  project_id: number | null;
  feature_id: number | null;
  issue_key: string | null;
  attempt_id: number | null;
  detail: string; // JSON
}

export interface EventOpts {
  actor?: Actor;
  project?: number | null;
  feature?: number | null;
  issue?: string | null;
  attempt?: number | null;
  detail?: unknown;
}

// ---------- Migrations ----------

export const MIGRATIONS: readonly string[] = [
  // 1: the spec's model, M1 cut
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, repo TEXT NOT NULL UNIQUE,
    base_ref TEXT NOT NULL, default_loop TEXT, next_issue_n INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE features (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), slug TEXT NOT NULL,
    title TEXT NOT NULL, idea TEXT NOT NULL, flow TEXT NOT NULL DEFAULT 'standard',
    stage TEXT NOT NULL DEFAULT 'clarify', status TEXT NOT NULL DEFAULT 'active', branch TEXT NOT NULL,
    integration_workspace_id TEXT, integration_path TEXT, planner_agent_id TEXT,
    spec_change_open INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, slug));
  CREATE TABLE feature_docs (
    feature_id INTEGER NOT NULL REFERENCES features(id), kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'drafting',
    head_sha TEXT, approved_sha TEXT, PRIMARY KEY(feature_id, kind));
  CREATE TABLE requirements (
    feature_id INTEGER NOT NULL REFERENCES features(id), ref TEXT NOT NULL, title TEXT NOT NULL,
    criteria TEXT NOT NULL DEFAULT '[]', spec_sha TEXT, retired INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(feature_id, ref));
  CREATE TABLE task_proposals (
    id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id), kind TEXT NOT NULL DEFAULT 'initial',
    tasks TEXT NOT NULL, tasks_sha TEXT, status TEXT NOT NULL DEFAULT 'proposed',
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE issues (
    key TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), feature_id INTEGER REFERENCES features(id),
    origin TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, reason TEXT, priority INTEGER NOT NULL DEFAULT 50, size TEXT, loop TEXT,
    checks TEXT NOT NULL DEFAULT '{}', touches TEXT NOT NULL DEFAULT '[]', requirement_refs TEXT NOT NULL DEFAULT '[]',
    profile TEXT, max_fix_rounds INTEGER, flag TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE issue_deps (
    issue_key TEXT NOT NULL REFERENCES issues(key), depends_on TEXT NOT NULL REFERENCES issues(key),
    reason TEXT NOT NULL DEFAULT '', PRIMARY KEY(issue_key, depends_on));
  CREATE TABLE attempts (
    id INTEGER PRIMARY KEY, issue_key TEXT NOT NULL REFERENCES issues(key), n INTEGER NOT NULL, branch TEXT NOT NULL,
    workspace_id TEXT, worktree_path TEXT, builder_agent_id TEXT, reviewer_agent_id TEXT,
    check_workspace_id TEXT, check_path TEXT, loop TEXT, step TEXT NOT NULL DEFAULT 'setup',
    step_index INTEGER NOT NULL DEFAULT 0, outcome TEXT, flag TEXT,
    fix_rounds INTEGER NOT NULL DEFAULT 0, reworks INTEGER NOT NULL DEFAULT 0, head_sha TEXT, tree_sha TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT, UNIQUE(issue_key, n));
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY, attempt_id INTEGER REFERENCES attempts(id), feature_id INTEGER REFERENCES features(id),
    kind TEXT NOT NULL, agent_id TEXT, status TEXT NOT NULL DEFAULT 'running', sha TEXT, detail TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT);
  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY, attempt_id INTEGER REFERENCES attempts(id), feature_id INTEGER REFERENCES features(id),
    actor TEXT NOT NULL, decision TEXT NOT NULL, head_sha TEXT, tree_sha TEXT, feedback TEXT NOT NULL DEFAULT '',
    findings TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY, role TEXT NOT NULL, project_id INTEGER, feature_id INTEGER, issue_key TEXT,
    attempt_id INTEGER, workspace_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE questions (
    id INTEGER PRIMARY KEY, issue_key TEXT, attempt_id INTEGER, feature_id INTEGER, agent_id TEXT NOT NULL,
    text TEXT NOT NULL, choices TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'live', answer TEXT,
    asked_at TEXT NOT NULL DEFAULT (datetime('now')), answered_at TEXT);
  CREATE TABLE cards (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), kind TEXT NOT NULL,
    actions TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', warnings TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'proposed', result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT);
  CREATE TABLE chat (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), thread TEXT NOT NULL DEFAULT 'main',
    role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE events (
    id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT NOT NULL, kind TEXT NOT NULL,
    project_id INTEGER, feature_id INTEGER, issue_key TEXT, attempt_id INTEGER, detail TEXT NOT NULL DEFAULT '{}');
  CREATE INDEX events_issue ON events(issue_key);
  CREATE INDEX events_feature ON events(feature_id);
  CREATE INDEX attempts_issue ON attempts(issue_key);
  CREATE INDEX runs_attempt ON runs(attempt_id);
  `,
  // 2: the feature branch head Foundry last wrote, to catch merges made outside Foundry
  `ALTER TABLE features ADD COLUMN head_sha TEXT;`,
  // 3: planning (loop 1): Clarify rounds, grill level, planning failures, task proposal results
  `ALTER TABLE features ADD COLUMN grill TEXT;
   ALTER TABLE features ADD COLUMN clarify_rounds INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE features ADD COLUMN planning_error TEXT;
   ALTER TABLE questions ADD COLUMN qkey TEXT;
   ALTER TABLE questions ADD COLUMN recommended TEXT;
   ALTER TABLE questions ADD COLUMN round INTEGER;
   ALTER TABLE task_proposals ADD COLUMN result TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE task_proposals ADD COLUMN cut TEXT NOT NULL DEFAULT '[]';`,
  // 4: spec changes after the task list exists, and the requirements as last approved
  `CREATE TABLE spec_changes (
     id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id), status TEXT NOT NULL DEFAULT 'open',
     base_spec_sha TEXT, diff TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT);
   CREATE TABLE approved_requirements (
     feature_id INTEGER NOT NULL REFERENCES features(id), ref TEXT NOT NULL, title TEXT NOT NULL,
     criteria TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(feature_id, ref));
   INSERT INTO approved_requirements(feature_id,ref,title,criteria)
     SELECT feature_id,ref,title,criteria FROM requirements WHERE retired=0 AND spec_sha IS NOT NULL;`,
  // 5: Verify runs (checks on the merged head plus the reviewer's per-requirement report)
  `CREATE TABLE verifications (
     id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id), head_sha TEXT,
     status TEXT NOT NULL DEFAULT 'running', failure TEXT, checks TEXT NOT NULL DEFAULT '[]',
     requirements TEXT NOT NULL DEFAULT '[]', workspace_id TEXT, path TEXT, reviewer_agent_id TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT);
   CREATE INDEX verifications_feature ON verifications(feature_id);`,
  // 6: the PM chat (threads as harness sessions) and its cards
  `CREATE TABLE pm_threads (
     project_id INTEGER NOT NULL REFERENCES projects(id), thread TEXT NOT NULL, agent_id TEXT,
     busy INTEGER NOT NULL DEFAULT 0, delivered_id INTEGER NOT NULL DEFAULT 0, last_turn_at TEXT,
     PRIMARY KEY(project_id, thread));
   ALTER TABLE chat ADD COLUMN card_id INTEGER;
   ALTER TABLE chat ADD COLUMN context TEXT;
   ALTER TABLE cards ADD COLUMN thread TEXT NOT NULL DEFAULT 'main';
   ALTER TABLE cards ADD COLUMN decided_by TEXT;
   CREATE INDEX chat_thread ON chat(project_id, thread, id);`,
  // 7: onboarding (install record, acknowledgements) and the entries Foundry added to Paseo's config
  `CREATE TABLE onboarding (key TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE TABLE paseo_owned (
     kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(kind, id));`,
  // 8: every branch Foundry had Paseo create (Paseo names them now), for the uninstall list
  `CREATE TABLE branches (
     repo TEXT NOT NULL, branch TEXT NOT NULL, purpose TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(repo, branch));`,
  // 9: comments on lines of a feature's docs (yours, saved then sent in a revision request; or the PM's)
  `CREATE TABLE doc_comments (
     id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id), doc TEXT NOT NULL,
     sha TEXT NOT NULL, line INTEGER NOT NULL, quote TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
     author TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'saved', created_at TEXT NOT NULL DEFAULT (datetime('now')),
     sent_at TEXT);
   CREATE INDEX doc_comments_feature ON doc_comments(feature_id, doc);`,
  // 10: resolving a comment (status 'resolved', and when)
  `ALTER TABLE doc_comments ADD COLUMN resolved_at TEXT;`,
  // 11: how a project ships a feature. New projects open a GitHub PR when the repo has a remote; projects
  // that already existed keep merging locally, as they did before.
  `ALTER TABLE projects ADD COLUMN ship_mode TEXT NOT NULL DEFAULT 'pr';
   UPDATE projects SET ship_mode='local_merge';`,
  // 12: which delivery a feature is on. A Done feature whose spec you edit reopens on a new branch (round 2, 3, ...).
  `ALTER TABLE features ADD COLUMN round INTEGER NOT NULL DEFAULT 1;`,
  // 13: slices. A feature ships as an ordered chain of slices, each a group of its tasks with its own
  // Verify and PR. Every feature that already has tasks becomes a one-slice feature on its own branch.
  `CREATE TABLE slices (
     id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id), n INTEGER NOT NULL,
     title TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', requirement_refs TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'planned', branch TEXT, workspace_id TEXT, path TEXT, head_sha TEXT,
     pr TEXT, shipped_sha TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE(feature_id, n));
   ALTER TABLE issues ADD COLUMN slice_id INTEGER REFERENCES slices(id);
   ALTER TABLE verifications ADD COLUMN slice_id INTEGER REFERENCES slices(id);
   ALTER TABLE task_proposals ADD COLUMN slices TEXT NOT NULL DEFAULT '[]';
   INSERT INTO slices(feature_id,n,title,requirement_refs,status,branch,workspace_id,path,head_sha)
     SELECT f.id, 1, f.title,
       COALESCE((SELECT json_group_array(r.ref) FROM requirements r WHERE r.feature_id=f.id AND r.retired=0), '[]'),
       CASE WHEN f.status='cancelled' THEN 'cancelled' WHEN f.stage='done' THEN 'shipped' WHEN f.stage IN ('verify','ship') THEN f.stage ELSE 'building' END,
       f.branch, f.integration_workspace_id, f.integration_path, f.head_sha
     FROM features f WHERE EXISTS (SELECT 1 FROM issues i WHERE i.feature_id=f.id);
   UPDATE issues SET slice_id=(SELECT s.id FROM slices s WHERE s.feature_id=issues.feature_id AND s.n=1) WHERE feature_id IS NOT NULL;
   UPDATE verifications SET slice_id=(SELECT s.id FROM slices s WHERE s.feature_id=verifications.feature_id AND s.n=1);`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
/** Marks a database as Foundry-on-Paseo's own. */
export const STORE_APP = "foundry-paseo";
/** Pre-upgrade copies kept beside the database. */
export const BACKUPS_KEPT = 5;

const json = (v: unknown) => JSON.stringify(v ?? null);

export class Store {
  readonly db: DatabaseSync;
  /** Called after every event row is written, so the host can mirror it (timeline rows, badges, notifications). */
  onEvent?: (row: EventRow) => void;

  constructor(private readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.refuseForeign();
    } catch (e) {
      this.db.close();
      throw e;
    }
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  /** Checks that change nothing: another program's database, or one newer than this plugin, is refused as it is. */
  private refuseForeign() {
    // Refuse a database another program made (an older Foundry, a prototype) instead of migrating over it.
    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    if (tables.length) {
      const has = (t: string) => tables.includes(t);
      const metaVal = (k: string) => (has("meta") ? (this.db.prepare("SELECT value FROM meta WHERE key=?").get(k) as { value: string } | undefined)?.value : undefined);
      const ours = metaVal("app") === STORE_APP || (metaVal("schema_version") !== undefined && has("feature_docs"));
      if (!ours)
        throw new FoundryError(
          "STORE_FOREIGN",
          `${this.path} was made by another program (tables: ${tables.slice(0, 6).join(", ")}${tables.length > 6 ? ", …" : ""}). ` +
            "Foundry won't change it. Move it aside, or set FOUNDRY_HOME to another folder for Foundry's data.",
        );
    }
    const v = this.schemaVersion();
    if (!Number.isInteger(v) || v < 0) throw new FoundryError("STORE_INVALID", `${this.path} has an unreadable schema version. Foundry won't change it.`);
    if (v > MIGRATIONS.length)
      throw new FoundryError("STORE_TOO_NEW", `${this.path} is at schema ${v}, newer than this plugin (${MIGRATIONS.length}). Update the plugin; Foundry won't change the database.`);
  }

  private schemaVersion(): number {
    const hasMeta = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
    const row = hasMeta ? (this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined) : undefined;
    return row ? Number(row.value) : 0;
  }

  /**
   * Bring the database to the current schema without ever losing data:
   * - a database newer than this plugin is refused untouched (a downgrade never rewrites it);
   * - before upgrading an existing database, a consistent copy is written beside it
   *   (foundry.db.backup-v<from>-<time>), and the newest few copies are kept;
   * - each migration runs in its own transaction with the version bump, so a failure leaves the
   *   database at the last version that applied fully, and the next start retries from there.
   * Migrations are append-only: never edit or reorder one that has shipped.
   */
  private migrate() {
    let v = this.schemaVersion();
    if (v > 0 && v < MIGRATIONS.length) this.backup(v);
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.prepare("INSERT INTO meta(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(STORE_APP);
    while (v < MIGRATIONS.length) {
      const from = v;
      try {
        this.tx(() => {
          this.db.exec(MIGRATIONS[from]!);
          this.db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(from + 1));
        });
      } catch (e) {
        throw new FoundryError("MIGRATION_FAILED", `Upgrading ${this.path} from schema ${from} to ${from + 1} failed and was rolled back; the database is unchanged at schema ${from}. ${String((e as Error)?.message ?? e)}`);
      }
      v = from + 1;
    }
  }

  // ---------- branches Foundry made ----------
  recordBranch(repo: string, branch: string, purpose: string) {
    if (branch) this.run("INSERT OR IGNORE INTO branches(repo,branch,purpose) VALUES(?,?,?)", repo, branch, purpose);
  }
  /** Branches Foundry made in a repo: the ones it recorded, plus feature, task and PM branches from before recording. */
  branchesMade(repo: string): string[] {
    const rows = this.all<{ b: string }>(
      `SELECT branch b FROM branches WHERE repo=?
       UNION SELECT f.branch FROM features f JOIN projects p ON p.id=f.project_id WHERE p.repo=? AND f.branch<>''
       UNION SELECT a.branch FROM attempts a JOIN issues i ON i.key=a.issue_key JOIN projects p ON p.id=i.project_id WHERE p.repo=? AND a.branch<>''`,
      repo,
      repo,
      repo,
    );
    return rows.map((r) => r.b).sort();
  }

  // ---------- onboarding ----------
  onboarding(key: string): { value: string; at: string } | undefined {
    return this.get<{ value: string; at: string }>("SELECT value, at FROM onboarding WHERE key=?", key);
  }
  onboardingAll(): { key: string; value: string; at: string }[] {
    return this.all("SELECT key, value, at FROM onboarding ORDER BY key");
  }
  setOnboarding(key: string, value: string) {
    this.run("INSERT INTO onboarding(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, at=datetime('now')", key, value);
  }
  /** Paseo config entries Foundry created (kind "profile" or "provider"), with the value as written. */
  owned(): { kind: string; id: string; value: string; at: string }[] {
    return this.all("SELECT kind, id, value, at FROM paseo_owned ORDER BY kind, id");
  }
  addOwned(kind: string, id: string, value: unknown) {
    this.run("INSERT INTO paseo_owned(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value, at=datetime('now')", kind, id, json(value));
  }
  removeOwned(kind: string, id: string) {
    this.run("DELETE FROM paseo_owned WHERE kind=? AND id=?", kind, id);
  }

  /**
   * Development only: copy the database to `backupPath`, then empty every table so Foundry starts as a
   * fresh install. The schema and the app marker stay, so nothing is migrated again.
   */
  wipe(backupPath: string) {
    if (this.path !== ":memory:") this.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'meta'").all() as { name: string }[]).map((t) => t.name);
    this.db.exec("PRAGMA foreign_keys=OFF");
    try {
      this.tx(() => {
        for (const t of tables) this.db.exec(`DELETE FROM "${t}"`);
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) this.db.exec("DELETE FROM sqlite_sequence");
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys=ON");
    }
  }

  /** A consistent copy of the database before an upgrade; keeps the newest BACKUPS_KEPT. */
  private backup(fromVersion: number) {
    if (this.path === ":memory:") return;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    const target = `${this.path}.backup-v${fromVersion}-${stamp}`;
    if (!existsSync(target)) this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const dir = dirname(this.path);
    const prefix = `${basename(this.path)}.backup-`;
    const old = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(BACKUPS_KEPT)
      .map((x) => x.f);
    for (const f of old) rmSync(join(dir, f), { force: true });
  }


  // ---------- low level ----------
  run(sql: string, ...p: SQLInputValue[]) {
    return this.db.prepare(sql).run(...p);
  }
  get<T>(sql: string, ...p: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...p) as T | undefined;
  }
  all<T>(sql: string, ...p: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...p) as T[];
  }
  private depth = 0;
  /** Run fn in one transaction (nested calls join the outer one). All-or-nothing writes go through here. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  // ---------- settings ----------
  setting(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM settings WHERE key=?", key)?.value;
  }
  setSetting(key: string, value: string) {
    this.run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
  }

  // ---------- events ----------
  event(kind: string, o: EventOpts = {}): number {
    const r = this.run(
      "INSERT INTO events(actor,kind,project_id,feature_id,issue_key,attempt_id,detail) VALUES(?,?,?,?,?,?,?)",
      o.actor ?? "system",
      kind,
      o.project ?? null,
      o.feature ?? null,
      o.issue ?? null,
      o.attempt ?? null,
      json(o.detail ?? {}),
    );
    const id = Number(r.lastInsertRowid);
    if (this.onEvent) {
      const row = this.get<EventRow>("SELECT * FROM events WHERE id=?", id)!;
      try {
        this.onEvent(row);
      } catch {
        // mirroring must never break the write path
      }
    }
    return id;
  }
  events(filter: { issue?: string; feature?: number; sinceId?: number; limit?: number } = {}): EventRow[] {
    const where: string[] = [];
    const p: SQLInputValue[] = [];
    if (filter.issue) (where.push("issue_key=?"), p.push(filter.issue));
    if (filter.feature) (where.push("feature_id=?"), p.push(filter.feature));
    if (filter.sinceId) (where.push("id>?"), p.push(filter.sinceId));
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return this.all<EventRow>(sql, ...p, filter.limit ?? 200).reverse();
  }

  // ---------- projects ----------
  createProject(p: { key: string; name: string; repo: string; baseRef: string }): Project {
    if (!/^[A-Z]{2,5}$/.test(p.key)) throw new FoundryError("INVALID_KEY", "A project key is 2 to 5 capital letters");
    if (this.get("SELECT 1 FROM projects WHERE key=?", p.key)) throw new FoundryError("KEY_TAKEN", `Key ${p.key} is already used`);
    const r = this.run("INSERT INTO projects(key,name,repo,base_ref) VALUES(?,?,?,?)", p.key, p.name, p.repo, p.baseRef);
    const project = this.project(Number(r.lastInsertRowid))!;
    this.event("project_created", { actor: "you", project: project.id, detail: { key: p.key, repo: p.repo } });
    return project;
  }
  project(id: number) {
    return this.get<Project>("SELECT * FROM projects WHERE id=?", id);
  }
  setShipMode(id: number, mode: ShipMode, actor: Actor = "you") {
    if (!SHIP_MODES.includes(mode)) throw new FoundryError("INVALID_SHIP_MODE", `Ship mode is ${SHIP_MODES.join(" or ")}`);
    const p = this.project(id);
    if (!p) throw new FoundryError("NOT_FOUND", `No project ${id}`);
    this.run("UPDATE projects SET ship_mode=? WHERE id=?", mode, id);
    this.event("project_ship_mode", { actor, project: id, detail: { from: p.ship_mode, to: mode } });
    return this.project(id)!;
  }
  projectByKey(key: string) {
    return this.get<Project>("SELECT * FROM projects WHERE key=?", key);
  }
  projects() {
    return this.all<Project>("SELECT * FROM projects ORDER BY id");
  }

  // ---------- features ----------
  createFeature(f: { projectId: number; slug: string; title: string; idea: string; flow: FeatureFlow; branch: string }): Feature {
    return this.tx(() => {
      const r = this.run(
        "INSERT INTO features(project_id,slug,title,idea,flow,branch) VALUES(?,?,?,?,?,?)",
        f.projectId,
        f.slug,
        f.title,
        f.idea,
        f.flow,
        f.branch,
      );
      const id = Number(r.lastInsertRowid);
      for (const kind of ["spec", "plan", "tasks"] as DocKind[]) this.run("INSERT INTO feature_docs(feature_id,kind) VALUES(?,?)", id, kind);
      this.event("feature_created", { actor: "you", project: f.projectId, feature: id, detail: { slug: f.slug, title: f.title } });
      return this.feature(id)!;
    });
  }
  feature(id: number) {
    return this.get<Feature>("SELECT * FROM features WHERE id=?", id);
  }
  featureBySlug(projectId: number, slug: string) {
    return this.get<Feature>("SELECT * FROM features WHERE project_id=? AND slug=?", projectId, slug);
  }
  features(projectId?: number) {
    return projectId
      ? this.all<Feature>("SELECT * FROM features WHERE project_id=? ORDER BY id", projectId)
      : this.all<Feature>("SELECT * FROM features ORDER BY id");
  }
  updateFeature(id: number, patch: Partial<Omit<Feature, "id" | "project_id" | "created_at">>) {
    this.patch("features", "id", id, { ...patch, updated_at: new Date().toISOString() });
  }
  setStage(id: number, stage: FeatureStage, actor: Actor = "system") {
    const f = this.feature(id)!;
    if (f.stage === stage) return;
    this.updateFeature(id, { stage });
    // The slice at the front of the merge order follows the feature through Build, Verify and Ship
    // (core/slices.ts moves the slices behind it); Done ships every slice.
    const front = this.get<Slice>("SELECT * FROM slices WHERE feature_id=? AND status NOT IN ('shipped','cancelled') ORDER BY n LIMIT 1", id);
    const map: Partial<Record<FeatureStage, SliceStatus>> = { build: "building", verify: "verify", ship: "ship" };
    if (stage === "done") this.run("UPDATE slices SET status='shipped', shipped_sha=COALESCE(shipped_sha, ?), updated_at=datetime('now') WHERE feature_id=? AND status NOT IN ('shipped','cancelled')", f.head_sha, id);
    else if (front && map[stage]) this.updateSlice(front.id, { status: map[stage]! });
    this.event("stage_changed", { actor, project: f.project_id, feature: id, detail: { from: f.stage, to: stage } });
  }
  doc(featureId: number, kind: DocKind) {
    return this.get<FeatureDoc>("SELECT * FROM feature_docs WHERE feature_id=? AND kind=?", featureId, kind)!;
  }
  docs(featureId: number) {
    return this.all<FeatureDoc>("SELECT * FROM feature_docs WHERE feature_id=? ORDER BY kind", featureId);
  }
  updateDoc(featureId: number, kind: DocKind, patch: Partial<Pick<FeatureDoc, "status" | "head_sha" | "approved_sha">>) {
    const sets = Object.keys(patch).map((k) => `${k}=?`);
    if (!sets.length) return;
    this.run(`UPDATE feature_docs SET ${sets.join(",")} WHERE feature_id=? AND kind=?`, ...(Object.values(patch) as SQLInputValue[]), featureId, kind);
  }
  requirements(featureId: number, includeRetired = false) {
    return this.all<Requirement>(
      `SELECT * FROM requirements WHERE feature_id=? ${includeRetired ? "" : "AND retired=0"} ORDER BY ref`,
      featureId,
    );
  }  /** Replace a feature's live requirements (propose_requirements). */
  setRequirements(featureId: number, reqs: { ref: string; title: string; criteria: string[] }[], specSha: string | null) {
    this.tx(() => {
      this.run("DELETE FROM requirements WHERE feature_id=? AND retired=0", featureId);
      for (const r of reqs)
        this.run("INSERT OR REPLACE INTO requirements(feature_id,ref,title,criteria,spec_sha,retired) VALUES(?,?,?,?,?,0)", featureId, r.ref, r.title, json(r.criteria), specSha);
    });
  }
  approvedRequirements(featureId: number) {
    return this.all<{ ref: string; title: string; criteria: string }>("SELECT ref,title,criteria FROM approved_requirements WHERE feature_id=? ORDER BY ref", featureId);
  }
  /** Snapshot the live requirements as approved. */
  approveRequirements(featureId: number) {
    this.run("DELETE FROM approved_requirements WHERE feature_id=?", featureId);
    this.run("INSERT INTO approved_requirements(feature_id,ref,title,criteria) SELECT feature_id,ref,title,criteria FROM requirements WHERE feature_id=? AND retired=0", featureId);
  }
  openSpecChange(featureId: number) {
    return this.get<SpecChange>("SELECT * FROM spec_changes WHERE feature_id=? AND status='open' ORDER BY id DESC LIMIT 1", featureId);
  }
  // ---------- doc comments ----------
  addComment(c: { featureId: number; doc: DocKind; sha: string; line: number; quote: string; body: string; author: "you" | "pm"; status?: CommentStatus }): DocComment {
    const r = this.run(
      "INSERT INTO doc_comments(feature_id,doc,sha,line,quote,body,author,status) VALUES(?,?,?,?,?,?,?,?)",
      c.featureId,
      c.doc,
      c.sha,
      c.line,
      c.quote,
      c.body,
      c.author,
      c.status ?? "saved",
    );
    return this.comment(Number(r.lastInsertRowid))!;
  }
  comment(id: number) {
    return this.get<DocComment>("SELECT * FROM doc_comments WHERE id=?", id);
  }
  comments(featureId: number, doc?: DocKind) {
    return doc
      ? this.all<DocComment>("SELECT * FROM doc_comments WHERE feature_id=? AND doc=? ORDER BY id", featureId, doc)
      : this.all<DocComment>("SELECT * FROM doc_comments WHERE feature_id=? ORDER BY id", featureId);
  }

  proposal(featureId: number) {
    return this.get<TaskProposal>("SELECT * FROM task_proposals WHERE feature_id=? AND status='proposed' ORDER BY id DESC LIMIT 1", featureId);
  }
  proposals(featureId: number) {
    return this.all<TaskProposal>("SELECT * FROM task_proposals WHERE feature_id=? ORDER BY id", featureId);
  }
  // ---------- slices ----------
  slices(featureId: number) {
    return this.all<Slice>("SELECT * FROM slices WHERE feature_id=? ORDER BY n", featureId);
  }
  slice(id: number) {
    return this.get<Slice>("SELECT * FROM slices WHERE id=?", id);
  }
  /** The slice new tasks of a feature join when nothing names one: the last slice that hasn't shipped. */
  openSlice(featureId: number) {
    return this.get<Slice>("SELECT * FROM slices WHERE feature_id=? AND status NOT IN ('shipped','cancelled') ORDER BY n DESC LIMIT 1", featureId);
  }
  addSlice(featureId: number, s: { n: number; title: string; goal?: string; requirementRefs?: string[]; status?: SliceStatus; branch?: string | null; workspaceId?: string | null; path?: string | null; headSha?: string | null }): Slice {
    const r = this.run(
      "INSERT INTO slices(feature_id,n,title,goal,requirement_refs,status,branch,workspace_id,path,head_sha) VALUES(?,?,?,?,?,?,?,?,?,?)",
      featureId, s.n, s.title, s.goal ?? "", json(s.requirementRefs ?? []), s.status ?? "planned", s.branch ?? null, s.workspaceId ?? null, s.path ?? null, s.headSha ?? null,
    );
    return this.slice(Number(r.lastInsertRowid))!;
  }
  updateSlice(id: number, patch: Partial<Omit<Slice, "id" | "feature_id" | "created_at">>) {
    this.patch("slices", "id", id, { ...patch, updated_at: new Date().toISOString() });
  }

  addProposal(featureId: number, tasks: unknown, result: unknown, kind: "initial" | "change" = "initial", slices: unknown = []): TaskProposal {
    return this.tx(() => {
      this.run("UPDATE task_proposals SET status='superseded' WHERE feature_id=? AND status='proposed'", featureId);
      const r = this.run("INSERT INTO task_proposals(feature_id,kind,tasks,result,slices) VALUES(?,?,?,?,?)", featureId, kind, json(tasks), json(result), json(slices));
      return this.get<TaskProposal>("SELECT * FROM task_proposals WHERE id=?", Number(r.lastInsertRowid))!;
    });
  }


  // ---------- issues ----------
  /** Allocate the next issue key for a project (KEY-n). */
  nextIssueKey(projectId: number): string {
    return this.tx(() => {
      const p = this.project(projectId)!;
      this.run("UPDATE projects SET next_issue_n=next_issue_n+1 WHERE id=?", projectId);
      return `${p.key}-${p.next_issue_n}`;
    });
  }
  createIssue(i: {
    projectId: number;
    featureId?: number | null;
    origin: IssueOrigin;
    title: string;
    description?: string;
    acceptance?: string;
    status: IssueStatus;
    priority?: number;
    size?: Size | null;
    loop?: string | null;
    checks?: unknown;
    touches?: string[];
    requirementRefs?: string[];
    profile?: string | null;
    sliceId?: number | null;
    actor?: Actor;
  }): Issue {
    return this.tx(() => {
      const key = this.nextIssueKey(i.projectId);
      this.run(
        `INSERT INTO issues(key,project_id,feature_id,origin,title,description,acceptance,status,priority,size,loop,checks,touches,requirement_refs,profile,slice_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        key,
        i.projectId,
        i.featureId ?? null,
        i.origin,
        i.title,
        i.description ?? "",
        i.acceptance ?? "",
        i.status,
        i.priority ?? 50,
        i.size ?? null,
        i.loop ?? null,
        json(i.checks ?? {}),
        json(i.touches ?? []),
        json(i.requirementRefs ?? []),
        i.profile ?? null,
        i.sliceId ?? null,
      );
      this.event("issue_created", { actor: i.actor ?? "system", project: i.projectId, feature: i.featureId ?? null, issue: key, detail: { status: i.status, origin: i.origin } });
      return this.issue(key)!;
    });
  }
  issue(key: string) {
    return this.get<Issue>("SELECT * FROM issues WHERE key=?", key);
  }
  issues(filter: { projectId?: number; featureId?: number; status?: IssueStatus } = {}) {
    const where: string[] = [];
    const p: SQLInputValue[] = [];
    if (filter.projectId) (where.push("project_id=?"), p.push(filter.projectId));
    if (filter.featureId) (where.push("feature_id=?"), p.push(filter.featureId));
    if (filter.status) (where.push("status=?"), p.push(filter.status));
    return this.all<Issue>(`SELECT * FROM issues ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY priority DESC, created_at, key`, ...p);
  }
  /** The one way to change an issue's status: checks the transition and records it with its actor. */
  setIssueStatus(key: string, to: IssueStatus, actor: Actor, reason: ReasonCode | null = null, detail: Record<string, unknown> = {}) {
    const i = this.issue(key);
    if (!i) throw new FoundryError("NOT_FOUND", `No issue ${key}`);
    if (i.status === to && i.reason === reason) return;
    assertTransition(i.status, to, actor);
    this.run("UPDATE issues SET status=?, reason=?, updated_at=datetime('now') WHERE key=?", to, reason, key);
    this.event("issue_status", { actor, project: i.project_id, feature: i.feature_id, issue: key, detail: { from: i.status, to, reason, ...detail } });
  }
  updateIssue(key: string, patch: Partial<Omit<Issue, "key" | "project_id" | "status" | "created_at">>, actor: Actor = "system") {
    const i = this.issue(key)!;
    this.patch("issues", "key", key, { ...patch, updated_at: new Date().toISOString() });
    this.event("issue_updated", { actor, project: i.project_id, feature: i.feature_id, issue: key, detail: { fields: Object.keys(patch) } });
  }
  deps(key: string) {
    return this.all<IssueDep>("SELECT * FROM issue_deps WHERE issue_key=? ORDER BY depends_on", key);
  }
  dependents(key: string) {
    return this.all<IssueDep>("SELECT * FROM issue_deps WHERE depends_on=? ORDER BY issue_key", key);
  }
  addDep(key: string, dependsOn: string, reason = "") {
    this.run("INSERT OR REPLACE INTO issue_deps(issue_key,depends_on,reason) VALUES(?,?,?)", key, dependsOn, reason);
  }

  // ---------- attempts and runs ----------
  createAttempt(issueKey: string, branch: string, loop: unknown): Attempt {
    return this.tx(() => {
      const n = (this.get<{ n: number }>("SELECT COALESCE(MAX(n),0) n FROM attempts WHERE issue_key=?", issueKey)?.n ?? 0) + 1;
      const r = this.run("INSERT INTO attempts(issue_key,n,branch,loop) VALUES(?,?,?,?)", issueKey, n, branch.replace("{n}", String(n)), json(loop));
      return this.attempt(Number(r.lastInsertRowid))!;
    });
  }
  attempt(id: number) {
    return this.get<Attempt>("SELECT * FROM attempts WHERE id=?", id);
  }
  latestAttempt(issueKey: string) {
    return this.get<Attempt>("SELECT * FROM attempts WHERE issue_key=? ORDER BY n DESC LIMIT 1", issueKey);
  }
  attemptByAgent(agentId: string) {
    return this.get<Attempt>("SELECT * FROM attempts WHERE builder_agent_id=? OR reviewer_agent_id=? ORDER BY id DESC LIMIT 1", agentId, agentId);
  }
  attemptByWorkspace(workspaceId: string) {
    return this.get<Attempt>("SELECT * FROM attempts WHERE workspace_id=? ORDER BY id DESC LIMIT 1", workspaceId);
  }
  activeAttempts() {
    return this.all<Attempt>("SELECT * FROM attempts WHERE ended_at IS NULL ORDER BY id");
  }
  updateAttempt(id: number, patch: Partial<Omit<Attempt, "id" | "issue_key" | "n" | "started_at">>) {
    this.patch("attempts", "id", id, patch);
  }
  startRun(kind: RunKind, o: { attempt?: number | null; feature?: number | null; agent?: string | null; sha?: string | null; detail?: unknown }) {
    const r = this.run(
      "INSERT INTO runs(attempt_id,feature_id,kind,agent_id,sha,detail) VALUES(?,?,?,?,?,?)",
      o.attempt ?? null,
      o.feature ?? null,
      kind,
      o.agent ?? null,
      o.sha ?? null,
      json(o.detail ?? {}),
    );
    return Number(r.lastInsertRowid);
  }
  endRun(id: number, status: RunStatus, detail?: Record<string, unknown>, sha?: string | null) {
    const prev = this.get<Run>("SELECT * FROM runs WHERE id=?", id);
    const merged = { ...(prev ? JSON.parse(prev.detail) : {}), ...(detail ?? {}) };
    this.run("UPDATE runs SET status=?, detail=?, sha=COALESCE(?,sha), ended_at=datetime('now') WHERE id=?", status, json(merged), sha ?? null, id);
  }
  runs(attemptId: number) {
    return this.all<Run>("SELECT * FROM runs WHERE attempt_id=? ORDER BY id", attemptId);
  }

  // ---------- agents Foundry owns ----------
  registerAgent(a: Omit<AgentRecord, "created_at">) {
    this.run(
      "INSERT OR REPLACE INTO agents(agent_id,role,project_id,feature_id,issue_key,attempt_id,workspace_id) VALUES(?,?,?,?,?,?,?)",
      a.agent_id,
      a.role,
      a.project_id,
      a.feature_id,
      a.issue_key,
      a.attempt_id,
      a.workspace_id,
    );
  }
  agent(agentId: string) {
    return this.get<AgentRecord>("SELECT * FROM agents WHERE agent_id=?", agentId);
  }
  setAgentWorkspace(agentId: string, workspaceId: string) {
    this.run("UPDATE agents SET workspace_id=? WHERE agent_id=?", workspaceId, agentId);
  }
  /** Workspace paths only Foundry may start agents and terminals in (integration and check checkouts). */
  ownedPaths(): string[] {
    const rows = [
      ...this.all<{ p: string | null }>("SELECT integration_path p FROM features"),
      ...this.all<{ p: string | null }>("SELECT path p FROM slices WHERE status NOT IN ('shipped','cancelled')"),
      ...this.all<{ p: string | null }>("SELECT check_path p FROM attempts WHERE ended_at IS NULL"),
      ...this.all<{ p: string | null }>("SELECT path p FROM verifications WHERE status='running'"),
    ];
    return rows.map((r) => r.p).filter((p): p is string => !!p);
  }

  // ---------- generic patch ----------
  private patch(table: string, idCol: string, id: SQLInputValue, patch: Record<string, unknown>) {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return;
    const vals = keys.map((k) => {
      const v = patch[k];
      return v === null || typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? (v as SQLInputValue) : json(v);
    });
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE ${idCol}=?`, ...vals, id);
  }

  /** A consistent copy of the whole database at `target`. */
  copyTo(target: string) {
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}

/** Parse a JSON column with a fallback, for callers reading rows. */
export function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
