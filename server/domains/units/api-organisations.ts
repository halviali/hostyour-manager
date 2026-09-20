import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../http/app-env.ts";
import { errValidation } from "../../kernel/errors.ts";
import type { OrganisationsListView } from "../../../shared/api-types-organisations.ts";
import { assertOrgLogin, forgetOrganisationCredential, listOrganisationIdentities, recordPackagesReader, recordRepositoryPat, type OrganisationDeps } from "./organisations.ts";

// The organisation identities over HTTP (hostyour-manager#219): the list, and one PUT per
// credential — the token rides the body once over TLS, is measured and sealed by the domain, and
// the answer carries its fingerprint only. A zod refusal names the field, never the value.
const CredentialBody = z.object({ token: z.string().min(1) });

export function registerOrganisationRoutes(app: Hono<AppEnv>, deps: OrganisationDeps): void {
  app.get("/api/organisations", async (c) => c.json({ organisations: await listOrganisationIdentities(deps, c.req.raw.signal) } satisfies OrganisationsListView));

  app.put("/api/organisations/:org/packages-reader", async (c) => {
    const org = assertOrgLogin(c.req.param("org"));
    const parsed = CredentialBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation("the packages reader is one field, token, and it was not given");
    return c.json({ packagesReader: await recordPackagesReader(deps, org, parsed.data.token, c.req.raw.signal) });
  });

  app.put("/api/organisations/:org/repository-pat", async (c) => {
    const org = assertOrgLogin(c.req.param("org"));
    const parsed = CredentialBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw errValidation("the repository PAT is one field, token, and it was not given");
    return c.json({ repositoryPat: await recordRepositoryPat(deps, org, parsed.data.token, c.req.raw.signal) });
  });

  app.delete("/api/organisations/:org/packages-reader", async (c) => {
    await forgetOrganisationCredential(deps, assertOrgLogin(c.req.param("org")), "packages-reader");
    return c.json({ ok: true });
  });

  app.delete("/api/organisations/:org/repository-pat", async (c) => {
    await forgetOrganisationCredential(deps, assertOrgLogin(c.req.param("org")), "repository-pat");
    return c.json({ ok: true });
  });
}
