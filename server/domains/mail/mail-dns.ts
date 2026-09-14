import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { errNotConfigured, errNotFound } from "../../kernel/errors.ts";
import { MASTER_ROLES, type Stage } from "../../../shared/enums.ts";
import type { MailDnsDomainView, MailDnsRow, MailDnsView, SenderRole } from "../../../shared/mail.ts";
import type { PlatformRepo } from "../../adapters/git/port.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import type { PublicDns } from "../../adapters/dns/public-dns.ts";
import { resolveClusterMarking } from "../inventory/cluster-marking.ts";

// The mail DNS of the installation, MEASURED: what receivers find at public DNS, held against what the
// master's map and address say they must find. Read-only — the writer is the catalogue's
// publish-mail-dns program, run by mail-dns-publish; this page is what tells the operator whether to
// run it, and what only the hosting provider can set (the reverse DNS).
//
// WHY MEASURED AND NOT REMEMBERED. The records live in a zone somebody else may edit (a domain whose
// mail already runs on another service), so nothing this manager stored about them would stay true.
// Every read asks public resolvers, never the machine's own: a record the master resolves through its
// cluster DNS and nobody else can is exactly the case this exists to show.

/** What the check needs to know about the installation before it asks DNS anything. */
export interface MailDnsNeed {
  domain: string;
  role: SenderRole;
  /** The relay signs with the stage as its selector, so that is where the key must stand. */
  stage: Stage;
  /** The master's egress address — null when the master has no A record, which paints every
   *  address-bound row red with the reason. */
  egress: string | null;
  /** The name the master greets with and the reverse DNS must give back: the platform domain. */
  platformDomain: string;
}

const isSpf = (txt: string): boolean => txt.trim().toLowerCase().startsWith("v=spf1");
const isDkim = (txt: string): boolean => txt.trim().toLowerCase().startsWith("v=dkim1");
const isDmarc = (txt: string): boolean => txt.trim().toLowerCase().startsWith("v=dmarc1");
const joined = (records: readonly string[]): string | null => (records.length === 0 ? null : records.join(" | "));

/** The five rows of one sender domain. Pure over the lookups, so a test scripts DNS and reads verdicts. */
export async function mailDnsRows(need: MailDnsNeed, dns: PublicDns): Promise<MailDnsRow[]> {
  const { domain, stage, egress, platformDomain } = need;
  const noEgress = "the master has no A record at the DNS provider, so no address can be expected here";

  const txt = await dns.txt(domain);
  const spf = txt.filter(isSpf);
  const spfRow: MailDnsRow = {
    record: "spf",
    name: domain,
    expected: egress === null ? "one v=spf1 record naming the master's egress address" : `one v=spf1 record naming ip4:${egress}`,
    found: joined(spf),
    ok: egress !== null && spf.length === 1 && spf[0]!.includes(`ip4:${egress}`),
    ...(egress === null
      ? { note: noEgress }
      : spf.length === 0
        ? { note: "no SPF record — receivers cannot tell the master's mail from anybody's; publish-mail-dns writes one" }
        : spf.length > 1
          ? { note: `${spf.length} v=spf1 records — a permanent error receivers fail the domain on; publish-mail-dns refuses the domain until one is removed by hand` }
          : spf[0]!.includes(`ip4:${egress}`)
            ? {}
            : { note: `the record does not name ip4:${egress} — publish-mail-dns merges it in and keeps the rest` }),
  };

  const addresses = await dns.a(domain);
  const aRow: MailDnsRow = {
    record: "a",
    name: domain,
    expected: egress ?? "the master's egress address",
    found: joined(addresses),
    ok: egress !== null && addresses.includes(egress),
    ...(egress === null ? { note: noEgress } : addresses.includes(egress) ? {} : { note: "the sending machine greets with this name and receivers resolve it; publish-mail-dns points it at the egress address" }),
  };

  const dkimName = `${stage}._domainkey.${domain}`;
  const dkim = (await dns.txt(dkimName)).filter(isDkim);
  const dkimRow: MailDnsRow = {
    record: "dkim",
    name: dkimName,
    expected: `one v=DKIM1 record carrying the relay's public key (selector ${stage}, the stage the relay signs with)`,
    found: joined(dkim),
    ok: dkim.length === 1,
    ...(dkim.length === 0
      ? { note: "no key published — the relay signs nothing until a key pair is seeded and its public half published (publish-mail-dns publishes it once the relay holds one)" }
      : dkim.length > 1
        ? { note: `${dkim.length} records under one selector — receivers find whichever they find; remove the extras by hand` }
        : {}),
  };

  const dmarcName = `_dmarc.${domain}`;
  const dmarc = (await dns.txt(dmarcName)).filter(isDmarc);
  const dmarcRow: MailDnsRow = {
    record: "dmarc",
    name: dmarcName,
    expected: "one v=DMARC1 record with a policy and a report mailbox",
    found: joined(dmarc),
    ok: dmarc.length === 1,
    ...(dmarc.length === 0 ? { note: "no DMARC record — receivers apply no policy and report to nobody; publish-mail-dns writes one" } : dmarc.length > 1 ? { note: `${dmarc.length} DMARC records — one is the rule` } : {}),
  };

  const ptrNames = egress === null ? [] : await dns.ptr(egress);
  const ptrRow: MailDnsRow = {
    record: "ptr",
    name: egress ?? domain,
    expected: platformDomain,
    found: joined(ptrNames),
    ok: egress !== null && ptrNames.includes(platformDomain),
    ...(egress === null
      ? { note: noEgress }
      : ptrNames.includes(platformDomain)
        ? {}
        : { note: `the reverse DNS of ${egress} is set where the address is rented (the hosting provider), not in any zone this manager writes — point it at ${platformDomain}` }),
  };

  return [spfRow, aRow, dkimRow, dmarcRow, ptrRow];
}

