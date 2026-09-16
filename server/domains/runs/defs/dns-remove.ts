import { z } from "zod";
import type { RunDefinition, Step } from "../../../executor/types.ts";
import { ATTEST_TARGET_STEP } from "../../../executor/guards.ts";
import { DNS_RECORD_TYPE } from "../../../../shared/dns.ts";
import { deleteRecord, ownedRecords, ownerSentence, removableRecord, requireDnsProvider, type DnsRecordPorts } from "./dns-record.kit.ts";

// dns-remove: take ONE record of this installation back at the DNS provider — the record an
// abandoned installation leaves in the zone when its machines are restored bare and its units are
// never offboarded (the leftover unit-dns.ts readStandingHost names, measured on 2026-09-15 when
// post.digitacloud.app still answered with the address of an apps machine that was gone).
//
// WHAT IT MAY DELETE is decided by the DNS inventory and never by the operator's typing: the plan
// resolves (name, type) in it and refuses a name this installation does not own or a row it lists
// read-only. The same resolution is taken AGAIN at attest-target, which is this run's fail-closed
// precondition: a plan can stand approved for a while, and a record that stopped being ours in the
// meantime must not be deleted on the strength of what was true then.
//
// IT REACHES NO MACHINE. The record is in the zone, so the target is this manager itself and the
// run carries no elevation password, no session and no program.

export const DnsRemoveParams = z.object({
  /** The record NAME exactly as the inventory carries it — a host, a wildcard, or a mail record's
   *  own name (`<stage>._domainkey.<domain>`, `_dmarc.<domain>`). */
  name: z.string().min(1),
  type: z.enum(DNS_RECORD_TYPE),
});
export type DnsRemoveParams = z.infer<typeof DnsRemoveParams>;

function dnsRemoveSteps(params: DnsRemoveParams, ports: DnsRecordPorts): Step[] {
  return [
    {
      name: ATTEST_TARGET_STEP,
      title: "Attest the record is this installation's and may be taken back",
      run: async (ctx) => {
        const row = removableRecord(await ownedRecords(ports), params.name, params.type);
        ctx.checkpoint({ record: row.name, type: row.type, owner: row.owner, found: row.found, verdict: row.verdict });
        ctx.log("meta", `${row.type} ${row.name} belongs to ${ownerSentence(row)} and stands at ${row.found ?? "nothing — it is already absent"}`);
      },
    },
    {
      name: "remove-record",
      title: "Remove the record at the DNS provider",
      // Resolved in the inventory AGAIN rather than deleted by the params: a TXT goes by the content
      // this platform owns, which the row and the book decide (dns-record.kit.ts), never the name.
      run: async (ctx) => deleteRecord(ctx, requireDnsProvider(ports), removableRecord(await ownedRecords(ports), params.name, params.type)),
    },
  ];
}

export function makeDnsRemoveDef(ports: DnsRecordPorts): RunDefinition<DnsRemoveParams> {
  return {
    kind: "dns-remove",
    paramsSchema: DnsRemoveParams,
    mutating: true,
    plan: async (params) => {
      const row = removableRecord(await ownedRecords(ports), params.name, params.type);
      requireDnsProvider(ports);
      return {
        kind: "dns-remove",
        targetKind: "self",
        targetId: "manager",
        summary:
          `Remove the ${row.type} record ${row.name} at the DNS provider — the record of ${ownerSentence(row)}. ` +
          `It stands at ${row.found ?? "nothing (it is already absent, and the removal is then a no-op)"}, where that owner's state says ${row.expected}. ` +
          "Nothing on any machine is touched: the record is in the zone, and what stood there is written into this run's log before it goes.",
        steps: dnsRemoveSteps(params, ports).map((s) => ({ name: s.name, title: s.title })),
        warnings:
          row.verdict === "standing"
            ? [`${row.name} answers with exactly what ${ownerSentence(row)} needs — removing it takes a name that is in use right now out of DNS.`]
            : [],
        requiredSecrets: [],
      };
    },
    steps: (params) => dnsRemoveSteps(params, ports),
  };
}
