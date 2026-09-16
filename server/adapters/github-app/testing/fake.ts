// In-memory GitHubApp fake for the run and boot tests — no network, no key. The token and the
// organisation are scripted, the repositories are a set keyed `org/name` so createRepository is
// genuinely idempotent (a seeded or already created name answers {created:false}), and every create
// that made a repository is recorded so a test can assert what a run created and where.
import type { GitHubApp, CreateRepositoryInput } from "../port.ts";

export class FakeGitHubApp implements GitHubApp {
  /** What installationToken answers — the value a test expects to see handed on as a per-call PAT. */
  token = "ghs_fake_installation_token";
  /** What installationOrg answers — the organisation the fake installation is bound to. */
  org = "example-org";
  /** When set, every call throws it — the App identity that GitHub refuses (a revoked key, a
   *  suspended installation, an unreachable API). */
  failWith: Error | null = null;
  /** Every repository standing in the fake, as `org/name`. */
  private readonly repos = new Set<string>();
  /** Only the calls that actually created a repository — not the idempotent-skip calls. */
  readonly created: CreateRepositoryInput[] = [];

  /** Pre-seed a standing repository so a test can drive the already-exists path. */
  seedRepository(org: string, name: string): void {
    this.repos.add(`${org}/${name}`);
  }

  /** Whether a repository stands right now — the shape a test asserts against. */
  hasRepository(org: string, name: string): boolean {
    return this.repos.has(`${org}/${name}`);
  }

  async installationToken(): Promise<string> {
    if (this.failWith) throw this.failWith;
    return this.token;
  }

  async installationOrg(): Promise<string> {
    if (this.failWith) throw this.failWith;
    return this.org;
  }

  async createRepository(input: CreateRepositoryInput): Promise<{ created: boolean }> {
    if (this.failWith) throw this.failWith;
    const key = `${input.org}/${input.name}`;
    if (this.repos.has(key)) return { created: false };
    this.repos.add(key);
    this.created.push(input);
    return { created: true };
  }
}
