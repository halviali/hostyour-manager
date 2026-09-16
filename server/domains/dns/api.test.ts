import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../http/app.ts";
import { parseConfig } from "../../kernel/config.ts";
import { createLogger } from "../../kernel/logger.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { clusters, servers } from "../../db/schema/inventory.ts";
import { SessionCodec, SESSION_COOKIE } from "../access/session.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import type { DnsInventoryView } from "../../../shared/dns.ts";
import { registerDnsRoutes } from "./api.ts";

// GET /api/dns answers the inventory itself — the route is a reading and nothing more, so what is
// asserted here is that it stands behind the session chokepoint and that the rows reach the browser
// in the shape shared/dns.ts declares.

const config = parseConfig({
  PUBLIC_URL: "https://m1.example", OIDC_ISSUER: "https://i.example/", OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "s",
  MANAGER_VERSION: "test", DATA_DIR: "/d", LOG_LEVEL: "silent", ADMIN_SOCKET_PATH: "/run/manager/admin.sock",
} as NodeJS.ProcessEnv);
const logger = createLogger(config);

describe("GET /api/dns", () => {
  const handles: DbHandle[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.sqlite.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function make() {
    const dir = mkdtempSync(join(tmpdir(), "mgr-dns-"));
    dirs.push(dir);
    const db = openDb(join(dir, "manager.db"));
    handles.push(db);
    db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "m1.example.com", sshUser: "m1", role: "master", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example.com", status: "active" }).run();
    const dns = new FakeDnsProvider();
    dns.seed("m1.example.com", "A", "203.0.113.9");
    dns.seed("post.example.net", "A", "203.0.113.9");
    const session = new SessionCodec(db.db, config);
    const app = createApp({
      config, logger, getReadiness: () => ({ ok: true, checks: [] }), session,
      registerAuth: () => undefined,
      registerProtected: (a) => registerDnsRoutes(a, {
        db: db.db, dns,
        consumers: async (_domain, stage) => (stage === "prod" ? [{ name: "post", host: "post" }] : []),
        tenants: async () => [],
        unitApex: async () => "example.net",
      }),
    });
    return { app, cookie: await session.mint({ sub: "op_test", groups: ["admins"], via: "oidc" }) };
  }

  it("answers the inventory to a signed-in operator and refuses an anonymous request", async () => {
    const { app, cookie } = await make();
    expect((await app.request("/api/dns")).status).toBe(401);
    const res = await app.request("/api/dns", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DnsInventoryView;
    expect(body.rows).toEqual([
      { owner: { kind: "consumer", name: "post", stage: "prod" }, name: "post.example.net", type: "A", expected: "203.0.113.9", found: "203.0.113.9", verdict: "standing", removable: true },
    ]);
    // No mail reader is wired in this harness, so the mail block is simply absent — never a sentence
    // claiming the installation publishes none.
    expect(body.skipped).toEqual([]);
    expect(Date.parse(body.readAt)).not.toBeNaN();
  });
});
