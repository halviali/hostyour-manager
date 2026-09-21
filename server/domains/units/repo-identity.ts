// WHICH IDENTITY READS AND WRITES A UNIT'S REPOSITORY, AND WHICH READS ITS PACKAGES — the one rule,
// derived from the OWNER of the repository URL and measured (hostyour-manager#218, #220).
//
// The owner names the owner, and the owner's record (owners.ts, #219) is what
// every unit of it is onboarded with; nothing is asked per unit. Two identities, because GitHub
// keeps them apart:
//  - the REPOSITORY identity: the platform's GitHub App where its installation reaches the
//    repository (measured: GET /repos/{owner}/{repo}/installation, never inferred from the owner
//    string) — the credential row stores no token and the store mints an installation token at
//    every open; else the owner's REPOSITORY PAT where one is recorded, sealed again under
//    the unit's own name so the unit's offboard takes its row and never the owner's; else a
//    refusal naming both halves;
//  - the PACKAGES identity: the owner's PACKAGES READER, required for a unit whose
//    repository routes a scope to GitHub Packages (its `.npmrc`, npmrcPackageScopes) and for no
//    other (#221). An App installation token reads no private npm package whatever the App's
//    permissions say, so a build's `.npmrc` carries this token (onboard-seed-repo-pat.ts), never
//    the repository's.
// Callers: the onboard POST and its prefill (api.ts, api-onboard-prefill.ts), the tenant build
// units (tenant-builds.ts) and the tenant's own apps repository (tenant-apps-steps.ts).
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { CredentialStore } from "../../security/store.ts";
import { fingerprintSecret } from "../../security/fingerprint.ts";
import { errValidation } from "../../kernel/errors.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";

export type RepoIdentityApp = Pick<GitHubApp, "reachesRepository" | "installationToken" | "identityFingerprint" | "installationOrg">;

/** What the owner record answers for an owner (owners.ts readOwnerIdentity). */
export type OwnerIdentityReader = (org: string) => { packagesCredentialId: string | null; repoCredentialId: string | null } | null;

/** The identity chosen for one repository: the App's installation token (minted now, for the reads
 *  the caller makes before any run exists) or the owner's repository PAT, opened now. */
export type RepoIdentity = { kind: "github-app"; token: string } | { kind: "pat"; token: string };

/** Whether the App reaches a repository named by its URL — the measurement behind the rule. */
export async function appReachesRepoURL(app: Pick<GitHubApp, "reachesRepository">, repoURL: string, signal?: AbortSignal): Promise<boolean> {
  const { owner, repo } = parseGitHubOwnerRepo(repoURL);
  return app.reachesRepository({ owner, repo, ...(signal ? { signal } : {}) });
}

export const ADD_APP_FORM = "the tenant's Add app form";
export const CONSUMER_WIZARD = "the consumer wizard";

/** The refusal a repository routing a scope to GitHub Packages gets where its owner records no
 *  packages reader — one sentence every caller uses; `where` names the place the token is given
 *  (a tenant's bundle: the Add app form, #233). */
export function packagesReaderMissing(owner: string, repo: string, scopes: readonly string[], where: string = CONSUMER_WIZARD): string {
  return `owner ${owner} records no packages reader, and ${owner}/${repo} installs private npm packages of ${scopes.map((s) => `@${s}`).join(", ")} from GitHub Packages (its .npmrc) — record a token that reads them in ${where} first`;
}

/** The scopes a repository's `.npmrc` routes to GitHub Packages — the one measurement that says
 *  whether its build needs the owner's packages reader. Empty for no `.npmrc`. */
export function npmrcPackageScopes(npmrc: string | null): string[] {
  return [...(npmrc ?? "").matchAll(/^@([^:\s]+):registry=https:\/\/npm\.pkg\.github\.com\/?\s*$/gm)].map((m) => m[1]!);
}

/** The rule, judged without minting or opening anything: what identity ${owner}/${repo} gets, or
 *  why it gets none. The plan-time half — the run's step resolves the same way and seals. */
export async function judgeRepoIdentity(input: { repoURL: string; githubApp?: Pick<GitHubApp, "reachesRepository" | "installationOrg"> | undefined; owners: OwnerIdentityReader; signal?: AbortSignal }): Promise<{ kind: "github-app" | "pat"; repoCredentialId?: string } | { refused: string; missing: "repository-pat"; owner: string }> {
  const { owner, repo } = parseGitHubOwnerRepo(input.repoURL);
  const org = input.owners(owner);
  if (input.githubApp && (await appReachesRepoURL(input.githubApp, input.repoURL, input.signal))) return { kind: "github-app" };
  if (org?.repoCredentialId) return { kind: "pat", repoCredentialId: org.repoCredentialId };
  const where = input.githubApp ? `is installed in the owner ${await input.githubApp.installationOrg(input.signal)} and does not reach ${owner}/${repo}` : "is not configured on this manager";
  return { refused: `the platform's GitHub App ${where}, and owner ${owner} records no repository PAT — install the App on the repository, or record the owner's repository PAT (repo + workflow + admin:repo_hook) in ${CONSUMER_WIZARD}`, missing: "repository-pat", owner };
}

/** The rule with the token in hand: the App's installation token minted now, or the owner's
 *  repository PAT opened from the store now. Throws the refusal. */
export async function resolveRepoIdentity(input: { repoURL: string; githubApp?: RepoIdentityApp | undefined; owners: OwnerIdentityReader; store: Pick<CredentialStore, "open">; signal?: AbortSignal }): Promise<RepoIdentity> {
  const judged = await judgeRepoIdentity(input);
  if ("refused" in judged) throw errValidation(judged.refused);
  if (judged.kind === "github-app") return { kind: "github-app", token: await input.githubApp!.installationToken(input.signal) };
  const pat = await input.store.open(judged.repoCredentialId!, { purpose: "repo-identity:owner-pat" });
  try {
    return { kind: "pat", token: pat.toString("utf8") };
  } finally {
    pat.fill(0);
  }
}

/** The credential row the run opens from then on: a `github-app` row storing nothing (the App's
 *  fingerprint, so an audit names which App acted), or the owner's PAT sealed again under
 *  the unit's name. The PAT's buffer is zeroed by seal(). */
export async function sealRepoIdentity(store: Pick<CredentialStore, "seal">, identity: RepoIdentity, label: string, githubApp?: Pick<GitHubApp, "identityFingerprint">): Promise<string> {
  if (identity.kind === "github-app") {
    if (!githubApp) throw errValidation("a github-app identity was chosen with no GitHub App to seal it under");
    return (await store.seal({ kind: "github-app", label: `GitHub App (${label})`, plaintext: Buffer.alloc(0), fingerprint: githubApp.identityFingerprint(), subject: { kind: "unit", id: label }, purpose: "repository-identity" })).id;
  }
  const plaintext = Buffer.from(identity.token, "utf8");
  const fingerprint = fingerprintSecret(plaintext); // before seal() zeroes the buffer
  return (await store.seal({ kind: "pat", label: `repository PAT (${label})`, plaintext, fingerprint, subject: { kind: "unit", id: label }, purpose: "repository-identity" })).id;
}

/** The packages reader of a unit's owner, by the owner of its repository URL — what the
 *  build seed and the App-token refresh write beside the repository token; null where the
 *  owner records none. Whether that is a refusal depends on the repository's `.npmrc`:
 *  the seed step and the packages probe decide (npmrcPackageScopes). */
export function packagesReaderFor(owners: OwnerIdentityReader, repoURL: string): string | null {
  return owners(parseGitHubOwnerRepo(repoURL).owner)?.packagesCredentialId ?? null;
}
