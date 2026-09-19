// In-memory GitHubConsumer fake for the onboarding domain tests — no network. Keeps a per-repo hook
// store so ensureHook is genuinely replacing (a stale EventListener hook is deleted, the current one
// kept or created), records every create/delete so a test can assert onboard created the push-hook
// (and offboard/purge removed it), and simulates the release workflow: a dispatch appends a run whose
// status/conclusion the test scripts, so the trigger + watch steps run against the same correlation
// contract the HTTP client answers.
import type {
  GitHubConsumer, EnsureHookInput, EnsureHookResult, DeleteHookInput, DeleteHookResult, TokenScopes,
  DispatchWorkflowInput,
} from "../port.ts";
import { WebhookScopeError, WorkflowNotFoundError, GitHubConsumerError, targetsEventListener } from "../port.ts";

interface StoredHook {
  id: number;
  targetUrl: string;
  secret: string;
  events: string[];
  contentType: string;
}

/** A recorded create (only the calls that actually created a hook — not the idempotent-skip calls). */
export interface CreatedHookRecord {
  owner: string;
  repo: string;
  token: string;
  targetUrl: string;
  secret: string;
  events: string[];
  contentType: string;
  id: number;
}

/** A recorded delete call + the hook ids it removed. No target URL: the removal matches the
 *  EventListener path, not one address. */
export interface DeletedHookRecord {
  owner: string;
  repo: string;
  token: string;
  ids: number[];
}

export class FakeGitHubConsumer implements GitHubConsumer {
  /** owner/repo -> its hooks. */
  private readonly hooks = new Map<string, StoredHook[]>();
  private nextId = 1;
  readonly created: CreatedHookRecord[] = [];
  readonly deletedCalls: DeletedHookRecord[] = [];
  /** When true, ensureHook + deleteHook throw WebhookScopeError (the PAT lacks admin:repo_hook). */
  scopeError = false;
  /** What readTokenScopes returns — default: a classic PAT with all three required scopes present. A
   *  preflight-scopes test overrides this to drive the missing-scope / fine-grained paths. */
  tokenScopes: TokenScopes = { classic: true, scopes: ["repo", "workflow", "admin:repo_hook", "read:packages"] };
  /** When true, readTokenScopes throws WebhookScopeError (the PAT is invalid/expired — a 401). */
  tokenInvalid = false;

  // ---- the release trigger (trigger-release) ----
  /** Every dispatch call, in order — a test asserts the trigger fired once with {version, channel,
   *  stage} and against which workflow file. */
  readonly dispatches: DispatchWorkflowInput[] = [];
  /** How many dispatch calls answer 404 (WorkflowNotFoundError) before one succeeds — the
   *  just-committed-workflow indexing lag the trigger step retries through. */
  dispatchNotFoundTimes = 0;
  /** When set, every dispatch throws GitHubConsumerError with this message + status — the 422/403
   *  surface-GitHub's-own-message path. */
  dispatchRefusal: { status: number; message: string } | null = null;

  /** owner/repo -> the tag names listReleaseTags answers; unseeded repos answer none. */
  private readonly tags = new Map<string, string[]>();
  /** Every listReleaseTags call, so a test can assert which repositories the next-version read spanned. */
  readonly tagReads: Array<{ owner: string; repo: string }> = [];
  /** The token each tag listing was made with — the identity the read ran under. */
  readonly tokensSeen: string[] = [];

  seedTags(owner: string, repo: string, names: readonly string[]): void {
    this.tags.set(this.key(owner, repo), [...names]);
  }

  async listReleaseTags(input: { owner: string; repo: string; token: string; signal?: AbortSignal }): Promise<string[]> {
    this.tagReads.push({ owner: input.owner, repo: input.repo });
    this.tokensSeen.push(input.token);
    return [...(this.tags.get(this.key(input.owner, input.repo)) ?? [])];
  }

