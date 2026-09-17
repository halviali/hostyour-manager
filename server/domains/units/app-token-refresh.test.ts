// The App-token refresh (app-token-refresh.ts): every unit whose build registration names a
// github-app credential has its build repo-pat rewritten with the value the store opens to now and
// its three build Secrets deleted behind the rewrite; a pat unit is left alone; one unit's failure
// is logged and the rest go on; nothing rejects.
import { describe, it, expect } from "vitest";
import type { Logger } from "../../kernel/logger.ts";
import type { CredentialStore } from "../../security/store.ts";
import type { BuildRepoPatSeedInput } from "../../adapters/vault/seeder-port.ts";
import { FakePlatformRepo } from "../../adapters/git/testing/fake.ts";
import { FakeClusterReader } from "../../adapters/kube/testing/fake.ts";
import { Registrations } from "./registrations.ts";
import { BUILD_TARGET_SECRETS, deleteBuildSecrets, readBuildSecretRefreshTimes, refreshAppTokens, refreshUnitRepoPat } from "./app-token-refresh.ts";

/** The three deletes one unit's refresh issues, in the order the names are declared. */
const deletesOf = (unit: string) => BUILD_TARGET_SECRETS.map((name) => ({ op: "delete" as const, namespace: `${unit}-build`, name }));

/** A store of two credentials: the App's (kind github-app), which opens to whatever `minted` says
 *  at the moment of the open, and a consumer's PAT. */
function fakeStore(minted: { value: string }): { store: Pick<CredentialStore, "list" | "open">; opened: string[] } {
  const opened: string[] = [];
  const store: Pick<CredentialStore, "list" | "open"> = {
    list: async (filter) => {
      const all = [
        { id: "cred_app", kind: "github-app" as const, label: "GitHub App (acme-apps)", fingerprint: "sha256:app" },
        { id: "cred_pat", kind: "pat" as const, label: "consumer repo PAT (shop)", fingerprint: "sha256:pat" },
      ];
      return all.filter((c) => !filter?.kind || c.kind === filter.kind);
    },
    open: async (id) => {
      opened.push(id);
      if (id === "cred_app") return Buffer.from(minted.value, "utf8");
      if (id === "cred_pat") return Buffer.from("github_pat_shop", "utf8");
      throw new Error(`credential ${id} not found`);
    },
  };
  return { store, opened };
}

function fakeSeeder(failFor: string[] = []): { seeder: { refreshBuildRepoPat: (i: BuildRepoPatSeedInput) => Promise<void> }; written: BuildRepoPatSeedInput[] } {
  const written: BuildRepoPatSeedInput[] = [];
  return {
    written,
    seeder: {
      refreshBuildRepoPat: async (i) => {
        if (failFor.includes(i.consumerName)) throw new Error(`vault build repo-pat put failed for secret/build/${i.consumerName}/repo-pat (403)`);
        written.push(i);
      },
    },
  };
}

function fakeLogger(): { logger: Logger; errors: string[]; warns: string[]; infos: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const logger = {
    error: (fields: unknown, msg: string) => { errors.push(`${msg} ${JSON.stringify(fields)}`); },
    warn: (fields: unknown, msg: string) => { warns.push(`${msg} ${JSON.stringify(fields)}`); },
    info: (fields: unknown, msg: string) => { infos.push(`${msg} ${JSON.stringify(fields)}`); },
    debug: () => undefined,
  } as unknown as Logger;
  return { logger, errors, warns, infos };
}

/** Three build registrations: two units on the App's credential, one consumer on its own PAT. */
async function registrations(): Promise<Registrations> {
  const reg = new Registrations(new FakePlatformRepo());
  const unit = (name: string, repoCredentialId: string) => ({ name, repoURL: `https://github.com/acme/${name}.git`, repoCredentialId, owner: "acme", onboardedAt: "2026-01-01T00:00:00Z", suspended: false, quiesced: false });
  await reg.commitRegistration({ unit: unit("acme-apps", "cred_app"), builds: ["acme-apps"], runId: "run_1" });
  await reg.commitRegistration({ unit: unit("shop", "cred_pat"), builds: ["shop-api"], runId: "run_2" });
  await reg.commitRegistration({ unit: unit("beta-apps", "cred_app"), builds: ["beta-apps"], runId: "run_3" });
  return reg;
}

