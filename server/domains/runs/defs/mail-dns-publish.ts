import { z } from "zod";
import type { Step, StepCtx, RunDefinition } from "../../../executor/types.ts";
import { errValidation } from "../../../kernel/errors.ts";
import { recordDnsWrite } from "../../../db/dns-writes.ts";
import { DMARC_POLICY, isMasterRole, type Stage } from "../../../../shared/enums.ts";
import { MAIL_RECORD_TAG, PUBLISHED_MAIL_RECORD, mailRecordNames, type PublishedMailRecord } from "../../../../shared/mail.ts";
import type { DnsProvider } from "../../../adapters/dns/port.ts";
import { resolveClusterMarking } from "../../inventory/cluster-marking.ts";
import { activeClusterTarget, requirePlatformRepo, type DeploySlavePorts } from "./deploy-slave.kit.ts";
import { attestClusterStep, loadActiveCluster } from "./live-cluster.kit.ts";
import { ansiwiseProgramStep, ANSIWISE_ELEVATION_SECRET, type AnsiwisePorts, type ExtraAnswers } from "./ansiwise-run.kit.ts";

// mail-dns-publish: publish the mail DNS of ONE sender domain of this installation — its SPF, its
// address record, its DKIM key where the relay holds one, its DMARC policy — by running the
// catalogue's `publish-mail-dns` program on the master, the way deploy-slave and redeploy run the
// machine's own programs. The Manager writes no mail record itself: the program is the ONE writer of
// these records (its SPF merge keeps what another service published and refuses a domain that already
// carries two v=spf1 records), and a second writer of the same records would drift from it.
//
// WHICH DOMAINS. An installation sends as exactly two: customer mail as its platform domain and
// alert mail as its unit apex — the two names deploy-branch writes into the relay's
// ALLOWED_SENDER_DOMAINS. Both stand on the master's cluster map (platformDomain, unitApex), so the
// plan reads them there and refuses any other name. One run publishes one domain, exactly as the
// program does; the Mail page offers one run per domain.
//
// WHAT IS ANSWERED, AND FROM WHERE. `stage` is the cluster row's (composeAnswers reads the inventory);
// `mail_domain` is the run's; `egress_address` is READ off the master's own A record at the DNS
// provider — the one authority for where the master is reachable, the same read provision-dns makes
// for a unit's record — never typed and never derived from a name the program is about to publish;
// `dkim_selector` is left to the program's default, the stage, which is what the relay signs with;
// `dmarc_policy` and `dmarc_mailbox` are the operator's on the Mail page. The DKIM public key is not
// answered here yet: the program reads it from the hand-filled input on the master until the key is
// minted by this manager (hostyour-manager#147, hostyour-deploy#33).
//
// WHAT THIS DOES NOT DO. The reverse DNS of the egress address is set where the address is rented;
// the plan says so in its warning and the Mail page shows the value to set.
//
// WHAT THE BOOK OF DNS WRITES LEARNS. The Manager writes none of these records itself, so the only
// way it can say what the program did is the DIFFERENCE: what stood under the three published names
// before the program and what stands after it. A record absent before and standing after was
// inserted, one standing with other content was updated, and each enters the book (db/dns-writes.ts)
// with the sender domain as its owner. Both readings are taken AT THE PROVIDER and not at public
// resolvers, although the Mail page measures there: a resolver answers from its cache for the
// record's TTL, and a reading before the program would prime that cache with the old content, so a
// public reading after it could not see the write. The address record is not diffed — the inventory
// lists it as the installer's, and the book carries only what a run of this Manager may take back.

export const MAIL_DNS_PROGRAM = "publish-mail-dns";

const senderDomain = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "a DNS apex, lowercase");

export const MailDnsPublishParams = z.object({
  serverId: z.string().startsWith("srv_"),
  /** The domain mail is sent AS — one of the two the master's map names. */
  senderDomain,
  dmarcPolicy: z.enum(DMARC_POLICY).default("none"),
  /** Where receivers send their aggregate DMARC reports — a mailbox somebody reads. */
  dmarcMailbox: z.string().email(),
});
export type MailDnsPublishParams = z.infer<typeof MailDnsPublishParams>;

export interface MailDnsPublishPorts extends DeploySlavePorts, AnsiwisePorts {
  /** The DNS provider the egress address is read from (the master's own A record). */
  dns?: DnsProvider;
}

/** The two domains an installation sends as, off the master's map: customer mail as the platform
 *  domain, alert mail as the unit apex. Both are required: a map that names neither belongs to an
 *  installation that sends no mail, and this run has nothing to publish for it. */
