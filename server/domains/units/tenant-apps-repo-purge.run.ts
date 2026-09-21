import { z } from "zod";
import type { RunDefinition, Step } from "../../executor/types.ts";
import { errValidation } from "../../kernel/errors.ts";
import { STAGE } from "../../../shared/enums.ts";
import type { OrphanBuildView } from "../../../shared/api-types.ts";
import { assertDeployState, type TenantLifecyclePorts } from "./lifecycle.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { resolveMasterCluster } from "./tenant-values.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import type { Registrations } from "./registrations.ts";

// "tenant-apps-repo-purge" — the removal of a build registration nothing accounts for (#241).
//
// A build-only registration (registrations/<unit>/build.yaml) is written by tenant-apps-repo for a
// tenant's own apps repository and goes with the tenant's last app or with the tenant
// (tenant-apps-repo-delete.ts, #217). Nothing else removes one: there is no unit offboard. So a
// registration whose tenant is gone another way — the repository deleted by hand, the tenant purged
// before #217 — stands forever: the App-token refresh presents it every tick and fails on it by name,
// its Vault entry build/<unit>/repo-pat stays, and the build ApplicationSet renders an Application
// for a repository that is not there. This run kind is that removal, keyed on the unit name the orphan
// scan found, exactly as tenant-purge is keyed on the guid the tenant scan found.
//
// WHAT IS ORPHANED: a build registration with NO stage file beside it (a consumer's build.yaml stands
// beside its stage files and is theirs) and NO tenant registration, at any stage, naming it as
// `appsImage`. Both are read from the two registration trees, and both are asked at plan time and
// again in the removal itself: removeBuildRegistration refuses on its own while a stage file stands.
//
// mutating: true ⇒ attest-target is step 0 (guards.assertGuardsArmed), on the master — the build
// plane the unit's `<unit>-build` namespace lives on, as for every build-only form.

export const TenantAppsRepoPurgeParams = z.object({ unit: z.string().min(1) });
export type TenantAppsRepoPurgeParams = z.infer<typeof TenantAppsRepoPurgeParams>;

/** Every build registration no stage file and no tenant registration accounts for. THROWS where a
 *  build.yaml does not read (listBuildRegistrations): a set that silently shrank would list an orphan
 *  as accounted for. */
export async function scanOrphanBuilds(deps: { registrations: Pick<TenantRegistrations, "listTenantPointers">; buildRegistrations: Pick<Registrations, "listBuildRegistrations" | "readUnitStages"> }): Promise<OrphanBuildView[]> {
  const named = new Set<string>();
  for (const stage of STAGE) {
    for (const t of (await deps.registrations.listTenantPointers(stage)).pointers) if (t.appsImage) named.add(t.appsImage);
  }
  const orphans: OrphanBuildView[] = [];
  for (const { unit, entry } of await deps.buildRegistrations.listBuildRegistrations()) {
    if (named.has(unit)) continue;
    if ((await deps.buildRegistrations.readUnitStages(unit)).length > 0) continue;
    orphans.push({ unit, repoURL: entry.repoURL });
  }
  return orphans;
}

