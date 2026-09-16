import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { listDnsWrites, recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { DnsInventoryView, DnsRecordRow } from "../../../shared/dns.ts";
import { makeDnsRemoveDef, type DnsRemoveParams } from "./defs/dns-remove.ts";
import type { DnsRecordPorts } from "./defs/dns-record.kit.ts";

// dns-remove takes ONE record back at the provider. What these tests hold is the refusal: the run
// deletes only what the DNS inventory names as this installation's and removable, so a typed name
// and a row this platform merely depends on both end the plan with a sentence instead of a deletion.
// The steps run against a real database, because the deletion takes the record's row out of the
// book of DNS writes beside it.

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const CONSUMER_ROW: DnsRecordRow = {
  owner: { kind: "consumer", name: "post", stage: "prod" },
  name: "post.example.net", type: "A", expected: "203.0.113.9", found: "198.51.100.4", verdict: "other", removable: true,
};
const INSTALLER_ROW: DnsRecordRow = {
  owner: { kind: "installer", name: "example.com" },
  name: "example.com", type: "A", expected: "203.0.113.9", found: "203.0.113.9", verdict: "standing", removable: false,
};

const inventory = (rows: DnsRecordRow[]): DnsInventoryView => ({ rows, skipped: [], readAt: new Date().toISOString() });
const ports = (dns?: FakeDnsProvider, rows: DnsRecordRow[] = [CONSUMER_ROW, INSTALLER_ROW]): DnsRecordPorts => ({
  ...(dns ? { dns } : {}),
  readDnsInventory: async () => inventory(rows),
});

function ctx(logs: string[], params: DnsRemoveParams): StepCtx {
  return {
    runId: "run_dns", stepName: "remove-record", db: db.db, creds: {} as unknown as CredentialStore, params: { ...params },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const PARAMS: DnsRemoveParams = { name: "post.example.net", type: "A" };

describe("dns-remove plan", () => {
  it("plans the two steps against this manager itself — the record is in the zone and no machine is reached", async () => {
    const plan = await makeDnsRemoveDef(ports(new FakeDnsProvider())).plan(PARAMS, { db: {} as unknown as StepCtx["db"] });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-record"]);
    expect(plan).toMatchObject({ targetKind: "self", targetId: "manager", requiredSecrets: [] });
    expect(plan.summary).toContain('the record of the consumer "post" at prod');
    expect(plan.summary).toContain("stands at 198.51.100.4");
    // The record carries an address its owner does not expect, so nothing in use is being taken away.
    expect(plan.warnings).toEqual([]);
  });

  it("warns when the record answers with exactly what its owner needs", async () => {
    const standing = { ...CONSUMER_ROW, found: "203.0.113.9", verdict: "standing" as const };
    const plan = await makeDnsRemoveDef(ports(new FakeDnsProvider(), [standing])).plan(PARAMS, { db: {} as unknown as StepCtx["db"] });
    expect(plan.warnings.join(" ")).toMatch(/takes a name that is in use right now out of DNS/);
  });

  it("refuses a name this installation does not own — the inventory is the permission, not the operator's typing", async () => {
    await expect(makeDnsRemoveDef(ports(new FakeDnsProvider())).plan({ name: "foreign.example", type: "A" }, { db: {} as unknown as StepCtx["db"] }))
      .rejects.toThrow(/this installation owns no A record foreign\.example/);
  });

  it("refuses a record it lists read-only, and says whose it is", async () => {
    await expect(makeDnsRemoveDef(ports(new FakeDnsProvider())).plan({ name: "example.com", type: "A" }, { db: {} as unknown as StepCtx["db"] }))
      .rejects.toThrow(/the A record example\.com is listed read-only: it is the installer "example\.com"/);
  });

  it("refuses without a DNS provider rather than reporting a removal nobody made", async () => {
    await expect(makeDnsRemoveDef(ports()).plan(PARAMS, { db: {} as unknown as StepCtx["db"] })).rejects.toThrow(/no DNS provider is wired into this manager/);
  });
});

describe("dns-remove steps", () => {
  it("attests the record is still ours, then deletes it at the provider, says what stood there, and forgets it in the book", async () => {
    const dns = new FakeDnsProvider();
    dns.seed("post.example.net", "A", "198.51.100.4");
    recordDnsWrite(db.db, { name: "post.example.net", type: "A", content: "198.51.100.4", act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_old" });
    recordDnsWrite(db.db, { name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1; p=none", act: "inserted", owner: { kind: "mail", name: "example.com" }, runId: "run_old" });
    const logs: string[] = [];
    const steps = makeDnsRemoveDef(ports(dns)).steps(PARAMS);
    for (const step of steps) await step.run(ctx(logs, PARAMS));
    expect(dns.record("post.example.net", "A")).toBeUndefined();
    expect(dns.deletes).toEqual([{ name: "post.example.net", type: "A", deleted: 1 }]);
    expect(logs[0]).toContain('belongs to the consumer "post" at prod');
    expect(logs[1]).toBe("A post.example.net stood at 198.51.100.4 and is gone (1 removed)");
    // ONE row leaves the book: the record this run took back, and no other.
    expect(listDnsWrites(db.db).map((r) => r.name)).toEqual(["_dmarc.example.com"]);
  });

  it("is a no-op on a record that is already absent — a resumed run deletes nothing twice", async () => {
    const dns = new FakeDnsProvider();
    const logs: string[] = [];
    await makeDnsRemoveDef(ports(dns)).steps(PARAMS)[1]!.run(ctx(logs, PARAMS));
    expect(logs).toEqual(["no A record post.example.net to remove — already absent"]);
  });

  it("refuses at attest-target when the record stopped being ours between the plan and the run", async () => {
    const logs: string[] = [];
    const attest = makeDnsRemoveDef(ports(new FakeDnsProvider(), [INSTALLER_ROW])).steps(PARAMS)[0]!;
    await expect(attest.run(ctx(logs, PARAMS))).rejects.toThrow(/this installation owns no A record post\.example\.net/);
  });
});
