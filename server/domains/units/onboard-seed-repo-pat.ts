// The onboard `seed-repo-pat` step, and the `refresh-repo-pat` step a release of a unit whose
// credential is the platform's GitHub App runs first. Split out of onboard.run.ts (like
// onboard-webhook.ts / onboard-activate.ts / secret-mint.ts) so the run file stays a thin
// orchestrator and the per-unit PAT writes are a small, self-contained unit.
import type { Step } from "../../executor/types.ts";
import { KV_MOUNT } from "../../adapters/vault/port.ts";
import type { OnboardPorts, OnboardParams } from "./onboard.run.ts";
import { refreshUnitRepoPat } from "./app-token-refresh.ts";

/** The onboard `seed-repo-pat` step: write the ONE per-unit GitHub PAT (the SAME value the
 *  Manager clones with) to secret/build/<name>/repo-pat (property `pat`) on the LOCAL Vault — the
 *  entry the unit's consumer-build ExternalSecrets (clone credential, npmrc, the bump credential)
 *  read. The manager runs on the build-plane cluster, so its own Vault IS the build plane's and
 *  there is no target-cluster resolution. Stage-free: one build plane, one PAT per unit.
 *
 *  ATTEST-OR-CREATE (cas=0): the seven platform units were hand-seeded before the run kind existed, so a
 *  path that already stands is attested (`created: false`) and never overwritten — the write-only
 *  rule on data holds, and the cas conflict is the existence proof. UNCONDITIONAL in both onboard
 *  forms and fail-closed: a failed write fails the run. The value is opened from the sealed store
 *  (never re-plumbed raw through params) and zeroed after the write. */
export function seedRepoPatStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "seed-repo-pat",
    title: "Seed the unit's repo PAT into the local build Vault",
    run: async (ctx) => {
      const pat = await ctx.creds.open(p.repoCredentialId, { purpose: "consumer-onboard:seed-repo-pat", runId: ctx.runId });
      let created: boolean;
      try {
        ({ created } = await ports.seeder.seedBuildRepoPat({ consumerName: p.consumerName, pat: pat.toString("utf8") }));
      } finally {
        pat.fill(0);
      }
      const path = `${KV_MOUNT}/build/${p.consumerName}/repo-pat`;
      ctx.checkpoint({ path, created });
      ctx.log(
        "meta",
        created
          ? `repo PAT seeded to ${path} (property pat) — the unit's build namespace can now clone, read packages and push its bump`
          : `repo PAT already present at ${path} — attested and left untouched (create-only). To rotate it, delete the entry deliberately and re-onboard.`,
      );
    },
  };
}

/** The `refresh-repo-pat` step: REWRITE the unit's entry with the value its credential opens to now.
 *  For a `github-app` credential that is a token the App minted this second, so the release
 *  triggered next clones with one that lives a full hour — the boot-time and 45-minute refresh
 *  (app-token-refresh.ts) keeps the entry alive between releases, and this step keeps a release
 *  right after a Manager boot from meeting the value a dead Manager left. Runs only in the release
 *  re-run of a unit already registered (tenant-apps-steps.ts): the first onboarding seeds the entry
 *  through seed-repo-pat and clones within the hour. */
export function refreshRepoPatStep(ports: OnboardPorts, p: OnboardParams): Step {
  return {
    name: "refresh-repo-pat",
    title: "Rewrite the unit's repo PAT in the local build Vault with a value minted now",
    run: async (ctx) => {
      await refreshUnitRepoPat({ store: ctx.creds, seeder: ports.seeder }, p.consumerName, p.repoCredentialId, { purpose: "consumer-onboard:refresh-repo-pat", runId: ctx.runId });
      const path = `${KV_MOUNT}/build/${p.consumerName}/repo-pat`;
      ctx.checkpoint({ path });
      ctx.log("meta", `repo PAT rewritten at ${path} (property pat) with the credential's current value — the release below clones with it`);
    },
  };
}