export async function senderDomainsOf(ports: DeploySlavePorts, clusterDomain: string): Promise<{ platformDomain: string; unitApex: string }> {
  const marking = await resolveClusterMarking(requirePlatformRepo(ports), clusterDomain);
  if (marking.platformDomain === undefined || marking.unitApex === undefined) {
    throw errValidation(
      `the map of ${clusterDomain} names no ${marking.platformDomain === undefined ? "platformDomain" : "unitApex"} — ` +
        "the two sender domains of an installation (customer mail as the platform domain, alert mail as the unit apex) are read off " +
        "the master's map, and nothing else may state them; write the answer into the installation's config and regenerate the branch",
    );
  }
  return { platformDomain: marking.platformDomain, unitApex: marking.unitApex };
}

/** Which of the two roles a sender domain plays on this installation, or undefined for a name the
 *  installation does not send as. */
export function senderRoleOf(domain: string, sender: { platformDomain: string; unitApex: string }): "customer mail" | "alert mail" | undefined {
  if (domain === sender.platformDomain) return "customer mail";
  if (domain === sender.unitApex) return "alert mail";
  return undefined;
}

/** What `publish-mail-dns` is answered with beyond the inventory (composeAnswers reads `stage` off
 *  the cluster row): the run's domain and DMARC choices, and the egress address READ off the master's
 *  own A record — fail-closed on a master that has none, since a record naming a guessed address
 *  would make receivers fail every mail of the domain. */
export function mailDnsAnswers(params: MailDnsPublishParams, ports: MailDnsPublishPorts): ExtraAnswers {
  return async (ctx) => {
    const { cluster } = loadActiveCluster(ctx.db, params.serverId);
    const sender = await senderDomainsOf(ports, cluster.domain);
    const role = senderRoleOf(params.senderDomain, sender);
    if (role === undefined) {
      throw errValidation(`${params.senderDomain} is not a sender domain of ${cluster.domain} — its map names ${sender.platformDomain} (customer mail) and ${sender.unitApex} (alert mail)`);
    }
    const egress = await requireMailDns(ports).readRecordContent({ name: cluster.domain, type: "A", signal: ctx.signal });
    if (egress === null) {
      throw errValidation(
        `${cluster.domain} has no A record at the DNS provider — the egress address the SPF names is read off that record, ` +
          "and a master that is not reachable by its own name is not one whose mail should be announced",
      );
    }
    ctx.log(
      "meta",
      `${MAIL_DNS_PROGRAM} is told mail_domain=${params.senderDomain} (${role}), egress_address=${egress} (the A record of ${cluster.domain}), ` +
        `dmarc_policy=${params.dmarcPolicy}, dmarc_mailbox=${params.dmarcMailbox}; dkim_selector is left to the stage, which is what the relay signs with`,
    );
    return {
      mail_domain: params.senderDomain,
      egress_address: egress,
      dmarc_policy: params.dmarcPolicy,
      dmarc_mailbox: params.dmarcMailbox,
    };
  };
}

/** What stands under the three published names at the provider, each picked by its version tag
 *  among the TXT of the name (the apex carries other services' TXT beside the SPF) — null where no
 *  such record stands. */
export async function readPublishedRecords(dns: DnsProvider, domain: string, stage: Stage, signal: AbortSignal): Promise<Record<PublishedMailRecord, string | null>> {
  const names = mailRecordNames(domain, stage);
  const standing: Record<PublishedMailRecord, string | null> = { spf: null, dkim: null, dmarc: null };
  for (const record of PUBLISHED_MAIL_RECORD) {
    standing[record] = (await dns.listRecordContents({ name: names[record], type: "TXT", signal })).find(MAIL_RECORD_TAG[record]) ?? null;
  }
  return standing;
}

/** The program step's checkpoint and, beside it, the reading this decoration took before the
 *  program ran — one slot, because a step has one. */
interface BookedCheckpoint {
  before?: Record<PublishedMailRecord, string | null>;
  program?: unknown;
}

/** The program step with the book around it: the three published names are read before the program
 *  and after it, and every record the program changed enters the book of DNS writes. The reading
 *  before is checkpointed the moment it is taken and the program's own checkpoint is kept under
 *  `program`, so a step re-entered after a crash judges against what stood before the FIRST attempt
 *  rather than against what the program has already written. */
