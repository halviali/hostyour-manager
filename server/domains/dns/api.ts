import type { Hono } from "hono";
import type { AppEnv } from "../../http/app-env.ts";
import type { DnsInventoryView } from "../../../shared/dns.ts";
import { readDnsInventory, type DnsInventoryDeps } from "./dns-inventory.ts";

/** GET /api/dns — every record this installation is responsible for at the DNS provider, derived
 *  from its own registrations and read there now (dns-inventory.ts). Taking one back is a run
 *  (`dns-remove`, POST /api/runs), never a route of its own: a deletion at the provider is an act
 *  that is planned, approved and recorded like every other. */
export function registerDnsRoutes(app: Hono<AppEnv>, deps: DnsInventoryDeps): void {
  app.get("/api/dns", async (c) => c.json((await readDnsInventory(deps)) satisfies DnsInventoryView));
}
