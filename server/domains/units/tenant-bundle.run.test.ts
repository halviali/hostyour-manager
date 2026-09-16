// The tenant's own apps bundle through the create-tenant run (hostyour-manager#178): the request
// names it, the render is handed it under `tenant:` exactly as the tenants ApplicationSet delivers
// it, the image it yields is a required image at the bundle's own tag, a bundle never built is a
// build unit of the tenant's own repository whose release the run reads the tag off, and the
// registration carries the three facts — or the empty pair for a tenant without one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedQuota } from "../../../shared/unit-size.ts";
import { seedUnitSizes } from "./unit-size.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeCreateTenantDef, CreateTenantParams, CreateTenantRequest, type TenantOnboardPorts } from "./create-tenant.run.ts";
import { resolveBuildUnits, buildUnitStep, buildUnitStepName, refreshImagesStep, type TenantBuildRuntime } from "./tenant-builds.ts";
import { writeRegistrationStep } from "./create-tenant-registration.ts";
import { validateTenant } from "./validate-tenant.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { memberNamespace, tenantApplicationSet } from "./tenant-fanout.ts";
import { composeTenantReport, TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { ports as onboardPorts } from "./onboard.fixture.ts";
import { FakeRepoReader, FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import type { StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RenderedDoc } from "../../adapters/helm/port.ts";
import type { TenantValidationReport } from "../../../shared/tenant.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";
import { APP_OVERLAYS, STANDING_MEMBER_NAMES as TEST_MEMBERS, TEST_BUNDLE, testMembers } from "./tenant-members.fixture.ts";
import { clusterMapPath } from "../../../shared/cluster-values.ts";

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const HOST = "zot.m1.example";
const PLACEHOLDER = "0.0.0-placeholder";
const DEPLOY_URL = "https://github.com/acme/acme-catalog.git";
const PLATFORM_URL = "https://github.com/simetrixch/hostyour-cloud.git";
const APPS = [{ name: "erp" }];
const BUILT_TAG = "0.1.0-stable-20260202000000-def5678";
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
  buildRepos:
    - repo: https://github.com/acme/example-platform.git
      builds: [example-engine]
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui }
`;
/** The bundle unit's own manifest, as the ungated read parses it off its repository: build-only. */
const BUNDLE_MANIFEST_YAML = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: acme-apps
owner: platform
envs: [dev, test, prod]
builds:
  - name: acme-apps
    containerfile: docker/Dockerfile
`;
const doc = (kind: string, over: Partial<RenderedDoc> = {}): RenderedDoc => ({
  apiVersion: "v1", kind, name: `${kind.toLowerCase()}-x`, namespace: `${GUID}`, raw: { kind }, ...over,
});
/** What the engine chart renders once the delivered `tenant.appsImage`/`appsImageTag` are composed
 *  into the app-fetch initContainer's image (digita-deploy#50) — the render the fake stands in for. */
const withBundle = (tag: string): RenderedDoc[] => [
  doc("Namespace", { namespace: "", raw: { kind: "Namespace" } }),
  doc("Deployment", {
    raw: { kind: "Deployment", spec: { template: { spec: {
      containers: [{ name: "engine", image: `${HOST}/example-engine:0.4.0` }],
      initContainers: [{ name: "app-fetch", image: `${HOST}/${TEST_BUNDLE.appsImage}:${tag}` }],
    } } } },
  }),
];
const CHAIN = [{ path: clusterMapPath("m1.example"), content: `global:\n  unitApex: example.com\n  placeholderTag: "${PLACEHOLDER}"\n  endpoints:\n    registry:\n      host: ${HOST}\n` }];

let db: DbHandle;
beforeEach(() => { db = openDb(":memory:"); seedUnitSizes(db.db); });
afterEach(() => { db.sqlite.close(); });

function passReport(): TenantValidationReport {
  return composeTenantReport({
    resolvedSha: SHA, probeGuid: GUID, appsValidated: ["erp"], resolvedMembers: ["auth", "jobs", "report", "erp"],
    startedAt: 1, finishedAt: 2, manifest: null,
    gates: [{ id: "T1", title: "manifest", severity: "hard", status: "pass", expected: "e", found: "f", reason: null, detail: "d" }],
  });
}
function fakeTenantSeeder(): VaultSeeder {
  const no = () => Promise.reject(new Error("a tenant run never seeds a consumer entry"));
  return {
    seed: no, seedPostgres: no, seedMongodb: no, seedBuildRepoPat: no,
    deleteBuildRepoPat: async () => {}, deleteApp: async () => {}, deletePostgres: async () => {}, deleteMongodb: async () => {},
    seedTenantCrypto: async () => ({ created: true }), deleteTenantCrypto: async () => {},
  };
}
function ports(over: Partial<TenantOnboardPorts> = {}): TenantOnboardPorts {
  const dns = new FakeDnsProvider();
  dns.seed("s1.example", "A", "203.0.113.10");
  return {
    seeder: fakeTenantSeeder(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML, ...APP_OVERLAYS } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: withBundle(TEST_BUNDLE.appsImageTag) } }),
    registrations: new TenantRegistrations(new FakePlatformRepo()),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({}), argoReader: new FakeMasterArgoReader({}), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
    }),
    catalogRepoUrl: DEPLOY_URL,
    platformRepoURL: PLATFORM_URL,
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => CHAIN,
    registryProbe: new FakeRegistryProbe(),
    dns,
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [{ unit: "example-platform", build: "example-engine" }, { unit: "acme-apps", build: "acme-apps" }],
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
function ctx(p: Record<string, unknown>, logs: string[]): StepCtx {
  const creds = {
    seal: async (i: { kind: string; label: string; fingerprint: string }) => ({ id: "cred_sealed", kind: i.kind, label: i.label, fingerprint: i.fingerprint }),
    open: async () => Buffer.from("ghp_test"),
  };
  return {
    runId: "run_bundle", stepName: "bundle", db: db.db, creds: creds as unknown as CredentialStore, params: p,
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
const REQUEST = { clusterId: "cls_1", stage: "prod", subdomain: "acme", owner: "team-acme", apps: APPS, ...TEST_BUNDLE };
const BUNDLE_UNIT = { unit: "acme-apps", repoURL: TEST_BUNDLE.appsRepo, images: ["acme-apps"], registered: true, form: "build-only" as const, repoCredentialId: "cred_apps" };

describe("the request — every tenant with an app names its own bundle", () => {
  const why = (over: Record<string, unknown>) => CreateTenantRequest.safeParse({ ...REQUEST, ...over }).error?.issues[0]?.message;
  it("refuses an app without a bundle, a repository without its image, and a tag without its image", () => {
    expect(why({ appsRepo: undefined, appsImage: undefined, appsImageTag: undefined })).toMatch(/1 app\(s\) selected and no apps bundle named/);
    expect(why({ appsImage: undefined, appsImageTag: undefined })).toMatch(/appsRepo and appsImage together/);
    expect(why({ appsRepo: undefined, appsImage: undefined })).toMatch(/appsImageTag names the tag of appsImage/);
  });
  it("accepts a zero-app tenant without one, and a bundle not yet built (no tag)", () => {
    expect(CreateTenantRequest.safeParse({ ...REQUEST, apps: [], appsRepo: undefined, appsImage: undefined, appsImageTag: undefined }).success).toBe(true);
    expect(CreateTenantRequest.safeParse({ ...REQUEST, appsImageTag: undefined }).success).toBe(true);
  });
});

describe("validateTenant — the bundle is delivered under tenant: as the ApplicationSet delivers it", () => {
  const deps = (helm: FakeHelmRenderer) => ({ repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: MANIFEST_YAML, ...APP_OVERLAYS } }), helm, log: () => undefined, signal: new AbortController().signal });
  const base = { repoURL: DEPLOY_URL, ref: "main", stage: "prod" as const, apps: APPS, probeGuid: GUID, subdomain: "acme", clusterValueFiles: CHAIN };
  it("hands every member the image and the tag, and the empty pair to a tenant without one", async () => {
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: [] } });
    await validateTenant({ ...base, appsImage: TEST_BUNDLE.appsImage, appsImageTag: TEST_BUNDLE.appsImageTag }, deps(helm));
    const engine = helm.requests.find((r) => r.namespace === memberNamespace(GUID, "erp", "prod"));
    expect(engine?.valuesObject).toMatchObject({ tenant: { appsImage: "acme-apps", appsImageTag: TEST_BUNDLE.appsImageTag } });
    helm.requests.length = 0;
    await validateTenant({ ...base, apps: [] }, deps(helm));
    expect(helm.requests[0]?.valuesObject).toMatchObject({ tenant: { appsImage: "", appsImageTag: "" } });
  });
});