function purgeSteps(ports: TenantLifecyclePorts, p: TenantAppsRepoPurgeParams): Step[] {
  return [
    {
      name: "attest-target",
      title: "Attest the build plane (deploy-state fresh)",
      run: async (ctx) => {
        const master = resolveMasterCluster(ctx.db);
        const { clusterReader } = await ports.resolver.resolve(master.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), master.domain, p.unit);
        ctx.log("meta", `build plane ${master.domain} attested for ${p.unit} — deploy-state generation ${state.generation}`);
      },
    },
    {
      name: "delete-repository",
      title: "Delete the repository, where this platform created it",
      run: async (ctx) => {
        // The same rule as the tenant's own deletion (tenant-apps-repo-delete.ts): only a repository
        // standing in the App's own owner under the unit's name is one the platform created.
        if (!ports.buildRegistrations) throw errValidation("no build registrations are wired on this manager — nothing can be purged");
        const current = await ports.buildRegistrations.readBuildRegistration(p.unit);
        if (!current) {
          ctx.log("meta", `registrations/${p.unit}/build.yaml is already absent — no repository to delete`);
          return;
        }
        if (!ports.githubApp) throw errValidation(`the repository of ${p.unit} is to be deleted and this Manager holds no GitHub App identity — set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY`);
        const { owner, repo } = parseGitHubOwnerRepo(current.entry.repoURL);
        const org = await ports.githubApp.installationOrg(ctx.signal);
        if (owner !== org || repo !== p.unit) {
          ctx.log("meta", `${current.entry.repoURL} is not one this platform created (the App creates ${org}/${p.unit}) — left standing`);
          return;
        }
        const { deleted } = await ports.githubApp.deleteRepository({ org: owner, name: repo, signal: ctx.signal });
        ctx.log("meta", deleted ? `repository ${current.entry.repoURL} deleted` : `repository ${current.entry.repoURL} already gone`);
      },
    },
    {
      name: "remove-build-registration",
      title: "Remove the build registration",
      run: async (ctx) => {
        if (!ports.buildRegistrations) throw errValidation("no build registrations are wired on this manager — nothing can be purged");
        const { removed } = await ports.buildRegistrations.removeBuildRegistration(p.unit, ctx.runId);
        ctx.log("meta", removed ? `build registration of ${p.unit} removed` : `build registration of ${p.unit} already absent`);
      },
    },
    {
      name: "remove-repo-pat",
      title: "Remove the unit's repo PAT (local build Vault)",
      run: async (ctx) => {
        // The entry the App-token refresh wrote for the registration (app-token-refresh.ts); the
        // consumer offboard's remove-repo-pat, idempotent on an already-absent entry.
        if (!ports.seeder) {
          ctx.log("meta", `no Vault seeder is wired on this manager — build/${p.unit}/repo-pat stays`);
          return;
        }
        await ports.seeder.deleteBuildRepoPat({ consumerName: p.unit });
        ctx.log("meta", `repo PAT removed — build/${p.unit}/repo-pat deleted`);
      },
    },
  ];
}

export function makeTenantAppsRepoPurgeDef(ports: TenantLifecyclePorts): RunDefinition<TenantAppsRepoPurgeParams> {
  return {
    kind: "tenant-apps-repo-purge",
    paramsSchema: TenantAppsRepoPurgeParams,
    mutating: true,
    plan: async (p, { db }) => {
      if (!ports.buildRegistrations) throw errValidation("no build registrations are wired on this manager — nothing can be purged");
      // Refused at plan and again in the removal: a unit a tenant names, or one standing at a stage,
      // is not an orphan, and the operator is told which.
      const orphan = (await scanOrphanBuilds({ registrations: ports.registrations, buildRegistrations: ports.buildRegistrations })).find((o) => o.unit === p.unit);
      if (!orphan) throw errValidation(`${p.unit} is not an orphaned build registration — a tenant names it, a stage file stands beside it, or it is already gone`);
      const master = resolveMasterCluster(db);
      const stepDefs = purgeSteps(ports, p);
      return {
        kind: "tenant-apps-repo-purge",
        targetKind: "cluster",
        targetId: master.clusterId,
        summary: `Purge the orphaned build registration ${p.unit}: delete ${orphan.repoURL} where this platform created it, remove registrations/${p.unit}/build.yaml and build/${p.unit}/repo-pat. No tenant names it and no stage file stands beside it.`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [],
        locks: [...tenantLocks(ports.registrations), { resource: "git-branch", key: ports.buildRegistrations.branch }],
        warnings: [],
        requiredSecrets: [],
      };
    },
    steps: (params) => purgeSteps(ports, params),
  };
}
