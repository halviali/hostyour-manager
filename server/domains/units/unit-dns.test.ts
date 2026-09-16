import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { listDnsWrites, recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { provisionUnitDns, removeUnitDns } from "./unit-dns.ts";

// The unit's ONE record and the book of DNS writes beside it: provisionUnitDns enters what it
// changed — inserted where nothing stood, updated where another address stood — and enters NOTHING
// where the address already stood, because the book says what this Manager changed; removeUnitDns
// takes the row out beside the record. Every case is asserted against the fake provider's own store
// and the book read back from the database.

const CLUSTER = "s1.example";
const ADDRESS = "203.0.113.10";
const HOST = "post.example.net";

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: CLUSTER, status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

function ctx(logs: string[], runId = "run_onboard"): StepCtx {
  return {
    runId, stepName: "provision-dns", db: db.db, creds: {} as unknown as CredentialStore, params: {},
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

function provider(): FakeDnsProvider {
  const dns = new FakeDnsProvider();
  dns.seed(CLUSTER, "A", ADDRESS);
  return dns;
}

const consumer = (dns: FakeDnsProvider, over: { overwriteAddress?: boolean } = {}) =>
  ({ dns, unit: "post", kind: "consumer" as const, stage: "prod" as const, recordName: HOST, clusterFqdn: CLUSTER, runKind: "consumer-onboard", ...over });

describe("provisionUnitDns and the book", () => {
  it("a record that stood nowhere is inserted, and the book says so with the owner and the run", async () => {
    const dns = provider();
    await provisionUnitDns(ctx([], "run_1"), consumer(dns));
    expect(dns.record(HOST, "A")).toBe(ADDRESS);
    expect(listDnsWrites(db.db)).toMatchObject([
      { name: HOST, type: "A", content: ADDRESS, act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_1" },
    ]);
  });

  it("a leftover of a gone installation is replaced, and the book says updated", async () => {
    const dns = provider();
    dns.seed(HOST, "A", "157.90.201.150");
    await provisionUnitDns(ctx([], "run_2"), consumer(dns));
    expect(listDnsWrites(db.db)).toMatchObject([{ name: HOST, act: "updated", content: ADDRESS, runId: "run_2" }]);
  });

  it("a record that already carries the address is left alone in the book — nothing was changed", async () => {
    const dns = provider();
    dns.seed(HOST, "A", ADDRESS);
    const logs: string[] = [];
    await provisionUnitDns(ctx(logs, "run_3"), consumer(dns));
    // The provider was still asked (the upsert is idempotent), the book was not.
    expect(dns.upserts).toHaveLength(1);
    expect(logs.at(-1)).toContain("updated in place");
    expect(listDnsWrites(db.db)).toEqual([]);
  });

  it("a re-run over its own earlier write keeps the earlier row rather than overwriting it with a write that changed nothing", async () => {
    const dns = provider();
    await provisionUnitDns(ctx([], "run_1"), consumer(dns));
    await provisionUnitDns(ctx([], "run_4"), consumer(dns));
    expect(listDnsWrites(db.db)).toMatchObject([{ act: "inserted", runId: "run_1" }]);
  });

  it("the move (overwriteAddress) reads what stood before it too, so the switch is booked as updated by the tenant's run", async () => {
    const dns = provider();
    dns.seed("*.acme.example.net", "A", "203.0.113.20"); // the source cluster's address
    await provisionUnitDns(ctx([], "run_move"), { dns, unit: "zsjs023ctne0", kind: "tenant", stage: "prod", recordName: "*.acme.example.net", clusterFqdn: CLUSTER, runKind: "tenant-migrate", overwriteAddress: true });
    expect(listDnsWrites(db.db)).toMatchObject([
      { name: "*.acme.example.net", act: "updated", content: ADDRESS, owner: { kind: "tenant", name: "zsjs023ctne0", stage: "prod" }, runId: "run_move" },
    ]);
  });

  it("a provider failure books nothing — the book never records a write the zone did not take", async () => {
    const dns = provider();
    dns.failWith = new Error("Cloudflare DNS refused");
    await expect(provisionUnitDns(ctx([]), consumer(dns))).rejects.toThrow(/Cloudflare DNS refused/);
    expect(listDnsWrites(db.db)).toEqual([]);
  });
});

describe("removeUnitDns and the book", () => {
  it("takes the row out beside the record", async () => {
    const dns = provider();
    await provisionUnitDns(ctx([]), consumer(dns));
    expect(listDnsWrites(db.db)).toHaveLength(1);
    await removeUnitDns(ctx([]), { dns, unit: "post", recordName: HOST });
    expect(dns.record(HOST, "A")).toBeUndefined();
    expect(listDnsWrites(db.db)).toEqual([]);
  });

  it("forgets a row whose record is already absent — a unit whose run died after the book was written", async () => {
    const dns = provider();
    recordDnsWrite(db.db, { name: HOST, type: "A", content: ADDRESS, act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_dead" });
    const logs: string[] = [];
    await removeUnitDns(ctx(logs), { dns, unit: "post", recordName: HOST });
    expect(logs.at(-1)).toContain("already absent");
    expect(listDnsWrites(db.db)).toEqual([]);
  });

  it("leaves the row standing when the provider refuses — the record still stands, and so must the book", async () => {
    const dns = provider();
    await provisionUnitDns(ctx([]), consumer(dns));
    dns.failWith = new Error("Cloudflare DNS refused");
    await expect(removeUnitDns(ctx([]), { dns, unit: "post", recordName: HOST })).rejects.toThrow(/Cloudflare DNS refused/);
    expect(listDnsWrites(db.db)).toHaveLength(1);
  });
});
