import { describe, it, expect } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { Registrations } from "./registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import type { Stage } from "../../../shared/enums.ts";

const unit = (over: { name?: string; repoURL?: string } = {}) => ({ name: "acme", repoURL: "https://github.com/x/acme.git", suspended: false, quiesced: false, ...over });
const deploy = (over: { stage?: Stage; cluster?: string; smtpEntry?: { service: string; port: number } } = {}) =>
  ({ stage: "prod" as Stage, chartPath: "deploy/chart", cluster: "s1", host: "acme", databases: [], keyPatterns: [], channelPatterns: [], services: [], size: "small" as const, mongodb: "shared" as const, quota: seedQuota("small"), ...over });

describe("Registrations.listSmtpSenders", () => {
  it("names every unit whose registration at the stage carries an SMTP entry, with the cluster it stands on", async () => {
    const repo = new FakePlatformRepo();
    const reg = new Registrations(repo);
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ cluster: "apps1", smtpEntry: { service: "acme-mta", port: 2525 } }), runId: "run_1" });
    await reg.commitRegistration({ unit: unit(), builds: [], deploy: deploy({ stage: "dev", cluster: "s1dev" }), runId: "run_2" });
    await reg.commitRegistration({ unit: unit({ name: "other", repoURL: "https://github.com/x/other.git" }), builds: [], deploy: deploy(), runId: "run_3" });
    expect(await reg.listSmtpSenders("prod")).toEqual([{ unit: "acme", cluster: "apps1", entry: { service: "acme-mta", port: 2525 } }]);
    expect(await reg.listSmtpSenders("dev")).toEqual([]);
  });

  it("THROWS on a stage file that does not validate — a skipped file would hide a sender and let a second one in", async () => {
    const repo = new FakePlatformRepo();
    repo.seed(repo.booksBranch, "registrations/broken/prod.yaml", "name: broken\nrepoURL: not-a-url\n");
    await expect(new Registrations(repo).listSmtpSenders("prod")).rejects.toThrow(/registrations\/broken\/prod\.yaml/);
  });
});
