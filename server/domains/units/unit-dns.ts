// The unit's ONE public DNS record (the address belongs to the unit, not to the server) —
// provisioned at onboard/create-tenant, removed at offboard AND at both purge run kinds, over the
// DnsProvider port (adapters/dns). One record per unit STANDING AT A STAGE, by kind of unit:
//
//   consumer — A `<label>.<stage apex>`. The chart renders exactly ONE host, and by DNS rule a
//              wildcard does NOT cover a bare label, so the record is the host itself.
//   tenant   — wildcard A `*.<subdomain>.<stage apex>`, one PER STAGE. Every member sits exactly one
//              level below (`<member>.<subdomain>.<stage apex>`, nothing lives on the bare zone), so
//              one wildcard covers a stage's members — members added later included — and a move
//              changes ONE record per stage.
//
// THE STAGE IS THE ZONE (`<stage>.<unitApex>`, and the apex itself for prod), and the apex is the
// target cluster's own (global.unitApex off its values chain). Two clusters may well share one apex — install.sh defaults
// `unit-apex` to the FQDN minus its first label precisely so a unit KEEPS its address when it moves
// between two clusters in one zone — and under a shared apex two stages of one unit are two records
// in two zones, so both may stand in one installation and on one cluster. What the name does NOT separate
// is two CLUSTERS claiming the same stage of one unit: the host can answer for exactly one cluster,
// so provisionUnitDns REFUSES a host that already answers with the address of ANOTHER CLUSTER OF THIS
// INSTALLATION. A standing record at an address none of this installation's clusters has is a
// different thing: only this installation's token writes the zone, so such a record is what an
// installation that is gone left behind (its machines restored bare, its units never offboarded —
// measured on 2026-09-15, post.digitacloud.app still at the abandoned apps4 when apps7 onboarded the
// same unit), and it is REPLACED, with the log saying what stood there. readStandingHost is the one
// reading of that difference; gate G27 (gates/compose.ts) takes it BEFORE the run writes anything, and
// provision-dns takes it again at its own step (hostyour-manager#151).
//
// The record's CONTENT is the target cluster's address, READ off the cluster's own A record (its
// FQDN resolves to the machine that serves it) — never computed. A move is then a content update of
// this one record and nothing else, and it is the ONE caller that overwrites a foreign address.
// Certificates are unaffected: HTTP-01 only requires that every certificate host resolves, which the
// record (or the wildcard) provides.
//
// Every step here is fail-CLOSED — an unwired provider or an API failure breaks the run, in the
// removal run kinds too: "no address is left pointing nowhere" holds without exception, and purge is the
// run kind that runs after failed offboards, exactly where the leftovers would appear. Absent records
// are the idempotent no-op (delete-by-(name,type) resolves 0).
import type { StepCtx } from "../../executor/types.ts";
import type { Db } from "../../db/client.ts";
import { clusters } from "../../db/schema/inventory.ts";
import type { DnsProvider } from "../../adapters/dns/port.ts";
import { errValidation } from "../../kernel/errors.ts";

// A CONSUMER'S HOST LABEL AND A TENANT SUBDOMAIN ARE ONE NAME SPACE. Both stand as a single DNS
// label directly under a stage zone: the consumer serves `<label>.<stage apex>`, and the tenant's
// members sit one level below `<subdomain>.<stage apex>`. That parent is not merely the tenant's wildcard root —
// it is the Domain its IdP scopes every session cookie to (`example-auth.cookieDomain` in
// catalog/charts/example-auth/templates/_helpers.tpl, delivered as AUTH_COOKIE_DOMAIN and set
// on the access and refresh cookies in example-auth/backend/src/auth/cookies.ts). A browser sends a
// cookie to every host at or below its Domain, so a consumer labelled `<subdomain>` would stand on
// the very host a tenant's cookies reach for. Both onboarding run kinds therefore hold their candidate
// against the other side's set: gate G23 refuses a consumer label a tenant already stands on
// (gates/compose.ts), and the create-tenant step ensure-subdomain-free refuses a subdomain a consumer
// already holds (tenant-replace.ts).

