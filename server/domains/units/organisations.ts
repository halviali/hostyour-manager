import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { organisationIdentities } from "../../db/schema/organisations.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { fingerprintSecret } from "../../security/fingerprint.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { GitHubConsumer } from "../../adapters/github-consumer/port.ts";
import type { OrganisationIdentityView, OrganisationCredentialView } from "../../../shared/api-types-organisations.ts";
import { missingConsumerPatScopes } from "./pat-scopes.ts";

// THE IDENTITY OF AN ORGANISATION (hostyour-manager#218, #219): recorded once, measured before it
// is sealed, derived per unit from the owner of its repository URL by the identity rule
// (repo-identity.ts). Two credentials per organisation, each optional on its own:
//  - the PACKAGES READER: what a build's `.npmrc` carries. GitHub grants an App installation token
//    no access to a private npm package whatever the App's permissions say, so this is a PAT —
//    classic with read:packages or fine-grained with Packages: Read — and the measurement is the
//    one thing that proves it: the token reads the organisation's packages, or it is refused;
//  - the REPOSITORY PAT: the repository identity where the platform's App is not installed in the
//    organisation (repo + workflow + admin:repo_hook). Absent where the App reaches, the ordinary case.
// A token is measured, sealed with its fingerprint, and zeroed; it is never logged and never
// persisted raw. Replacing a credential revokes the row it replaces.

export interface OrganisationDeps {
  db: Db;
  store: Pick<CredentialStore, "seal" | "revoke" | "list">;
  github: Pick<GitHubConsumer, "readOrgToken">;
  githubApp?: Pick<GitHubApp, "installationOrg"> | undefined;
  actor: () => string;
}

/** The three scopes the organisation's repository PAT carries — the consumer contract without
 *  read:packages, which the packages reader carries instead. */
export const REPOSITORY_PAT_SCOPES = ["repo", "workflow", "admin:repo_hook"] as const;

const ORG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

export function assertOrgLogin(org: string): string {
  if (!ORG_RE.test(org)) throw errValidation(`"${org}" is not a GitHub organisation login`);
  return org;
}

/** Every organisation with an identity recorded, and which of them the App is installed in. The
 *  fingerprints come through the store (the one reader of credential rows); the date is the
 *  organisation row's, written when the credential was recorded. */
export async function listOrganisationIdentities(deps: Pick<OrganisationDeps, "db" | "store" | "githubApp">, signal?: AbortSignal): Promise<OrganisationIdentityView[]> {
  const appOrg = deps.githubApp ? await deps.githubApp.installationOrg(signal) : null;
  const rows = deps.db.select().from(organisationIdentities).all();
  const fingerprints = new Map((await deps.store.list({ kind: "pat" })).map((c) => [c.id, c.fingerprint]));
  const view = (id: string | null, at: Date): OrganisationCredentialView | null => {
    const fingerprint = id ? fingerprints.get(id) : undefined;
    return fingerprint ? { fingerprint, recordedAt: at.toISOString() } : null;
  };
  const views = rows.map((r) => ({
    org: r.org,
    appInstalled: r.org === appOrg,
    packagesReader: view(r.packagesCredentialId, r.updatedAt),
    repositoryPat: view(r.repoCredentialId, r.updatedAt),
  }));
  // The App's own organisation is listed even before anything is recorded for it: it is the one
  // the operator most likely needs to complete.
  if (appOrg && !rows.some((r) => r.org === appOrg)) views.unshift({ org: appOrg, appInstalled: true, packagesReader: null, repositoryPat: null });
  return views.sort((a, b) => a.org.localeCompare(b.org));
}

/** The credential ids an onboarding derives a unit's identity from — the identity rule's read. */
export function readOrganisationIdentity(db: Db, org: string): { packagesCredentialId: string | null; repoCredentialId: string | null } | null {
  const row = db.select().from(organisationIdentities).where(eq(organisationIdentities.org, org)).get();
  return row ? { packagesCredentialId: row.packagesCredentialId, repoCredentialId: row.repoCredentialId } : null;
}