describe("refreshAppTokens", () => {
  it("rewrites the repo-pat of every unit whose build registration names a github-app credential with the value opened NOW, deletes its three build Secrets behind the rewrite, and skips the pat unit", async () => {
    const minted = { value: "ghs_minted_at_tick_1" };
    const { store, opened } = fakeStore(minted);
    const { seeder, written } = fakeSeeder();
    const { logger, errors, warns, infos } = fakeLogger();
    const kube = new FakeClusterReader();
    const reg = await registrations();
    expect(await refreshAppTokens({ store, registrations: reg, seeder, kube, logger })).toEqual({ refreshed: ["acme-apps", "beta-apps"], failed: [] });
    expect(written).toEqual([{ consumerName: "acme-apps", pat: "ghs_minted_at_tick_1" }, { consumerName: "beta-apps", pat: "ghs_minted_at_tick_1" }]);
    expect(opened).toEqual(["cred_app", "cred_app"]);
    // The three target Secrets of each App unit, by name, in ITS build namespace; the pat unit's
    // shop-build is not touched. None of them stood in the fake — an absent Secret is done, not an
    // error, exactly as the live port treats a 404.
    expect(kube.secretWrites).toEqual([...deletesOf("acme-apps"), ...deletesOf("beta-apps")]);
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
    expect(infos.some((l) => l.includes("App tokens refreshed"))).toBe(true);
    // The next tick writes the token of that hour — the value is never remembered between ticks —
    // and deletes the Secrets again, because ESO reads Vault at no other moment.
    minted.value = "ghs_minted_at_tick_2";
    await refreshAppTokens({ store, registrations: reg, seeder, kube, logger });
    expect(written.at(-1)).toEqual({ consumerName: "beta-apps", pat: "ghs_minted_at_tick_2" });
    expect(kube.secretWrites).toHaveLength(12);
  });

  it("logs the unit whose write fails, with its name, deletes none of its Secrets, and refreshes the others", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder(["acme-apps"]);
    const { logger, errors } = fakeLogger();
    const kube = new FakeClusterReader();
    expect(await refreshAppTokens({ store, registrations: await registrations(), seeder, kube, logger })).toEqual({ refreshed: ["beta-apps"], failed: ["acme-apps"] });
    expect(written.map((w) => w.consumerName)).toEqual(["beta-apps"]);
    // A Secret deleted behind a write that did not happen would make ESO materialize the DEAD value
    // again — nothing is gained, so nothing is deleted.
    expect(kube.secretWrites).toEqual(deletesOf("beta-apps"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"unit":"acme-apps"');
    expect(errors[0]).toContain("repo-pat put failed");
    expect(errors[0]).not.toContain("ghs_x");
  });

  it("logs the unit whose Secret deletion fails, with its name and its build namespace, counts it failed, and the tick goes on to the next unit without rejecting", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const kube = new FakeClusterReader({ throwOnDeleteSecret: new Error("delete Secret acme-apps-build/build-git-https: secrets is forbidden (403)") });
    expect(await refreshAppTokens({ store, registrations: await registrations(), seeder, kube, logger })).toEqual({ refreshed: [], failed: ["acme-apps", "beta-apps"] });
    // Both Vault writes happened: the failure is behind the write, and the second unit was reached.
    expect(written.map((w) => w.consumerName)).toEqual(["acme-apps", "beta-apps"]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('"unit":"acme-apps"');
    expect(errors[0]).toContain('"namespace":"acme-apps-build"');
    expect(errors[0]).toContain("could not be deleted");
    expect(errors[1]).toContain('"unit":"beta-apps"');
    for (const l of errors) expect(l).not.toContain("ghs_x");
  });

  it("without a wired kube it rewrites Vault, counts the units refreshed, and logs the skipped deletion naming them", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors, warns } = fakeLogger();
    expect(await refreshAppTokens({ store, registrations: await registrations(), seeder, logger })).toEqual({ refreshed: ["acme-apps", "beta-apps"], failed: [] });
    expect(written.map((w) => w.consumerName)).toEqual(["acme-apps", "beta-apps"]);
    expect(errors).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("no kube is wired");
    expect(warns[0]).toContain('"units":["acme-apps","beta-apps"]');
  });

  it("logs, writes nothing and does not reject when the registration tree cannot be read", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors } = fakeLogger();
    const kube = new FakeClusterReader();
    const broken = { listBuildRegistrations: async () => { throw new Error("registrations/broken/build.yaml is not a readable build registration"); } };
    expect(await refreshAppTokens({ store, registrations: broken, seeder, kube, logger })).toEqual({ refreshed: [], failed: [] });
    expect(written).toEqual([]);
    expect(kube.secretWrites).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("could not read which units");
  });

  it("does nothing, and says nothing, on an installation without an App-credentialed unit", async () => {
    const { store } = fakeStore({ value: "ghs_x" });
    const { seeder, written } = fakeSeeder();
    const { logger, errors, warns, infos } = fakeLogger();
    const kube = new FakeClusterReader();
    const reg = new Registrations(new FakePlatformRepo());
    await reg.commitRegistration({ unit: { name: "shop", repoURL: "https://github.com/acme/shop.git", repoCredentialId: "cred_pat", owner: "acme", onboardedAt: "2026-01-01T00:00:00Z", suspended: false, quiesced: false }, builds: ["shop-api"], runId: "run_1" });
    expect(await refreshAppTokens({ store, registrations: reg, seeder, kube, logger })).toEqual({ refreshed: [], failed: [] });
    expect(written).toEqual([]);
    expect(kube.secretWrites).toEqual([]);
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
    expect(infos).toEqual([]);
  });
});

