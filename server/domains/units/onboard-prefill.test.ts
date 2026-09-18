import { describe, it, expect } from "vitest";
import { FakeGitHubConsumer } from "../../adapters/github-consumer/testing/fake.ts";
import { FakeGitHubApp } from "../../adapters/github-app/testing/fake.ts";
import { OnboardPrefillRequest, readOnboardPrefill } from "./onboard-prefill.ts";

// The wizard's prefill: the version the onboarding will release, read off the release tags — the
// next number, never the last one — and the repositories it was read over named in the source.

const REPO = "https://github.com/x/acme.git";
const request = (over: Partial<OnboardPrefillRequest> = {}): OnboardPrefillRequest => OnboardPrefillRequest.parse({ repoURL: REPO, repoPat: "github_pat_test", ...over });
const signal = (): AbortSignal => new AbortController().signal;

describe("readOnboardPrefill", () => {
  it("answers the next number after the repository's release tags, naming the repository", async () => {
    const github = new FakeGitHubConsumer();
    github.seedTags("x", "acme", ["0.1.0-stable-20260909094733", "0.1.2-stable-20260909121415", "0.1.1-beta-20260909114034", "v9"]);
    const view = await readOnboardPrefill({ github }, request(), signal());
    expect(view).toEqual({ version: "0.1.3", versionSource: "the next number after the release tags of x/acme", channel: "stable", channelSource: "default", identity: "pat" });
    expect(github.tagReads).toEqual([{ owner: "x", repo: "acme" }]);
  });

  it("starts a repository with no release tag at 0.1.0", async () => {
    const view = await readOnboardPrefill({ github: new FakeGitHubConsumer() }, request(), signal());
    expect(view.version).toBe("0.1.0");
  });

  it("reads a platform-line unit over the platform's line: its own repo, the platform repo and the engine's", async () => {
    const github = new FakeGitHubConsumer();
    github.seedTags("simetrixch", "hostyour-manager", ["0.8.169-stable-20260913211928"]);
    github.seedTags("simetrixch", "hostyour-cloud", ["0.8.170-stable-20260914032934"]);
    github.seedTags("simetrixch", "ansiwise-cli", ["0.8.165-stable-20260911210935"]);
    const platformRepo = { withBranch: async (_b: string, fn: (t: { readFile: (p: string) => Promise<string | null> }) => Promise<string | null>) => fn({ readFile: async () => "cliTools:\n  ansiwise:\n    version: 0.8.165-stable-20260911210935\n    upstream: { kind: github_release, project: simetrixch/ansiwise-cli }\n" }) };
    const view = await readOnboardPrefill(
      { github, platformGitHub: { owner: "simetrixch", repo: "hostyour-cloud" }, platformRepo: platformRepo as never },
      request({ repoURL: "https://github.com/simetrixch/hostyour-manager.git" }),
      signal(),
    );
    expect(view.version).toBe("0.8.171");
    expect(view.versionSource).toBe("the next number after the release tags of simetrixch/hostyour-manager, simetrixch/hostyour-cloud, simetrixch/ansiwise-cli");
  });

  it("reads a customer's unit over its own tags only, whatever the platform's line holds", async () => {
    const github = new FakeGitHubConsumer();
    github.seedTags("x", "acme", ["1.4.0-stable-20260909094733"]);
    github.seedTags("simetrixch", "hostyour-cloud", ["0.8.170-stable-20260914032934"]);
    const view = await readOnboardPrefill({ github, platformGitHub: { owner: "simetrixch", repo: "hostyour-cloud" } }, request(), signal());
    expect(view.version).toBe("1.4.1");
    expect(github.tagReads).toEqual([{ owner: "x", repo: "acme" }]);
  });
});

// THE MEASURED RULE (#194): the App where its installation reaches the repository, else the PAT.
describe("readOnboardPrefill — which identity reads the repository", () => {
  it("reads a repository the App reaches with the App's token, PAT or no PAT, and names the identity", async () => {
    const github = new FakeGitHubConsumer();
    const githubApp = new FakeGitHubApp();
    github.seedTags(githubApp.org, "acme", ["0.2.0-stable-20260909094733"]);
    const view = await readOnboardPrefill({ github, githubApp }, request({ repoURL: `https://github.com/${githubApp.org}/acme.git`, repoPat: undefined }), signal());
    expect(view.identity).toBe("github-app");
    expect(view.version).toBe("0.2.1");
    expect(github.tokensSeen).toEqual([githubApp.token]);
  });

  it("reads a repository outside the installation with the PAT — the external consumer, exactly as before the App", async () => {
    const github = new FakeGitHubConsumer();
    const view = await readOnboardPrefill({ github, githubApp: new FakeGitHubApp() }, request(), signal());
    expect(view.identity).toBe("pat");
    expect(github.tokensSeen).toEqual(["github_pat_test"]);
  });

  it("refuses a repository outside the installation with no PAT, naming the organisation the App is installed in", async () => {
    const err = await readOnboardPrefill({ github: new FakeGitHubConsumer(), githubApp: new FakeGitHubApp() }, request({ repoPat: undefined }), signal()).catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain("installed in the organisation example-org and does not reach x/acme");
    expect(String((err as Error).message)).toContain("hand in the repository's own PAT");
  });
});

describe("OnboardPrefillRequest", () => {
  it("takes a .git https URL and an optional non-empty PAT", () => {
    expect(OnboardPrefillRequest.safeParse({ repoURL: "git@github.com:x/acme.git", repoPat: "p" }).success).toBe(false);
    expect(OnboardPrefillRequest.safeParse({ repoURL: REPO, repoPat: "" }).success).toBe(false);
    expect(OnboardPrefillRequest.safeParse({ repoURL: REPO, repoPat: "p" }).success).toBe(true);
    expect(OnboardPrefillRequest.safeParse({ repoURL: REPO }).success).toBe(true);
  });
});
