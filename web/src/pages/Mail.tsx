import { useEffect, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router";
import { DMARC_POLICY, type DmarcPolicy } from "../../../shared/enums.ts";
import type { MailDnsDomainView, MailDnsRow, MailDnsView } from "../../../shared/mail.ts";
import { getMailDns, publishMailDns } from "../api.ts";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The five records, named as the records are named, in the order a receiver judges them. */
const RECORD_LABEL: Record<MailDnsRow["record"], string> = { spf: "SPF", a: "A", dkim: "DKIM", dmarc: "DMARC", ptr: "PTR" };

/** The report mailbox a published DMARC record already names, so the form starts from what stands. */
function reportMailboxOf(rows: MailDnsRow[]): string {
  const found = rows.find((r) => r.record === "dmarc")?.found ?? "";
  const m = /rua=mailto:([^;,\s]+)/i.exec(found);
  return m?.[1] ?? "";
}

function RecordRow({ row }: { row: MailDnsRow }) {
  return (
    <li>
      <div className="row">
        <span className="mono">{RECORD_LABEL[row.record]}</span>
        <span className="mono">{row.name}</span>
        <span className={row.ok ? "chip chip--ok" : "chip chip--warn"}>{row.ok ? "ok" : "missing"}</span>
        <span className="row__meta">
          expected: {row.expected} · found: {row.found === null ? "none" : row.found}
          {row.note ? ` — ${row.note}` : ""}
        </span>
      </div>
    </li>
  );
}

function DomainCard({ view, masterId, onError }: { view: MailDnsDomainView; masterId: string; onError: (m: string | null) => void }) {
  const nav = useNavigate();
  const [policy, setPolicy] = useState<DmarcPolicy>("none");
  const [mailbox, setMailbox] = useState(() => reportMailboxOf(view.rows));
  const [busy, setBusy] = useState(false);
  const green = view.rows.filter((r) => r.ok).length;

  async function publish(): Promise<void> {
    setBusy(true);
    onError(null);
    try {
      const { runId } = await publishMailDns({ serverId: masterId, senderDomain: view.domain, dmarcPolicy: policy, dmarcMailbox: mailbox.trim() });
      nav(`/runs/${runId}`);
    } catch (err) {
      onError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3 className="page__title">
        {view.domain} <span className="muted">— {view.role}</span>{" "}
        <span className={green === view.rows.length ? "chip chip--ok" : "chip chip--warn"}>{green}/{view.rows.length} records</span>
      </h3>
      <ul className="rows">
        {view.rows.map((row) => <RecordRow key={row.record} row={row} />)}
      </ul>
      <div className="form-grid">
        <label className="field">
          <span className="field__label">DMARC policy</span>
          <select value={policy} onChange={(e: ChangeEvent<HTMLSelectElement>) => setPolicy(e.target.value as DmarcPolicy)}>
            {DMARC_POLICY.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <span className="field__hint">Start at none — reports without enforcement — and tighten once the reports show only this installation&apos;s mail.</span>
        </label>
        <label className="field">
          <span className="field__label">DMARC report mailbox</span>
          <input type="email" value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="dmarc@example.com" required />
          <span className="field__hint">Where receivers send their aggregate reports — a mailbox somebody reads.</span>
        </label>
        <div className="field">
          <span className="field__label">Publish</span>
          <button type="button" className="btn btn--primary" disabled={busy || mailbox.trim() === ""} onClick={() => void publish()}>
            {busy ? "Planning…" : `Publish the mail DNS of ${view.domain}`}
          </button>
          <span className="field__hint">
            A run on the master: the catalogue&apos;s publish-mail-dns merges the egress address into the SPF (keeping what stands), writes the address
            record, publishes the DKIM key where the relay holds one, and sets DMARC. The PTR is set at the hosting provider, not here.
          </span>
        </div>
      </div>
    </section>
  );
}

/** The installation's mail DNS as receivers see it, measured at public resolvers on every load, and
 *  the one act it offers: publishing a sender domain's records through the master. */
export function Mail() {
  const [data, setData] = useState<MailDnsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMailDns()
      .then((v) => setData(v))
      .catch((e: unknown) => setError(msg(e)));
  }, []);

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">Mail</h2>
          <p className="page__desc">
            What receivers of this installation&apos;s mail look up — measured now at public resolvers, never at the machine&apos;s own — held against
            what the master&apos;s map and address say they must find. Customer mail leaves as the platform domain, alerts as the unit apex.
          </p>
        </div>
      </header>
      {error && <div className="alert alert--danger">{error}</div>}
      {data === null && !error && <p className="muted">Measuring…</p>}
      {data && (
        <>
          <section className="card">
            <h3 className="page__title">Master</h3>
            <p>
              <span className="mono">{data.master.fqdn}</span> ({data.master.name}, {data.master.stage}) — egress address{" "}
              {data.master.egress ? <span className="mono">{data.master.egress}</span> : <span className="chip chip--warn">no A record at the DNS provider</span>}
              <span className="muted"> · measured {new Date(data.measuredAt).toLocaleTimeString()}</span>
            </p>
          </section>
          {data.domains.map((d) => <DomainCard key={d.domain} view={d} masterId={data.master.serverId} onError={setError} />)}
        </>
      )}
    </section>
  );
}
