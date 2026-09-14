// The mail vocabulary both ends share: what the Manager publishes and measures for the installation's
// mail DNS. An installation sends as exactly two domains — customer mail as its platform domain, alert
// mail as its unit apex (the two names the relay's ALLOWED_SENDER_DOMAINS carries) — and receiving is
// never the platform's; everything here is about what receivers of OUR mail look up.
import type { DmarcPolicy } from "./enums.ts";

/** POST /api/runs {kind: "mail-dns-publish"} — the mail DNS of ONE of the two sender domains (the
 *  master's map names both), published from the master by the catalogue's publish-mail-dns program.
 *  The two DMARC values are the operator's; the egress address is read off the master's own A record. */
export interface MailDnsPublishInput {
  serverId: string;
  senderDomain: string;
  dmarcPolicy: DmarcPolicy;
  dmarcMailbox: string;
}
