// The tenant onboarding builds the images its fan-out lacks (hostyour-manager#165): the plan maps
// every missing image to the repository the catalogue's tenant.buildRepos names and asks one PAT per
// repository the installation has not registered; the run onboards each such unit build-only before
// the tenant's own writes and re-reads the image set off the pins the builds wrote.
import { dropCredentialRows } from "../../security/store.fixture.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { resolveBuildUnits, buildUnitStep, buildUnitStepName, refreshImagesStep, channelReaching, type TenantBuildRuntime } from "./tenant-builds.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { tenantApplicationSet } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { ports as onboardPorts } from "./onboard.fixture.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { TenantValidationReport } from "../../../shared/tenant.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import { STANDING_MEMBER_NAMES as TEST_MEMBERS, testMembers, APP_OVERLAYS } from "./tenant-members.fixture.ts";
import { TEMPLATE_SPEC, withAppsTemplate, recordTestOwners } from "./tenant-apps-repo.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const HOST = "zot.m1.example";
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const JOBS_REPO = "https://github.com/acme/example-jobs.git";
const PLATFORM_REPO = "https://github.com/acme/example-platform.git";
const APPS = [{ name: "erp" }];
const MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: catalog
owner: platform
envs: [dev, prod]
builds:
  - name: engine
    containerfile: Containerfile
