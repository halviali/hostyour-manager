import { useEffect, useState, type FormEvent } from "react";
import type { OrganisationCredentialView, OrganisationIdentityView } from "../../../shared/api-types-organisations.ts";
import { listOrganisations, recordOrganisationCredential, forgetOrganisationCredential } from "../api.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Which = "packages-reader" | "repository-pat";

/**
 * The identity of each organisation: what every unit of it — a consumer, a tenant's build unit, a
 * tenant's own apps repository — is onboarded with, derived from the owner of its repository URL.
 * Nothing is asked per unit (hostyour-manager#218).
 *
 * Two credentials. The PACKAGES READER is a token that reads the organisation's private npm
 * packages — GitHub grants the platform's App no access to a private package whatever its
 * permissions say, so a build's `.npmrc` carries this token; it is required for every unit whose
 * repository installs private packages from GitHub Packages (#221). The REPOSITORY PAT is the repository identity only where the
 * App is not installed in the organisation. Each token is measured against GitHub before it is
 * sealed, and only its fingerprint ever comes back.
 */
export function Organisations() {
  const [orgs, setOrgs] = useState<OrganisationIdentityView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newOrg, setNewOrg] = useState("");

  function refresh(): void {
    listOrganisations()
      .then((r) => setOrgs(r.organisations))
      .catch((e: unknown) => setError(msg(e)));
  }
  useEffect(refresh, []);

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Organisations</h2>
          <p className="page__desc">The identity every unit of an organisation is onboarded with — recorded once here, never asked per unit.</p>
        </div>
      </header>

      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}

      {!orgs ? (
        <div className="loading">
          <span className="spinner" aria-hidden="true" />
          Loading organisations…
        </div>
      ) : (
        <ul className="cards">
          {orgs.map((o) => (
            <OrganisationCard key={o.org} entry={o} onChanged={refresh} onError={setError} />
          ))}
          <li className="card">
            <h3 className="form-card__title">Another organisation</h3>
            <div className="form-grid">
              <label className="field">
                <span className="field__label">GitHub organisation</span>
                <input value={newOrg} onChange={(e) => setNewOrg(e.target.value.trim())} placeholder="acme-org" pattern="[A-Za-z0-9-]+" />
              </label>
            </div>
            {newOrg && !orgs.some((o) => o.org === newOrg) && (
              <OrganisationCard entry={{ org: newOrg, appInstalled: false, packagesReader: null, repositoryPat: null }} onChanged={() => { setNewOrg(""); refresh(); }} onError={setError} bare />
            )}
          </li>
        </ul>
      )}
    </section>
  );
}

function OrganisationCard(props: { entry: OrganisationIdentityView; onChanged: () => void; onError: (m: string | null) => void; bare?: boolean }) {
  const { entry } = props;
  const body = (
    <>
      {!props.bare && (
        <div className="card__head">
          <strong className="servercard__name">{entry.org}</strong>
          <span className={entry.appInstalled ? "chip chip--ok" : "chip"}>
            {entry.appInstalled ? "GitHub App installed" : "no GitHub App"}
          </span>
        </div>
      )}
      <CredentialRow
        org={entry.org}
        which="packages-reader"
        title="Packages reader"
        standing={entry.packagesReader}
        hint="A token that reads the organisation's private npm packages: a classic PAT with read:packages, or a fine-grained PAT with Packages: Read for this organisation. Required for every unit whose repository installs private packages from GitHub Packages (its .npmrc) — the App's own token cannot read packages."
        required
        onChanged={props.onChanged}
        onError={props.onError}
      />
      <CredentialRow
        org={entry.org}
        which="repository-pat"
        title="Repository PAT"
        standing={entry.repositoryPat}
        hint={entry.appInstalled
          ? "Not needed: the GitHub App is installed here and is the identity of every repository of the organisation."
          : "A classic PAT with repo + workflow + admin:repo_hook — the repository identity where the GitHub App is not installed in the organisation."}
        required={!entry.appInstalled}
        onChanged={props.onChanged}
        onError={props.onError}
      />
    </>
  );
  return props.bare ? <div>{body}</div> : <li className="card">{body}</li>;
}

function CredentialRow(props: { org: string; which: Which; title: string; standing: OrganisationCredentialView | null; hint: string; required: boolean; onChanged: () => void; onError: (m: string | null) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [formKey, setFormKey] = useState(0);

  async function record(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    props.onError(null);
    try {
      await recordOrganisationCredential(props.org, props.which, token.trim());
      setToken("");
      setFormKey((k) => k + 1);
      props.onChanged();
    } catch (err) {
      props.onError(msg(err));
    }
    setBusy(false);
  }

  async function forget(): Promise<void> {
    setBusy(true);
    props.onError(null);
    try {
      await forgetOrganisationCredential(props.org, props.which);
      props.onChanged();
    } catch (err) {
      props.onError(msg(err));
    }
    setBusy(false);
  }

  return (
    <form key={formKey} onSubmit={record}>
      <div className="card__head">
        <strong>{props.title}</strong>
        {props.standing ? (
          <span className="chip chip--ok">recorded {new Date(props.standing.recordedAt).toLocaleDateString()} · {props.standing.fingerprint}</span>
        ) : (
          <span className={props.required ? "chip chip--warn" : "chip"}>{props.required ? "not recorded" : "not needed"}</span>
        )}
      </div>
      <p className="servercard__reading">{props.hint}</p>
      <div className="form-grid">
        <label className="field">
          <span className="field__label">{props.standing ? "Replace with" : "Token"}</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… or github_pat_…" autoComplete="off" />
        </label>
      </div>
      <div className="form-foot">
        <span className="field__hint">Measured against GitHub before it is sealed; only its fingerprint is kept in view.</span>
        <span className="page__actions">
          {props.standing && (
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void forget()}>
              Forget
            </button>
          )}
          <button type="submit" className="btn btn--primary" disabled={busy || !token.trim()}>
            {busy ? "Measuring…" : props.standing ? "Replace" : "Record"}
          </button>
        </span>
      </div>
    </form>
  );
}
