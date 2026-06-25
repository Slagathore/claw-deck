import React from 'react';
import { useWorkspaces } from '../store/workspaces';
import { atlas } from '../lib/atlasClient';

/** Open-folders tab strip. "Open folder" → new workspace + kicks the Atlas index. */
export default function WorkspaceTabs() {
  const { workspaces, active, add, setActive, remove } = useWorkspaces();

  async function open() {
    const p = await window.api.app.pickPath({ properties: ['openDirectory'] });
    if (!p) return;
    add(p);
    const o = await atlas.open(p);
    if (o.ok) atlas.index(p); // background; auto-enrichment follows
  }

  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
      {workspaces.map((w) => (
        <span key={w.path} className={`tab-btn ${active === w.path ? 'active' : ''}`} style={{ cursor: 'pointer', padding: '4px 10px' }} onClick={() => setActive(w.path)} title={w.path}>
          📁 {w.name}
          <button onClick={(e) => { e.stopPropagation(); atlas.close(w.path); remove(w.path); }} style={{ marginLeft: 8, padding: '0 4px' }}>×</button>
        </span>
      ))}
      <button onClick={open}>+ Open folder</button>
    </div>
  );
}
