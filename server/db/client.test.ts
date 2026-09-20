import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb, type DbHandle } from "./client.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

describe("openDb — migration phase + append-only invariants", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  function fresh(): DbHandle {
    const dir = mkdtempSync(join(tmpdir(), "mgr-db-"));
    dirs.push(dir);
    const h = openDb(join(dir, "manager.db"));
    handles.push(h);
    return h;
  }
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("migrates a fresh DB with foreign keys on and integrity ok", () => {
    const { sqlite } = fresh();
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("re-opens idempotently (migrate is a no-op the second time)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-db-"));
    dirs.push(dir);
    const file = join(dir, "manager.db");
    const h1 = openDb(file);
    handles.push(h1);
    h1.sqlite.close();
    expect(() => {
      handles.push(openDb(file));
    }).not.toThrow();
  });

  // A database built by the BASELINE ALONE — what every installation before hostyour-manager#222
  // stands on — is carried forward by the migrations that follow it, and the baseline is never run
  // again against it (#222: a re-stamped baseline died on `table audit already exists`).
  it("carries a database built by the baseline alone forward: 0001 adds organisation_identities, the baseline stays applied once", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgr-db-"));
    dirs.push(dir);
    // The baseline alone, as a migrations folder of its own: the same 0000 file, a journal naming only it.
    const baselineOnly = join(dir, "baseline-only");
    mkdirSync(join(baselineOnly, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toEqual(["0000_baseline", "0001_organisation-identities"]);
    writeFileSync(join(baselineOnly, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
    copyFileSync(join(MIGRATIONS_DIR, "0000_baseline.sql"), join(baselineOnly, "0000_baseline.sql"));
    const file = join(dir, "manager.db");
    const standing = new Database(file);
    migrate(drizzle(standing), { migrationsFolder: baselineOnly });
    expect(standing.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organisation_identities'").all()).toEqual([]);
    standing.close();
    // Opened by the Manager: the migrator applies 0001 alone.
    const h = openDb(file);
    handles.push(h);
    expect(h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organisation_identities'").all()).toEqual([{ name: "organisation_identities" }]);
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 2 });
    expect(h.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("enforces append-only on events and audit (UPDATE and DELETE both raise)", () => {
    const { sqlite } = fresh();
    sqlite
      .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, plan_json, status, started_by) VALUES (?,?,?,?,?,?,?,?)")
      .run("run_x", "noop", "server", "srv_x", "{}", "{}", "planned", "op_system");
    sqlite.prepare("INSERT INTO events (id, run_id, stream, seq, text) VALUES (?,?,?,?,?)").run("evt_x", "run_x", "stdout", 0, "hello");
    sqlite.prepare("INSERT INTO audit (id, actor, action) VALUES (?,?,?)").run("aud_x", "system", "run.started");

    expect(() => sqlite.prepare("UPDATE events SET text='y' WHERE id='evt_x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM events WHERE id='evt_x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("UPDATE audit SET action='x' WHERE id='aud_x'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM audit WHERE id='aud_x'").run()).toThrow(/append-only/);
  });

  it("the runs plan_json CHECK rejects a planned run with no plan, but allows a failed one", () => {
    const { sqlite } = fresh();
    const insert = (id: string, status: string) =>
      sqlite
        .prepare("INSERT INTO runs (id, kind, target_kind, target_id, params_json, status, started_by) VALUES (?,?,?,?,?,?,?)")
        .run(id, "noop", "server", "srv_y", "{}", status, "op_system");
    expect(() => insert("run_bad", "planned")).toThrow(); // planned + NULL plan_json violates the CHECK
    expect(() => insert("run_ok", "failed")).not.toThrow(); // failed may carry no plan
  });

  it("seeds the reserved system operators op_system + op_emergency", () => {
    const { sqlite } = fresh();
    const rows = sqlite.prepare("SELECT username FROM operators ORDER BY username").all() as { username: string }[];
    expect(rows.map((r) => r.username)).toEqual(["emergency", "system"]);
  });
});