describe("deleteBuildSecrets / readBuildSecretRefreshTimes", () => {
  it("deletes exactly the three target Secrets of the ExternalSecrets in <unit>-build, in the declared order", async () => {
    const kube = new FakeClusterReader();
    await deleteBuildSecrets(kube, "acme-apps");
    expect(kube.secretWrites).toEqual(deletesOf("acme-apps"));
    expect(BUILD_TARGET_SECRETS).toEqual(["build-git-https", "bump-git-https", "build-npmrc"]);
  });

  it("reads each Secret's refreshTime off the ExternalSecret row that TARGETS it, and the empty text where no row does", async () => {
    const kube = new FakeClusterReader({ externalSecretsByNamespace: { "acme-apps-build": [
      // Matched by target, not by the ExternalSecret's own name.
      { name: "git", ready: true, reason: "SecretSynced", targetSecret: "build-git-https", refreshTime: "2026-09-17T10:00:00Z" },
      { name: "build-npmrc", ready: true, reason: "SecretSynced", targetSecret: "build-npmrc", refreshTime: "" },
    ] } });
    expect(await readBuildSecretRefreshTimes(kube, "acme-apps")).toEqual({ "build-git-https": "2026-09-17T10:00:00Z", "bump-git-https": "", "build-npmrc": "" });
    expect(kube.listedExternalSecrets).toEqual(["acme-apps-build"]);
  });
});

describe("refreshUnitRepoPat", () => {
  it("opens the credential under the purpose given, writes it as the unit's repo-pat and zeroes it", async () => {
    let handed: Buffer | undefined;
    const store: Pick<CredentialStore, "open"> = { open: async (id, use) => { expect(use.purpose).toBe("consumer-onboard:refresh-repo-pat"); handed = Buffer.from(`token-of-${id}`); return handed; } };
    const { seeder, written } = fakeSeeder();
    await refreshUnitRepoPat({ store, seeder }, "acme-apps", "cred_app", { purpose: "consumer-onboard:refresh-repo-pat" });
    expect(written).toEqual([{ consumerName: "acme-apps", pat: "token-of-cred_app" }]);
    expect(handed?.every((b) => b === 0)).toBe(true);
  });
});
