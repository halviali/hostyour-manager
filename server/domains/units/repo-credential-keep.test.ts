// A unit's ArgoCD repository access (repo-credential-keep.ts, repo-credential-sweep.ts): a
// repository the owner's GitHub App reaches has no Secret of its own — ArgoCD reads it through the
// App's credential template — so a standing token Secret is removed; any other gets its owner's PAT
// written again on every call; the sweep keeps every live unit, skips a repository no identity
// reaches, and one unit's failure stays that unit's.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DbHandle } from "../../db/client.ts";
import { apps, clusters, servers } from "../../db/schema/inventory.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { ClusterKubeResolver, ResolvedClusterKube } from "../../adapters/kube/port.ts";
import { FakeRepoCredentialWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { OwnerIdentityReader } from "./repo-identity.ts";
import { renderConsumerRepoCredential } from "./repo-credential.ts";
import { keepUnitRepoCredential } from "./repo-credential-keep.ts";
import { keepRepoCredentials } from "./repo-credential-sweep.ts";

/** The App's one row (kind github-app) and the owner acme's repository PAT. */
const store: Pick<CredentialStore, "list" | "open"> = {
  list: async (filter) => {
    const all = [
      { id: "cred_app", kind: "github-app" as const, label: "GitHub App (acme)", fingerprint: "sha256:app", subject: { kind: "owner" as const, id: "acme" }, purpose: "repository-identity" as const, recordedAt: "2026-01-01T00:00:00.000Z" },
      { id: "cred_pat", kind: "pat" as const, label: "repository PAT (acme)", fingerprint: "sha256:pat", subject: { kind: "owner" as const, id: "acme" }, purpose: "repository-pat" as const, recordedAt: "2026-01-01T00:00:00.000Z" },
    ];
    return all.filter((c) => !filter?.kind || c.kind === filter.kind);
  },
  open: async (id) => {
    if (id === "cred_pat") return Buffer.from("github_pat_shop", "utf8");
    throw new Error(`credential ${id} is not opened for a repository Secret`);
  },
};

/** A token Secret as the onboarding wrote it before this rule: an installation token that dies within the hour. */
async function standingTokenSecret(writer: FakeRepoCredentialWriter, name: string): Promise<void> {
  await writer.applyRepoCredential(renderConsumerRepoCredential({ consumerName: name, stage: "prod", argoNamespace: "argocd", repoURL: `https://github.com/acme/${name}`, pat: "ghs_expired" }));
}

describe("keepUnitRepoCredential", () => {
  it("removes the token Secret of a unit the App reaches and writes none", async () => {
    const writer = new FakeRepoCredentialWriter();
    await standingTokenSecret(writer, "post");
    const kept = await keepUnitRepoCredential({ store, repoCredential: writer }, { name: "post", stage: "prod", repoURL: "https://github.com/acme/post", credentialId: "cred_app", argoNamespace: "argocd" }, { purpose: "test" });
    expect(kept).toEqual({ identity: "github-app", removed: true });
    expect(writer.keys()).toEqual([]);
  });

  it("writes a PAT unit's Secret again once it is gone", async () => {
    const writer = new FakeRepoCredentialWriter();
    const unit = { name: "shop", stage: "prod" as const, repoURL: "https://github.com/acme/shop", credentialId: "cred_pat", argoNamespace: "argocd" };
    expect(await keepUnitRepoCredential({ store, repoCredential: writer }, unit, { purpose: "test" })).toEqual({ identity: "pat", created: true });
    expect(await keepUnitRepoCredential({ store, repoCredential: writer }, unit, { purpose: "test" })).toEqual({ identity: "pat", created: false });
    expect(writer.keys()).toEqual(["argocd/repo-shop-prod"]);
  });
});

describe("keepRepoCredentials", () => {
  let db: DbHandle;
  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { db.sqlite.close(); });

  it("keeps every live unit, leaves an offboarded one and a public repository alone, and isolates a failing unit", async () => {
    db.db.insert(servers).values({ id: "srv_1", name: "m1", host: "1.2.3.4", sshUser: "root", role: "master", status: "healthy" }).run();
    db.db.insert(servers).values({ id: "srv_2", name: "s2", host: "1.2.3.5", sshUser: "root", role: "slave", status: "healthy" }).run();
    db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
    db.db.insert(clusters).values({ id: "cls_down", serverId: "srv_2", stage: "prod", domain: "s2.example", status: "active" }).run();
    const row = (id: string, name: string, status: "active" | "suspended" | "offboarded", repoUrl: string, clusterId = "cls_1") =>
      db.db.insert(apps).values({ id, clusterId, name, stage: "prod", host: name, provenance: "manager", status, repoUrl }).run();
    row("app_post", "post", "active", "https://github.com/acme/post");
    row("app_shop", "shop", "suspended", "https://github.com/acme/shop");
    row("app_old", "old", "offboarded", "https://github.com/acme/old");
    row("app_pub", "pub", "active", "https://github.com/stranger/pub");
    row("app_far", "far", "active", "https://github.com/acme/far", "cls_down");

    const writer = new FakeRepoCredentialWriter();
    await standingTokenSecret(writer, "post");
    await standingTokenSecret(writer, "old");
    const githubApp = new FakeGitHubApp();
    githubApp.org = "acme";
    githubApp.reachable.set("acme/shop", false);
    const owners: OwnerIdentityReader = (org) => (org === "acme" ? { packagesCredentialId: null, repoCredentialId: "cred_pat" } : null);
    const resolver: Pick<ClusterKubeResolver, "resolve"> = {
      resolve: async (clusterId) => {
        if (clusterId === "cls_down") throw new Error("cluster cls_down unreachable");
        return { argoNamespace: "argocd" } as ResolvedClusterKube;
      },
    };
    const errors: string[] = [];
    const logger = { info: () => undefined, error: (fields: unknown, msg: string) => { errors.push(`${msg} ${JSON.stringify(fields)}`); } } as unknown as Logger;

    const result = await keepRepoCredentials({ db: db.db, store, githubApp, owners, resolver, repoCredential: writer, logger });

    expect(result).toEqual({ kept: ["post-prod", "shop-prod"], failed: ["far-prod"] });
    expect(writer.keys()).toEqual(["argocd/repo-old-prod", "argocd/repo-shop-prod"]);
    expect(errors.join("\n")).toContain("far-prod");
  });
});