/** The compositions themselves live in shared/unit-host.ts — ONE place for the Manager and, by the
 *  same strings, for hostyour-cloud's ApplicationSets — and are re-exported here for the callers of
 *  this module: a consumer stands at `<label>.<stage apex>`, a tenant's members at
 *  `<member>.<subdomain>.<stage apex>`, under ONE wildcard PER STAGE (the zones differ). The label is
 *  the registration's / the row's `host`, never the name (simetrixch/hostyour-cloud#208). */
export { consumerUnitHost, tenantMemberHost, tenantWildcardHost, tenantZone, stageApex } from "../../../shared/unit-host.ts";

function requireDns(dns: DnsProvider | undefined, unit: string, runKind: string): DnsProvider {
  if (!dns) {
    throw errValidation(
      `${runKind} "${unit}" requires the DNS provider but none is wired on this manager (CLOUDFLARE_DNS_API_TOKEN unset) — DNS is a mandatory part of this run kind, never a silent skip`,
    );
  }
  return dns;
}

/** The target cluster's address: the content of ITS own A record. The cluster's FQDN is the one
 *  authority for where the cluster is reachable, so the unit record copies it rather than computing
 *  an address from inventory. Fail-closed: a cluster without an address record can serve nothing. */
async function resolveClusterAddress(dns: DnsProvider, clusterFqdn: string, signal: AbortSignal): Promise<string> {
  const content = await dns.readRecordContent({ name: clusterFqdn, type: "A", signal });
  if (content === null) {
    throw errValidation(`the target cluster ${clusterFqdn} has no A record of its own — there is no address to point the unit's record at`);
  }
  return content;
}

/** What a unit's host answers with now, read against this installation's own clusters. */
export type StandingHost =
  /** No record stands under the host. */
  | { kind: "free" }
  /** The record already carries the target cluster's address — a re-run, never a takeover. */
  | { kind: "ours" }
  /** The record carries the address of ANOTHER cluster of this installation: one stage of a unit has
   *  one host, and that cluster serves it. Refused wherever it is read. */
  | { kind: "collision"; standing: string; cluster: string }
  /** The record carries an address none of this installation's clusters has — what an installation
   *  that is gone left in the zone. Replaced by provision-dns, and said so. */
  | { kind: "leftover"; standing: string };

/** The unit's host as the DNS provider answers it now, judged against the installation's own
 *  clusters — every cluster row's domain resolved to its address at the same provider. The target
 *  cluster's own address is read the way provision-dns reads it, and a target without one is refused
 *  here for the same reason. The one reading gate G27 and the provision-dns step both take. */
export async function readStandingHost(
  dns: DnsProvider,
  db: Db,
  opts: { recordName: string; clusterFqdn: string; signal: AbortSignal },
): Promise<StandingHost> {
  const address = await resolveClusterAddress(dns, opts.clusterFqdn, opts.signal);
  const standing = await dns.readRecordContent({ name: opts.recordName, type: "A", signal: opts.signal });
  if (standing === null) return { kind: "free" };
  if (standing === address) return { kind: "ours" };
  for (const row of db.select({ domain: clusters.domain }).from(clusters).all()) {
    if (row.domain === opts.clusterFqdn) continue;
    const theirs = await dns.readRecordContent({ name: row.domain, type: "A", signal: opts.signal });
    if (theirs === standing) return { kind: "collision", standing, cluster: row.domain };
  }
  return { kind: "leftover", standing };
}

/** G27's input: the unit's host as the provider answers it now, judged against the installation's own
 *  clusters. Bound by the caller to the provider and the inventory through standingHostFrom. */
export type StandingHostReader = (host: string, clusterFqdn: string) => Promise<StandingHost>;

/** G27's reader, bound to the DNS provider and the inventory — the same reading provision-dns takes
 *  at its own step. Empty where the Manager has no provider, so the gate says so. Shared by the
 *  consumer planner (validate.ts) and the tenant planner (validate-tenant.ts). */
