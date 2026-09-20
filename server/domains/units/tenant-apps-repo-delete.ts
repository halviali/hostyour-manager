import type { Step, StepCtx } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { Stage } from "../../../shared/enums.ts";
import type { TenantLifecyclePorts } from "./lifecycle.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";

// A TENANT'S APPS REPOSITORY GOES WITH ITS LAST APP (hostyour-manager#217). The repository the
// platform created for the tenant (`<bundle>-<subdomain>`, tenant-apps-tree.ts) stands as long as an
// app of the tenant does: remove-app deletes it when the app it drops was the last one, and every
// tenant removal (offboard, purge, the replace and abort teardowns) deletes it with the tenant. Three
// things go together, because they were written together by tenant-apps-repo: the repository on
// github.com (through the App that created it), the bundle's build-only registration
// (registrations/<unit>/build.yaml), and — where the tenant stays — the bundle's three fields on its
// registration, so the tenant is its platform alone again and the next add-app creates afresh.
//
// ONLY WHAT THE PLATFORM CREATED IS DELETED: the repository is deleted when it stands in the App's
// own organisation under the bundle's unit name, which is exactly and only what create-repository
// creates. A registration pointing anywhere else (the catalog's template, a repository the tenant
// brought) names a repository this platform never made, and that one is left standing, said in the
// log. Idempotent on a resume: a repository already gone answers deleted:false, a registration
// already cleared carries no repository to delete.

export interface TenantAppsRepoTarget {
  stage: Stage;
  guid: string;
}

/** Deletes the tenant's apps repository, its build registration and (where `clear`) the bundle
 *  fields of its registration. `clear` is for a tenant that STAYS (remove-app); a removal whose next
 *  step git-rms the registration has nothing to clear. */
export async function deleteTenantAppsRepository(ctx: StepCtx, ports: TenantLifecyclePorts, t: TenantAppsRepoTarget, opts: { clear: boolean }): Promise<void> {
  const current = await ports.registrations.readTenant(t.stage, t.guid);
  if (!current?.entry.appsRepo) {
    ctx.log("meta", `tenant ${t.guid} records no apps repository — nothing to delete`);
    return;
  }
  const { appsRepo, appsImage } = current.entry;
  const { owner, repo } = parseGitHubOwnerRepo(appsRepo);
  if (!ports.githubApp) throw errValidation(`tenant ${t.guid}'s apps repository ${appsRepo} is to be deleted and this Manager holds no GitHub App identity — set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY`);
  const org = await ports.githubApp.installationOrg(ctx.signal);
  if (owner !== org || repo !== appsImage) {
    ctx.log("meta", `tenant ${t.guid}'s apps repository ${appsRepo} is not one this platform created (the App creates ${org}/${appsImage}) — left standing`);
    return;
  }
  const { deleted } = await ports.githubApp.deleteRepository({ org: owner, name: repo, signal: ctx.signal });
  ctx.log("meta", deleted ? `repository ${appsRepo} deleted` : `repository ${appsRepo} already gone`);
  if (ports.buildRegistrations) {
    const { removed } = await ports.buildRegistrations.removeBuildRegistration(appsImage, ctx.runId);
    ctx.log("meta", removed ? `build registration of ${appsImage} removed` : `build registration of ${appsImage} already absent`);
  } else {
    ctx.log("meta", `no build registrations are wired on this manager — registrations/${appsImage}/build.yaml stays`);
  }
  if (opts.clear) {
    const { commit } = await ports.registrations.clearTenantAppsRepo(t.stage, t.guid, ctx.runId);
    ctx.log("meta", `tenant ${t.guid} is its platform alone again — the bundle cleared from its registration (${commit}); the next add-app creates a repository afresh`);
  }
}

/** The step a tenant removal composes ahead of the pointer's removal: the target is frozen. */
export function deleteTenantAppsRepositoryStep(ports: TenantLifecyclePorts, name: string, t: TenantAppsRepoTarget): Step {
  return {
    name,
    title: `Delete the tenant's apps repository, where this platform created one`,
    run: (ctx) => deleteTenantAppsRepository(ctx, ports, t, { clear: false }),
  };
}
