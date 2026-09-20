import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const now = sql`(unixepoch('subsec') * 1000)`;

/** THE IDENTITY OF AN ORGANISATION (hostyour-manager#218, #219) — what every unit of that
 *  organisation is onboarded with, derived from the owner of its repository URL, never asked per
 *  unit. Two sealed credentials, each a row of `credentials` (kind `pat`):
 *  - packagesCredentialId: the organisation's PACKAGES READER — a token holding read:packages
 *    (classic) or Packages: Read (fine-grained). GitHub grants an App installation token no access
 *    to a private npm package whatever the App's permissions say, so a build's `.npmrc` carries this.
 *    Required for every onboarding of a unit of the organisation.
 *  - repoCredentialId: the organisation's REPOSITORY PAT (repo + workflow + admin:repo_hook), the
 *    repository identity where the platform's GitHub App is not installed in the organisation.
 *    Absent where the App reaches the organisation, which is the ordinary case.
 *  One row per organisation, keyed by its login as GitHub spells it. The two ids name rows of
 *  `credentials` by convention, not by foreign key: only the store touches that table (the boundary
 *  law), and it is the store that revokes a row this table stops naming. */
export const organisationIdentities = sqliteTable("organisation_identities", {
  org: text("org").primaryKey(),
  packagesCredentialId: text("packages_credential_id"),
  repoCredentialId: text("repo_credential_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
});