export function standingHostFrom(dns: DnsProvider | undefined, db: Db, signal: AbortSignal): { standingHost?: StandingHostReader } {
  if (!dns) return {};
  return { standingHost: (host, clusterFqdn) => readStandingHost(dns, db, { recordName: host, clusterFqdn, signal }) };
}

/** The sentence a collision is refused with, the same at the gate and at the step. */
export function standingHostRefusal(recordName: string, unit: string, judged: { standing: string; cluster: string }): string {
  return (
    `the host ${recordName} already answers with ${judged.standing}, the address of ${judged.cluster} of this installation — ` +
    `refusing to point "${unit}" at a second cluster: one stage of a unit has ONE host, and that cluster serves it. ` +
    `Offboard the unit there first, or give the two clusters different unit_apex answers.`
  );
}

/** Create (or move onto the current cluster address) the unit's ONE record. Shared by the consumer
 *  onboard and create-tenant provision-dns steps AND by the relocation switch-dns (a move IS a
 *  content update of exactly this record) — the caller composes the record name per kind and names
 *  its run kind for the refusal message. */
export async function provisionUnitDns(
  ctx: StepCtx,
  opts: {
    dns: DnsProvider | undefined;
    unit: string;
    recordName: string;
    clusterFqdn: string;
    /** The run kind the refusal message names. REQUIRED and never defaulted: this step is shared by
     *  consumer-onboard, tenant-create and the two relocation run kinds, so a default would put one
     *  of their names on the other three's refusal. */
    runKind: string;
    /** The MOVE alone. switch-dns repoints a record the unit already owns onto the target cluster,
     *  so overwriting an address that is not the target's IS the step. Every other caller is putting
     *  a unit onto a cluster for the first time and must not take a live address off whatever answers
     *  there now — see the host-collision paragraph in this module's header. */
    overwriteAddress?: boolean;
  },
): Promise<void> {
  const dns = requireDns(opts.dns, opts.unit, opts.runKind);
  const address = await resolveClusterAddress(dns, opts.clusterFqdn, ctx.signal);
  if (!opts.overwriteAddress) {
    // Read before write, because upsertRecord overwrites the first match in place and reports it as
    // the benign "updated in place": a takeover would leave no trace anywhere in the run, and a
    // leftover replaced without a word would leave none either.
    const judged = await readStandingHost(dns, ctx.db, { recordName: opts.recordName, clusterFqdn: opts.clusterFqdn, signal: ctx.signal });
    if (judged.kind === "collision") {
      throw errValidation(standingHostRefusal(opts.recordName, opts.unit, judged));
    }
    if (judged.kind === "leftover") {
      ctx.log(
        "meta",
        `the host ${opts.recordName} stood at ${judged.standing}, an address no cluster of this installation has — what an installation that is gone left in the zone; replaced with ${address}`,
      );
    }
  }
  const { created } = await dns.upsertRecord({ name: opts.recordName, type: "A", content: address, signal: ctx.signal });
  ctx.checkpoint({ record: opts.recordName, content: address, created });
  ctx.log(
    "meta",
    `DNS record ${opts.recordName} → ${address} ${created ? "created" : "updated in place"} — the unit's address is its own, and a move is a content update of exactly this record`,
  );
}

/** Remove the unit's ONE record (offboard + both purge run kinds). Fail-closed on the API, absent=ok:
 *  a unit whose run died before provision-dns simply deletes nothing. */
export async function removeUnitDns(
  ctx: StepCtx,
  opts: { dns: DnsProvider | undefined; unit: string; recordName: string },
): Promise<void> {
  const dns = requireDns(opts.dns, opts.unit, "remove");
  const { deleted } = await dns.deleteRecord({ name: opts.recordName, type: "A", signal: ctx.signal });
  ctx.checkpoint({ record: opts.recordName, deleted });
  ctx.log(
    "meta",
    deleted > 0
      ? `DNS record ${opts.recordName} removed (${deleted}) — no address is left pointing nowhere`
      : `no DNS record ${opts.recordName} to remove — already absent`,
  );
}
