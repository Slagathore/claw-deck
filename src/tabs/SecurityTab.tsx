import React, { useEffect, useState } from 'react';

export default function SecurityTab() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { window.api.security.auditLog().then(setRows); }, []);
  return (
    <div className="col">
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
                <td style={{ fontFamily: 'monospace', fontSize: 10 }}>{r.hash.slice(0, 16)}…</td>
                <td style={{ maxWidth: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.payload}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