  private key(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  async readTokenScopes(input: { owner: string; repo: string; token: string; signal?: AbortSignal }): Promise<TokenScopes> {
    if (this.tokenInvalid) throw new WebhookScopeError(`fake: the PAT is invalid on ${input.owner}/${input.repo}`, 401);
    return this.tokenScopes;
  }

  /** Pre-seed an existing hook so a test can drive the idempotent-keep and stale-replace paths.
   *  Returns the hook id. */
  seedHook(owner: string, repo: string, targetUrl: string): number {
    const id = this.nextId++;
    const list = this.hooks.get(this.key(owner, repo)) ?? [];
    list.push({ id, targetUrl, secret: "", events: ["push"], contentType: "json" });
    this.hooks.set(this.key(owner, repo), list);
    return id;
  }

  /** The hooks currently present on a repo (test assertion helper). */
  hooksFor(owner: string, repo: string): ReadonlyArray<{ id: number; targetUrl: string; secret: string; events: string[] }> {
    return (this.hooks.get(this.key(owner, repo)) ?? []).map((h) => ({ id: h.id, targetUrl: h.targetUrl, secret: h.secret, events: h.events }));
  }

  async ensureHook(input: EnsureHookInput): Promise<EnsureHookResult> {
    if (this.scopeError) throw new WebhookScopeError(`fake: the PAT lacks admin:repo_hook on ${input.owner}/${input.repo}`, 403);
    const list = this.hooks.get(this.key(input.owner, input.repo)) ?? [];
    // The replace half of the contract: stale EventListener hooks go first (same rule as the HTTP client).
    const stale = list.filter((h) => h.targetUrl !== input.targetUrl && targetsEventListener(h.targetUrl));
    const kept = list.filter((h) => !stale.includes(h));
    const match = kept.find((h) => h.targetUrl === input.targetUrl);
    if (match) {
      // Re-set whole, as the HTTP client PATCHes it: the secret and the events are this
      // installation's from here on, whatever the hook carried before (#198).
      match.secret = input.secret;
      match.events = input.events;
      match.contentType = input.contentType;
      this.hooks.set(this.key(input.owner, input.repo), kept);
      return { created: false, id: match.id, staleRemoved: stale.length };
    }
    const id = this.nextId++;
    kept.push({ id, targetUrl: input.targetUrl, secret: input.secret, events: input.events, contentType: input.contentType });
    this.hooks.set(this.key(input.owner, input.repo), kept);
    this.created.push({
      owner: input.owner, repo: input.repo, token: input.token, targetUrl: input.targetUrl,
      secret: input.secret, events: input.events, contentType: input.contentType, id,
    });
    return { created: true, id, staleRemoved: stale.length };
  }

  async deleteHook(input: DeleteHookInput): Promise<DeleteHookResult> {
    if (this.scopeError) throw new WebhookScopeError(`fake: the PAT lacks admin:repo_hook on ${input.owner}/${input.repo}`, 403);
    const list = this.hooks.get(this.key(input.owner, input.repo)) ?? [];
    // The EventListener path on ANY host, same rule as the HTTP client — a hook left at an address
    // the platform no longer composes is still the one this removal exists to take.
    const matches = list.filter((h) => targetsEventListener(h.targetUrl));
    this.hooks.set(this.key(input.owner, input.repo), list.filter((h) => !matches.includes(h)));
    this.deletedCalls.push({ owner: input.owner, repo: input.repo, token: input.token, ids: matches.map((h) => h.id) });
    return { deleted: matches.length, urls: matches.map((h) => h.targetUrl) };
  }



  /** What getDefaultBranch answers — overridable so a test can drive a master-named repo. */
  defaultBranch = "main";

  async getDefaultBranch(): Promise<string> {
    return this.defaultBranch;
  }

  async dispatchWorkflow(input: DispatchWorkflowInput): Promise<void> {
    if (this.dispatchNotFoundTimes > 0) {
      this.dispatchNotFoundTimes--;
      throw new WorkflowNotFoundError(`fake: workflow ${input.workflowFile} not indexed yet on ${input.owner}/${input.repo}`);
    }
    if (this.dispatchRefusal) {
      throw new GitHubConsumerError(
        `GitHub POST /repos/${input.owner}/${input.repo}/actions/workflows/${input.workflowFile}/dispatches → ${this.dispatchRefusal.status}: ${this.dispatchRefusal.message}`,
        this.dispatchRefusal.status,
      );
    }
    this.dispatches.push(input);
  }

}
