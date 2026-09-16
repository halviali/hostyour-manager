// The fake template and catalog a tenant-apps-repo test reads: a catalog naming the template by
// appsBundle + appsRepo, the template's apps.yaml with two apps, its build-only manifest, and the
// tree the reader lists — root files, the release kit (never copied) and the two app folders.
import { tenantAppsRepoURL, tenantAppsUnit } from "./tenant-apps-tree.ts";

export const SHA = "a".repeat(40);
export const GUID = "zsjs023ctne0";
export const ORG = "acme-org";
export const SUBDOMAIN = "acme";
export const UNIT = tenantAppsUnit(SUBDOMAIN); // acme-apps
export const TENANT_URL = tenantAppsRepoURL(ORG, SUBDOMAIN);
export const CATALOG_URL = "https://github.com/acme/acme-catalog.git";
export const TEMPLATE_URL = `https://github.com/${ORG}/example-apps.git`;
export const IMAGE_TAG = "0.1.0-stable-20260101000000-abc1234";

export const catalogManifest = (over: { appsOrg?: string; appsBundle?: string } = { appsOrg: ORG, appsBundle: "example-apps" }): string => `
apiVersion: hostyour.cloud/v1
kind: ConsumerManifest
name: acme-catalog
owner: platform
envs: [dev, prod]
tenant:
  ${over.appsOrg ? `appsOrg: ${over.appsOrg}` : ""}
  ${over.appsBundle ? `appsBundle: ${over.appsBundle}\n  appsRepo: ${TEMPLATE_URL}` : ""}
  members:
    - { name: auth, chart: charts/example-auth, identityProvider: true }
    - { name: jobs, chart: charts/example-jobs }
    - { name: report, chart: charts/example-report }
  perApp:
    engine: { chart: charts/example-engine }
    front: { chart: charts/example-ui }
`;

export const TEMPLATE_APPS_YAML = `# The app catalog of this bundle.
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
export const TEMPLATE_MANIFEST = `
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
export const TEMPLATE_FILES: Record<string, string> = {
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

