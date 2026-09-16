// tenant-apps-repo (hostyour-manager#177): the plan's refusals, the tree written from a fake template
// into a fake writer, its idempotency, the build-only chain driven with the App's token, and the
// registration carrying repo and image afterwards.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parse as parseYaml } from "yaml";
import { seedQuota } from "../../../shared/unit-size.ts";
import { TenantRegistrationSchema } from "../../../shared/tenant.ts";
import { ConsumerManifestSchema } from "../../../shared/consumer.ts";
import { parseAppsManifest } from "../../../shared/apps-manifest.ts";
import { openDb, type DbHandle } from "../../db/client.ts";
import { servers, clusters } from "../../db/schema/inventory.ts";
import { makeTenantAppsRepoDef, type TenantAppsRepoParams } from "./tenant-apps-repo.run.ts";
import { mergeAppsManifest, tenantAppsRepoURL, tenantAppsUnit } from "./tenant-apps-tree.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { TenantRegistrations } from "./tenant-registrations.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { ports as onboardPorts, type FakeSeeder } from "./onboard.fixture.ts";
import { testMembers } from "./tenant-members.fixture.ts";
import { FakeRepoReader, FakePlatformRepo, FakeConsumerRepo } from "../../adapters/git/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeHelmRenderer } from "../../adapters/helm/testing/fake.ts";
import { FakeMasterArgoReader, FakeClusterReader, FakeMasterProjectWriter, FakeClusterKubeResolver, FakeBuildRbacWriter } from "../../adapters/kube/testing/fake.ts";
import { FakeRegistryProbe } from "../../adapters/registry/testing/fake.ts";
import { FakeDnsProvider } from "../../adapters/dns/testing/fake.ts";
import { FakeBuildPlane } from "../../adapters/build-plane/testing/fake.ts";
import type { Step, StepCtx, PlanStreamCtx } from "../../executor/types.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultSeeder } from "../../adapters/vault/seeder-port.ts";

const SHA = "a".repeat(40);
const GUID = "zsjs023ctne0";
const ORG = "acme-org";
const SUBDOMAIN = "acme";
const UNIT = tenantAppsUnit(SUBDOMAIN); // acme-apps
const TENANT_URL = tenantAppsRepoURL(ORG, SUBDOMAIN);
const CATALOG_URL = "https://github.com/acme/acme-catalog.git";
const TEMPLATE_URL = `https://github.com/${ORG}/example-apps.git`;
const TEMPLATE_CREDENTIAL = "cred_template";

const catalogManifest = (over: { appsOrg?: string; appsBundle?: string } = { appsOrg: ORG, appsBundle: "example-apps" }): string => `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: acme-catalog
owner: platform
envs: [dev, prod]
tenant:
  ${over.appsOrg ? `appsOrg: ${over.appsOrg}` : ""}
  ${over.appsBundle ? `appsBundle: ${over.appsBundle}` : ""}
  buildRepos:
    - repo: ${TEMPLATE_URL}
      builds: [example-apps]
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui }
`;

const TEMPLATE_APPS_YAML = `# The app catalog of this bundle.
apps:
  - name: erp
    title: ERP
    description: >-
      Enterprise resource planning,
      split per domain.
    selections:
      seedReference: { title: "Reference data", default: true }
    databases: [core, sales]
  - name: web
    title: Website content
    selections:
      seedDemo: { title: "Demo data", default: false }
`;
const TEMPLATE_MANIFEST = `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: example-apps
owner: platform
envs: [dev, test, prod]
builds:
  - name: example-apps
    containerfile: docker/Dockerfile
`;
/** The template as the reader lists it: root files, the kit (never copied), two app folders. */
const TEMPLATE_FILES: Record<string, string> = {
  "apps.yaml": TEMPLATE_APPS_YAML,
  "deploy/platform.yaml": TEMPLATE_MANIFEST,
  "package.json": '{ "name": "example-apps" }\n',
  ".dockerignore": ".git\n",
  "docker/Dockerfile": "FROM busybox\n",
  ".github/CODEOWNERS": "* @acme\n",
  ".github/workflows/release.yml": "name: an old kit\n",
  "release/release.sh": "#!/bin/sh\necho old kit\n",
  "erp/package.json": '{ "name": "erp" }\n',
  "erp/seeds/roles.json": "[]\n",
  "web/site.json": "{}\n",
};

