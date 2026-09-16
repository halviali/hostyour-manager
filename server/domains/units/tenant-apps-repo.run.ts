import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { RunDefinition, Step, StepCtx, Plan, PlanStreamCtx } from "../../executor/types.ts";
import { STAGE } from "../../../shared/enums.ts";
import { appName, guid as guidSchema, subdomain as subdomainSchema } from "../../../shared/tenant.ts";
import { CONSUMER_MANIFEST_PATH, ConsumerManifestSchema, consumerName, tenantAppsTemplate, type ConsumerManifest, type TenantSpec } from "../../../shared/consumer.ts";
import { APPS_MANIFEST_PATH, parseAppsManifest } from "../../../shared/apps-manifest.ts";
import { AppError, errValidation } from "../../kernel/errors.ts";
import { fingerprintSecret } from "../../security/fingerprint.ts";
import type { GitHubApp } from "../../adapters/github-app/port.ts";
import type { TenantOnboardPorts } from "./create-tenant.run.ts";
import { assertDeployState } from "./lifecycle.ts";
import { resolveMasterCluster } from "./tenant-values.ts";
import { TENANT_MANIFEST_PATH } from "./gates/tenant-gates.ts";
import { DEFAULT_BRANCH_HEAD } from "./onboard-check.ts";
import { buildOnlySteps, type BuildOnlyOnboardParams } from "./onboard.run.ts";
import { readUngatedOnboard } from "./first-master.ts";
import { resolveNextVersion } from "./release-version.ts";
import { channelReaching } from "./tenant-builds.ts";
import { triggerReleaseStep, watchReleaseBuildStep, type ReleaseCycleRuntime } from "./onboard-release-cycle.ts";
import { recordBuildOnlyStep } from "./onboard-registration.ts";
import { tenantLocks } from "./tenant-lifecycle.run.ts";
import { mergeAppsManifest, readTemplateTree, tenantAppsManifest, tenantAppsRepoURL, tenantAppsUnit } from "./tenant-apps-tree.ts";

// The "tenant-apps-repo" Run (hostyour-manager#177): the tenant's OWN apps repository, created from
// the catalog's apps bundle with the apps the tenant chose, registered build-only and built once —
// so that create-tenant (or tenant-add-app on a standing tenant) mounts `<subdomain>-apps` instead
// of the catalog's shared bundle. Five steps: attest the build plane; create the private repository
// through the platform's GitHub App; write the tree from the template; run the consumer Build-only
// onboarding of the new unit with the App's installation token as the unit's credential; record
// `appsRepo`, `appsImage` and `appsImageTag` on the tenant's registration.
//
// IDEMPOTENT, by construction of each step: a repository that stands is found, not failed on; a
// second run adds the folders and entries the repository lacks and removes nothing, committing only
// when something changed; a unit already registered build-only has its release re-run rather than
// being onboarded again; a registration that already carries the three fields is left alone.
//
// mutating: true ⇒ steps()[0] MUST be attest-target (executor/guards.ts). The target is the master —
// the build plane the unit's `<unit>-build` namespace lives on — as it is for every build-only form.

const repoURL = z.string().regex(/^https:\/\/[^ ]+\.git$/);

/** What the wizard (or a hand-made request) sends. */
export const TenantAppsRepoRequest = z.object({
  subdomain: subdomainSchema,
  guid: guidSchema,
  stage: z.enum(STAGE),
  // The chosen apps. Only the NAMES shape the repository: a selection is the tenant's choice among
  // what an app offers and rides create-tenant, while the repository carries what the app offers
  // (its apps.yaml entry). Accepted here so one app list serves both runs.
  apps: z.array(z.object({ name: appName, selections: z.record(z.string(), z.boolean()).optional() })).min(1),
  // The manifest's owner: the tenant's owner where the caller knows it, else the subdomain.
  owner: z.string().min(1).optional(),
});
export type TenantAppsRepoRequest = z.infer<typeof TenantAppsRepoRequest>;

