// G29 mail sender (HARD). A unit that declares an SMTP entry becomes its stage's mail sender: the
// installation's own relay forwards to that entry and the Mail page measures the address mail leaves
// from there (hostyour-cloud#242, hostyour-manager#249). One stage has ONE sender (decided
// 2026-09-23), so a candidate declaring an entry at a stage where another unit already carries one is
// refused before the first write. A re-onboard of the sender itself passes.
import type { GateResult } from "../../../../shared/gates.ts";
import type { Stage } from "../../../../shared/enums.ts";

export function gateMailSender(input: { unitName: string; stage: Stage; senders: { unit: string; cluster: string }[] }): GateResult {
  const others = input.senders.filter((s) => s.unit !== input.unitName);
  const base = {
    id: "G29",
    title: "mail sender",
    severity: "hard" as const,
    expected: `no other unit carries an SMTP entry at ${input.stage} — one stage has one mail sender`,
  };
  if (others.length === 0) {
    return { ...base, status: "pass", found: `${input.unitName} becomes the mail sender of ${input.stage}`, reason: null, detail: "the stage's only mail sender" };
  }
  return {
    ...base,
    status: "fail",
    found: `${others.map((s) => `${s.unit} (on ${s.cluster})`).join(", ")} already carries the SMTP entry of ${input.stage}`,
    reason: `offboard ${others.map((s) => s.unit).join(", ")} at ${input.stage} first, or onboard ${input.unitName} without smtpEntry`,
    detail: "the stage already has a mail sender",
    evidence: others.map((s) => ({ source: "manager" as const, name: s.unit, fieldPath: "smtpEntry", value: s.cluster })),
  };
}