let db: DbHandle;
beforeEach(() => {
  db = openDb(":memory:");
  db.db.insert(servers).values({ id: "srv_m", name: "m1", host: "5.6.7.8", sshUser: "root", role: "master", status: "healthy" }).run();
  db.db.insert(clusters).values({ id: "cls_m", serverId: "srv_m", stage: "prod", domain: "m1.example", status: "active" }).run();
});
afterEach(() => { db.sqlite.close(); });

function fakeTenantSeeder(): VaultSeeder {
  const no = () => Promise.reject(new Error("a tenant-apps-repo run never seeds through the tenant seeder"));
  return { seed: no, seedPostgres: no, seedMongodb: no, seedBuildRepoPat: no, deleteBuildRepoPat: async () => {}, deleteApp: async () => {}, deletePostgres: async () => {}, deleteMongodb: async () => {}, seedTenantCrypto: async () => ({ created: true }), deleteTenantCrypto: async () => {} };
}

interface Harness {
  ports: TenantOnboardPorts;
  githubApp: FakeGitHubApp;
  /** The consumer family's reader: serves the registered template, and the tenant's repository once a test scripts it. */
  unitReader: FakeRepoReader;
  consumerRepo: FakeConsumerRepo;
  github: FakeGitHubConsumer;
  seeder: FakeSeeder;
  buildPlane: FakeBuildPlane;
}

function harness(over: { catalog?: string; ports?: Partial<TenantOnboardPorts>; noApp?: boolean } = {}): Harness {
  const githubApp = new FakeGitHubApp();
  githubApp.org = ORG;
  const unitReader = new FakeRepoReader({ resolvedSha: SHA, files: TEMPLATE_FILES });
  const consumerRepo = new FakeConsumerRepo();
  const github = new FakeGitHubConsumer();
  const buildPlane = new FakeBuildPlane();
  buildPlane.seedReleaseRun(UNIT, { runName: `${UNIT}-release-1`, releaseTag: "0.1.0-stable-20260101000000", succeeded: true });
  const onboard = onboardPorts({ repo: unitReader, consumerRepo, github, buildPlane });
  const ports: TenantOnboardPorts = {
    seeder: fakeTenantSeeder(),
    repo: new FakeRepoReader({ resolvedSha: SHA, files: { [TENANT_MANIFEST_PATH]: over.catalog ?? catalogManifest() } }),
    helm: new FakeHelmRenderer({ fallback: { ok: true, docs: [] } }),
    registrations: new TenantRegistrations(new FakePlatformRepo()),
    resolver: new FakeClusterKubeResolver({
      clusterReader: new FakeClusterReader({ deployState: { domain: "m1.example", stage: "prod", writtenAt: "2026-01-01T00:00:00Z", generation: 3 } }),
      argoReader: new FakeMasterArgoReader({}), projectWriter: new FakeMasterProjectWriter(), argoNamespace: "argocd",
    }),
    catalogRepoUrl: CATALOG_URL,
    platformRepoURL: "https://github.com/simetrixch/hostyour-cloud.git",
    catalogCredentialId: "catalog-read-pat",
    argoWatchTimeoutMs: 1000,
    resolveUnitApex: async () => "example.com",
    resolveClusterValueFiles: async () => [],
    registryProbe: new FakeRegistryProbe(),
    dns: new FakeDnsProvider(),
    buildRbac: new FakeBuildRbacWriter(),
    attestedBuilds: async () => [],
    consumerHostLabels: async () => [],
    onboard: () => ({ ports: onboard }),
    // The template is a registered build unit with a stored credential — read as itself.
    buildUnitRegistration: async (unit) => (unit === "example-apps" ? { form: "build-only", repoCredentialId: TEMPLATE_CREDENTIAL } : null),
    ...(over.noApp ? {} : { githubApp }),
    ...over.ports,
  };
  return { ports, githubApp, unitReader, consumerRepo, github, seeder: onboard.seeder as FakeSeeder, buildPlane };
}

