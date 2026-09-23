// The sweep the App-token refresh timer runs over every live unit: each one's ArgoCD repository access
// kept by the rule of repo-credential-keep.ts. Its own module because it reads the live statuses from
// onboard-abort.ts, which imports the onboarding steps that import the rule.
import { inArray } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { apps } from "../../db/schema/inventory.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { ClusterKubeResolver, RepoCredentialWriter } from "../../adapters/kube/port.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { Logger } from "../../kernel/logger.ts";
import { keepUnitRepoCredential } from "./repo-credential-keep.ts";
import { unitRepoCredentialId, type OwnerIdentityReader } from "./repo-identity.ts";
import { CONSUMER_LIVE_STATUS } from "./onboard-abort.ts";

export interface KeepRepoCredentialsDeps {
  db: Db;
  store: Pick<CredentialStore, "list" | "open">;
  githubApp?: Pick<GitHubApp, "reachesRepository" | "installationOrg">;
  owners: OwnerIdentityReader;
  resolver: Pick<ClusterKubeResolver, "resolve">;
  repoCredential: Pick<RepoCredentialWriter, "applyRepoCredential" | "deleteRepoCredential">;
  logger: Pick<Logger, "info" | "error">;
}

/** The sweep over every live unit (active or suspended): each one's access kept by the rule above,
 *  its identity resolved from its repository URL at this tick. A repository no identity reaches has no
 *  credential to keep, as in the relocation. One unit's failure is that unit's, logged by name; the
 *  others go on. */
export async function keepRepoCredentials(deps: KeepRepoCredentialsDeps): Promise<{ kept: string[]; failed: string[] }> {
  const kept: string[] = [];
  const failed: string[] = [];
  const rows = deps.db
    .select({ name: apps.name, stage: apps.stage, clusterId: apps.clusterId, repoUrl: apps.repoUrl })
    .from(apps)
    .where(inArray(apps.status, [...CONSUMER_LIVE_STATUS]))
    .all();
  for (const r of rows) {
    if (!r.repoUrl) continue;
    const unit = `${r.name}-${r.stage}`;
    try {
      const credentialId = await unitRepoCredentialId({ repoURL: r.repoUrl, githubApp: deps.githubApp, owners: deps.owners, store: deps.store });
      if (!credentialId) continue;
      const { argoNamespace } = await deps.resolver.resolve(r.clusterId);
      const result = await keepUnitRepoCredential(deps, { name: r.name, stage: r.stage, repoURL: r.repoUrl, credentialId, argoNamespace }, { purpose: "repo-credential-keep" });
      if (result.identity === "github-app" && result.removed) {
        deps.logger.info({ unit, argoNamespace }, "the token repository Secret of this unit is removed — ArgoCD reads its repository through the App's credential template");
      }
      kept.push(unit);
    } catch (err) {
      failed.push(unit);
      deps.logger.error({ unit, err: err instanceof Error ? err.message : String(err) }, "this unit's ArgoCD repository access could not be kept on this tick — the next tick tries again");
    }
  }
  return { kept, failed };
}
