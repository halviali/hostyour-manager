import { Link } from "react-router";
import type { DnsRecordType, DnsVerdict, DnsWriteRow, DnsWritesView } from "../../../shared/dns.ts";

// The first tab of the DNS page: the book of what this Manager wrote. One row per record a run
// here inserted or updated, with the run that did it and what stands under the name now. The
// inventory (the second tab) lists everything the installation could own; this lists only what a run
// changed, which is what an operator checking a day's work wants first (hostyour-manager#171).

/** The three verdicts in the operator's words, and the one for a row nobody could read. */
const VERDICT_LABEL: Record<DnsVerdict, string> = { standing: "standing", absent: "absent", other: "other content" };

export function writeOwnerCell(owner: DnsWriteRow["owner"]): string {
  return owner.stage === undefined ? `${owner.kind} ${owner.name}` : `${owner.kind} ${owner.name} (${owner.stage})`;
}

function WriteRow({ row, busy, onRemove }: { row: DnsWriteRow; busy: boolean; onRemove: (row: DnsWriteRow) => void }) {
  return (
    <tr>
      <td><span className={row.act === "inserted" ? "chip chip--ok" : "chip"}>{row.act}</span></td>
      <td>{writeOwnerCell(row.owner)}</td>
      <td className="mono">{row.name}</td>
      <td>{row.type}</td>
      <td className="mono">{row.content}</td>
      <td><Link className="mono" to={`/runs/${row.runId}`}>{row.runId}</Link></td>
      <td>{new Date(row.writtenAt).toLocaleString()}</td>
      <td>
        {row.verdict === null
          ? <span className="muted">not read</span>
          : <span className={row.verdict === "standing" ? "chip chip--ok" : "chip chip--warn"} title={row.found ?? "no record stands under the name"}>{VERDICT_LABEL[row.verdict]}</span>}
      </td>
      <td><button type="button" className="btn" disabled={busy} onClick={() => onRemove(row)}>Remove</button></td>
    </tr>
  );
}

export function DnsWritesTable({ data, busy, onRemove }: { data: DnsWritesView; busy: boolean; onRemove: (record: { name: string; type: DnsRecordType; found: string | null; owner: string }) => void }) {
  return (
    <>
      {data.skipped.map((why) => <div key={why} className="alert alert--warn">{why}</div>)}
      <section className="card">
        <h3 className="page__title">
          {data.rows.length} record{data.rows.length === 1 ? "" : "s"} written by this Manager{" "}
          <span className="muted">· read {new Date(data.readAt).toLocaleTimeString()}</span>
        </h3>
        {data.rows.length === 0 && <p className="muted">No run of this Manager has inserted or updated a DNS record yet.</p>}
        {data.rows.length > 0 && (
          <div className="table__wrap">
            <table className="table">
              <thead>
                <tr><th>Act</th><th>Owner</th><th>Name</th><th>Type</th><th>Content</th><th>Run</th><th>Written</th><th>Now</th><th /></tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <WriteRow
                    key={`${row.type} ${row.name}`}
                    row={row}
                    busy={busy}
                    onRemove={(r) => onRemove({ name: r.name, type: r.type, found: r.found, owner: writeOwnerCell(r.owner) })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
