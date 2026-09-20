import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errNotFound } from "../../kernel/errors.ts";
import { APPS_MANIFEST_PATH, type TenantAppCatalogView } from "../../../shared/apps-manifest.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import type { AppCatalogProvider, TenantAppsManifestReader } from "./app-catalog.ts";
import { tenantAppsUnit } from "./tenant-apps-tree.ts";

// The catalog of ONE tenant, apart from api.ts the way api-tenant-apps-repo.ts is: the apps its
// own bundle carries (its repository's apps.yaml, read with the credential the bundle's build
// registration names — app-catalog.ts readTenantAppsManifest), each marked deployed where the
// registration's apps[] names it. The tenant page offers the undeployed ones to tenant-add-app, which judges the
// choice against the same apps.yaml (T4), so what the page offers and what the plan accepts are one
// thing. A READ: it degrades with `reason` where there is nothing to read by design and with
// `error` where the read failed (TenantAppCatalogView says why neither may render as "no apps").
export interface TenantAppCatalogApiDeps {
  db: Db;
  registrations?: TenantRegistrations;
  tenantAppsManifest?: TenantAppsManifestReader;
  /** The catalog's TEMPLATE, for a tenant that has no bundle yet: the apps its first "Add app" may
   *  choose from, which tenant-add-app then creates the bundle with (hostyour-manager#213). */
  appCatalog?: AppCatalogProvider;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function registerTenantAppCatalogRoute(app: Hono<AppEnv>, deps: TenantAppCatalogApiDeps): void {
  const { db, registrations, tenantAppsManifest, appCatalog } = deps;
  app.get("/api/tenants/:id/app-catalog", async (c) => {
    const id = c.req.param("id");
    const tenant = db.select({ guid: tenants.guid, stage: tenants.stage, subdomain: tenants.subdomain }).from(tenants).where(eq(tenants.id, id)).get();
    if (!tenant) throw errNotFound(`tenant ${id}`);
    const none = (reason: string): Response => c.json({ apps: [], reason } satisfies TenantAppCatalogView);
    if (!registrations) return none("tenant onboarding is not configured on this manager — the catalog write PAT must be wired first");
    if (!tenantAppsManifest) return none("this Manager holds no GitHub App identity, so a tenant's repository cannot be read — set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY");
    try {
      const current = await registrations.readTenant(tenant.stage, tenant.guid);
      if (!current) return none(`tenant ${tenant.guid} is not onboarded (no registration at ${tenant.stage})`);
      const { appsRepo } = current.entry;
      if (!appsRepo) {
        // No bundle yet: the template's catalog is what the first app is chosen from, and adding it
        // is what creates the bundle — nothing of it is deployed.
        if (!appCatalog) return none(`tenant ${tenant.guid} has no apps bundle yet, and this Manager reads no app catalog to choose its first app from`);
        const template = await appCatalog.list(c.req.raw.signal);
        return c.json({ apps: template.apps.map((a) => ({ ...a, deployed: false })) } satisfies TenantAppCatalogView);
      }
      const manifest = await tenantAppsManifest({ appsRepo, unit: tenantAppsUnit(tenant.subdomain) }, c.req.raw.signal);
      if (!manifest) return none(`${appsRepo} carries no ${APPS_MANIFEST_PATH} at its default branch — nothing says which apps tenant ${tenant.guid}'s bundle carries; tenant-apps-repo writes it`);
      const deployed = new Set(current.entry.apps.map((a) => a.name));
      return c.json({ apps: manifest.apps.map((a) => ({ ...a, deployed: deployed.has(a.name) })) } satisfies TenantAppCatalogView);
    } catch (e) {
      return c.json({ apps: [], error: errText(e) } satisfies TenantAppCatalogView);
    }
  });
}
