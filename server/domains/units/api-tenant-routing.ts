// The routing move's route, apart from api.ts the way api-unit-sizes.ts is: POST
// /api/tenants/:id/routing plans tenant-set-routing (tenant-routing.run.ts) with the routing the body
// names, validated through the run's OWN params schema. Approve via the Runs API.
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { Db } from "../../db/client.ts";
import { errValidation, errNotConfigured } from "../../kernel/errors.ts";
import { assertTenantProvisioned, loadTenantStatus } from "./tenant-provisioned.ts";
import { TenantSetRoutingParams } from "./tenant-routing.run.ts";
import type { Executor } from "../../executor/executor.ts";

export interface TenantRoutingApiDeps {
  db: Db;
  executor?: Executor;
  tenantEnabled: boolean;
}

export function registerTenantRoutingRoutes(app: Hono<AppEnv>, deps: TenantRoutingApiDeps): void {
  const { db, executor, tenantEnabled } = deps;
  // A provisioning tenant is refused like a resize: its registration may never have been written, and
  // a field write into a file that is not there moves nothing.
  app.post("/api/tenants/:id/routing", async (c) => {
    if (!tenantEnabled || !executor) throw errNotConfigured("tenant onboarding is not configured on this manager");
    const id = c.req.param("id");
    assertTenantProvisioned(loadTenantStatus(db, id), "moving its routing");
    const body = (await c.req.json().catch(() => ({}))) as { routing?: unknown };
    const parsed = TenantSetRoutingParams.safeParse({ tenantId: id, routing: body.routing });
    if (!parsed.success) throw errValidation(`invalid tenant routing request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return c.json(await executor.plan("tenant-set-routing", parsed.data), 201);
  });
}
