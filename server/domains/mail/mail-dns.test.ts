import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakePublicDns } from "../../adapters/dns/testing/fake-public-dns.ts";
import { mailDnsRows, readMailDns, type MailDnsNeed } from "./mail-dns.ts";

// The Mail page's check: the five records of a sender domain, measured at public DNS and held against
// what the master's map and address say they must carry. Pure over scripted DNS, so every verdict
// and every note is read here exactly as the operator reads it.

const EGRESS = "203.0.113.9";
const need = (over: Partial<MailDnsNeed> = {}): MailDnsNeed => ({ domain: "example.com", role: "customer mail", stage: "prod", egress: EGRESS, platformDomain: "example.com", ...over });

function published(): FakePublicDns {
  const dns = new FakePublicDns();
  dns.seedTxt("example.com", `v=spf1 ip4:${EGRESS} include:spf.protection.outlook.com -all`, "MS=ms123");
  dns.seedA("example.com", EGRESS);
  dns.seedTxt("prod._domainkey.example.com", "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkq");
  dns.seedTxt("_dmarc.example.com", "v=DMARC1; p=none; rua=mailto:dmarc@example.com");
  dns.seedPtr(EGRESS, "example.com");
  return dns;
}

describe("mailDnsRows", () => {
  it("reads every record green when the domain is published for this master", async () => {
    const dns = published();
    const rows = await mailDnsRows(need(), dns);
    expect(rows.map((r) => `${r.record}:${r.ok}`)).toEqual(["spf:true", "a:true", "dkim:true", "dmarc:true", "ptr:true"]);
    expect(rows.find((r) => r.record === "spf")?.found).toBe(`v=spf1 ip4:${EGRESS} include:spf.protection.outlook.com -all`); // the MS= record is not SPF
    expect(rows.find((r) => r.record === "dkim")?.name).toBe("prod._domainkey.example.com"); // the selector is the stage
    expect(rows.find((r) => r.record === "ptr")).toMatchObject({ name: EGRESS, expected: "example.com" });
    expect(rows.every((r) => r.note === undefined)).toBe(true);
    expect(dns.asked).toEqual(["TXT example.com", "A example.com", "TXT prod._domainkey.example.com", "TXT _dmarc.example.com", `PTR ${EGRESS}`]);
  });

  it("a red row's note is one sentence naming the act: publish, or remove the extra record by hand", async () => {
    const dns = published();
    dns.seedTxt("example.com", "v=spf1 ip4:198.51.100.7 -all");
    dns.seedTxt("_dmarc.example.com");
    dns.seedA("example.com");
    const rows = await mailDnsRows(need(), dns);
    expect(rows.find((r) => r.record === "spf")).toMatchObject({ ok: false, note: "publish; the address is merged into the record that stands" });
    expect(rows.find((r) => r.record === "a")).toMatchObject({ ok: false, note: "publish" });
    expect(rows.find((r) => r.record === "dmarc")).toMatchObject({ ok: false, note: "publish" });
    for (const row of rows) expect(row.note ?? "x").not.toMatch(/\. /); // one sentence
    dns.seedTxt("example.com", "v=spf1 ip4:198.51.100.7 -all", `v=spf1 ip4:${EGRESS} -all`);
    const two = (await mailDnsRows(need(), dns)).find((r) => r.record === "spf")!;
    expect(two).toMatchObject({ ok: false, note: "remove 1 of the 2 v=spf1 records by hand, then publish" });
  });

  it("no DKIM record says publish, and a foreign PTR names the provider as the place to set it", async () => {
    const dns = published();
    dns.seedTxt("prod._domainkey.example.com");
    dns.seedPtr(EGRESS, "static.9.113.0.203.clients.example-hosting.net");
    const rows = await mailDnsRows(need(), dns);
    expect(rows.find((r) => r.record === "dkim")).toMatchObject({ ok: false, found: null, note: "publish; the key is published where the relay holds one" });
    expect(rows.find((r) => r.record === "ptr")?.note).toBe(`set the reverse DNS of ${EGRESS} to example.com at the hosting provider`);
  });

  it("without an egress address every address-bound row is red for that ONE reason, and no PTR is asked", async () => {
    const dns = published();
    const rows = await mailDnsRows(need({ egress: null }), dns);
    for (const record of ["spf", "a", "ptr"] as const) {
      const row = rows.find((r) => r.record === record)!;
      expect(row.ok).toBe(false);
      expect(row.note).toBe("give the master an A record at the DNS provider first");
    }
    expect(dns.asked.some((q) => q.startsWith("PTR"))).toBe(false);
  });
});

describe("readMailDns", () => {
  let db: DbHandle;
  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { db.sqlite.close(); });

  const MAP = [
    "stage: prod", "role: master", "booksCluster: m1.example.com", "", "global:",
    "  domain: m1.example.com", "  buildPlane: m1.example.com", "  unitApex: apps.example.net", "  platformDomain: example.com",
    "  clusterName: m1", "  clusterIssuer: platform-acme",
  ].join("\n") + "\n";

  function seedMaster(): void {
    db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "m1.example.com", sshUser: "m1", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example.com", status: "active" }).run();
  }

  it("measures the master's two sender domains — customer mail as the platform domain, alerts as the unit apex — with the egress read off the master's own A record", async () => {
    seedMaster();
    const platformRepo = new FakePlatformRepo();
    platformRepo.seed(platformRepo.booksBranch, clusterMapPath("m1.example.com"), MAP);
    const dns = new FakeDnsProvider();
    dns.seed("m1.example.com", "A", EGRESS);
    const view = await readMailDns({ db: db.db, platformRepo, dns, publicDns: published() });
    expect(view.master).toEqual({ serverId: "srv_m", name: "m1", fqdn: "m1.example.com", stage: "prod", egress: EGRESS });
    expect(view.domains.map((d) => `${d.domain} (${d.role})`)).toEqual(["example.com (customer mail)", "apps.example.net (alert mail)"]);
    expect(view.domains[0]!.rows.every((r) => r.ok)).toBe(true);
    // The alert domain has nothing published in this script: four red rows, each with its reason — and
    // the PTR green, because one machine greets as the platform domain whatever it sends as.
    expect(view.domains[1]!.rows.map((r) => `${r.record}:${r.ok}`)).toEqual(["spf:false", "a:false", "dkim:false", "dmarc:false", "ptr:true"]);
    expect(view.domains[1]!.rows.find((r) => r.record === "ptr")?.expected).toBe("example.com");
  });

  it("one block when the map names one domain for both roles; no master or no map is a named refusal", async () => {
    seedMaster();
    const platformRepo = new FakePlatformRepo();
    platformRepo.seed(platformRepo.booksBranch, clusterMapPath("m1.example.com"), MAP.replace("unitApex: apps.example.net", "unitApex: example.com"));
    const view = await readMailDns({ db: db.db, platformRepo, publicDns: published() });
    expect(view.domains.map((d) => d.role)).toEqual(["customer mail"]);
    expect(view.master.egress).toBeNull(); // no provider wired ⇒ no egress, and the rows say so
    await expect(readMailDns({ db: db.db, publicDns: published() })).rejects.toThrow(/no platform repository is configured/);
    db.sqlite.exec("DELETE FROM clusters; DELETE FROM servers");
    await expect(readMailDns({ db: db.db, platformRepo, publicDns: published() })).rejects.toThrow(/no master server is registered/);
  });
});
