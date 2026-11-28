// Installs and plugin updates never corrupt or wipe an existing Foundry database: every past schema
// upgrades with its data intact and a backup beside it; newer or foreign databases are refused untouched;
// a failing migration rolls back to the last good version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKUPS_KEPT, MIGRATIONS, SCHEMA_VERSION, Store } from "../server/core/store";

const dir = () => mkdtempSync(join(tmpdir(), "foundry-upgrade-"));

/** A database as an older plugin left it: the first `k` migrations, schema_version k, and some data. */
function atVersion(path: string, k: number) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (let i = 0; i < k; i++) db.exec(MIGRATIONS[i]!);
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(k));
  db.exec(`INSERT INTO projects(id,key,name,repo,base_ref) VALUES(1,'SHT','Shout','/tmp/shout','main');
           INSERT INTO features(id,project_id,slug,title,idea,branch) VALUES(1,1,'shout-mode','Shout mode','Shout','foundry/feature/shout-mode');
           INSERT INTO issues(key,project_id,feature_id,origin,title,status) VALUES('SHT-1',1,1,'feature','Add shout()','Done');
           INSERT INTO events(actor,kind,project_id) VALUES('you','project_created',1);`);
  db.close();
}

const backups = (d: string) => readdirSync(d).filter((f) => f.startsWith("foundry.db.backup-"));

for (let k = 1; k < SCHEMA_VERSION; k++) {
  test(`an install at schema ${k} upgrades to ${SCHEMA_VERSION} with its data and a backup`, () => {
    const d = dir();
    const path = join(d, "foundry.db");
    atVersion(path, k);
    const s = new Store(path);
    assert.equal(s.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'")!.value, String(SCHEMA_VERSION));
    assert.equal(s.projects()[0]!.key, "SHT");
    assert.equal(s.feature(1)!.title, "Shout mode");
    assert.equal(s.issue("SHT-1")!.status, "Done");
    s.close();
    const b = backups(d);
    assert.equal(b.length, 1);
    assert.match(b[0]!, new RegExp(`^foundry\\.db\\.backup-v${k}-`));
    const copy = new DatabaseSync(join(d, b[0]!));
    assert.equal((copy.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as any).value, String(k), "the backup is the database as it was");
    assert.equal((copy.prepare("SELECT COUNT(*) n FROM issues").get() as any).n, 1);
    copy.close();
  });
}

test("reopening a current database changes nothing and makes no backup", () => {
  const d = dir();
  const path = join(d, "foundry.db");
  new Store(path).close();
  new Store(path).close();
  assert.equal(backups(d).length, 0);
});

test("a database from a newer plugin is refused byte for byte untouched", () => {
  const d = dir();
  const path = join(d, "foundry.db");
  const s = new Store(path);
  s.run("UPDATE meta SET value=? WHERE key='schema_version'", String(SCHEMA_VERSION + 1));
  s.close();
  const before = readFileSync(path);
  assert.throws(() => new Store(path), (e: any) => e.code === "STORE_TOO_NEW");
  assert.deepEqual(readFileSync(path), before);
  assert.equal(backups(d).length, 0);
});

test("a failing migration rolls back: the version and data stay as they were, and the backup is there", () => {
  const d = dir();
  const path = join(d, "foundry.db");
  const last = SCHEMA_VERSION - 1;
  atVersion(path, last);
  // Something in the way of the last migration (it adds doc_comments.resolved_at).
  const db = new DatabaseSync(path);
  db.exec("ALTER TABLE doc_comments ADD COLUMN resolved_at INTEGER");
  db.close();
  assert.throws(() => new Store(path), (e: any) => e.code === "MIGRATION_FAILED" && new RegExp(`unchanged at schema ${last}`).test(e.message));
  const after = new DatabaseSync(path);
  assert.equal((after.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as any).value, String(last));
  assert.equal((after.prepare("SELECT COUNT(*) n FROM issues").get() as any).n, 1);
  assert.equal((after.prepare("SELECT type FROM pragma_table_info('doc_comments') WHERE name='resolved_at'").get() as any).type, "INTEGER", "no part of the failed migration stayed");
  after.close();
  assert.equal(backups(d).length, 1);
});

test(`only the newest ${BACKUPS_KEPT} backups are kept`, () => {
  const d = dir();
  const path = join(d, "foundry.db");
  for (let i = 0; i < BACKUPS_KEPT + 2; i++) {
    const f = join(d, `foundry.db.backup-v1-2026010${i}T000000`);
    writeFileSync(f, "old");
    utimesSync(f, new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i));
  }
  atVersion(path, 1);
  new Store(path).close();
  const b = backups(d);
  assert.equal(b.length, BACKUPS_KEPT);
  assert.ok(b.some((f) => f.startsWith("foundry.db.backup-v1-2026") && !f.includes("20260100")), "the oldest went first");
  assert.ok(!existsSync(join(d, "foundry.db.backup-v1-20260100T000000")));
});
