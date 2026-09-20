/** GET /api/organisations — the identity recorded for each organisation (server
 *  domains/units/organisations.ts, hostyour-manager#219): its two credentials as fingerprints and
 *  dates, never values, and whether the platform's GitHub App is installed in it. */
export interface OrganisationCredentialView {
  fingerprint: string;
  recordedAt: string; // ISO
}

export interface OrganisationIdentityView {
  org: string;
  /** The platform's GitHub App is installed in this organisation: its repositories need no
   *  repository PAT — the App is their identity. */
  appInstalled: boolean;
  /** The organisation's packages reader — what every build of its units installs private npm
   *  packages with. Required for every onboarding of a unit of the organisation. */
  packagesReader: OrganisationCredentialView | null;
  /** The organisation's repository PAT — the repository identity where the App is not installed. */
  repositoryPat: OrganisationCredentialView | null;
}

export interface OrganisationsListView {
  organisations: OrganisationIdentityView[];
}

/** PUT /api/organisations/:org/packages-reader and /repository-pat — the one field, sent once
 *  over TLS, measured and sealed on the server, never echoed. */
export interface OrganisationCredentialInput {
  token: string;
}