/** The frozen params: the request's identity fields plus what the plan resolved. */
export const TenantAppsRepoParams = z.object({
  subdomain: subdomainSchema,
  guid: guidSchema,
  stage: z.enum(STAGE),
  apps: z.array(appName).min(1),
  owner: z.string().min(1),
  // The organisation the App is installed in — the catalog's `tenant.appsOrg` where it names one,
  // held equal to the installation's at the plan. The repository is `<org>/<subdomain>-apps`.
  org: z.string().min(1),
  // The template: the catalog's `tenant.appsRepo` and `tenant.appsBundle` — the repository the tree
  // is copied from, and the entry of its manifest whose containerfile the tenant's own build takes.
  templateRepoURL: repoURL,
  templateBuild: z.string().regex(/^[a-z0-9-]+$/),
  // The unit already stands registered build-only on this installation (a second run): its release
  // is re-run through the registered chain instead of the whole onboarding.
  registered: z.boolean(),
  // The master — the build plane this run's build-only onboarding acts on (attest-target).
  clusterId: z.string().startsWith("cls_"),
  domain: z.string().min(1),
});
export type TenantAppsRepoParams = z.infer<typeof TenantAppsRepoParams>;

/** In-run memory of one execute() pass: the credential id the App's token was sealed under, and the
 *  image tag the bundle's release built (read off its PipelineRun, onboard-release-cycle.ts). A
 *  resumed pass seals afresh — the token sealed before has expired by then — and carries no tag,
 *  which record-apps-repo refuses rather than guessing one. */
interface AppsRepoRuntime {
  credentialId?: string;
  imageTag?: string;
}

function requireGitHubApp(ports: TenantOnboardPorts): GitHubApp {
  if (!ports.githubApp) throw errValidation("this Manager holds no GitHub App identity — set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY");
  return ports.githubApp;
}

/** The App's installation token, sealed under a credential id of the unit's own — the id the
 *  build-only chain opens the way it opens a consumer's PAT (tenant-builds.ts seals an approve-time
 *  PAT the same way). The value never reaches params, a log or a checkpoint.
 *
 *  ponytail: the token lives one hour. The build registration and the build Vault keep its id and
 *  its value past that, so the unit's NEXT release (from its Consumers page, or the tenant's next
 *  push) needs a fresh one; the upgrade path is opening the App at use time instead of a stored copy. */
async function sealAppToken(ctx: StepCtx, app: GitHubApp, unit: string, runtime: AppsRepoRuntime): Promise<string> {
  if (runtime.credentialId) return runtime.credentialId;
  const plaintext = Buffer.from(await app.installationToken(ctx.signal), "utf8");
  const fingerprint = fingerprintSecret(plaintext); // before seal() zeroes the buffer
  const ref = await ctx.creds.seal({ kind: "pat", label: `GitHub App installation token (${unit})`, plaintext, fingerprint });
  runtime.credentialId = ref.id;
  return ref.id;
}

/** The template's two files this run reads: its apps.yaml (which apps it offers) and its manifest
 *  (how its bundle is built). Cloned the way the catalog reads it (app-catalog.ts readAppsManifest):
 *  at its default branch head, with the catalog's own credential — the template is no unit and has
 *  no credential of its own. */
