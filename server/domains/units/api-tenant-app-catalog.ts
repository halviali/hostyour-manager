import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { AppEnv } from "../../http/app-env.ts";
import { tenants } from "../../db/schema/inventory.ts";
import { errNotFound } from "../../kernel/errors.ts";
import type { TenantAppCatalogView } from "../../../shared/apps-manifest.ts";
import type { TenantRegistrations } from "./tenant-registrations.ts";
import type { AppCatalogProvider } from "./app-catalog.ts";

// The catalog of ONE tenant, apart from api.ts the way api-tenant-apps-repo.ts is: the apps the
// catalog's TEMPLATE names (app-catalog.ts — what can be added to any tenant), each marked deployed
// where the tenant's registration names it in apps[]. The tenant page offers the undeployed ones to
// tenant-add-app, which judges the choice against the same template catalog (T4) and carries the
// app's folder into the tenant's own repository (tenant-apps-repo), so what the page offers and
// what the plan accepts are one thing (hostyour-manager#213, #215). A READ: it degrades with
// `reason` where there is nothing to read by design and with `error` where the read failed
// (TenantAppCatalogView says why neither may render as "no apps").
export interface TenantAppCatalogApiDeps {
  db: Db;
  registrations?: TenantRegistrations;
  appCatalog?: AppCatalogProvider;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function registerTenantAppCatalogRoute(app: Hono<AppEnv>, deps: TenantAppCatalogApiDeps): void {
  const { db, registrations, appCatalog } = deps;
  app.get("/api/tenants/:id/app-catalog", async (c) => {
    const id = c.req.param("id");
    const tenant = db.select({ guid: tenants.guid, stage: tenants.stage }).from(tenants).where(eq(tenants.id, id)).get();
    if (!tenant) throw errNotFound(`tenant ${id}`);
    const none = (reason: string): Response => c.json({ apps: [], reason } satisfies TenantAppCatalogView);
    if (!registrations) return none("tenant onboarding is not configured on this manager — the catalog write PAT must be wired first");
    if (!appCatalog) return none("this Manager reads no app catalog — the catalog's template is what an app is chosen from");
    try {
      const current = await registrations.readTenant(tenant.stage, tenant.guid);
      if (!current) return none(`tenant ${tenant.guid} is not onboarded (no registration at ${tenant.stage})`);
      const template = await appCatalog.list(c.req.raw.signal);
      const deployed = new Set(current.entry.apps.map((a) => a.name));
      return c.json({ apps: template.apps.map((a) => ({ ...a, deployed: deployed.has(a.name) })) } satisfies TenantAppCatalogView);
    } catch (e) {
      return c.json({ apps: [], error: errText(e) } satisfies TenantAppCatalogView);
    }
  });
}
