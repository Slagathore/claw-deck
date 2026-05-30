import React, { useEffect, useState } from 'react';

export default function HistoryTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState('');
  async function refresh() { setRows(await window.api.history.list({ search: q })); }
  useEffect(() => { refresh(); }, []);
  return (
    <div className="col">
      <div className="row">
        <input placeholder="Search history…" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1 }} />
        <button onClick={refresh}>Search</button>
        <button onClick={async () => { await window.api.history.clear(); refresh(); }}>Clear All</button>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>When</th><th>Backend</th><th>Model</th><th>Prompt</th><th>Response</th><th></th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{new Date(r.ts).toLocaleString()}</td>
                <td>{r.backend}</td>
                <td>{r.model}</td>
                <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.prompt}</td>
                <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.response}</td>
                <td><button onClick={async () => { await window.api.history.delete(r.id); refresh(); }}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