/** A credential store that keeps what it sealed, so the chain's opens read the App's token back. */
function fakeCreds(): { store: CredentialStore; seals: { id: string; kind: string; label: string; plaintext: string }[] } {
  const seals: { id: string; kind: string; label: string; plaintext: string }[] = [];
  const store = {
    seal: async (i: { kind: string; label: string; plaintext: Buffer; fingerprint: string }) => {
      const id = `cred_${seals.length + 1}`;
      seals.push({ id, kind: i.kind, label: i.label, plaintext: i.plaintext.toString("utf8") });
      return { id, kind: i.kind, label: i.label, fingerprint: i.fingerprint };
    },
    open: async (id: string) => {
      const s = seals.find((x) => x.id === id);
      if (!s) throw new Error(`unknown credential ${id}`);
      return Buffer.from(s.plaintext, "utf8");
    },
  };
  return { store: store as unknown as CredentialStore, seals };
}

function ctx(p: Record<string, unknown>, logs: string[], creds: CredentialStore): StepCtx {
  return {
    runId: "run_apps", stepName: "s", db: db.db, creds, params: p,
    secrets: { get: () => undefined, wipe: () => undefined },
    signal: new AbortController().signal, logger: {} as unknown as Logger,
    ssh: () => Promise.reject(new Error("no ssh")), openPasswordSession: () => Promise.reject(new Error("no ssh")),
    closePasswordSession: () => undefined, attest: () => Promise.reject(new Error("no attest")),
    log: (_s, t) => logs.push(t), checkpoint: () => undefined, readCheckpoint: () => undefined, registerCleanup: () => undefined,
  };
}
function planCtx(logs: string[] = []): PlanStreamCtx {
  return { db: db.db, log: (l) => logs.push(l), signal: new AbortController().signal };
}
const REQUEST = { subdomain: SUBDOMAIN, guid: GUID, stage: "prod", apps: [{ name: "erp", selections: { seedReference: true } }] };

async function plan(h: Harness, request: Record<string, unknown> = REQUEST) {
  return makeTenantAppsRepoDef(h.ports).planStream!(request, planCtx());
}
async function planned(h: Harness, request: Record<string, unknown> = REQUEST): Promise<TenantAppsRepoParams> {
  const r = await plan(h, request);
  if (r.outcome !== "planned") throw new Error(r.summary);
  return r.params;
}
/** One execute() pass: the executor builds the step list ONCE and the steps share its memory. */
function pass(h: Harness, p: TenantAppsRepoParams): (name: string) => Step {
  const steps = makeTenantAppsRepoDef(h.ports).steps(p);
  return (name) => {
    const s = steps.find((x) => x.name === name);
    if (!s) throw new Error(`no step ${name}`);
    return s;
  };
}
function step(h: Harness, p: TenantAppsRepoParams, name: string) {
  return pass(h, p)(name);
}

describe("tenant-apps-repo planStream — the refusals, each a sentence", () => {
  it("refuses without the GitHub App, naming the three config keys", async () => {
    const r = await plan(harness({ noApp: true }));
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    for (const key of ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"]) expect(r.summary).toContain(key);
  });
  it("refuses a catalog that names no apps bundle — there is no template", async () => {
    const r = await plan(harness({ catalog: catalogManifest({ appsOrg: ORG }) }));
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.summary).toMatch(/declares no tenant\.appsBundle/);
  });
  it("refuses an app the template's apps.yaml does not offer, naming what it offers", async () => {
    const r = await plan(harness(), { ...REQUEST, apps: [{ name: "erp" }, { name: "crm" }] });
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.summary).toMatch(/crm is not in the template's apps\.yaml \(it offers erp, web\)/);
  });
  it("refuses a catalog whose appsOrg is not the organisation the App is installed in", async () => {
    const h = harness();
    h.githubApp.org = "other-org";
    const r = await plan(h);
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.summary).toMatch(/tenant\.appsOrg is "acme-org" and the GitHub App is installed in "other-org"/);
  });
  it("refuses a unit registered as deployable under the tenant's apps name", async () => {
    const h = harness({ ports: { buildUnitRegistration: async (unit) => (unit === UNIT ? { form: "deployable" } : { form: "build-only", repoCredentialId: TEMPLATE_CREDENTIAL }) } });
    const r = await plan(h);
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.summary).toMatch(/registered as DEPLOYABLE/);
  });
});

