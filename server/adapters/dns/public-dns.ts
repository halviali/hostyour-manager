import { Resolver } from "node:dns/promises";

// What RECEIVERS of the installation's mail look up: the public DNS, read through public resolvers
// rather than the machine's own — a record the master resolves through its cluster DNS and nobody
// else can is exactly the case the Mail page exists to show. Read-only; the writer of these records
// is the catalogue's publish-mail-dns program (mail-dns-publish), never this manager.

/** The three lookups the mail DNS check is made of. Every answer is a list; an absent name and a
 *  name without records of the type both answer the empty list, because to a receiver the two are
 *  the same thing. Anything else — a resolver that cannot be reached, a refused query — throws. */
export interface PublicDns {
  /** The TXT records at a name, each record's chunks joined into one string. */
  txt(name: string): Promise<string[]>;
  /** The IPv4 addresses a name resolves to. */
  a(name: string): Promise<string[]>;
  /** The names an address reverses to (its PTR records). */
  ptr(address: string): Promise<string[]>;
}

/** The resolvers the check asks — two independent public services, so one outage does not paint
 *  every record red. */
export const PUBLIC_RESOLVERS = ["1.1.1.1", "9.9.9.9"] as const;

const NOTHING = new Set(["ENOTFOUND", "ENODATA", "ESERVFAIL"]);

function empty(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && NOTHING.has(String((err as { code: unknown }).code));
}

export class NodePublicDns implements PublicDns {
  private readonly resolver: Resolver;

  constructor(servers: readonly string[] = PUBLIC_RESOLVERS) {
    // Its own Resolver instance: the process-wide resolver stays the machine's, which the rest of
    // this manager (the kube client, the git adapters) reaches its cluster by.
    this.resolver = new Resolver();
    this.resolver.setServers([...servers]);
  }

  async txt(name: string): Promise<string[]> {
    try {
      return (await this.resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch (err) {
      if (empty(err)) return [];
      throw err;
    }
  }

  async a(name: string): Promise<string[]> {
    try {
      return await this.resolver.resolve4(name);
    } catch (err) {
      if (empty(err)) return [];
      throw err;
    }
  }

  async ptr(address: string): Promise<string[]> {
    try {
      return await this.resolver.reverse(address);
    } catch (err) {
      if (empty(err)) return [];
      throw err;
    }
  }
}
