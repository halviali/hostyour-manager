// The DNS vocabulary both ends share: every record this installation is responsible for at the DNS
// provider, and the verdict each one carries. The Manager keeps no book of the records it writes —
// a consumer's host, a tenant's wildcard, the mail records of a sender domain — so the inventory is
// DERIVED from the state that does exist (the registrations and the cluster rows) and every row is
// then READ at the provider. A stored list would go on naming records a hand at the provider has
// long since changed, which is the very leftover this surface exists to show.
import type { Stage } from "./enums.ts";

/** The record types the DnsProvider port writes and reads: A for the unit records the onboarding
 *  run kinds provision, TXT for the mail records of a sender domain (SPF, DKIM, DMARC). Nothing
 *  else is ever written through this platform. */
export const DNS_RECORD_TYPE = ["A", "TXT"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPE)[number];

/** What a row of the inventory may carry — the two written types plus the PTR, which lives at the
 *  hosting provider rather than in the zone and is therefore listed and never removed here. */
export type DnsRowType = DnsRecordType | "PTR";

/** WHOSE record a row is, which is also what decides whether this Manager may take it back:
 *   - consumer / tenant — the unit's ONE record per stage, written by provision-dns and removed by
 *                         offboard and purge (server/domains/units/unit-dns.ts).
 *   - mail             — a sender domain's SPF, DKIM or DMARC, published by mail-dns-publish.
 *   - installer        — a record of the installation that no run of this Manager wrote: the sender
 *                        domain's own address record, and the reverse DNS of the egress address,
 *                        which is set where the address is rented. Listed read-only. */
export type DnsOwnerKind = "consumer" | "tenant" | "mail" | "installer";

/** Who a record belongs to, in the words the operator knows the thing by: a consumer's unit name, a
 *  tenant's subdomain, a sender domain. `stage` is carried where the owner HAS one — a unit stands
 *  at one stage and its record is that stage's zone; a sender domain is the installation's and
 *  stands at no stage. */
export interface DnsOwner {
  kind: DnsOwnerKind;
  name: string;
  stage?: Stage;
}

/** What the reading found, against what the owner's state says must stand there. `other` is the
 *  interesting one: a record under this installation's own name carrying content nobody here would
 *  write is what an installation that is gone leaves behind (unit-dns.ts readStandingHost). */
export type DnsVerdict = "standing" | "absent" | "other";

/** ONE record: who owns it, the name asked at the provider, what the owner's state says it must
 *  carry, what was found (null for no record at all), and whether a `dns-remove` run may take it
 *  back — false for every row the installer or the hosting provider owns. */
export interface DnsRecordRow {
  owner: DnsOwner;
  name: string;
  type: DnsRowType;
  expected: string;
  found: string | null;
  verdict: DnsVerdict;
  removable: boolean;
}

/** GET /api/dns — every record the Manager is responsible for, read at the provider at `readAt`.
 *  `skipped` carries ONE sentence per source the walk could not read: a registration scan that
 *  failed or a mail measurement without a master is not an installation with fewer records, and an
 *  inventory that silently shrank would tell the operator the zone is clean. */
export interface DnsInventoryView {
  rows: DnsRecordRow[];
  skipped: string[];
  readAt: string;
}

/** POST /api/runs {kind: "dns-remove"} — take back ONE record the inventory names as removable. */
export interface DnsRemoveInput {
  name: string;
  type: DnsRecordType;
}
