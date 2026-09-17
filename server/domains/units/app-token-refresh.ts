// The build Vault's repo-pat of every unit whose credential is the platform's GitHub App, rewritten
// with a token minted now. An installation token lives one hour and the release pipeline's clone
// reads it off secret/build/<unit>/repo-pat, so a value seeded once at the onboarding lets the unit
// build exactly once. The entry is therefore REWRITTEN — every 45 minutes on a timer
// (boot/refresh-app-tokens-schedule.ts, once at boot too) and before every release the Manager
// triggers for such a unit (onboard-seed-repo-pat.ts refreshRepoPatStep). A unit whose credential is
// a consumer's own PAT is left alone: that value does not expire and its entry is create-only.
//
// WHICH units: every build registration whose repoCredentialId is a `github-app` credential of the
// store. The registration is the one holder of the id (registrations/<unit>/build.yaml), and the
// store's kind column says what the id is; nothing here reads a label or a name.
import type { Logger } from "../../kernel/logger.ts";
import type { CredentialStore, UseContext } from "../../security/store.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import type { Registrations } from "./registrations.ts";

export interface AppTokenRefreshDeps {
  store: Pick<CredentialStore, "list" | "open">;
  registrations: Pick<Registrations, "listBuildRegistrations">;
  seeder: Pick<VaultSeeder, "refreshBuildRepoPat">;
  logger: Logger;
}

/** ONE unit's entry, rewritten with the value its credential opens to now — a token minted by the
 *  App for a `github-app` credential. The value is zeroed after the write and never logged. Throws
 *  where the open or the write fails. */
export async function refreshUnitRepoPat(deps: { store: Pick<CredentialStore, "open">; seeder: Pick<VaultSeeder, "refreshBuildRepoPat"> }, unit: string, credentialId: string, use: UseContext): Promise<void> {
  const token = await deps.store.open(credentialId, use);
  try {
    await deps.seeder.refreshBuildRepoPat({ consumerName: unit, pat: token.toString("utf8") });
  } finally {
    token.fill(0);
  }
}

/** Every unit whose build registration names a `github-app` credential, refreshed one by one: a
 *  unit whose open or write fails is logged with its name and the rest go on, and a registration
 *  tree that cannot be read is logged as one failure. NEVER rejects — boot starts it unawaited and
 *  the timer fires it unattended. Answers what it did, so a caller can read it back. */
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
  for (const { unit, credentialId } of units) {
    try {
      await refreshUnitRepoPat(deps, unit, credentialId, { purpose: "app-token-refresh" });
      refreshed.push(unit);
    } catch (err) {
      failed.push(unit);
      deps.logger.error({ unit, credentialId, err: err instanceof Error ? err.message : String(err) }, "the App token of this unit could not be rewritten into its build repo-pat — its next release clones with the value that stands, which dies an hour after it was minted");
    }
  }
  if (units.length > 0) deps.logger.info({ refreshed, failed }, "App tokens refreshed into the build repo-pat entries");
  return { refreshed, failed };
}