describe("tenant-apps-repo planStream — the plan", () => {
  it("freezes the organisation, the template and the master, and reads the template as the registered unit", async () => {
    const h = harness();
    const r = await plan(h);
    expect(r.outcome).toBe("planned");
    if (r.outcome !== "planned") return;
    expect(r.params).toMatchObject({ subdomain: SUBDOMAIN, guid: GUID, stage: "prod", apps: ["erp"], owner: SUBDOMAIN, org: ORG, templateRepoURL: TEMPLATE_URL, templateBuild: "example-apps", registered: false, clusterId: "cls_m", domain: "m1.example" });
    expect(r.plan.steps.map((s) => s.name)).toEqual(["attest-target", "create-repository", "write-tree", "onboard-build-only", "record-apps-repo"]);
    expect(r.plan.requiredSecrets).toEqual([]);
    expect(r.plan.targetId).toBe("cls_m");
    expect(r.plan.summary).toContain(`${ORG}/${UNIT}`);
    // The template was cloned through the consumer family's reader with the credential its registration stores.
    expect(h.unitReader.clones).toEqual([{ repoURL: TEMPLATE_URL, ref: "HEAD", credentialId: TEMPLATE_CREDENTIAL }]);
  });
  it("marks a unit already registered build-only, so its release is re-run", async () => {
    const h = harness({ ports: { buildUnitRegistration: async () => ({ form: "build-only", repoCredentialId: "cred_any" }) } });
    const p = await planned(h);
    expect(p.registered).toBe(true);
  });
});

