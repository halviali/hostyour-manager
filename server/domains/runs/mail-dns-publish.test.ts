import { describe, it, expect, afterEach } from "vitest";
import { clusters } from "../../db/schema/inventory.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { StepCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import { makeHarness, disposeHarnesses, seedMasterCluster, MASTER_ID, SLAVE_ID, MASTER_MARKING_YAML, type Harness } from "./deploy-slave.fixture.ts";
import { MASTER_FQDN } from "./cluster-maps.fixture.ts";
import { ANSIWISE_ELEVATION_SECRET } from "./defs/ansiwise-run.kit.ts";
import { makeMailDnsPublishDef, mailDnsAnswers, senderRoleOf, type MailDnsPublishParams, type MailDnsPublishPorts } from "./defs/mail-dns-publish.ts";

// mail-dns-publish runs the catalogue's publish-mail-dns on the master for ONE of the two sender
// domains the master's map names. What these tests hold: the plan stands only on a master and only
// for one of those two names, the program is answered with the egress address READ off the master's
// own A record (never typed), and the two DMARC choices travel from the params to the answers.

const EGRESS = "203.0.113.9";
const PARAMS: MailDnsPublishParams = { serverId: MASTER_ID, senderDomain: "example.com", dmarcPolicy: "none", dmarcMailbox: "dmarc@example.com" };

afterEach(disposeHarnesses);

function ports(h: Harness, dns?: FakeDnsProvider): MailDnsPublishPorts {
  return { ...h.runPorts, ...(dns ? { dns } : {}) };
}

function ctx(h: Harness, logs: string[]): StepCtx {
  return {
    runId: "run_mail", stepName: "run-publish-mail-dns", db: h.db.db, creds: {} as unknown as CredentialStore, params: { ...PARAMS },
    secrets: { get: () => undefined, wipe: () => undefined }, signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}

describe("mail-dns-publish plan", () => {
  it("stands on the master: attest, then the ONE program step, the elevation password required, the master the only target", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const plan = await makeMailDnsPublishDef(ports(h)).plan(PARAMS, { db: h.db.db });
    expect(plan.steps.map((s) => s.name)).toEqual(["attest-target", "run-publish-mail-dns"]);
    expect(plan.targets).toEqual([{ serverId: MASTER_ID, ownsHost: true, label: "m1 (master)" }]);
    expect(plan.requiredSecrets).toEqual([ANSIWISE_ELEVATION_SECRET]);
    expect(plan.summary).toContain("example.com (customer mail)");
    // The PTR is the provider's to set; the plan says so rather than pretending to.
    expect(plan.warnings.join(" ")).toMatch(/reverse DNS .* point it at example\.com/);
  });

  it("names the alert domain by its role when the map's unit apex differs from the platform domain", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    h.platformRepo.seed(h.platformRepo.booksBranch, clusterMapPath(MASTER_FQDN), MASTER_MARKING_YAML.replace("unitApex: example.com", "unitApex: apps.example.net"));
    const plan = await makeMailDnsPublishDef(ports(h)).plan({ ...PARAMS, senderDomain: "apps.example.net" }, { db: h.db.db });
    expect(plan.summary).toContain("apps.example.net (alert mail)");
    expect(senderRoleOf("nobody.example", { platformDomain: "example.com", unitApex: "apps.example.net" })).toBeUndefined();
  });

  it("refuses a domain the master's map does not name — mail leaves the installation as nothing else", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    await expect(makeMailDnsPublishDef(ports(h)).plan({ ...PARAMS, senderDomain: "foreign.example" }, { db: h.db.db }))
      .rejects.toThrow(/foreign\.example is not a sender domain of m1\.example\.com: its map names example\.com \(customer mail/);
  });

  it("refuses a slave: the relay, the token and the egress address are the master's", async () => {
    const h = await makeHarness();
    h.db.db.insert(clusters).values({ id: "cls_s1", serverId: SLAVE_ID, stage: "prod", domain: "s1.example.com", status: "active", slaveId: 1 }).run();
    await expect(makeMailDnsPublishDef(ports(h)).plan({ ...PARAMS, serverId: SLAVE_ID }, { db: h.db.db }))
      .rejects.toThrow(/s1 is a slave — publish-mail-dns runs on the master/);
  });
});

describe("what publish-mail-dns is answered with", () => {
  it("the run's domain, the DMARC choices, and the egress address READ off the master's own A record", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    const dns = new FakeDnsProvider();
    dns.seed(MASTER_FQDN, "A", EGRESS);
    const logs: string[] = [];
    const answers = await mailDnsAnswers({ ...PARAMS, dmarcPolicy: "quarantine" }, ports(h, dns))(ctx(h, logs));
    expect(answers).toEqual({ mail_domain: "example.com", egress_address: EGRESS, dmarc_policy: "quarantine", dmarc_mailbox: "dmarc@example.com" });
    // dkim_selector is NOT answered: the program defaults it to the stage, which is what the relay signs with.
    expect(logs.join(" ")).toContain("dkim_selector is left to the stage");
  });

  it("refuses a master without an A record rather than announcing an address nobody resolves", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    await expect(mailDnsAnswers(PARAMS, ports(h, new FakeDnsProvider()))(ctx(h, [])))
      .rejects.toThrow(/m1\.example\.com has no A record at the DNS provider/);
  });

  it("refuses without a DNS provider wired — the egress address has no other source", async () => {
    const h = await makeHarness();
    seedMasterCluster(h);
    await expect(mailDnsAnswers(PARAMS, ports(h))(ctx(h, []))).rejects.toThrow(/no DNS provider is wired/);
  });
});