export interface MailDnsDeps {
  db: Db;
  platformRepo?: PlatformRepo;
  /** The DNS provider the egress address is read from — the master's own A record there, the same
   *  read mail-dns-publish answers the program with. */
  dns?: PublicDnsEgress;
  publicDns: PublicDns;
}

/** The one read the check makes at the provider: the master's address record. Narrowed from the
 *  full DnsProvider so a caller that only measures needs nothing that writes. */
export type PublicDnsEgress = Pick<DnsProvider, "readRecordContent">;

/** The installation's mail DNS, measured now. The master is the one role=master server and its
 *  cluster row; the sender domains are its map's platformDomain (customer mail) and unitApex
 *  (alert mail) — one block when the two are the same name. */
export async function readMailDns(deps: MailDnsDeps): Promise<MailDnsView> {
  const master = deps.db.select().from(servers).where(inArray(servers.role, [...MASTER_ROLES])).get();
  if (!master) throw errNotFound("no master server is registered — the mail leaves the master, and there is none to measure");
  const cluster = deps.db.select().from(clusters).where(eq(clusters.serverId, master.id)).get();
  if (!cluster) throw errNotFound(`the master ${master.name} carries no cluster row — boot seeds it from MASTER_FQDN (boot/seed-master.ts)`);
  if (!deps.platformRepo) throw errNotConfigured("no platform repository is configured — the sender domains are read off the master's cluster map there");
  const marking = await resolveClusterMarking(deps.platformRepo, cluster.domain);
  if (marking.platformDomain === undefined || marking.unitApex === undefined) {
    throw errNotFound(
      `the map of ${cluster.domain} names no ${marking.platformDomain === undefined ? "platformDomain" : "unitApex"} — ` +
        "the two sender domains are read off it; write the answer into the installation's config and regenerate the branch",
    );
  }
  const egress = deps.dns ? await deps.dns.readRecordContent({ name: cluster.domain, type: "A" }) : null;
  const senders: Array<{ domain: string; role: SenderRole }> = [{ domain: marking.platformDomain, role: "customer mail" }];
  if (marking.unitApex !== marking.platformDomain) senders.push({ domain: marking.unitApex, role: "alert mail" });
  const domains: MailDnsDomainView[] = [];
  for (const sender of senders) {
    domains.push({
      ...sender,
      rows: await mailDnsRows({ ...sender, stage: cluster.stage, egress, platformDomain: marking.platformDomain }, deps.publicDns),
    });
  }
  return {
    master: { serverId: master.id, name: master.name, fqdn: cluster.domain, stage: cluster.stage, egress },
    domains,
    measuredAt: new Date().toISOString(),
  };
}
