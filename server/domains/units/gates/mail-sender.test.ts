import { describe, it, expect } from "vitest";
import { gateMailSender } from "./mail-sender.ts";

describe("G29 mail sender (hard) — one stage, one unit carrying an SMTP entry", () => {
  it("passes the first sender of a stage", () => {
    expect(gateMailSender({ unitName: "post", stage: "prod", senders: [] })).toMatchObject({ id: "G29", severity: "hard", status: "pass", reason: null });
  });

  it("passes a re-onboard of the sender itself — its own entry is not a second sender", () => {
    expect(gateMailSender({ unitName: "post", stage: "prod", senders: [{ unit: "post", cluster: "apps1" }] }).status).toBe("pass");
  });

  it("fails a second sender, naming the unit that stands, its cluster, and the way out", () => {
    const g = gateMailSender({ unitName: "shop", stage: "prod", senders: [{ unit: "post", cluster: "apps1" }] });
    expect(g.status).toBe("fail");
    expect(g.found).toContain("post (on apps1)");
    expect(g.reason).toContain("offboard post at prod first");
    expect(g.evidence).toEqual([{ source: "manager", name: "post", fieldPath: "smtpEntry", value: "apps1" }]);
  });
});
