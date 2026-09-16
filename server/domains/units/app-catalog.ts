// The tenant APP CATALOG — what the create-tenant wizard offers and what gate T4 judges the chosen
// apps and their selections against. The catalog is the apps manifest (shared/apps-manifest.ts) of
// the APPS TEMPLATE: the repository `tenant.appsRepo` names, read at its default branch with the
// catalog's own credential. Titles, descriptions and selections come from that file; the platform
// carries no list of apps and no list of selections. The template is the repository a tenant's own
// apps repository is copied from, never a unit: the platform does not build it and no tenant mounts
// it, so nothing here reaches for a registration or a unit's credential. readAppsManifest is the
// primitive: one apps repository, one credential. A STANDING tenant's own catalog is its own
// bundle's apps.yaml, read through the same primitive by readTenantAppsManifest with a credential
// minted from the GitHub App at the moment of the read, because the App is installed in the
// organisation the tenant repositories live in and a token stored at the onboarding has expired.
//
// WHERE NO MANIFEST STANDS — the catalog declares no template, or the template carries no apps.yaml
// yet — the catalog is what it was before the manifest existed: the engine chart's
// `values-<app>.yaml` overlays, one app per overlay, with the two seed selections the registration
// names as fields (SEED_SELECTIONS). That stand-in is logged as one every time it is served, so an
// installation running on it can see that it is.
//
// Boundary: a domain module. It depends on the git RepoReader PORT, on shared/ and on nothing that
// does IO of its own; the clone/read/dispose is the port's job. fallbackCatalog is pure.
import type { RepoReader } from "../../adapters/git/port.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { CredentialStore } from "../../security/store.ts";
import { fingerprintSecret } from "../../security/fingerprint.ts";
import { parse as parseYaml } from "yaml";
import { appName } from "../../../shared/tenant.ts";
import { SEED_SELECTIONS } from "../../../shared/app-selections.ts";
import { APPS_MANIFEST_PATH, parseAppsManifest, type AppEntry, type AppsManifest } from "../../../shared/apps-manifest.ts";
import { ConsumerManifestSchema, tenantAppsTemplate, type TenantSpec } from "../../../shared/consumer.ts";
import { errValidation } from "../../kernel/errors.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { DEFAULT_BRANCH_HEAD } from "./onboard-check.ts";

/** values-<name>.yaml file-name shape; the capture group is the candidate app. The bare values.yaml
 *  (no `-<name>` suffix) never matches, so the chart base is excluded for free. */
const VALUES_OVERLAY_RE = /^values-(.+)\.yaml$/;

/** Overlay names that are NOT apps: the per-stage overlays every chart layers plus the shared
 *  `common` overlay. */
export const RESERVED_OVERLAY_NAMES = new Set<string>(["dev", "test", "prod", "common"]);

/** The two selections the stand-in offers for every app — the ones the registration carries as
 *  fields and the engine reads (shared/tenant.ts SEED_SELECTIONS). Titles here are the platform's
 *  words, because no manifest supplied the product's. */
const FALLBACK_SELECTIONS: AppEntry["selections"] = {
  [SEED_SELECTIONS[0]]: { title: "Reference data (roles, navigation)", default: false },
  [SEED_SELECTIONS[1]]: { title: "Demo data (sample records)", default: false },
};

/** PURE: the stand-in catalog out of an engine-chart directory listing. Keep only values-<name>.yaml
 *  overlays; drop the stage/common overlays; keep only names the appName schema accepts; de-dupe +
 *  sort for a stable picker order. The title is the name, because nothing else is known. */
export function fallbackCatalog(entries: string[]): AppsManifest {
  const names = new Set<string>();
  for (const entry of entries) {
    const name = VALUES_OVERLAY_RE.exec(entry)?.[1];
    if (name === undefined || RESERVED_OVERLAY_NAMES.has(name) || !appName.safeParse(name).success) continue;
    names.add(name);
  }
  return { apps: [...names].sort().map((name) => ({ name, title: name, description: "", selections: { ...FALLBACK_SELECTIONS } })) };
}

export interface ReadAppsManifestInput {
  repo: RepoReader;
  repoURL: string;
  /** The stored credential the clone opens; absent for a repository the reader reaches without one. */
  credentialId?: string;
  signal?: AbortSignal;
}

/** THE PRIMITIVE: the apps manifest of ONE apps repository, cloned at its default branch head with
 *  the credential given, or null where it carries no apps.yaml there. THROWS on a clone that fails
 *  and on an apps.yaml that does not parse; the throwaway checkout is always disposed. */
