// The onboard wizard's PREFILL: the version the onboarding will release, read off the repository's
// release tags before any run exists (release-version.ts), so the operator sees the number and
// types none. The channel is `stable` for every prefill: the ceiling is the operator's call and the
// table is on the wizard.
//
// THE PAT DOES NOT OUTLIVE THE READ: it rides the tag listing as the Bearer header and nothing else —
// no clone, no credential row, nothing an abandoned wizard leaves behind.
import { z } from "zod";
import type { OnboardPrefillView } from "../../../shared/api-types.ts";
import { resolveNextVersion, type ReleaseVersionDeps } from "./release-version.ts";

/** What the prefill is asked: the repository and the ONE PAT that reads it. */
export const OnboardPrefillRequest = z.object({
  repoURL: z.string().regex(/^https:\/\/[^ ]+\.git$/),
  repoPat: z.string().min(1),
});
export type OnboardPrefillRequest = z.infer<typeof OnboardPrefillRequest>;

export async function readOnboardPrefill(deps: ReleaseVersionDeps, input: OnboardPrefillRequest, signal: AbortSignal): Promise<OnboardPrefillView> {
  const { version, readFrom } = await resolveNextVersion(deps, { repoURL: input.repoURL, token: input.repoPat, signal });
  return {
    version,
    versionSource: `the next number after the release tags of ${readFrom.join(", ")}`,
    channel: "stable",
    channelSource: "default",
  };
}