async function readTemplate(ports: TenantOnboardPorts, templateRepoURL: string, signal: AbortSignal): Promise<{ appsYaml: string; manifest: ConsumerManifest; folders: (app: string) => Promise<boolean>; tree: (chosen: readonly string[]) => Promise<{ path: string; content: string }[]>; dispose: () => Promise<void> }> {
  const repo = ports.repo;
  const cloned = await repo.cloneAtRef({ repoURL: templateRepoURL, ref: DEFAULT_BRANCH_HEAD, ...(ports.catalogCredentialId ? { credentialId: ports.catalogCredentialId } : {}), signal });
  try {
    const appsYaml = await repo.readFile(cloned.workdir, APPS_MANIFEST_PATH);
    if (appsYaml === null) throw errValidation(`${templateRepoURL} carries no ${APPS_MANIFEST_PATH} at its default branch — nothing says which apps the template offers`);
    const manifestText = await repo.readFile(cloned.workdir, CONSUMER_MANIFEST_PATH);
    if (manifestText === null) throw errValidation(`${templateRepoURL} carries no ${CONSUMER_MANIFEST_PATH} at its default branch — the tenant's manifest is composed from it`);
    const manifest = ConsumerManifestSchema.safeParse(parseYaml(manifestText));
    if (!manifest.success) throw errValidation(`${CONSUMER_MANIFEST_PATH} in ${templateRepoURL} is not a valid consumer manifest: ${manifest.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const templateApps = parseAppsManifest(appsYaml).apps.map((a) => a.name);
    return {
      appsYaml,
      manifest: manifest.data,
      folders: async (app) => (await repo.listDir(cloned.workdir, app)).length > 0,
      tree: (chosen) => readTemplateTree(repo, cloned.workdir, { templateApps, chosen }),
      dispose: () => repo.dispose(cloned.workdir),
    };
  } catch (e) {
    await repo.dispose(cloned.workdir);
    throw e;
  }
}

/** The catalog's tenant spec off this installation's books branch — where `appsOrg`, `appsBundle`
 *  and `appsRepo` are stated (the same clone validateTenant makes). */
async function readTenantSpec(ports: TenantOnboardPorts, ctx: PlanStreamCtx): Promise<TenantSpec | null> {
  const cloned = await ports.repo.cloneAtRef({ repoURL: ports.catalogRepoUrl, ref: ports.registrations.branch, ...(ports.catalogCredentialId ? { credentialId: ports.catalogCredentialId } : {}), signal: ctx.signal });
  try {
    const text = await ports.repo.readFile(cloned.workdir, TENANT_MANIFEST_PATH);
    if (text === null) return null;
    return ConsumerManifestSchema.parse(parseYaml(text)).tenant ?? null;
  } finally {
    await ports.repo.dispose(cloned.workdir);
  }
}

function tenantAppsRepoSteps(ports: TenantOnboardPorts, p: TenantAppsRepoParams): Step[] {
  // Read defensively: the armed check evaluates def.steps({}) with no params at all.
  const unit = tenantAppsUnit(p.subdomain ?? "");
  const url = tenantAppsRepoURL(p.org ?? "", p.subdomain ?? "");
  const chosen = p.apps ?? [];
  const runtime: AppsRepoRuntime = {};
  return [
    {
      name: "attest-target",
      title: "Attest the build plane (deploy-state fresh)",
      run: async (ctx) => {
        const { clusterReader } = await ports.resolver.resolve(p.clusterId);
        const state = assertDeployState(await clusterReader.readDeployState(), p.domain, unit);
        ctx.log("meta", `build plane ${p.domain} attested for ${unit} — deploy-state generation ${state.generation}`);
      },
    },
    {
      name: "create-repository",
      title: `Create the private repository ${unit}`,
      run: async (ctx) => {
        const app = requireGitHubApp(ports);
        const { created } = await app.createRepository({ org: p.org, name: unit, description: `The apps of tenant ${p.subdomain} (${p.guid}), created from the catalog's ${p.templateBuild}`, private: true, signal: ctx.signal });
        ctx.checkpoint({ repoURL: url, created });
        ctx.log("meta", created ? `repository ${url} created, private` : `repository ${url} already stands — left as it is, the tree below adds what it lacks`);
      },
    },
    {
      name: "write-tree",
      title: `Write the tree of ${unit} from the catalog's ${p.templateBuild}`,
      run: async (ctx) => {
        const writer = ports.onboard?.()?.ports.consumerRepo;
        if (!writer) throw errValidation(`${unit} needs the consumer repository writer to commit its tree, and the consumer onboarding is not wired on this manager — the gate-runner and the git/kube/vault adapters must be wired first`);
        const credentialId = await sealAppToken(ctx, requireGitHubApp(ports), unit, runtime);
        const template = await readTemplate(ports, p.templateRepoURL, ctx.signal);
        let files: { path: string; content: string }[];
        try {
          files = await template.tree(chosen);
        } finally {
          await template.dispose();
        }
        const build = template.manifest.builds.find((b) => b.name === p.templateBuild);
        if (!build) throw errValidation(`${p.templateRepoURL} declares no build named ${p.templateBuild} in its ${CONSUMER_MANIFEST_PATH} — the tenant's build takes its containerfile from that entry`);
        const session = await writer.open({ repoURL: url, credentialId, signal: ctx.signal });
        try {
          // A path that stands is left as it stands, whatever it says: this run ADDS what the
          // repository lacks and never overwrites or removes — the repository is the tenant's.
          const write: { path: string; content: string }[] = [];
          for (const f of files) if ((await writer.readFile(session.workdir, f.path)) === null) write.push(f);
          if ((await writer.readFile(session.workdir, CONSUMER_MANIFEST_PATH)) === null) {
            write.push({ path: CONSUMER_MANIFEST_PATH, content: tenantAppsManifest({ unit, owner: p.owner, envs: template.manifest.envs, containerfile: build.containerfile, context: build.context }) });
          }
          const current = await writer.readFile(session.workdir, APPS_MANIFEST_PATH);
          const merged = mergeAppsManifest(template.appsYaml, current, chosen);
          if (current === null || merged.added.length > 0) write.push({ path: APPS_MANIFEST_PATH, content: merged.content });
          if (write.length === 0) {
            ctx.checkpoint({ repoURL: url, branch: session.branch, files: 0, added: [] });
            ctx.log("meta", `${url} already carries every file of the template and every chosen entry (${chosen.join(", ")}) — nothing to commit`);
            return;
          }
          const message = current === null ? `Create ${unit} from the catalog` : `Add ${merged.added.join(", ")} to ${unit} from the catalog`;
          const { commit } = await writer.commitPush({ workdir: session.workdir, branch: session.branch, credentialId, message, write, signal: ctx.signal });
          ctx.checkpoint({ repoURL: url, branch: session.branch, commit, files: write.length, added: merged.added });
          ctx.log("meta", `${write.length} file(s) committed to ${url} on ${session.branch} (${commit}) — apps ${merged.added.join(", ") || "(none added)"}; the release kit follows with the onboarding`);
        } finally {
          await writer.dispose(session.workdir);
        }
      },
    },
    {
      name: "onboard-build-only",
      title: `Onboard ${unit} build-only and build its first image`,
      run: async (ctx) => {
        const d = ports.onboard?.();
        if (!d) throw errValidation(`${unit} needs the consumer onboarding's build-only chain, and it is not wired on this manager — the gate-runner and the git/kube/vault adapters must be wired first`);
        const onboard = d.ports;
        if (!onboard.github) throw errValidation(`${unit} needs the GitHub consumer client to read its release tags, and none is wired on this manager`);
        const credentialId = await sealAppToken(ctx, requireGitHubApp(ports), unit, runtime);
        const token = await ctx.creds.open(credentialId, { purpose: "tenant-apps-repo:release-version", runId: ctx.runId });
        let version: string;
        try {
          ({ version } = await resolveNextVersion(
            { github: onboard.github, ...(d.platformGitHub ? { platformGitHub: d.platformGitHub } : {}), ...(d.platformRepo ? { platformRepo: d.platformRepo } : {}) },
            { repoURL: url, token: token.toString("utf8"), signal: ctx.signal },
          ));
        } finally {
          token.fill(0);
        }
        const channel = channelReaching(await onboard.channelStages(), p.stage);
        // Read the way the tenant's build units are read (tenant-builds.ts): the manifest this run
        // wrote a step ago, refused unless it declares the build-only shape. The image it builds is
        // mounted by a fan-out the tenant gates judge at create-tenant.
        const ungated = await readUngatedOnboard(
          { repo: onboard.repo, log: (l) => ctx.log("meta", `${unit}: ${l}`), signal: ctx.signal },
          { repoURL: url, ref: DEFAULT_BRANCH_HEAD, consumerName: unit, repoCredentialId: credentialId },
          { cluster: p.domain, admittedBy: [`apps repository of tenant ${p.guid}, created by this run from the catalog's ${p.templateBuild}; its manifest was written by this run and its image is mounted by a fan-out the tenant gates judge`] },
        );
        const params: BuildOnlyOnboardParams = {
          form: "build-only", consumerName: unit, repoURL: url, repoCredentialId: credentialId, owner: p.owner,
          version, channel, stage: p.stage, resolvedSha: ungated.resolvedSha, domain: p.domain, builds: ungated.builds, ungated,
        };
        // The App's rights are the installation's permissions (repository administration, contents,
        // workflows, webhooks), not a PAT's scopes: GitHub answers no X-OAuth-Scopes for an
        // installation token, which preflight-scopes reads as a fine-grained token and refuses. It is
        // left out by name; a permission the App lacks fails loud at the step that needs it.
        const release: ReleaseCycleRuntime = {};
        const chain: Step[] = p.registered
          ? [triggerReleaseStep(onboard, params), watchReleaseBuildStep(onboard, params, release), recordBuildOnlyStep(onboard, params, release)]
          : buildOnlySteps(onboard, params, release).filter((s) => s.name !== "preflight-scopes");
        ctx.log("meta", `${unit}: version ${version}, channel ${channel}, release run on ${p.stage}, build plane ${p.domain} — ${p.registered ? "registered build-only, its release is re-run" : "onboarded build-only by this run"}`);
        for (const step of chain) {
          ctx.log("meta", `${unit}: ${step.title}`);
          await step.run(ctx);
        }
        // The bundle's tag is what its release's PipelineRun states (the `image-tag` result), and
        // nothing else names it: no chart's builds[] pins a tenant's bundle, so the registration
        // carries the tag (tenant-builds.ts buildUnitStep does the same inside create-tenant).
        if (!release.imageTag) {
          throw errValidation(`the release PipelineRun of ${unit} states no image-tag result — the tag ${unit} was pushed under cannot be read, so the registration cannot carry it`);
        }
        runtime.imageTag = release.imageTag;
        ctx.checkpoint({ appsImage: unit, appsImageTag: release.imageTag });
        ctx.log("meta", `${unit} built as ${unit}:${release.imageTag} for ${p.stage} — the registration will carry that tag`);
      },
    },
    {
      name: "record-apps-repo",
      title: "Record the apps repository, image and tag on the tenant's registration",
      run: async (ctx) => {
        const appsImageTag = runtime.imageTag;
        if (!appsImageTag) {
          throw errValidation(`the tag ${unit} was built at is not in this pass's memory — onboard-build-only reads it off the release and a resumed pass has none; the registration cannot name an image without its tag`);
        }
        const current = await ports.registrations.readTenant(p.stage, p.guid);
        if (!current) {
          ctx.checkpoint({ appsRepo: url, appsImage: unit, appsImageTag, registration: "absent" });
          ctx.log("meta", `tenant ${p.guid} has no registration at ${p.stage} yet — appsRepo ${url}, appsImage ${unit} and appsImageTag ${appsImageTag} ride this run's record; the create-tenant that follows writes them`);
          return;
        }
        if (current.entry.appsRepo === url && current.entry.appsImage === unit && current.entry.appsImageTag === appsImageTag) {
          ctx.log("meta", `tenant ${p.guid}'s registration already names ${url} and ${unit}:${appsImageTag} — nothing to commit`);
          return;
        }
        const { commit } = await ports.registrations.setTenantAppsRepo(p.stage, p.guid, { appsRepo: url, appsImage: unit, appsImageTag }, ctx.runId);
        ctx.checkpoint({ commit, appsRepo: url, appsImage: unit, appsImageTag });
        ctx.log("meta", `tenant ${p.guid}'s registration now names ${url} and the image ${unit}:${appsImageTag} (${commit}) — its fan-out mounts the tenant's own bundle from here on`);
      },
    },
  ];
}

