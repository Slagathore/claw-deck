import React, { useEffect, useState } from 'react';
import { useSettings } from '../store/ui';
import { toggleAllowlist } from '../lib/scanReview';
import DeepScanReport from '../components/DeepScanReport';

export default function SecurityTab() {
  const { data: s, save } = useSettings();
  const allowlist = new Set<string>(s.scanAllowlist ?? []);
  const toggleIgnore = (fp: string) => save({ scanAllowlist: toggleAllowlist(s.scanAllowlist ?? [], fp) });
  const [rows, setRows] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<any | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => { window.api.security.auditLog().then(setRows); }, []);

  async function scanFolder() {
    setScanning(true);
    setReport(null);
    try {
      const r = await window.api.audit.pickAndScan();
      setReport(r);
    } catch (e: any) {
      setReport({ ok: false, error: e?.message ?? String(e) });
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="col">
      <div className="card col">
        <div className="row">
          <strong>Deep file scan</strong>
          <span className="label" style={{ color: 'var(--muted)' }}>
            Walk any folder for risky JS/TS patterns (eval, child_process, secret reads, obfuscation, exfil endpoints).
          </span>
          <div style={{ flex: 1 }} />
          <button className="primary" onClick={scanFolder} disabled={scanning}>
            {scanning ? 'Scanning…' : '📂 Pick folder & scan'}
          </button>
        </div>
        <div className="label">
          Same engine used by the upgrade gate and the Library security audit. Use it on a downloaded
          extension, an npm package, or any source tree before you trust it.
        </div>
        {report && <DeepScanReport report={report} showAll={showAll} onToggleShowAll={() => setShowAll(v => !v)} allowlist={allowlist} onToggleIgnore={toggleIgnore} />}
      </div>

      <div className="card">
        <b>Tamper-evident audit log</b> — every entry hash-chained to the previous. Any modification breaks the chain.
      </div>
      <div className="card">
        <table>
          <thead><tr><th>When</th><th>Kind</th><th>Hash</th><th>Payload</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{new Date(r.ts).toLocaleString()}</td>
                <td>{r.kind}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 10 }}>{r.hash?.slice(0, 16)}…</td>
                <td style={{ maxWidth: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.payload}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
