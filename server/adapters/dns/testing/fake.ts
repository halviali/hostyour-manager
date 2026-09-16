// In-memory DnsProvider fake for the onboarding domain tests — no network. A flat (name, type) →
// contents record store: seed the target cluster's own A record so provision-dns can read the address
// it points the unit's record at, then assert the exact records a run created and removed. A name
// holds a LIST because a real zone does — the sender domain's apex carries other services' TXT
// beside the SPF — and an upsert leaves exactly one, the way the Cloudflare adapter does.
import type { DnsProvider, DnsRecordType } from "../port.ts";

export class FakeDnsProvider implements DnsProvider {
  private readonly records = new Map<string, string[]>();
  /** Every upsert, in order — a test asserts the one record per unit and its content. */
  readonly upserts: Array<{ name: string; type: DnsRecordType; content: string; created: boolean }> = [];
  /** Every delete call, in order, with how many records it removed. */
  readonly deletes: Array<{ name: string; type: DnsRecordType; deleted: number }> = [];
  /** When set, every call throws it — the API-failure path (an unreachable/refusing provider). */
  failWith: Error | null = null;

  private key(name: string, type: DnsRecordType): string {
    return `${type} ${name}`;
  }

  /** Seed the records that pre-exist the run under one name — above all the target cluster's own A
   *  record. Several contents seed several records of that name and type. */
  seed(name: string, type: DnsRecordType, ...contents: string[]): void {
    this.records.set(this.key(name, type), contents);
  }

  /** The first record's content right now, or undefined — the shape a test asserts against. */
  record(name: string, type: DnsRecordType): string | undefined {
    return this.records.get(this.key(name, type))?.[0];
  }

  async upsertRecord(input: { name: string; type: DnsRecordType; content: string }): Promise<{ created: boolean }> {
    if (this.failWith) throw this.failWith;
    const created = !this.records.has(this.key(input.name, input.type));
    this.records.set(this.key(input.name, input.type), [input.content]);
    this.upserts.push({ name: input.name, type: input.type, content: input.content, created });
    return { created };
  }

  async deleteRecord(input: { name: string; type: DnsRecordType }): Promise<{ deleted: number }> {
    if (this.failWith) throw this.failWith;
    const deleted = this.records.get(this.key(input.name, input.type))?.length ?? 0;
    this.records.delete(this.key(input.name, input.type));
    this.deletes.push({ name: input.name, type: input.type, deleted });
    return { deleted };
  }

  async readRecordContent(input: { name: string; type: DnsRecordType }): Promise<string | null> {
    return (await this.listRecordContents(input))[0] ?? null;
  }

  async listRecordContents(input: { name: string; type: DnsRecordType }): Promise<string[]> {
    if (this.failWith) throw this.failWith;
    return this.records.get(this.key(input.name, input.type)) ?? [];
  }
}