export function bookedProgramStep(params: MailDnsPublishParams, ports: MailDnsPublishPorts, program: Step): Step {
  return {
    name: program.name,
    title: program.title,
    run: async (ctx: StepCtx) => {
      const dns = requireMailDns(ports);
      const { cluster } = loadActiveCluster(ctx.db, params.serverId);
      const names = mailRecordNames(params.senderDomain, cluster.stage);
      const cp = ctx.readCheckpoint<BookedCheckpoint>() ?? {};
      const before = cp.before ?? (await readPublishedRecords(dns, params.senderDomain, cluster.stage, ctx.signal));
      cp.before = before;
      ctx.checkpoint(cp);
      await program.run({
        ...ctx,
        checkpoint: (data) => { cp.program = data; ctx.checkpoint(cp); },
        readCheckpoint: <T>() => cp.program as T | undefined,
      });
      const after = await readPublishedRecords(dns, params.senderDomain, cluster.stage, ctx.signal);
      for (const record of PUBLISHED_MAIL_RECORD) {
        const stands = after[record];
        if (stands === null || stands === before[record]) continue;
        const act = before[record] === null ? "inserted" : "updated";
        recordDnsWrite(ctx.db, { name: names[record], type: "TXT", content: stands, act, owner: { kind: "mail", name: params.senderDomain }, runId: ctx.runId });
        ctx.log("meta", `TXT ${names[record]} ${act === "inserted" ? "inserted" : `updated from ${before[record]}`} → ${stands} — entered into the book of DNS writes`);
      }
    },
  };
}

function requireMailDns(ports: MailDnsPublishPorts): DnsProvider {
  if (!ports.dns) {
    throw errValidation("no DNS provider is wired into this manager — the egress address is read off the master's own A record there, and nothing else may state it");
  }
  return ports.dns;
}

function mailDnsPublishSteps(params: MailDnsPublishParams, ports: MailDnsPublishPorts): Step[] {
  const target = activeClusterTarget(params.serverId);
  return [
    attestClusterStep(target),
    bookedProgramStep(params, ports, ansiwiseProgramStep(target, MAIL_DNS_PROGRAM, ports, {
      extra: mailDnsAnswers(params, ports),
      // Silent degradation this run may not produce: a program that dropped one of these would
      // publish a record for the wrong domain, a wrong address, or reports to nobody.
      requiredAnswers: ["mail_domain", "egress_address", "dmarc_mailbox"],
    })),
  ];
}

export function makeMailDnsPublishDef(ports: MailDnsPublishPorts): RunDefinition<MailDnsPublishParams> {
  return {
    kind: "mail-dns-publish",
    paramsSchema: MailDnsPublishParams,
    mutating: true,
    plan: async (params, { db }) => {
      const { server, cluster } = loadActiveCluster(db, params.serverId);
      if (!isMasterRole(server.role)) {
        throw errValidation(
          `${server.name} is a ${server.role} — ${MAIL_DNS_PROGRAM} runs on the master: the relay stands there, the hand-filled input ` +
            "with the DNS token stands there, and the egress address the records name is the master's",
        );
      }
      const sender = await senderDomainsOf(ports, cluster.domain);
      const role = senderRoleOf(params.senderDomain, sender);
      if (role === undefined) {
        throw errValidation(
          `${params.senderDomain} is not a sender domain of ${cluster.domain}: its map names ${sender.platformDomain} (customer mail, platformDomain) ` +
            `and ${sender.unitApex} (alert mail, unitApex), and mail leaves this installation as nothing else`,
        );
      }
      const stepDefs = mailDnsPublishSteps(params, ports);
      return {
        kind: "mail-dns-publish",
        targetKind: "server",
        targetId: params.serverId,
        summary:
          `Publish the mail DNS of ${params.senderDomain} (${role}) through the DNS provider, from the master "${server.name}" ` +
          `(${cluster.domain}, ${cluster.stage}): the catalogue's ${MAIL_DNS_PROGRAM} program merges the master's egress address into the ` +
          `domain's SPF (one v=spf1 record, everything already in it kept), writes the domain's address record, publishes the DKIM key ` +
          `where the relay holds one, and sets DMARC ${params.dmarcPolicy} with reports to ${params.dmarcMailbox} — proved dry, then run, ` +
          `on the master's own record. The password you enter raises the program's root commands and is stored nowhere.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [{ serverId: server.id, ownsHost: true, label: `${server.name} (${server.role})` }],
        locks: [],
        warnings: [
          `The reverse DNS of the master's egress address is set at the hosting provider, not here — point it at ${sender.platformDomain}.`,
        ],
        requiredSecrets: [ANSIWISE_ELEVATION_SECRET],
      };
    },
    steps: (params) => mailDnsPublishSteps(params, ports),
  };
}
