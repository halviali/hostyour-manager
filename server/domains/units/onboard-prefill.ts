// The onboard wizard's PREFILL: the version the onboarding will release, read off the repository's
// release tags before any run exists (release-version.ts), so the operator sees the number and
// types none. The channel is `stable` for every prefill: the ceiling is the operator's call and the
// table is on the wizard.
//
// THE TOKEN DOES NOT OUTLIVE THE READ: it rides the tag listing as the Bearer header and nothing
// else — no clone, no credential row, nothing an abandoned wizard leaves behind. Which token: the
// organisation's identity for this repository (repo-identity.ts, #220) — the App's where its
// installation reaches the repository, the organisation's repository PAT else — the same choice
// the onboard POST makes, so the check answers for the identity the onboarding will run with, and
// refuses by name where the organisation records no packages reader.
import { z } from "zod";
import type { OnboardPrefillView } from "../../../shared/api-types-onboard.ts";
import type { CredentialStore } from "../../security/store.ts";
import { resolveNextVersion, type ReleaseVersionDeps } from "./release-version.ts";
import { npmrcPackageScopes, resolveRepoIdentity, type OrganisationIdentityReader, type RepoIdentityApp } from "./repo-identity.ts";
import { parseGitHubOwnerRepo } from "./onboard-webhook.ts";

/** What the prefill is asked: the repository. */
export const OnboardPrefillRequest = z.object({
  repoURL: z.string().regex(/^https:\/\/[^ ]+\.git$/),
});
export type OnboardPrefillRequest = z.infer<typeof OnboardPrefillRequest>;

export async function readOnboardPrefill(deps: ReleaseVersionDeps & { githubApp?: RepoIdentityApp; organisations: OrganisationIdentityReader; store: Pick<CredentialStore, "open" | "list"> }, input: OnboardPrefillRequest, signal: AbortSignal): Promise<OnboardPrefillView> {
  const identity = await resolveRepoIdentity({ repoURL: input.repoURL, githubApp: deps.githubApp, organisations: deps.organisations, store: deps.store, signal });
  const { version, readFrom } = await resolveNextVersion(deps, { repoURL: input.repoURL, token: identity.token, signal });
  // THE PACKAGES READER IS ASKED FOR WHERE IT IS NEEDED (#237): the repository's `.npmrc`, read
  // through the API with the same identity, says which scopes its build installs from GitHub
  // Packages; the owner's recorded reader says whether the wizard has to ask.
  const { owner, repo } = parseGitHubOwnerRepo(input.repoURL);
  const scopes = npmrcPackageScopes(await deps.github.readFile({ owner, repo, path: ".npmrc", token: identity.token, signal }));
  const readerId = deps.organisations(owner)?.packagesCredentialId ?? null;
  const row = readerId ? (await deps.store.list({ subject: { kind: "organisation", id: owner }, purpose: "packages-reader" })).find((r) => r.id === readerId) : undefined;
  return {
    version,
    versionSource: `the next number after the release tags of ${readFrom.join(", ")}`,
    channel: "stable",
    channelSource: "default",
    identity: identity.kind,
    ...(scopes.length > 0 ? { packagesReader: { owner, scopes, recorded: row ? { fingerprint: row.fingerprint, recordedAt: row.recordedAt } : null } } : {}),
  };
}
