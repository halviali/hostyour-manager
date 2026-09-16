import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters, tenants } from "../../db/schema/inventory.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { seedQuota } from "../../../shared/unit-size.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import type { AppsManifest, TenantAppCatalogView } from "../../../shared/apps-manifest.ts";
import { registerTenantAppCatalogRoute, type TenantAppCatalogApiDeps } from "./api-tenant-app-catalog.ts";
import { TenantRegistrations, tenantRegistrationWrite } from "./tenant-registrations.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { testMembers, TEST_BUNDLE } from "./tenant-members.fixture.ts";
import type { AppEnv } from "../../http/app-env.ts";

// GET /api/tenants/:id/app-catalog — one tenant's own catalog over HTTP: the apps its bundle's
// apps.yaml names, each marked deployed where the registration's apps[] carries it, and the
// read's three degradations, each a sentence and never a bare empty list.

const config = parseConfig({ PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s", MANAGER_VERSION: "test", DATA_DIR: "/d", ADMIN_SOCKET_PATH: "/run/manager/admin.sock", LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const logger = pino({ level: "silent" });
const GUID = "zsjs023ctne0";

const CATALOG: AppsManifest = {
  apps: [
    { name: "erp", title: "ERP", description: "Orders and stock.", selections: { seedDemo: { title: "Demo data", default: true } } },
    { name: "crm", title: "CRM", description: "", selections: {} },
  ],
};

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(tenants).values({ id: "tnt_1", clusterId: "cls_1", guid: GUID, subdomain: "acme", stage: "prod", members: ["auth", "jobs", "report"], identityProvider: "auth" }).run();
});
afterEach(() => { db.sqlite.close(); });

/** The registrations of a tenant deploying "erp", with the bundle given (the empty pair for none). */
function registrationsWith(bundle: { appsRepo?: string; appsImage?: string; appsImageTag?: string } = TEST_BUNDLE): TenantRegistrations {
  const repo = new FakePlatformRepo();
  const registration = TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: "acme", members: testMembers([{ name: "erp" }]), identityProvider: "auth", apps: [{ name: "erp" }], quota: seedQuota("small"), ...bundle,
  });
  const w = tenantRegistrationWrite("prod", GUID, registration);
  repo.seed(repo.booksBranch, w.path, w.content);
  return new TenantRegistrations(repo);
}

const authed = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "sec-fetch-site": "same-origin" } });

async function serve(deps: Omit<TenantAppCatalogApiDeps, "db">): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const session = new SessionCodec(db.db, config);
  const app = createApp({
    config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
    registerAuth: () => undefined,
    registerProtected: (a) => registerTenantAppCatalogRoute(a, { db: db.db, ...deps }),
  });
  const cookie = await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" });
  return { app, cookie };
}

const read = async (app: Hono<AppEnv>, cookie: string, id = "tnt_1"): Promise<{ status: number; body: TenantAppCatalogView }> => {
  const res = await app.request(`/api/tenants/${id}/app-catalog`, authed(cookie));
  return { status: res.status, body: (await res.json()) as TenantAppCatalogView };
};

describe("GET /api/tenants/:id/app-catalog", () => {
  it("answers the bundle's apps off the registration's appsRepo, each marked deployed where the registration's apps[] names it", async () => {
    const asked: string[] = [];
    const { app, cookie } = await serve({ registrations: registrationsWith(), tenantAppsManifest: async (appsRepo) => { asked.push(appsRepo); return CATALOG; } });
    const { status, body } = await read(app, cookie);
    expect(status).toBe(200);
    expect(body).toEqual({ apps: [{ ...CATALOG.apps[0], deployed: true }, { ...CATALOG.apps[1], deployed: false }] });
    expect(asked).toEqual([TEST_BUNDLE.appsRepo]);
  });

  it("says why there is no catalog: not wired, no App, no bundle, no apps.yaml — each a reason, never a bare empty list", async () => {
    const manifest = async (): Promise<AppsManifest | null> => CATALOG;
    const unwired = await serve({ tenantAppsManifest: manifest });
    expect((await read(unwired.app, unwired.cookie)).body).toEqual({ apps: [], reason: expect.stringContaining("tenant onboarding is not configured") });
    const noApp = await serve({ registrations: registrationsWith() });
    expect((await read(noApp.app, noApp.cookie)).body).toEqual({ apps: [], reason: expect.stringContaining("no GitHub App identity") });
    const noBundle = await serve({ registrations: registrationsWith({ appsImage: "", appsImageTag: "" }), tenantAppsManifest: manifest });
    expect((await read(noBundle.app, noBundle.cookie)).body).toEqual({ apps: [], reason: expect.stringContaining("has no apps bundle (appsRepo)") });
    const noManifest = await serve({ registrations: registrationsWith(), tenantAppsManifest: async () => null });
    expect((await read(noManifest.app, noManifest.cookie)).body).toEqual({ apps: [], reason: expect.stringContaining(`${TEST_BUNDLE.appsRepo} carries no apps.yaml`) });
  });

  it("answers { apps: [], error } when the read fails, and 404 for a tenant the inventory does not know", async () => {
    const { app, cookie } = await serve({ registrations: registrationsWith(), tenantAppsManifest: async () => { throw new Error("clone failed: authentication required"); } });
    expect((await read(app, cookie)).body).toEqual({ apps: [], error: "clone failed: authentication required" });
    expect((await read(app, cookie, "tnt_none")).status).toBe(404);
  });
});