export function makeTenantAppsRepoDef(ports: TenantOnboardPorts): RunDefinition<TenantAppsRepoParams> {
  return {
    kind: "tenant-apps-repo",
    paramsSchema: TenantAppsRepoParams,
    mutating: true, // mutating ⇒ steps()[0] MUST be attest-target, asserted at boot
    plan: () => {
      throw new AppError("INTERNAL", "tenant-apps-repo is planned via planStream (the streaming entrypoint), not plan()");
    },
    // Streaming planner: the four refusals, each a sentence the operator acts on, then the template
    // read once for what it offers, then the plan.
    planStream: async (rawParams, ctx) => {
      const req = TenantAppsRepoRequest.parse(rawParams);
      const unit = tenantAppsUnit(req.subdomain);
      const chosen = req.apps.map((a) => a.name);
      const refuse = (why: string) => ({ outcome: "rejected" as const, summary: `Apps repository "${unit}" for tenant ${req.guid} was refused — ${why}`, planJson: { subdomain: req.subdomain, apps: chosen } });
      if (!ports.githubApp) return refuse("this Manager holds no GitHub App identity: set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY (Vault <stage>/app/github-app) and restart it");
      if (!consumerName.safeParse(unit).success) return refuse(`"${unit}" is not a unit name (lower-case letters, digits and hyphens, at most 40 characters) — choose a shorter subdomain`);
      const master = resolveMasterCluster(ctx.db);
      const org = await ports.githubApp.installationOrg(ctx.signal);
      const spec = await readTenantSpec(ports, ctx);
      if (!spec) return refuse(`the catalog ${ports.catalogRepoUrl} declares no tenant fan-out in ${TENANT_MANIFEST_PATH} on ${ports.registrations.branch}`);
      if (spec.appsOrg !== undefined && spec.appsOrg !== org) return refuse(`the catalog's tenant.appsOrg is "${spec.appsOrg}" and the GitHub App is installed in "${org}" — the repository would be created where the App has no rights; install the App in ${spec.appsOrg} or correct the catalog`);
      const template = tenantAppsTemplate(spec);
      if (!template) return refuse(`the catalog declares no tenant.appsBundle and tenant.appsRepo in ${TENANT_MANIFEST_PATH} — the template a tenant's repository is created from`);
      const bundle = template.name;
      ctx.log(`template ${template.repo} (${bundle}), organisation ${org}, repository ${tenantAppsRepoURL(org, req.subdomain)}`);
      const read = await readTemplate(ports, template.repo, ctx.signal);
      let offered: string[];
      let unfolded: string[];
      try {
        offered = parseAppsManifest(read.appsYaml).apps.map((a) => a.name);
        unfolded = [];
        for (const app of chosen) if (offered.includes(app) && !(await read.folders(app))) unfolded.push(app);
        if (!read.manifest.builds.some((b) => b.name === bundle)) return refuse(`${template.repo} declares no build named ${bundle} in its ${CONSUMER_MANIFEST_PATH} — the tenant's build takes its containerfile from that entry`);
      } finally {
        await read.dispose();
      }
      const unknown = chosen.filter((a) => !offered.includes(a));
      if (unknown.length > 0) return refuse(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in the template's ${APPS_MANIFEST_PATH} (it offers ${offered.join(", ") || "nothing"})`);
      if (unfolded.length > 0) return refuse(`${unfolded.join(", ")} ${unfolded.length === 1 ? "has" : "have"} no folder in ${template.repo} although its ${APPS_MANIFEST_PATH} names ${unfolded.length === 1 ? "it" : "them"} — the bundle would refuse to build`);
      const registration = (await ports.buildUnitRegistration?.(unit)) ?? null;
      if (registration?.form === "deployable") return refuse(`the unit ${unit} is registered as DEPLOYABLE on this installation — a tenant's apps repository is a build-only unit; offboard that unit first`);
      const params: TenantAppsRepoParams = {
        subdomain: req.subdomain, guid: req.guid, stage: req.stage, apps: chosen, owner: req.owner ?? req.subdomain,
        org, templateRepoURL: template.repo, templateBuild: bundle, registered: registration !== null,
        clusterId: master.clusterId, domain: master.domain,
      };
      const stepDefs = tenantAppsRepoSteps(ports, params);
      const plan: Plan = {
        kind: "tenant-apps-repo",
        targetKind: "cluster",
        targetId: master.clusterId, // the build plane — the one cluster this run touches
        summary: `Create ${org}/${unit} from ${template.repo} with ${chosen.length} app(s) (${chosen.join(", ")}), onboard it build-only on ${req.stage} and build its first image: ${stepDefs.length} steps.${registration ? ` The unit is already registered build-only; its release is re-run.` : ""}`,
        steps: stepDefs.map((s) => ({ name: s.name, title: s.title })),
        targets: [], // no host owned — the Manager acts master-locally
        // The tenant registration rides the catalog's books branch, the unit's build registration
        // the platform repo's — one installation, one branch name in both, two locks by resource.
        locks: [...tenantLocks(ports.registrations), { resource: "git-branch", key: ports.registrations.branch }],
        warnings: [],
        requiredSecrets: [], // the App's token is minted by the Manager itself — nothing is asked at approve
      };
      return { outcome: "planned", params, plan };
    },
    steps: (params) => tenantAppsRepoSteps(ports, params),
  };
}