async function record(deps: OrganisationDeps, org: string, column: "packagesCredentialId" | "repoCredentialId", token: string, label: string): Promise<OrganisationCredentialView> {
  const plaintext = Buffer.from(token, "utf8");
  const fingerprint = fingerprintSecret(plaintext); // before seal() zeroes the buffer
  const ref = await deps.store.seal({ kind: "pat", label, plaintext, fingerprint });
  const standing = deps.db.select().from(organisationIdentities).where(eq(organisationIdentities.org, org)).get();
  const replaced = standing?.[column] ?? null;
  const now = new Date();
  // Literal keys per column: the schema census reads a writer's payload by name.
  const values = column === "packagesCredentialId" ? { packagesCredentialId: ref.id, updatedAt: now } : { repoCredentialId: ref.id, updatedAt: now };
  if (standing) deps.db.update(organisationIdentities).set(values).where(eq(organisationIdentities.org, org)).run();
  else deps.db.insert(organisationIdentities).values({ org, createdAt: now, ...values }).run();
  if (replaced) await deps.store.revoke(replaced, `replaced by ${ref.id} (${label})`);
  writeAudit(deps.db, { actor: deps.actor(), action: "organisation.credential_recorded", targetKind: "organisation", targetId: org, detail: { column, credentialId: ref.id, fingerprint, replaced } });
  return { fingerprint, recordedAt: now.toISOString() };
}

/** Records the organisation's packages reader after measuring that it reads the organisation's
 *  packages. Refused by name otherwise: an invalid token, one without read:packages, an
 *  organisation the token cannot see. */
export async function recordPackagesReader(deps: OrganisationDeps, org: string, token: string, signal?: AbortSignal): Promise<OrganisationCredentialView> {
  assertOrgLogin(org);
  const reading = await deps.github.readOrgToken({ org, token, ...(signal ? { signal } : {}) });
  if (reading.packages === "invalid") throw errValidation(`the token is invalid or expired — GitHub answered 401 for the packages of ${org}`);
  if (reading.packages === "absent") throw errValidation(`GitHub knows no organisation "${org}" this token can see (404 on its packages)`);
  if (reading.packages === "unreadable") {
    throw errValidation(reading.classic
      ? `the token does not read the packages of ${org} — a classic PAT needs the read:packages scope (granted: ${reading.scopes.join(", ") || "none"})`
      : `the token does not read the packages of ${org} — a fine-grained PAT needs the "Packages: Read" permission for this organisation`);
  }
  return record(deps, org, "packagesCredentialId", token, `packages reader (${org})`);
}

/** Records the organisation's repository PAT after measuring its scopes: a classic PAT carrying
 *  repo + workflow + admin:repo_hook. A fine-grained token reports no scopes and is refused. */
export async function recordRepositoryPat(deps: OrganisationDeps, org: string, token: string, signal?: AbortSignal): Promise<OrganisationCredentialView> {
  assertOrgLogin(org);
  const reading = await deps.github.readOrgToken({ org, token, ...(signal ? { signal } : {}) });
  if (reading.packages === "invalid") throw errValidation(`the token is invalid or expired — GitHub answered 401 for ${org}`);
  if (!reading.classic) throw errValidation(`the token is fine-grained, which reports no scopes — the repository PAT of an organisation is a CLASSIC PAT with ${REPOSITORY_PAT_SCOPES.join(" + ")}`);
  const missing = missingConsumerPatScopes(reading.scopes);
  if (missing.length > 0) throw errValidation(`the token lacks ${missing.join(", ")} (granted: ${reading.scopes.join(", ") || "none"}) — the repository PAT of an organisation carries ${REPOSITORY_PAT_SCOPES.join(" + ")}`);
  return record(deps, org, "repoCredentialId", token, `repository PAT (${org})`);
}

/** Forgets one credential of the organisation: the row is revoked, the column cleared, and the
 *  organisation's row removed when nothing is left in it. */
export async function forgetOrganisationCredential(deps: OrganisationDeps, org: string, which: "packages-reader" | "repository-pat"): Promise<void> {
  const column = which === "packages-reader" ? "packagesCredentialId" : "repoCredentialId";
  const standing = deps.db.select().from(organisationIdentities).where(eq(organisationIdentities.org, org)).get();
  if (!standing?.[column]) throw errNotFound(`organisation ${org} records no ${which}`);
  const other = column === "packagesCredentialId" ? standing.repoCredentialId : standing.packagesCredentialId;
  const cleared = column === "packagesCredentialId" ? { packagesCredentialId: null, updatedAt: new Date() } : { repoCredentialId: null, updatedAt: new Date() };
  if (other) deps.db.update(organisationIdentities).set(cleared).where(eq(organisationIdentities.org, org)).run();
  else deps.db.delete(organisationIdentities).where(eq(organisationIdentities.org, org)).run();
  await deps.store.revoke(standing[column], `forgotten: ${which} of ${org}`);
  writeAudit(deps.db, { actor: deps.actor(), action: "organisation.credential_forgotten", targetKind: "organisation", targetId: org, detail: { column, credentialId: standing[column] } });
}