describe("resolveBuildUnits — the bundle maps to the tenant's own repository", () => {
  it("never to a catalog buildRepos entry; an image no one builds stays unmapped", async () => {
    const r = await resolveBuildUnits({
      missing: [{ repo: "acme-apps", tag: PLACEHOLDER }, { repo: "example-nobody", tag: "1" }],
      buildRepos: [{ repo: "https://github.com/acme/example-platform.git", builds: ["example-engine"] }],
      bundle: { image: "acme-apps", repo: TEST_BUNDLE.appsRepo },
      registration: async () => null,
    });
    expect(r.units).toEqual([{ unit: "acme-apps", repoURL: TEST_BUNDLE.appsRepo, images: ["acme-apps"], registered: false }]);
    expect(r.unmapped).toEqual([{ repo: "example-nobody", tag: "1" }]);
  });
});

describe("create-tenant planStream — the bundle at its pin, or as a build unit of its own repository", () => {
  it("a built bundle: its image at its tag is a required image, no build unit, the tag frozen into params", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: withBundle(TEST_BUNDLE.appsImageTag) } });
    const result = await makeCreateTenantDef(ports({ helm })).planStream!(REQUEST, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(result.params.requiredImages).toContainEqual({ repo: "acme-apps", tag: TEST_BUNDLE.appsImageTag });
    expect(result.params.buildUnits).toEqual([]);
    expect(result.params).toMatchObject(TEST_BUNDLE);
    expect(result.params.syncUnits).toContain("acme-apps"); // the bundle's own release pipeline may sync this tenant
  });
  it("a bundle never built: rendered at the platform's placeholder tag, so its repository becomes a build unit and no tag is frozen", async () => {
    seedClusters();
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: withBundle(PLACEHOLDER) } });
    const probe = new FakeRegistryProbe({ missing: [`acme-apps:${PLACEHOLDER}`] });
    const { appsImageTag: _t, ...unbuilt } = REQUEST;
    const result = await makeCreateTenantDef(ports({ helm, registryProbe: probe, buildUnitRegistration: async (u) => (u === "acme-apps" ? { form: "build-only", repoCredentialId: "cred_apps" } : null) })).planStream!(unbuilt, planCtx());
    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") return;
    expect(helm.requests.find((r) => r.namespace === memberNamespace(result.params.guid, "erp", "prod"))?.valuesObject).toMatchObject({ tenant: { appsImage: "acme-apps", appsImageTag: PLACEHOLDER } });
    expect(result.params.buildUnits).toEqual([BUNDLE_UNIT]);
    expect(result.params.appsImageTag).toBeUndefined();
    expect(result.plan.steps.map((s) => s.name)).toContain(buildUnitStepName("acme-apps"));
  });
  it("a bundle without the placeholder in the chain is refused by name", async () => {
    seedClusters();
    const { appsImageTag: _t, ...unbuilt } = REQUEST;
    const prt = ports({ resolveClusterValueFiles: async () => [{ path: clusterMapPath("m1.example"), content: `global:\n  unitApex: example.com\n  endpoints:\n    registry:\n      host: ${HOST}\n` }] });
    await expect(makeCreateTenantDef(prt).planStream!(unbuilt, planCtx())).rejects.toThrow(/global\.placeholderTag/);
  });
});

