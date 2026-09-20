// The onboard wizard's two read views, apart from api-types.ts the way the wizard's routes stand
// apart from api.ts (api-onboard-prefill.ts): what it fills its fields with before any run exists.
import type { Stage } from "./enums.ts";
import type { ReleaseChannel } from "./release.ts";

/** GET /api/consumers/channels — the channel table the onboard wizard reads: WHICH stages a release
 *  channel may reach. Served LITERALLY from the platform repo's clusters/platform/values-common.yaml
 *  (global.channelStages) — the ONE table, enforced in the release pipeline at the point that
 *  writes; the manager keeps no copy. Keys are the channels the file states (normally all
 *  three), each value the stages that channel admits, in the file's own order. */
export interface ChannelStagesView {
  channelStages: Partial<Record<ReleaseChannel, Stage[]>>;
}

/** POST /api/consumers/prefill — what the onboard wizard fills its Version and Channel fields with
 *  before the operator confirms them, read off the consumer's repository: `package.json` `version`
 *  when it is in the release grammar, else the chart's `Chart.yaml` `appVersion`, else `0.1.0`;
 *  the channel is `stable`. Each value names its SOURCE in a sentence the wizard prints as the
 *  field's hint, so the operator sees whether the number was read or defaulted. Both stay editable. */
export interface OnboardPrefillView {
  version: string;
  versionSource: string;
  channel: ReleaseChannel;
  channelSource: string;
  /** The identity the onboarding will run with: the PAT the wizard was given, else the platform's
   *  GitHub App where its installation reaches the repository (measured, no PAT asked). */
  identity: "github-app" | "pat"; // the App, or the organisation's repository PAT (#220)
}
