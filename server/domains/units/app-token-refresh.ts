// The build Vault's repo-pat of every unit whose credential is the platform's GitHub App, rewritten
// with a token minted now. An installation token lives one hour and the release pipeline's clone
// reads it off secret/build/<unit>/repo-pat, so a value seeded once at the onboarding lets the unit
// build exactly once. The entry is therefore REWRITTEN — every 45 minutes on a timer
// (boot/refresh-app-tokens-schedule.ts, once at boot too) and before every release the Manager
// triggers for such a unit (onboard-seed-repo-pat.ts refreshRepoPatStep). A unit whose credential is
// a consumer's own PAT is left alone: that value does not expire and its entry is create-only.
//
// A REWRITE ALONE REACHES NO CLONE. The pipeline's clone task reads the Secret `build-git-https`
// in <unit>-build, and that Secret is what an ExternalSecret materialized out of Vault at ONE of two
// moments: its deploy, or the deletion of the Secret it targets (`refreshPolicy: OnChange`,
// `refreshInterval: "0"` — hostyour-cloud's delivery rule, stated in
// clusters/charts/external-secret/templates/externalsecret.yaml; nothing on the platform reads Vault
// on a timer). So every successful rewrite is followed by the deletion of the unit's three target
// Secrets, which is the one act that makes ESO fetch the new value.
//
// WHICH units: every build registration whose repoCredentialId is a `github-app` credential of the
// store. The registration is the one holder of the id (registrations/<unit>/build.yaml), and the
// store's kind column says what the id is; nothing here reads a label or a name.
import type { Logger } from "../../kernel/logger.ts";
import type { CredentialStore, UseContext } from "../../security/store.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import type { ClusterReader } from "../../adapters/kube/port.ts";
import type { Registrations } from "./registrations.ts";
import { unitBuildNamespace } from "./build-rbac.ts";

/** The three Secrets of a unit's build namespace that carry its repo-pat, by the `target.name` of
 *  the ExternalSecret that materializes each — hostyour-cloud
 *  clusters/inventories/consumer-build/templates/externalsecret-git-https.yaml (the clone
 *  credential), externalsecret-bump.yaml (the bump's push credential) and externalsecret-npmrc.yaml
 *  (the package read). Deleting one is what makes its ExternalSecret read Vault again. */
export const BUILD_TARGET_SECRETS = ["build-git-https", "bump-git-https", "build-npmrc"] as const;

export interface AppTokenRefreshDeps {
  store: Pick<CredentialStore, "list" | "open">;
  registrations: Pick<Registrations, "listBuildRegistrations">;
  seeder: Pick<VaultSeeder, "refreshBuildRepoPat">;
  /** The build plane's cluster reader — the master's own, the cluster this Manager runs on. Absent
   *  on a Manager whose kube is not wired: the entries are still rewritten, and the deletion that
   *  would carry them into the Secrets is logged as skipped, per unit. */
  kube?: Pick<ClusterReader, "deleteSecret">;
  logger: Logger;
}

/** ONE unit's entry, rewritten with the value its credential opens to now — a token minted by the
 *  App for a `github-app` credential. The value is zeroed after the write and never logged. Throws
 *  where the open or the write fails. Writes Vault only: the deletion that lets the value reach the
 *  pipeline is `deleteBuildSecrets`, called by both callers after this succeeded. */
export async function refreshUnitRepoPat(deps: { store: Pick<CredentialStore, "open">; seeder: Pick<VaultSeeder, "refreshBuildRepoPat"> }, unit: string, credentialId: string, use: UseContext): Promise<void> {
  const token = await deps.store.open(credentialId, use);
  try {
    await deps.seeder.refreshBuildRepoPat({ consumerName: unit, pat: token.toString("utf8") });
  } finally {
    token.fill(0);
  }
}

/** Delete the unit's three target Secrets in <unit>-build, so each ExternalSecret materializes the
 *  entry again from Vault. An absent Secret is done (the port treats a 404 as success); a refused
 *  delete throws with the namespace and the name. */
