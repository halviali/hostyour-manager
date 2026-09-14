// The mail vocabulary both ends share: what the Manager publishes and measures for the installation's
// mail DNS. An installation sends as exactly two domains — customer mail as its platform domain, alert
// mail as its unit apex (the two names the relay's ALLOWED_SENDER_DOMAINS carries) — and receiving is
// never the platform's; everything here is about what receivers of OUR mail look up.
import type { DmarcPolicy, Stage } from "./enums.ts";

/** POST /api/runs {kind: "mail-dns-publish"} — the mail DNS of ONE of the two sender domains (the
 *  master's map names both), published from the master by the catalogue's publish-mail-dns program.
 *  The two DMARC values are the operator's; the egress address is read off the master's own A record. */
export interface MailDnsPublishInput {
  serverId: string;
  senderDomain: string;
  dmarcPolicy: DmarcPolicy;
  dmarcMailbox: string;
}

/** Which of the two roles a sender domain plays: the platform domain carries customer mail, the
 *  unit apex the alerts. */
export type SenderRole = "customer mail" | "alert mail";

/** The five records a receiver judges the installation's mail by. */
export type MailDnsRecord = "spf" | "a" | "dkim" | "dmarc" | "ptr";

/** One record as measured against what the installation needs: the NAME asked, what the master's
 *  map and address say it must carry (`expected`), what public DNS answers (`found`, null for no
 *  record), and the verdict. `note` says why a red row is red in a sentence the operator acts on. */
export interface MailDnsRow {
  record: MailDnsRecord;
  name: string;
  expected: string;
  found: string | null;
  ok: boolean;
  note?: string;
}

export interface MailDnsDomainView {
  domain: string;
  role: SenderRole;
  rows: MailDnsRow[];
}

/** GET /api/mail/dns — the mail DNS of the installation as receivers see it: the master the mail
 *  leaves from (its egress address is its own A record at the DNS provider), and one block per
 *  sender domain. Measured against PUBLIC resolvers at `measuredAt`, never against the machine's. */
export interface MailDnsView {
  master: { serverId: string; name: string; fqdn: string; stage: Stage; egress: string | null };
  domains: MailDnsDomainView[];
  measuredAt: string;
}
