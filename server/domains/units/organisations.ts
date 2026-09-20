import type { Db } from "../../db/client.ts";
import { writeAudit } from "../../db/audit-writer.ts";
import { organisationIdentity, organisationsWithIdentity } from "../../security/store.ts";
import { errNotFound, errValidation } from "../../kernel/errors.ts";
import { fingerprintSecret } from "../../security/fingerprint.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { GitHubConsumer } from "../../adapters/github-consumer/port.ts";
import type { OrganisationIdentityView, OrganisationCredentialView } from "../../../shared/api-types-organisations.ts";
import { missingConsumerPatScopes } from "./pat-scopes.ts";

// THE IDENTITY OF AN ORGANISATION (hostyour-manager#218, #219, #225): recorded once, measured
// before it is sealed, derived per unit from the owner of its repository URL by the identity rule
// (repo-identity.ts). Two credentials per organisation, each a row of the store whose subject is
// the organisation and whose purpose says which (there is no table of ids beside the store):
//  - the PACKAGES READER: what a build's `.npmrc` carries. GitHub grants an App installation token
//    no access to a private npm package whatever the App's permissions say, so this is a PAT —
//    classic with read:packages or fine-grained with Packages: Read — and the measurement is the
//    one thing that proves it: the token reads the organisation's packages, or it is refused;
//  - the REPOSITORY PAT: the repository identity where the platform's App is not installed in the
//    organisation (repo + workflow + admin:repo_hook). Absent where the App reaches, the ordinary case.
// A token is measured, sealed with its fingerprint, and zeroed; it is never logged and never
// persisted raw. Replacing a credential revokes the row it replaces; the newest unrevoked row of a
// purpose is the organisation's (store.ts organisationIdentity).

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

/** Every organisation with an identity recorded, and which of them the App is installed in. */
export async function listOrganisationIdentities(deps: Pick<OrganisationDeps, "db" | "store" | "githubApp">, signal?: AbortSignal): Promise<OrganisationIdentityView[]> {
  const appOrg = deps.githubApp ? await deps.githubApp.installationOrg(signal) : null;
  const orgs = organisationsWithIdentity(deps.db);
  // The App's own organisation is listed even before anything is recorded for it: it is the one
  // the operator most likely needs to complete.
  if (appOrg && !orgs.includes(appOrg)) orgs.push(appOrg);
  const rows = await deps.store.list({ kind: "pat" });
  const view = (id: string | null): OrganisationCredentialView | null => {
    const row = id ? rows.find((r) => r.id === id) : undefined;
    return row ? { fingerprint: row.fingerprint, recordedAt: row.recordedAt } : null;
  };
  return orgs.sort().map((org) => {
    const ids = organisationIdentity(deps.db, org);
    return { org, appInstalled: org === appOrg, packagesReader: view(ids?.packagesCredentialId ?? null), repositoryPat: view(ids?.repoCredentialId ?? null) };
  });
}

/** The credential ids an onboarding derives a unit's identity from — the identity rule's read. */
export function readOrganisationIdentity(db: Db, org: string): { packagesCredentialId: string | null; repoCredentialId: string | null } | null {
  return organisationIdentity(db, org);
}

async function record(deps: OrganisationDeps, org: string, purpose: "packages-reader" | "repository-pat", token: string, label: string): Promise<OrganisationCredentialView> {
  const plaintext = Buffer.from(token, "utf8");
  const fingerprint = fingerprintSecret(plaintext); // before seal() zeroes the buffer
  const standing = organisationIdentity(deps.db, org);
  const replaced = purpose === "packages-reader" ? standing?.packagesCredentialId ?? null : standing?.repoCredentialId ?? null;
  const ref = await deps.store.seal({ kind: "pat", label, plaintext, fingerprint, subject: { kind: "organisation", id: org }, purpose });
  if (replaced) await deps.store.revoke(replaced, `replaced by ${ref.id} (${label})`);
  writeAudit(deps.db, { actor: deps.actor(), action: "organisation.credential_recorded", targetKind: "organisation", targetId: org, detail: { purpose, credentialId: ref.id, fingerprint, replaced } });
  return { fingerprint, recordedAt: ref.recordedAt };
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
  return record(deps, org, "packages-reader", token, `packages reader (${org})`);
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
  return record(deps, org, "repository-pat", token, `repository PAT (${org})`);
}

/** Forgets one credential of the organisation: its newest row of that purpose is revoked. */
export async function forgetOrganisationCredential(deps: OrganisationDeps, org: string, which: "packages-reader" | "repository-pat"): Promise<void> {
  const standing = organisationIdentity(deps.db, org);
  const id = which === "packages-reader" ? standing?.packagesCredentialId : standing?.repoCredentialId;
  if (!id) throw errNotFound(`organisation ${org} records no ${which}`);
  await deps.store.revoke(id, `forgotten: ${which} of ${org}`);
  writeAudit(deps.db, { actor: deps.actor(), action: "organisation.credential_forgotten", targetKind: "organisation", targetId: org, detail: { purpose: which, credentialId: id } });
}
