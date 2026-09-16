import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { listDnsWrites, recordDnsWrite } from "../../db/dns-writes.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { DnsInventoryView, DnsRecordRow } from "../../../shared/dns.ts";
import { makeMailDnsUnpublishDef, type MailDnsUnpublishParams } from "./defs/mail-dns-unpublish.ts";
import type { DnsRecordPorts } from "./defs/dns-record.kit.ts";

// mail-dns-unpublish is the inverse of mail-dns-publish: the SPF, the DKIM key and the DMARC policy
// of ONE sender domain go in one act, and the two records this platform does not own stay — the
// domain's address record, which answers for the machine, and the reverse DNS, which is set where
// the egress address is rented. Both facts are asserted against the FakeDnsProvider's own store,
// and the book of DNS writes loses exactly the three rows, read back from a real database.

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.sqlite.close(); });

const EGRESS = "203.0.113.9";

/** The mail half of the inventory for one sender domain, as dns-inventory.ts composes it from the
 *  rows the Mail page measures. */
const MAIL_ROWS: DnsRecordRow[] = [
  { owner: { kind: "mail", name: "example.com" }, name: "example.com", type: "TXT", expected: `one v=spf1 record naming ip4:${EGRESS}`, found: `v=spf1 ip4:${EGRESS} -all`, verdict: "standing", removable: true },
  { owner: { kind: "installer", name: "example.com" }, name: "example.com", type: "A", expected: EGRESS, found: EGRESS, verdict: "standing", removable: false },
  { owner: { kind: "mail", name: "example.com" }, name: "prod._domainkey.example.com", type: "TXT", expected: "one v=DKIM1 record", found: "v=DKIM1; p=MIIB", verdict: "standing", removable: true },
  { owner: { kind: "mail", name: "example.com" }, name: "_dmarc.example.com", type: "TXT", expected: "one v=DMARC1 record", found: "v=DMARC1; p=none", verdict: "standing", removable: true },
  { owner: { kind: "installer", name: "example.com" }, name: EGRESS, type: "PTR", expected: "example.com", found: "example.com", verdict: "standing", removable: false },
];

const ports = (dns?: FakeDnsProvider, rows: DnsRecordRow[] = MAIL_ROWS): DnsRecordPorts => ({
  ...(dns ? { dns } : {}),
  readDnsInventory: async (): Promise<DnsInventoryView> => ({ rows, skipped: [], readAt: new Date().toISOString() }),
});

function ctx(logs: string[], params: MailDnsUnpublishParams): StepCtx {
  return {
    runId: "run_mail_unpublish", stepName: "remove-records", db: db.db, creds: {} as unknown as CredentialStore, params: { ...params },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

const PARAMS: MailDnsUnpublishParams = { domain: "example.com" };

function published(): FakeDnsProvider {
  const dns = new FakeDnsProvider();
  dns.seed("example.com", "TXT", `v=spf1 ip4:${EGRESS} -all`);
  dns.seed("example.com", "A", EGRESS);
  dns.seed("prod._domainkey.example.com", "TXT", "v=DKIM1; p=MIIB");
  dns.seed("_dmarc.example.com", "TXT", "v=DMARC1; p=none");
  return dns;
}

describe("mail-dns-unpublish plan", () => {
  it("names the three records it deletes and warns what the domain loses the moment they are gone", async () => {
    const plan = await makeMailDnsUnpublishDef(ports(published())).plan(PARAMS, { db: {} as unknown as StepCtx["db"] });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "remove-records"]);
    expect(plan).toMatchObject({ targetKind: "self", targetId: "manager", requiredSecrets: [] });
    expect(plan.summary).toContain("delete example.com, prod._domainkey.example.com, _dmarc.example.com at the DNS provider");
    expect(plan.summary).toContain("The domain's own address record stays");
    expect(plan.warnings.join(" ")).toMatch(/fails the checks receivers make the moment these records are gone/);
  });

  it("refuses a domain this installation does not send as, and names the ones it does", async () => {
    await expect(makeMailDnsUnpublishDef(ports(published())).plan({ domain: "foreign.example" }, { db: {} as unknown as StepCtx["db"] }))
      .rejects.toThrow(/this installation publishes no mail records for foreign\.example — it sends as example\.com/);
  });
});

describe("mail-dns-unpublish steps", () => {
  it("deletes the SPF, the DKIM key and the DMARC policy, forgets the three in the book, and leaves the address record standing", async () => {
    const dns = published();
    for (const row of MAIL_ROWS.filter((r) => r.removable)) {
      recordDnsWrite(db.db, { name: row.name, type: "TXT", content: row.found!, act: "inserted", owner: { kind: "mail", name: "example.com" }, runId: "run_publish" });
    }
    recordDnsWrite(db.db, { name: "post.example.net", type: "A", content: EGRESS, act: "inserted", owner: { kind: "consumer", name: "post", stage: "prod" }, runId: "run_onboard" });
    const logs: string[] = [];
    for (const step of makeMailDnsUnpublishDef(ports(dns)).steps(PARAMS)) await step.run(ctx(logs, PARAMS));
    expect(listDnsWrites(db.db).map((r) => `${r.type} ${r.name}`)).toEqual(["A post.example.net"]);
    expect(dns.deletes.map((d) => `${d.type} ${d.name}`)).toEqual(["TXT example.com", "TXT prod._domainkey.example.com", "TXT _dmarc.example.com"]);
    expect(dns.record("example.com", "TXT")).toBeUndefined();
    expect(dns.record("prod._domainkey.example.com", "TXT")).toBeUndefined();
    expect(dns.record("_dmarc.example.com", "TXT")).toBeUndefined();
    expect(dns.record("example.com", "A")).toBe(EGRESS); // the installer's, and never this run's to take
    expect(logs.at(-1)).toContain("announces no SPF, no DKIM key and no DMARC policy any more");
  });

  it("refuses at attest-target when the domain stopped being a sender domain between the plan and the run", async () => {
    const attest = makeMailDnsUnpublishDef(ports(published(), [])).steps(PARAMS)[0]!;
    await expect(attest.run(ctx([], PARAMS))).rejects.toThrow(/no domain the DNS inventory could read/);
  });
});