describe("write-tree — the tree from the template into the tenant's repository", () => {
  it("copies the root files and the chosen app folder, skips the kit and the unchosen apps, writes the manifest and the apps.yaml, in one commit", async () => {
    const h = harness();
    const p = await planned(h);
    const creds = fakeCreds();
    const logs: string[] = [];
    await step(h, p, "write-tree").run(ctx(p, logs, creds.store));
    const files = h.consumerRepo.filesFor(TENANT_URL);
    expect(Object.keys(files).sort()).toEqual([".dockerignore", ".github/CODEOWNERS", "apps.yaml", "deploy/platform.yaml", "docker/Dockerfile", "erp/package.json", "erp/seeds/roles.json", "package.json"]);
    expect(files["package.json"]).toBe(TEMPLATE_FILES["package.json"]);
    // The manifest: a build-only unit named after the tenant, one build, the template's envs and containerfile.
    const manifest = ConsumerManifestSchema.parse(parseYaml(files["deploy/platform.yaml"]!));
    expect(manifest).toMatchObject({ name: UNIT, owner: SUBDOMAIN, envs: ["dev", "test", "prod"], builds: [{ name: UNIT, containerfile: "docker/Dockerfile" }] });
    expect(manifest.chart).toBeUndefined();
    // apps.yaml: only the chosen entry, as the template spells it, under the template's header.
    const apps = parseAppsManifest(files["apps.yaml"]!);
    expect(apps.apps.map((a) => a.name)).toEqual(["erp"]);
    expect(apps.apps[0]).toEqual(parseAppsManifest(TEMPLATE_APPS_YAML).apps[0]);
    expect(files["apps.yaml"]).toContain("# The app catalog of this bundle.");
    expect(h.consumerRepo.commits).toHaveLength(1);
    expect(h.consumerRepo.commits[0]).toMatchObject({ repoURL: TENANT_URL, branch: "main", message: `Create ${UNIT} from the catalog` });
    expect(h.consumerRepo.commits[0]!.remove).toBeUndefined();
    // The writer opened the repository with the App's installation token, sealed as a PAT of the unit.
    expect(creds.seals).toEqual([{ id: "cred_1", kind: "pat", label: `GitHub App installation token (${UNIT})`, plaintext: h.githubApp.token }]);
    expect(h.consumerRepo.opened).toEqual([{ repoURL: TENANT_URL, credentialId: "cred_1" }]);
    expect(logs.some((l) => l.includes(`8 file(s) committed to ${TENANT_URL}`))).toBe(true);
  });
  it("a second run adds the missing app folder and entry, deletes nothing, overwrites nothing, and commits nothing when nothing changed", async () => {
    const h = harness();
    const creds = fakeCreds();
    await step(h, await planned(h), "write-tree").run(ctx({}, [], creds.store));
    // The tenant edited a root file in the meantime: it stays theirs.
    h.consumerRepo.seed(TENANT_URL, "package.json", '{ "name": "acme-apps", "edited": true }\n');
    const p2 = await planned(h, { ...REQUEST, apps: [{ name: "erp" }, { name: "web" }] });
    await step(h, p2, "write-tree").run(ctx(p2, [], creds.store));
    const files = h.consumerRepo.filesFor(TENANT_URL);
    expect(files["web/site.json"]).toBe("{}\n");
    expect(files["erp/package.json"]).toBe(TEMPLATE_FILES["erp/package.json"]);
    expect(files["package.json"]).toBe('{ "name": "acme-apps", "edited": true }\n');
    expect(parseAppsManifest(files["apps.yaml"]!).apps.map((a) => a.name)).toEqual(["erp", "web"]);
    expect(h.consumerRepo.commits).toHaveLength(2);
    expect(h.consumerRepo.commits[1]).toMatchObject({ message: `Add web to ${UNIT} from the catalog`, write: [{ path: "web/site.json", content: "{}\n" }, { path: "apps.yaml", content: files["apps.yaml"] }] });
    expect(h.consumerRepo.commits[1]!.remove).toBeUndefined();
    // Nothing changed: no commit at all.
    const logs: string[] = [];
    await step(h, p2, "write-tree").run(ctx(p2, logs, creds.store));
    expect(h.consumerRepo.commits).toHaveLength(2);
    expect(logs.some((l) => l.includes("nothing to commit"))).toBe(true);
  });
  it("refuses without the consumer repository writer, naming the wiring", async () => {
    const h = harness();
    const p = await planned(h);
    h.ports.onboard = () => undefined;
    await expect(step(h, p, "write-tree").run(ctx(p, [], fakeCreds().store))).rejects.toThrow(/consumer onboarding is not wired/);
  });
});

describe("mergeAppsManifest — never removes", () => {
  it("keeps an entry the tenant added by hand beside the chosen ones", () => {
    const current = "apps:\n  - name: custom\n    title: Theirs\n";
    const { content, added } = mergeAppsManifest(TEMPLATE_APPS_YAML, current, ["erp"]);
    expect(added).toEqual(["erp"]);
    expect(parseAppsManifest(content).apps.map((a) => a.name)).toEqual(["custom", "erp"]);
    expect(mergeAppsManifest(TEMPLATE_APPS_YAML, content, ["erp"]).added).toEqual([]);
  });
});

