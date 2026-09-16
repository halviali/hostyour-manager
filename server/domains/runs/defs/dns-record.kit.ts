// What the two run kinds that TAKE A DNS RECORD BACK share: the provider they delete at, the
// inventory they are allowed to delete by, and the one deletion itself.
//
// THE INVENTORY IS THE PERMISSION. Neither run kind may delete a name an operator types: the
// records this installation owns are exactly the ones server/domains/dns/dns-inventory.ts derives
// from the registrations, the cluster rows and the sender domains, and everything else in the zone
// belongs to somebody — the installer, the customer's own mail service, another installation. So
// both defs resolve their target IN the inventory, at the plan and again at the run's fail-closed
// first step, and refuse anything the inventory does not carry as removable.
//
// It arrives as a FUNCTION rather than as an import: the run definitions are assembled in this
// domain and the inventory lives in the DNS domain, which no module of another domain may import
// (.dependency-cruiser.cjs domains-no-crosstalk). server/boot/wire.ts binds it.
import type { StepCtx } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { forgetDnsWrite } from "../../../db/dns-writes.ts";
import type { DnsProvider } from "../../../adapters/dns/port.ts";
import type { DnsInventoryView, DnsRecordRow, DnsRecordType, DnsRowType } from "../../../../shared/dns.ts";

export interface DnsRecordPorts {
  /** The provider the record is deleted at. Absent on a manager with no DNS token: the run kind
   *  then refuses at its plan rather than reporting a removal nobody made. */
  dns?: DnsProvider;
  /** The DNS inventory, read now — the one statement of which records this installation owns. */
  readDnsInventory?: () => Promise<DnsInventoryView>;
}

export function requireDnsProvider(ports: DnsRecordPorts): DnsProvider {
  if (!ports.dns) {
    throw errValidation(
      "no DNS provider is wired into this manager (CLOUDFLARE_DNS_API_TOKEN unset) — the record stands at the provider and nothing else can take it back",
    );
  }
  return ports.dns;
}

/** The inventory as the refusal reads it. A manager without the DNS domain wired owns no statement
 *  of what it owns, and a removal decided without one would be a deletion by typed name. */
export async function ownedRecords(ports: DnsRecordPorts): Promise<DnsRecordRow[]> {
  if (!ports.readDnsInventory) {
    throw errValidation("the DNS inventory is not wired into this manager — which records this installation owns is what decides whether a removal is allowed at all");
  }
  return (await ports.readDnsInventory()).rows;
}

/** Whose record this is, in the sentence the plan and the log both use. */
export function ownerSentence(row: DnsRecordRow): string {
  const stage = row.owner.stage === undefined ? "" : ` at ${row.owner.stage}`;
  return `the ${row.owner.kind} "${row.owner.name}"${stage}`;
}

/** The row for one (name, type), REFUSED unless this installation owns it and may take it back. The
 *  two refusals are deliberately different sentences: a name nobody here wrote and a record this
 *  platform lists but does not own are two different mistakes, and one message for both would send
 *  the operator looking in the wrong place. */
export function removableRecord(rows: DnsRecordRow[], name: string, type: DnsRowType): DnsRecordRow {
  const row = rows.find((r) => r.name === name && r.type === type);
  if (!row) {
    throw errValidation(
      `this installation owns no ${type} record ${name}: the DNS inventory names ${rows.length} record(s), and a record that is not among them belongs to somebody — ` +
        "the installer, the customer's own mail service, or an installation this one knows nothing about",
    );
  }
  if (!row.removable) {
    throw errValidation(
      `the ${type} record ${name} is listed read-only: it is ${ownerSentence(row)}'s, not a record any run of this Manager wrote — ` +
        "the sender domain's address record is the installer's and the reverse DNS is set where the egress address is rented",
    );
  }
  return row;
}

/** Delete ONE record and say what stood there. The content is read BEFORE the deletion, because
 *  afterwards nothing anywhere can say what the zone carried — the run log is the only record of it.
 *  Absent is the idempotent no-op (delete-by-(name,type) resolves 0), so a resumed run is safe. The
 *  book of DNS writes loses its row of the record here, the one place both run kinds delete through. */
export async function deleteRecord(ctx: StepCtx, dns: DnsProvider, record: { name: string; type: DnsRecordType }): Promise<void> {
  const stood = await dns.readRecordContent({ name: record.name, type: record.type, signal: ctx.signal });
  const { deleted } = await dns.deleteRecord({ name: record.name, type: record.type, signal: ctx.signal });
  forgetDnsWrite(ctx.db, { name: record.name, type: record.type });
  ctx.checkpoint({ record: record.name, type: record.type, stood, deleted });
  ctx.log(
    "meta",
    deleted > 0
      ? `${record.type} ${record.name} stood at ${stood ?? "content the provider did not answer"} and is gone (${deleted} removed)`
      : `no ${record.type} record ${record.name} to remove — already absent`,
  );
}
