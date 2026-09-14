import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import { errNotConfigured, errValidation } from "../../kernel/errors.ts";
import type { OnboardPrefillView } from "../../../shared/api-types.ts";
import { OnboardPrefillRequest, readOnboardPrefill } from "./onboard-prefill.ts";
import type { ReleaseVersionDeps } from "./release-version.ts";

// The wizard's PREFILL route, apart from api.ts the way api-unit-sizes.ts is: the version the
// onboarding will release, read off the repository's release tags before any run exists
// (onboard-prefill.ts). The PAT rides the one tag listing and is not kept.
export interface OnboardPrefillApiDeps extends Partial<ReleaseVersionDeps> {
  onboardingEnabled: boolean;
}

export function registerOnboardPrefillRoute(app: Hono<AppEnv>, deps: OnboardPrefillApiDeps): void {
  const { onboardingEnabled, github, platformGitHub, platformRepo } = deps;
  app.post("/api/consumers/prefill", async (c) => {
    if (!onboardingEnabled || !github) throw errNotConfigured("onboarding is not configured on this manager — the gate-runner and git/kube/vault adapters must be wired first");
    const parsed = OnboardPrefillRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation(`invalid onboard prefill request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const view = await readOnboardPrefill({ github, ...(platformGitHub ? { platformGitHub } : {}), ...(platformRepo ? { platformRepo } : {}) }, parsed.data, c.req.raw.signal);
    return c.json(view satisfies OnboardPrefillView);
  });
}
