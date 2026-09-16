import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { DnsInventoryView, DnsRecordRow, DnsRecordType, DnsWritesView } from "../../../shared/dns.ts";
import { getDnsInventory, getDnsWrites, removeDnsRecord } from "../api.ts";
import { DnsWritesTable } from "./DnsWrites.tsx";

// The DNS page in two tabs. FIRST the book: only the records a run of this Manager inserted or
// updated, with the run, the time and what stands there now — what an operator asks after a day's
// work. SECOND everything derived: every record this installation is responsible for at the DNS
// provider, standing or absent, which is what a tear-down needs. One act on both: a row this
// Manager wrote can be taken back, and a row it merely depends on is listed without a button — the
// sender domain's address record is the installer's and the reverse DNS is set where the egress
// address is rented (shared/dns.ts states both).

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

type Tab = "written" | "derived";

/** Both readings are taken on load, and the removal either tab offers is the same RUN: this starts
 *  the plan and navigates to it, where the operator reads what stands at the record and approves —
 *  a deletion at the provider is never one click here. The run resolves the name in the inventory,
 *  which is the permission, so a book row the inventory no longer carries is refused with a sentence. */
export function Dns() {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("written");
  const [writes, setWrites] = useState<DnsWritesView | null>(null);
  const [data, setData] = useState<DnsInventoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getDnsWrites()
      .then((v) => setWrites(v))
      .catch((e: unknown) => setError(msg(e)));
    getDnsInventory()
      .then((v) => setData(v))
      .catch((e: unknown) => setError(msg(e)));
  }, []);

  async function remove(record: { name: string; type: DnsRecordType; found: string | null; owner: string }): Promise<void> {
    if (!window.confirm(`Remove the ${record.type} record ${record.name}? It stands at ${record.found ?? "nothing"} and is ${record.owner}'s.`)) return;
    setBusy(true);
    setError(null);
    try {
      const { runId } = await removeDnsRecord({ name: record.name, type: record.type });
      nav(`/runs/${runId}`);
    } catch (e: unknown) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  function removeDerived(row: DnsRecordRow): void {
    if (row.type === "PTR") return; // never reachable: a PTR row is listed read-only and offers no button
    void remove({ name: row.name, type: row.type, found: row.found, owner: ownerCell(row.owner) });
  }

  return (
    <section className="page">
      <header className="page__head">
        <div>
          <h2 className="page__title">DNS</h2>
        </div>
      </header>
      {error && <div className="alert alert--danger">{error}</div>}

      <div className="tabs" role="tablist" aria-label="DNS view">
        <button type="button" role="tab" id="tab-written" aria-selected={tab === "written"} aria-controls="panel-written" className={tab === "written" ? "tab tab--active" : "tab"} onClick={() => setTab("written")}>
          Written by this Manager
        </button>
        <button type="button" role="tab" id="tab-derived" aria-selected={tab === "derived"} aria-controls="panel-derived" className={tab === "derived" ? "tab tab--active" : "tab"} onClick={() => setTab("derived")}>
          Everything derived
        </button>
      </div>

      <div role="tabpanel" id="panel-written" aria-labelledby="tab-written" hidden={tab !== "written"}>
        {writes === null && !error && <p className="muted">Reading the book against the provider…</p>}
        {writes && <DnsWritesTable data={writes} busy={busy} onRemove={(r) => void remove(r)} />}
      </div>

      <div role="tabpanel" id="panel-derived" aria-labelledby="tab-derived" hidden={tab !== "derived"}>
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
                    {data.rows.map((row) => <RecordRow key={`${row.type} ${row.name}`} row={row} busy={busy} onRemove={removeDerived} />)}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </section>
  );
}