tenant:
${TEMPLATE_SPEC}  buildRepos:
    - repo: ${JOBS_REPO}
      builds: [example-jobs]
    - repo: ${PLATFORM_REPO}
      builds: [example-engine]
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui, override: { web: { chart: charts/example-web } } }
`;
/** The build unit's own manifest, as the ungated read parses it off its repository: build-only. */
const JOBS_MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: example-jobs
owner: platform
envs: [dev, test, prod]
builds:
  - name: example-jobs
    containerfile: Containerfile
`;
const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}`, raw: { kind }, ...over,
});
const withImages = (tags: { jobs: string; engine: string }): RenderedDoc[] => [
  doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }),
  doc("Deployment", {
    raw: { kind: "Deployment", spec: { template: { spec: { containers: [
      { name: "jobs", image: `${HOST}/example-jobs:${tags.jobs}` },
      { name: "engine", image: `${HOST}/example-engine:${tags.engine}` },
    ] } } } },
  }),
];
const TRUNK_DOCS = withImages({ jobs: "0.2.0", engine: "0.4.0" });
const BUILT_DOCS = withImages({ jobs: "0.1.0-stable-20260101000000-abc1234", engine: "0.4.0" });

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); recordTestOwners(db.db); });
afterEach(() => { db.sqlite.close(); });

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["auth", "jobs", "report", "erp"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
}
function fakeTenantSeeder(): VaultSeeder {
  return {
    seed: () => Promise.reject(new Error("a tenant run never seeds a consumer entry")),
    seedPostgres: () => Promise.reject(new Error("no")), seedMongodb: () => Promise.reject(new Error("no")),
    seedBuildRepoPat: () => Promise.reject(new Error("a tenant run never seeds a repo pat itself")),
    refreshBuildRepoPat: () => Promise.reject(new Error("a tenant run never refreshes a repo pat itself")),
    deleteBuildRepoPat: async () => {}, deleteApp: async () => {}, deletePostgres: async () => {}, deleteMongodb: async () => {},
    seedTenantCrypto: async () => ({ created: true }), deleteTenantCrypto: async () => {},
  };
}
/** The target cluster's own A record — what G27 reads the tenant's wildcard against at the plan. */
function seededDns(): FakeDnsProvider {
  const dns = new FakeDnsProvider();
  dns.seed("s1.example", "A", "203.0.113.10");
  return dns;
}

function ports(over: Partial<TenantOnboardPorts> = {}): TenantOnboardPorts {
  return {
    seeder: fakeTenantSeeder(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: TRUNK_DOCS } }),
    registrations: new TenantRegistrations(new FakePlatformRepo()),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({}), argoReader: new FakeMasterArgoReader({}), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: ${HOST}\n` }],
    registryProbe: new FakeRegistryProbe(),
    dns: seededDns(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }],
    consumerHostLabels: async () => [],
    ...over,
  };
}
function params(over: Partial<CreateTenantParams> = {}): CreateTenantParams {
  return CreateTenantParams.parse({
    guid: GUID, subdomain: "acme", stage: "prod", clusterId: "cls_1", domain: "s1.example",
    members: testMembers(APPS), identityProvider: "auth",
    cluster: "s1", chartsRef: SHA, registryHost: HOST,
    apps: APPS, seedUsers: false, quota: seedQuota("small"), owner: "team-acme",
    report: passReport(), expectedApps: tenantApplicationSet([...TEST_MEMBERS, ...APPS.map((a) => a.name)], GUID, "prod"), catalogRepoUrl: DEPLOY_URL,
    ...over,
  });
}
function ctx(p: Record<string, unknown>, logs: string[], sealed: { kind: string; label: string }[] = []): StepCtx {
  const creds = {
    seal: async (i: { kind: string; label: string; fingerprint: string }) => { sealed.push({ kind: i.kind, label: i.label }); return { id: "cred_sealed", kind: i.kind, label: i.label, fingerprint: i.fingerprint }; },
    open: async () => Buffer.from("ghp_test"),
    list: async () => [],
  };
  return {
    runId: "run_bld", stepName: "build", db: db.db, creds: creds as unknown as CredentialStore, params: p,
    secrets: { get: () => undefined, wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}
function planCtx(): PlanStreamCtx {
  return { db: db.db, log: () => undefined, signal: new AbortController().signal };
}
function seedClusters(): void {
  db.db.insert(servers).values({ id: "srv_1", name: "s1", host: "10.1.1.11", sshUser: "root", role: "slave", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_1", serverId: "srv_1", stage: "prod", domain: "s1.example", status: "active" }).run();
  db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "5.6.7.8", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example", status: "active" }).run();
}
const BUILD_REPOS = [{ repo: JOBS_REPO, builds: ["example-jobs"] }, { repo: PLATFORM_REPO, builds: ["example-engine"] }];

describe("resolveBuildUnits — the missing images grouped by the repository that builds them", () => {
  it("one unit per repository, named by the repository, registered or not; an image nobody builds is unmapped", async () => {
    const r = await resolveBuildUnits({
      missing: [{ repo: "example-jobs", tag: "0.2.0" }, { repo: "example-engine", tag: "0.4.0" }, { repo: "example-nobody", tag: "1" }],
      buildRepos: BUILD_REPOS,
      registration: async (unit) => (unit === "example-platform" ? { form: "build-only", repoCredentialId: "cred_platform" } : null),
    });
    expect(r.units).toEqual([
      { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false },
      { unit: "example-platform", repoURL: PLATFORM_REPO, images: ["example-engine"], registered: true, form: "build-only", repoCredentialId: "cred_platform" },
    ]);
    expect(r.unmapped).toEqual([{ repo: "example-nobody", tag: "1" }]);
  });
});

describe("channelReaching — the highest channel whose ceiling admits the stage", () => {
  const table = { alpha: ["dev" as const], beta: ["dev" as const, "test" as const], stable: ["dev" as const, "test" as const, "prod" as const] };
  it("stable for prod, stable for dev too (a tenant is never a pre-release), refused where nothing reaches", () => {
    expect(channelReaching(table, "prod")).toBe("stable");
    expect(channelReaching(table, "dev")).toBe("stable");
    expect(() => channelReaching({ alpha: ["dev"] }, "prod")).toThrow(/no release channel reaches stage prod/);
  });
});

describe("create-tenant planStream — the build units and their owner's identity (#220)", () => {
  it("lists a build unit per missing image's repository, asks nothing at approve, and places its steps before the tenant's writes", async () => {
    seedClusters();
    const prt = withAppsTemplate(ports({ registryProbe: new FakeRegistryProbe({ missing: ["example-jobs:0.2.0"] }) }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.buildUnits).toEqual([{ unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false }]);
    expect(result.plan.requiredSecrets).toEqual([]);
    expect(result.plan.optionalSecrets).toBeUndefined();
    expect(result.plan.warnings[0]).toContain("example-jobs: example-jobs");
    const names = result.plan.steps.map((s) => s.name);
    expect(names.indexOf(buildUnitStepName("example-jobs"))).toBeGreaterThan(names.indexOf("record-provisional"));
    expect(names.indexOf(buildUnitStepName("example-jobs"))).toBeLessThan(names.indexOf("seed-tenant-crypto"));
    expect(names.indexOf("refresh-images")).toBe(names.indexOf("ensure-images") - 1);
  });
  it("refuses, naming the owner and the page, a build unit whose owner records no identity", async () => {
    seedClusters();
    dropCredentialRows(db.db, { kind: "owner", id: "acme" });
    const prt = withAppsTemplate(ports({ registryProbe: new FakeRegistryProbe({ missing: ["example-jobs:0.2.0"] }) }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/build unit example-jobs .* has no identity: .*owner acme records no repository PAT .* consumer wizard/);
  });
  it("a registered build-only unit is re-released with its stored credential and asks for nothing", async () => {
    seedClusters();
    const prt = withAppsTemplate(ports({
      registryProbe: new FakeRegistryProbe({ missing: ["example-engine:0.4.0"] }),
      buildUnitRegistration: async (unit) => (unit === "example-platform" ? { form: "build-only", repoCredentialId: "cred_platform" } : null),
    }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.buildUnits[0]).toMatchObject({ unit: "example-platform", registered: true, repoCredentialId: "cred_platform" });
    expect(result.plan.requiredSecrets).toEqual([]);
  });
  it("refuses a render that pulls the apps TEMPLATE (tenant.appsBundle), by name, before the registry is asked — a stale chart is named, never built", async () => {
    seedClusters();
    // The catalog names example-apps as the template; the fixture's engine chart still mounts it.
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [...TRUNK_DOCS, doc("Deployment", { name: "x", raw: { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "n", image: `${HOST}/example-apps:0.9.0` }] } } } } })] } });
    const probe = new FakeRegistryProbe({ missing: [] }); // the registry still carries the template's image
    const prt = withAppsTemplate(ports({ helm, registryProbe: probe }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/example-apps:0\.9\.0.*"example-apps" is the catalogue's apps template \(tenant\.appsBundle\).*never built and never mounted/);
    expect(probe.probes).toEqual([]);
  });
  it("no image missing ⇒ no build unit and no secret; the refresh step stays, because the tenant's own bundle is built by the run", async () => {
    seedClusters();
    const result = await makeCreateTenantDef(withAppsTemplate(ports())).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.buildUnits).toEqual([]);
    expect(result.plan.requiredSecrets).toEqual([]);
    expect(result.plan.steps.map((s) => s.name)).toContain("refresh-images");
  });
  it("refuses a missing image no buildRepos entry names, by name", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [...TRUNK_DOCS, doc("Deployment", { name: "x", raw: { kind: "Deployment", spec: { template: { spec: { containers: [{ name: "n", image: `${HOST}/example-nobody:1` }] } } } } })] } });
    const prt = withAppsTemplate(ports({ helm, registryProbe: new FakeRegistryProbe({ missing: ["example-nobody:1"] }) }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/tenant\.buildRepos names no repository.*example-nobody:1/);
  });
  it("refuses a missing image of a unit registered as deployable — its release is the unit's own act", async () => {
    seedClusters();
    const prt = withAppsTemplate(ports({
      registryProbe: new FakeRegistryProbe({ missing: ["example-jobs:0.2.0"] }),
      buildUnitRegistration: async (unit) => (unit === "example-jobs" ? { form: "deployable", repoCredentialId: "cred_jobs" } : null),
    }));
    const result = await makeCreateTenantDef(prt).planStream!({ clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS }, planCtx());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.summary).toMatch(/registered as deployable \(example-jobs\)/);
  });
});