export async function readAppsManifest(input: ReadAppsManifestInput): Promise<AppsManifest | null> {
  const cloned = await input.repo.cloneAtRef({
    repoURL: input.repoURL,
    ref: DEFAULT_BRANCH_HEAD,
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  try {
    const text = await input.repo.readFile(cloned.workdir, APPS_MANIFEST_PATH);
    return text === null ? null : parseAppsManifest(text);
  } finally {
    await input.repo.dispose(cloned.workdir);
  }
}

export interface ReadTenantAppsManifestInput {
  /** The tenant's own apps repository — `appsRepo` off its registration (shared/tenant.ts). */
  appsRepo: string;
  /** A reader that opens a SEALED credential by id (wire-units.ts: the tenant family's reader does,
   *  for every id but the catalog's own). */
  repo: RepoReader;
  githubApp: GitHubApp;
  creds: Pick<CredentialStore, "seal" | "purge">;
  signal?: AbortSignal;
}

/** The reader of ONE tenant's own catalog, closed over the reader, the App and the store where the
 *  ports are built: `tenant-add-app` judges against what it answers and the tenant page shows it. */
export type TenantAppsManifestReader = (appsRepo: string, signal?: AbortSignal) => Promise<AppsManifest | null>;

/** A standing tenant's OWN catalog: the apps.yaml of its bundle's repository, cloned at its default
 *  branch head with a credential minted from the App NOW and sealed for this one read — the id is
 *  purged in finally, so nothing of the token outlives the clone (a token stored at the onboarding
 *  has expired, hostyour-manager#184). null where the repository carries no apps.yaml; throws where
 *  the App refuses, the clone fails or the file does not parse. */
export async function readTenantAppsManifest(input: ReadTenantAppsManifestInput): Promise<AppsManifest | null> {
  const plaintext = Buffer.from(await input.githubApp.installationToken(input.signal), "utf8");
  const fingerprint = fingerprintSecret(plaintext); // before seal() zeroes the buffer
  const ref = await input.creds.seal({ kind: "pat", label: `GitHub App installation token (catalog read of ${input.appsRepo})`, plaintext, fingerprint });
  try {
    return await readAppsManifest({ repo: input.repo, repoURL: input.appsRepo, credentialId: ref.id, ...(input.signal ? { signal: input.signal } : {}) });
  } finally {
    await input.creds.purge(ref.id);
  }
}

export interface ReadAppCatalogInput {
  spec: TenantSpec;
  /** The catalog checkout already made (validateTenant's, or listTenantAppCatalog's) and the
   *  credential it was cloned with: the stand-in lists its engine chart, and the template is cloned
   *  with the same credential. That credential reaches the template only where the installation's
   *  catalog PAT was granted it; where it was not, the clone fails and the plan says so. */
  catalog: { repo: RepoReader; workdir: string; credentialId?: string };
  /** Where a stand-in is said: the run's log, or pino. */
  warn: (msg: string) => void;
  signal?: AbortSignal;
}

/** The catalog for ONE catalog checkout: the apps manifest of the template the spec names, else the
 *  overlay stand-in, each stand-in logged. THROWS on a clone that fails and on an apps.yaml that does
 *  not parse — the caller decides whether that is a preflight rejection (the gates) or a fail-soft
 *  fallback (the wizard route). */
export async function readAppCatalog(input: ReadAppCatalogInput): Promise<AppsManifest> {
  const { spec, catalog } = input;
  const standIn = async (why: string): Promise<AppsManifest> => {
    input.warn(`${why} — the app catalog is the ${spec.perApp.engine.chart}/values-<app>.yaml overlays, with the two seed selections and no titles`);
    return fallbackCatalog(await catalog.repo.listDir(catalog.workdir, spec.perApp.engine.chart));
  };
  const template = tenantAppsTemplate(spec);
  if (template === null) return standIn(`${TENANT_MANIFEST_PATH} declares no tenant.appsBundle`);
  const manifest = await readAppsManifest({
    repo: catalog.repo,
    repoURL: template.repo,
    ...(catalog.credentialId ? { credentialId: catalog.credentialId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return manifest ?? standIn(`the apps template ${template.repo} carries no ${APPS_MANIFEST_PATH} at its default branch`);
}

/** What a single catalog fetch needs: the same catalog ref + read credential validateTenant clones
 *  with. That ref is this installation's books branch in the catalog, which is where its member
 *  charts stand (tenant-registrations.ts, the `branch` getter), so the wizard offers the apps this
 *  installation can actually deploy and no others. */
export interface ListAppCatalogDeps {
  repo: RepoReader;
  repoURL: string;
  ref: string;
  credentialId?: string;
  warn: (msg: string) => void;
  signal?: AbortSignal;
}

/** Clone the catalog at ref (the SAME RepoReader validateTenant uses), read its fan-out manifest,
 *  and read the app catalog off it. THROWS on a clone/read failure — makeAppCatalogProvider turns
 *  that into the fail-soft fallback; the throwaway workdir is always disposed (finally). */
export async function listTenantAppCatalog(deps: ListAppCatalogDeps): Promise<AppsManifest> {
  const cloned = await deps.repo.cloneAtRef({
    repoURL: deps.repoURL,
    ref: deps.ref,
    ...(deps.credentialId ? { credentialId: deps.credentialId } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  try {
    const manifestText = await deps.repo.readFile(cloned.workdir, TENANT_MANIFEST_PATH);
    if (manifestText === null) throw errValidation(`${TENANT_MANIFEST_PATH} is absent on the tenant product's repo — the app catalog is read off the apps repository it names`);
    const manifest = ConsumerManifestSchema.parse(parseYaml(manifestText));
    if (!manifest.tenant) throw errValidation(`${TENANT_MANIFEST_PATH} declares no tenant fan-out — there is no apps repository to read the catalog from`);
    return readAppCatalog({
      spec: manifest.tenant,
      catalog: { repo: deps.repo, workdir: cloned.workdir, ...(deps.credentialId ? { credentialId: deps.credentialId } : {}) },
      warn: deps.warn,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } finally {
    await deps.repo.dispose(cloned.workdir);
  }
}

/** The route-facing catalog reader: list() returns the catalog, cached in memory with a short TTL so a
 *  wizard load is cheap (the manifest changes rarely — a clone-per-load would be wasteful), and FAIL-SOFT.
 *  Any clone/read error logs + serves the prior good cache when there is one, else no apps — the
 *  create-tenant wizard degrades to an "app catalog unavailable" note, never a blank screen, and
 *  onboarding with no apps still works. */
export interface AppCatalogProvider {
  list(signal?: AbortSignal): Promise<AppsManifest>;
}

/** Minimal structured-log sink (pino warn-shaped) so this domain module observes a failed fetch without
 *  importing the concrete Logger type. wire-units.ts binds it to logger.warn. */
export type CatalogWarn = (fields: Record<string, unknown>, msg: string) => void;

export interface AppCatalogProviderDeps {
  repo: RepoReader;
  repoURL: string;
  ref: string;
  credentialId?: string;
  warn: CatalogWarn;
  /** Cache freshness window; defaults to 5 min. */
  ttlMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const EMPTY: AppsManifest = { apps: [] };

export function makeAppCatalogProvider(deps: AppCatalogProviderDeps): AppCatalogProvider {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  let cache: { catalog: AppsManifest; at: number } | null = null;
  return {
    async list(signal?: AbortSignal): Promise<AppsManifest> {
      const t = now();
      if (cache && t - cache.at < ttlMs) return cache.catalog; // fresh — one clone per TTL window, not per load
      try {
        const catalog = await listTenantAppCatalog({
          repo: deps.repo,
          repoURL: deps.repoURL,
          ref: deps.ref,
          ...(deps.credentialId ? { credentialId: deps.credentialId } : {}),
          warn: (msg) => deps.warn({ repoURL: deps.repoURL, ref: deps.ref }, msg),
          ...(signal ? { signal } : {}),
        });
        cache = { catalog, at: t };
        return catalog;
      } catch (e) {
        // Fail-soft: serve the last good catalog (STALE) if we ever had one, else nothing. Re-cache
        // with a fresh timestamp so a persistent catalog outage does NOT re-clone on every wizard
        // load — the staleness/retry cadence is bounded by the same TTL.
        const catalog = cache?.catalog ?? EMPTY;
        cache = { catalog, at: t };
        deps.warn(
          { err: e instanceof Error ? e.message : String(e), repoURL: deps.repoURL, ref: deps.ref, servedStale: catalog.apps.length > 0 },
          "tenant app-catalog fetch failed — serving fallback",
        );
        return catalog;
      }
    },
  };
}