describe("create-repository and onboard-build-only — the App's token as the unit's credential", () => {
  it("creates the private repository once, then finds it standing", async () => {
    const h = harness();
    const p = await planned(h);
    const logs: string[] = [];
    await step(h, p, "create-repository").run(ctx(p, logs, fakeCreds().store));
    expect(h.githubApp.created).toEqual([{ org: ORG, name: UNIT, description: expect.stringContaining("example-apps"), private: true, signal: expect.anything() }]);
    await step(h, p, "create-repository").run(ctx(p, logs, fakeCreds().store));
    expect(h.githubApp.created).toHaveLength(1);
    expect(logs.at(-1)).toContain("already stands");
  });
  it("registers the unit build-only with the sealed App token, seeds that token as the build repo-pat, dispatches with it and watches the build", async () => {
    const h = harness();
    const p = await planned(h);
    const creds = fakeCreds();
    const logs: string[] = [];
    const run = pass(h, p);
    await run("write-tree").run(ctx(p, logs, creds.store));
    // The tenant repository as the chain reads it back: the manifest write-tree just committed.
    h.unitReader.scriptFor(TENANT_URL, { resolvedSha: SHA, files: { "deploy/platform.yaml": h.consumerRepo.filesFor(TENANT_URL)["deploy/platform.yaml"]! } });
    await run("onboard-build-only").run(ctx(p, logs, creds.store));
    const onboard = h.ports.onboard!()!.ports;
    const registration = await onboard.registrations.readBuildRegistration(UNIT);
    expect(registration?.entry).toMatchObject({ name: UNIT, repoURL: TENANT_URL, repoCredentialId: "cred_1", owner: SUBDOMAIN, builds: [UNIT] });
    expect(h.seeder.buildRepoPats).toEqual([{ consumerName: UNIT, pat: h.githubApp.token }]);
    expect(h.github.dispatches.map((d) => ({ repo: d.repo, token: d.token, inputs: d.inputs }))).toEqual([{ repo: UNIT, token: h.githubApp.token, inputs: { version: "0.1.0", channel: "stable", stage: "prod" } }]);
    expect(h.buildPlane.releaseWatches).toEqual([{ unit: UNIT, version: "0.1.0", channel: "stable" }]);
    // The token was sealed ONCE for the whole pass, and the PAT scope preflight was not run on it.
    expect(creds.seals).toHaveLength(1);
    expect(logs.some((l) => l.includes("Pre-flight"))).toBe(false);
    expect(logs.at(-1)).toContain(`${UNIT} built and pinned for prod`);
  });
  it("re-runs the release of a unit already registered build-only instead of registering it again", async () => {
    const h = harness({ ports: { buildUnitRegistration: async (unit) => (unit === UNIT ? { form: "build-only", repoCredentialId: "cred_old" } : { form: "build-only", repoCredentialId: TEMPLATE_CREDENTIAL }) } });
    const p = await planned(h);
    h.unitReader.scriptFor(TENANT_URL, { resolvedSha: SHA, files: { "deploy/platform.yaml": TEMPLATE_MANIFEST.replace(/example-apps/g, UNIT) } });
    const creds = fakeCreds();
    await step(h, p, "onboard-build-only").run(ctx(p, [], creds.store));
    expect(await h.ports.onboard!()!.ports.registrations.readBuildRegistration(UNIT)).toBeNull();
    expect(h.buildPlane.releaseWatches).toEqual([{ unit: UNIT, version: "0.1.0", channel: "stable" }]);
    expect(h.github.dispatches[0]?.token).toBe(h.githubApp.token); // a fresh token, never the stored one
  });
});

describe("record-apps-repo — the registration carries repo and image", () => {
  const registration = () => TenantRegistrationSchema.parse({
    cluster: "s1", subdomain: SUBDOMAIN, apps: [{ name: "erp" }], members: testMembers(["erp"]), identityProvider: "auth",
    quota: seedQuota("small"), seedUsers: false, resetNonce: "1", suspended: false, quiesced: false,
  });
  it("writes appsRepo and appsImage onto a standing registration, and leaves it alone the second time", async () => {
    const h = harness();
    const p = await planned(h);
    await h.ports.registrations.commitTenant({ stage: "prod", guid: GUID, registration: registration(), runId: "run_0" });
    const logs: string[] = [];
    await step(h, p, "record-apps-repo").run(ctx(p, logs, fakeCreds().store));
    const after = await h.ports.registrations.readTenant("prod", GUID);
    expect(after?.entry).toMatchObject({ appsRepo: TENANT_URL, appsImage: UNIT, apps: [{ name: "erp" }] });
    await step(h, p, "record-apps-repo").run(ctx(p, logs, fakeCreds().store));
    expect(logs.at(-1)).toContain("nothing to commit");
  });
  it("says so when the tenant has no registration yet, and writes nothing", async () => {
    const h = harness();
    const p = await planned(h);
    const logs: string[] = [];
    await step(h, p, "record-apps-repo").run(ctx(p, logs, fakeCreds().store));
    expect(logs.at(-1)).toMatch(/no registration at prod yet/);
    expect(await h.ports.registrations.readTenant("prod", GUID)).toBeNull();
  });
});