describe("buildUnitStep — the bundle's tag is read off its release run", () => {
  const onboard = (imageTag?: string) => {
    const buildPlane = new FakeBuildPlane();
    // The version the step resolves off a repository with no release tag yet is 0.1.0 (release-version.ts).
    buildPlane.seedReleaseRun("acme-apps", { runName: "acme-apps-release-1", releaseTag: "0.1.0-stable-20260202000000", succeeded: true, ...(imageTag ? { imageTag } : {}) });
    return onboardPorts({ repo: new FakeRepoReader({ resolvedSha: SHA, files: { "deploy/platform.yaml": BUNDLE_MANIFEST_YAML } }), buildPlane });
  };
  it("records the image-tag result of the PipelineRun for the steps after it", async () => {
    seedClusters();
    const runtime: TenantBuildRuntime = {};
    const logs: string[] = [];
    await buildUnitStep(() => ({ ports: onboard(BUILT_TAG) }), { guid: GUID, owner: "team-acme", stage: "prod", appsImage: "acme-apps" }, BUNDLE_UNIT, runtime).run(ctx(params(), logs));
    expect(runtime.appsImageTag).toBe(BUILT_TAG);
    expect(logs.some((l) => l.includes(`acme-apps:${BUILT_TAG}`))).toBe(true);
  });
  it("refuses a run that states no image-tag result — the old tag never stands in for a build that just happened", async () => {
    seedClusters();
    const runtime: TenantBuildRuntime = {};
    await expect(buildUnitStep(() => ({ ports: onboard() }), { guid: GUID, owner: "team-acme", stage: "prod", appsImage: "acme-apps" }, BUNDLE_UNIT, runtime).run(ctx(params(), []))).rejects.toThrow(/states no image-tag result/);
    expect(runtime.appsImageTag).toBeUndefined();
  });
  it("leaves the runtime alone for a unit that does not build the bundle", async () => {
    seedClusters();
    const runtime: TenantBuildRuntime = {};
    await buildUnitStep(() => ({ ports: onboard(BUILT_TAG) }), { guid: GUID, owner: "team-acme", stage: "prod", appsImage: "other-apps" }, BUNDLE_UNIT, runtime).run(ctx(params(), []));
    expect(runtime.appsImageTag).toBeUndefined();
  });
});