export async function deleteBuildSecrets(kube: Pick<ClusterReader, "deleteSecret">, unit: string): Promise<void> {
  const namespace = unitBuildNamespace(unit);
  for (const name of BUILD_TARGET_SECRETS) await kube.deleteSecret(namespace, name);
}

/** When ESO last wrote each of the three, off the ExternalSecret rows of <unit>-build: the
 *  `refreshTime` of the row targeting each Secret, keyed by that Secret's name, the empty text where
 *  no row targets it or it never materialized. Read before a deletion and again after it, the two
 *  readings say whether the Secret stands again: its time moved. */
export async function readBuildSecretRefreshTimes(kube: Pick<ClusterReader, "listExternalSecrets">, unit: string): Promise<Record<string, string>> {
  const rows = await kube.listExternalSecrets(unitBuildNamespace(unit));
  return Object.fromEntries(BUILD_TARGET_SECRETS.map((name) => [name, rows.find((r) => r.targetSecret === name)?.refreshTime ?? ""]));
}

/** Every unit whose build registration names a `github-app` credential, refreshed one by one: a
 *  unit whose open or write fails is logged with its name and the rest go on, and a registration
 *  tree that cannot be read is logged as one failure. After each rewrite the unit's three build
 *  Secrets are deleted, which is what makes ESO's `OnChange` ExternalSecrets fetch the new value —
 *  a unit whose deletion fails is logged with its name and counted failed, because its clone still
 *  reads the value ESO wrote before. The timer does not wait for the Secrets to return; the release
 *  step (refreshRepoPatStep) does. NEVER rejects — boot starts it unawaited and the timer fires it
 *  unattended. Answers what it did, so a caller can read it back. */
export async function refreshAppTokens(deps: AppTokenRefreshDeps): Promise<{ refreshed: string[]; failed: string[] }> {
  const refreshed: string[] = [];
  const failed: string[] = [];
  const units: { unit: string; credentialId: string }[] = [];
  try {
    const appCredentials = new Set((await deps.store.list({ kind: "github-app" })).map((c) => c.id));
    for (const { unit, entry } of await deps.registrations.listBuildRegistrations()) {
      if (entry.repoCredentialId && appCredentials.has(entry.repoCredentialId)) units.push({ unit, credentialId: entry.repoCredentialId });
    }
  } catch (err) {
    deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, "the App-token refresh could not read which units carry a GitHub App credential — no repo-pat was rewritten this time");
    return { refreshed, failed };
  }
  const undeleted: string[] = [];
  for (const { unit, credentialId } of units) {
    try {
      await refreshUnitRepoPat(deps, unit, credentialId, { purpose: "app-token-refresh" });
    } catch (err) {
      failed.push(unit);
      deps.logger.error({ unit, credentialId, err: err instanceof Error ? err.message : String(err) }, "the App token of this unit could not be rewritten into its build repo-pat — its next release clones with the value that stands, which dies an hour after it was minted");
      continue;
    }
    if (!deps.kube) {
      undeleted.push(unit);
      refreshed.push(unit);
      continue;
    }
    try {
      await deleteBuildSecrets(deps.kube, unit);
      refreshed.push(unit);
    } catch (err) {
      failed.push(unit);
      deps.logger.error({ unit, namespace: unitBuildNamespace(unit), err: err instanceof Error ? err.message : String(err) }, "the build repo-pat of this unit was rewritten but its build Secrets could not be deleted — ESO keeps the Secrets it wrote before, so the next clone reads the old token");
    }
  }
  if (undeleted.length > 0) deps.logger.warn({ units: undeleted }, "no kube is wired on this Manager, so the build Secrets of these units were not deleted after the rewrite — ESO keeps the Secrets it wrote before, and the next clone reads the old token");
  if (units.length > 0) deps.logger.info({ refreshed, failed }, "App tokens refreshed into the build repo-pat entries and their build Secrets deleted");
  return { refreshed, failed };
}
