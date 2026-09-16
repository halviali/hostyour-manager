import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { DnsInventoryView, DnsRecordRow } from "../../../shared/dns.ts";
import { getDnsInventory, removeDnsRecord } from "../api.ts";

// Every record this installation is responsible for at the DNS provider, with what stands there
// now. One table and one act: a row this Manager wrote can be taken back, and a row it merely
// depends on is listed without a button — the sender domain's address record is the installer's and
// the reverse DNS is set where the egress address is rented (shared/dns.ts states both).

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The three verdicts in the operator's words. `other` is the one that matters on a tear-down: a
 *  name of this installation answering with content nobody here would write is what an installation
 *  that is gone leaves behind. */
const VERDICT_LABEL: Record<DnsRecordRow["verdict"], string> = { standing: "standing", absent: "absent", other: "other content" };

function ownerCell(owner: DnsRecordRow["owner"]): string {
  return owner.stage === undefined ? `${owner.kind} ${owner.name}` : `${owner.kind} ${owner.name} (${owner.stage})`;
}

function RecordRow({ row, busy, onRemove }: { row: DnsRecordRow; busy: boolean; onRemove: (row: DnsRecordRow) => void }) {
  return (
    <tr>
      <td>{ownerCell(row.owner)}</td>
      <td className="mono">{row.name}</td>
      <td>{row.type}</td>
      <td className="mono">{row.expected}</td>
      <td className="mono">{row.found ?? "none"}</td>
      <td><span className={row.verdict === "standing" ? "chip chip--ok" : "chip chip--warn"}>{VERDICT_LABEL[row.verdict]}</span></td>
      <td>
        {row.removable
          ? <button type="button" className="btn" disabled={busy} onClick={() => onRemove(row)}>Remove</button>
          : <span className="muted">read-only</span>}
      </td>
    </tr>
  );
}

/** The inventory, read on every load, and the removal it offers. The removal is a RUN: this starts
 *  the plan and navigates to it, where the operator reads what stands at the record and approves —
 *  a deletion at the provider is never one click here. */
export function Dns() {
  const nav = useNavigate();
  const [data, setData] = useState<DnsInventoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getDnsInventory()
      .then((v) => setData(v))
      .catch((e: unknown) => setError(msg(e)));
  }, []);

  async function remove(row: DnsRecordRow): Promise<void> {
    if (row.type === "PTR") return; // never reachable: a PTR row is listed read-only and offers no button
    if (!window.confirm(`Remove the ${row.type} record ${row.name}? It stands at ${row.found ?? "nothing"} and is ${ownerCell(row.owner)}'s.`)) return;
    setBusy(true);
    setError(null);
    try {
      const { runId } = await removeDnsRecord({ name: row.name, type: row.type });
      nav(`/runs/${runId}`);
    } catch (e: unknown) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">DNS</h2>
        </div>
      </header>
      {error && <div className="alert alert--danger">{error}</div>}
      {data === null && !error && <p className="muted">Reading the records at the provider…</p>}
      {data && (
        <>
          {data.skipped.map((why) => <div key={why} className="alert alert--warn">{why}</div>)}
          <section className="card">
            <h3 className="page__title">
              {data.rows.length} record{data.rows.length === 1 ? "" : "s"}{" "}
              <span className="muted">· read {new Date(data.readAt).toLocaleTimeString()}</span>
            </h3>
            <div className="table__wrap">
              <table className="table">
                <thead>
                  <tr><th>Owner</th><th>Name</th><th>Type</th><th>Expected</th><th>Found</th><th>Verdict</th><th /></tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => <RecordRow key={`${row.type} ${row.name}`} row={row} busy={busy} onRemove={(r) => void remove(r)} />)}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