describe("buildUnitStep — the consumer's build-only chain, run for one unit inside the tenant run", () => {
  it("seals the owner's repository PAT under the unit's name, resolves version and channel, registers the unit and watches its release", async () => {
    seedClusters();
    const buildPlane = new FakeBuildPlane();
    buildPlane.seedReleaseRun("example-jobs", { runName: "example-jobs-release-1", releaseTag: "0.1.0-stable-20260101000000", succeeded: true });
    const onboard = onboardPorts({
      repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/platform.yaml": JOBS_MANIFEST_YAML } }),
      buildPlane,
    });
    const unit = { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false };
    const step = buildUnitStep(() => ({ ports: onboard }), { guid: GUID, owner: "team-acme", stage: "prod" }, unit);
    const logs: string[] = [];
    const sealed: { kind: string; label: string }[] = [];
    await step.run(ctx(params(), logs, sealed));
    expect(sealed).toEqual([{ kind: "pat", label: "repository PAT (example-jobs)" }]); // acme records a repository PAT; the App does not reach it
    // The unit stands registered build-only on the books branch, its release watched at the version
    // read off the repository's tags (none ⇒ 0.1.0) on the channel that reaches prod.
    expect(await onboard.registrations.readBuildRegistration("example-jobs")).not.toBeNull();
    expect(buildPlane.releaseWatches).toEqual([{ unit: "example-jobs", version: "0.1.0", channel: "stable" }]);
    expect(logs.some((l) => l.includes("build unit example-jobs done"))).toBe(true);
  });
  // The rule of #220 on the tenant path: a unit the App reaches is sealed under the App, one it does
  // not under its owner's repository PAT, and one whose owner records nothing refuses.
  it("seals a unit the App reaches under the App, one it does not under the owner's repository PAT, and refuses one of an unrecorded owner", async () => {
    seedClusters();
    const unit = { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false };
    const make = () => {
      const buildPlane = new FakeBuildPlane();
      buildPlane.seedReleaseRun("example-jobs", { runName: "example-jobs-release-1", releaseTag: "0.1.0-stable-20260101000000", succeeded: true });
      return onboardPorts({ repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/platform.yaml": JOBS_MANIFEST_YAML } }), buildPlane });
    };
    const reaching = new FakeGitHubApp();
    reaching.org = "acme"; // the App is installed in the owner of JOBS_REPO
    const viaApp: { kind: string; label: string }[] = [];
    await buildUnitStep(() => ({ ports: make(), githubApp: reaching }), { guid: GUID, owner: "team-acme", stage: "prod" }, unit).run(ctx(params(), [], viaApp));
    expect(viaApp).toEqual([{ kind: "github-app", label: "GitHub App (example-jobs)" }]);
    const elsewhere = new FakeGitHubApp(); // installed in example-org: acme's repository PAT is the identity
    const viaPat: { kind: string; label: string }[] = [];
    await buildUnitStep(() => ({ ports: make(), githubApp: elsewhere }), { guid: GUID, owner: "team-acme", stage: "prod" }, unit).run(ctx(params(), [], viaPat));
    expect(viaPat).toEqual([{ kind: "pat", label: "repository PAT (example-jobs)" }]);
    const nobody = { unit: "x", repoURL: "https://github.com/nobody/x.git", images: ["x"], registered: false };
    await expect(buildUnitStep(() => ({ ports: make(), githubApp: elsewhere }), { guid: GUID, owner: "team-acme", stage: "prod" }, nobody).run(ctx(params(), [])))
      .rejects.toThrow(/owner nobody records no repository PAT/);
  });
  it("refuses when the consumer onboarding is not wired, naming it", async () => {
    seedClusters();
    const unit = { unit: "example-jobs", repoURL: JOBS_REPO, images: ["example-jobs"], registered: false };
    const step = buildUnitStep(() => undefined, { guid: GUID, owner: "team-acme", stage: "prod" }, unit);
    await expect(step.run(ctx(params(), []))).rejects.toThrow(/consumer onboarding is not wired/);
  });
});

describe("refreshImagesStep — the image set re-read off the pins the builds wrote", () => {
  it("replaces the plan's frozen set with the re-rendered one and names every tag that moved", async () => {
    const runtime: TenantBuildRuntime = {};
    const prt = ports({ helm: new FakeHelmRenderer({ fallback: { ok: true, docs: BUILT_DOCS } }) });
    const p = params({ requiredImages: [{ repo: "example-jobs", tag: "0.2.0" }, { repo: "example-engine", tag: "0.4.0" }] });
    const logs: string[] = [];
    await refreshImagesStep(prt, { guid: GUID, domain: "s1.example", stage: "prod", subdomain: "acme", apps: APPS, seedUsers: false, registryHost: HOST, requiredImages: p.requiredImages }, runtime).run(ctx(p, logs));
    expect(runtime.requiredImages).toEqual([{ repo: "example-engine", tag: "0.4.0" }, { repo: "example-jobs", tag: "0.1.0-stable-20260101000000-abc1234" }]);
    expect(runtime.syncUnits).toEqual(["example-platform"]);
    expect(logs.some((l) => l.includes("example-jobs: 0.2.0 -> 0.1.0-stable-20260101000000-abc1234"))).toBe(true);
  });
});
