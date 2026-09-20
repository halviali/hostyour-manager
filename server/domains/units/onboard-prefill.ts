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
import { resolveRepoIdentity, type OrganisationIdentityReader, type RepoIdentityApp } from "./repo-identity.ts";

/** What the prefill is asked: the repository. */
export const OnboardPrefillRequest = z.object({
  repoURL: z.string().regex(/^https:\/\/[^ ]+\.git$/),
});
export type OnboardPrefillRequest = z.infer<typeof OnboardPrefillRequest>;

export async function readOnboardPrefill(deps: ReleaseVersionDeps & { githubApp?: RepoIdentityApp; organisations: OrganisationIdentityReader; store: Pick<CredentialStore, "open"> }, input: OnboardPrefillRequest, signal: AbortSignal): Promise<OnboardPrefillView> {
  const identity = await resolveRepoIdentity({ repoURL: input.repoURL, githubApp: deps.githubApp, organisations: deps.organisations, store: deps.store, signal });
  const { version, readFrom } = await resolveNextVersion(deps, { repoURL: input.repoURL, token: identity.token, signal });
  return {
    version,
    versionSource: `the next number after the release tags of ${readFrom.join(", ")}`,
    channel: "stable",
    channelSource: "default",
    identity: identity.kind,
  };
}
