// WHICH IDENTITY READS AND WRITES A CONSUMER REPOSITORY — the one rule, measured (#194, #201).
//
// A PAT handed in is the repository's identity: the operator chose it, it carries the scopes the
// preflight measures (pat-scopes.ts), among them read:packages, which the build's npm install needs
// and which the platform's GitHub App does not hold. Where NO PAT is handed in, the App
// (adapters/github-app) is the identity of every repository its installation reaches — installed
// in ONE organisation on every repository of it: the credential row stores no token, and the store
// mints an installation token at every open (security/store.ts). Where neither holds — no PAT, and
// a repository in another organisation — the onboarding is refused naming both halves. Whether the
// App reaches a repository is NOT decided off an owner string: an installation is a fact GitHub
// holds (GET /repos/{owner}/{repo}/installation), so it is asked, per repository, at the moment
// the identity is chosen. Two callers choose one: the onboard POST and its prefill (api.ts,
// api-onboard-prefill.ts) for a consumer, and the tenant plan for every build unit a tenant lacks
// (tenant-builds.ts), which hands no PAT and so takes the App wherever it reaches.
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { CredentialStore } from "../../security/store.ts";
import { fingerprintSecret } from "../../security/fingerprint.ts";
import { errValidation } from "../../kernel/errors.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";

export type RepoIdentityApp = Pick<GitHubApp, "reachesRepository" | "installationToken" | "identityFingerprint" | "installationOrg">;

/** The identity chosen for one repository: the App's installation token (minted now, for the reads
 *  the caller makes before any run exists) or the PAT the operator handed in. */
export type RepoIdentity = { kind: "github-app"; token: string } | { kind: "pat"; token: string };

/** Whether the App reaches a repository named by its URL — the measurement behind the rule. */
export async function appReachesRepoURL(app: Pick<GitHubApp, "reachesRepository">, repoURL: string, signal?: AbortSignal): Promise<boolean> {
  const { owner, repo } = parseGitHubOwnerRepo(repoURL);
  return app.reachesRepository({ owner, repo, ...(signal ? { signal } : {}) });
}

/** The rule: the PAT where one is handed in, else the App where it reaches the repository, else a
 *  refusal that names both halves — which organisation the App is installed in, and that this
 *  repository needs its own PAT. A handed-in PAT is never dropped: #194 chose the App over it, and
 *  the App's token, lacking read:packages, failed a unit's npm install that the PAT had passed. */
export async function resolveRepoIdentity(input: { repoURL: string; repoPat?: string | undefined; githubApp?: RepoIdentityApp | undefined; signal?: AbortSignal }): Promise<RepoIdentity> {
  if (input.repoPat) return { kind: "pat", token: input.repoPat };
  if (input.githubApp && (await appReachesRepoURL(input.githubApp, input.repoURL, input.signal))) {
    return { kind: "github-app", token: await input.githubApp.installationToken(input.signal) };
  }
  const { owner, repo } = parseGitHubOwnerRepo(input.repoURL);
  const where = input.githubApp ? `is installed in the organisation ${await input.githubApp.installationOrg(input.signal)} and does not reach ${owner}/${repo}` : "is not configured on this manager";
  throw errValidation(`the platform's GitHub App ${where} — hand in the repository's own PAT (repo + workflow + admin:repo_hook + read:packages) to onboard ${owner}/${repo}`);
}

/** The credential row the run opens from then on: a `github-app` row storing nothing (the App's
 *  fingerprint, so an audit names which App acted), or the PAT sealed with its own fingerprint. The
 *  PAT's buffer is zeroed by seal(). */
export async function sealRepoIdentity(store: Pick<CredentialStore, "seal">, identity: RepoIdentity, label: string, githubApp?: Pick<GitHubApp, "identityFingerprint">): Promise<string> {
  if (identity.kind === "github-app") {
    if (!githubApp) throw errValidation("a github-app identity was chosen with no GitHub App to seal it under");
    return (await store.seal({ kind: "github-app", label: `GitHub App (${label})`, plaintext: Buffer.alloc(0), fingerprint: githubApp.identityFingerprint() })).id;
  }
  const plaintext = Buffer.from(identity.token, "utf8");
  const fingerprint = fingerprintSecret(plaintext); // before seal() zeroes the buffer
  return (await store.seal({ kind: "pat", label: `consumer repo PAT (${label})`, plaintext, fingerprint })).id;
}