describe("refreshImagesStep — the fan-out rendered again with the tag the build read", () => {
  it("delivers the runtime's tag over the request's, and the re-read set carries the bundle at it", async () => {
    const runtime: TenantBuildRuntime = { appsImageTag: BUILT_TAG };
    const helm = new FakeHelmRenderer({ fallback: { ok: true, docs: withBundle(BUILT_TAG) } });
    const p = params({ ...TEST_BUNDLE, requiredImages: [{ repo: "acme-apps", tag: PLACEHOLDER }] });
    await refreshImagesStep(ports({ helm }), { guid: GUID, domain: "s1.example", stage: "prod", subdomain: "acme", apps: APPS, seedUsers: false, registryHost: HOST, requiredImages: p.requiredImages, appsImage: p.appsImage, appsImageTag: p.appsImageTag }, runtime).run(ctx(p, []));
    expect(helm.requests[0]?.valuesObject).toMatchObject({ tenant: { appsImage: "acme-apps", appsImageTag: BUILT_TAG } });
    expect(runtime.requiredImages).toContainEqual({ repo: "acme-apps", tag: BUILT_TAG });
  });
});

describe("write-registration — the registration carries the bundle, or the empty pair", () => {
  const read = async (prt: TenantOnboardPorts) => (await prt.registrations.readTenant("prod", GUID))?.entry;
  it("carries appsRepo, appsImage and the tag the build read, over the one the request carried", async () => {
    const prt = ports();
    await writeRegistrationStep(prt, params(TEST_BUNDLE), { appsImageTag: BUILT_TAG }).run(ctx(params(), []));
    expect(await read(prt)).toMatchObject({ ...TEST_BUNDLE, appsImageTag: BUILT_TAG });
  });
  it("a tenant without a bundle carries the empty pair and no repository — both keys stand for the appset's bare read", async () => {
    const prt = ports();
    await writeRegistrationStep(prt, params({ apps: [], members: testMembers([]), expectedApps: tenantApplicationSet(TEST_MEMBERS, GUID, "prod") }), {}).run(ctx(params(), []));
    const entry = await read(prt);
    expect(entry?.appsImage).toBe("");
    expect(entry?.appsImageTag).toBe("");
    expect(entry?.appsRepo).toBeUndefined();
  });
  it("refuses to name an image without a tag — the bundle was not built in this run and the request carried none", async () => {
    const { appsImageTag: _t, ...unbuilt } = TEST_BUNDLE;
    await expect(writeRegistrationStep(ports(), params(unbuilt), {}).run(ctx(params(), []))).rejects.toThrow(/has no image tag/);
  });
});
