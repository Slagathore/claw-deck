import React, { useEffect, useMemo, useState } from 'react';
import { useUI } from '../store/ui';
import { extractVariables, applyVariables } from '../lib/promptVault';

interface Prompt {
  id: number;
  name: string;
  template: string;
  tags: string;
  defaults: string;
  updated_at: number;
}

interface Draft {
  id?: number;
  name: string;
  template: string;
  tags: string;
  defaults: Record<string, string>;
}

const EMPTY: Draft = { name: '', template: '', tags: '', defaults: {} };

function parseDefaults(s: string): Record<string, string> {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}
function parseTags(s: string): string[] {
  try { return JSON.parse(s || '[]'); } catch { return []; }
}

export default function PromptVaultTab() {
  const branch = useUI(s => s.branchFromHistory);
  const [items, setItems] = useState<Prompt[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [filter, setFilter] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});

  async function reload() {
    const list = await window.api.prompts.list();
    setItems(list);
  }
  useEffect(() => { reload(); }, []);

  const vis = useMemo(
    () => items.filter(p => !filter || p.name.toLowerCase().includes(filter.toLowerCase()) || p.template.toLowerCase().includes(filter.toLowerCase())),
    [items, filter]
  );

  const detected = useMemo(() => extractVariables(draft.template), [draft.template]);
  const preview = useMemo(() => applyVariables(draft.template, { ...draft.defaults, ...vars }), [draft.template, draft.defaults, vars]);

  function loadIntoDraft(p: Prompt) {
    setDraft({
      id: p.id,
      name: p.name,
      template: p.template,
      tags: parseTags(p.tags).join(', '),
      defaults: parseDefaults(p.defaults)
    });
    setVars({});
  }

  async function save() {
    if (!draft.name.trim() || !draft.template.trim()) return;
    const id = await window.api.prompts.upsert({
      id: draft.id,
      name: draft.name.trim(),
      template: draft.template,
      tags: draft.tags.split(',').map(t => t.trim()).filter(Boolean),
      defaults: draft.defaults
    });
    await reload();
    setDraft(d => ({ ...d, id: id as number }));
  }

  async function remove(id: number) {
    if (!confirm('Delete this prompt?')) return;
    await window.api.prompts.delete(id);
    if (draft.id === id) setDraft(EMPTY);
    reload();
  }

  function useInChat() {
    if (!preview.trim()) return;
    branch(preview);
  }

  return (
    <div className="tab-pad" style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 12, height: '100%' }}>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="row">
          <input placeholder="filter" value={filter} onChange={e => setFilter(e.target.value)} style={{ flex: 1 }} />
          <button onClick={() => { setDraft(EMPTY); setVars({}); }}>+ New</button>
        </div>
        <div style={{ overflow: 'auto', marginTop: 8 }}>
          {vis.length === 0 && <div className="label" style={{ padding: 8 }}>No prompts yet.</div>}
          {vis.map(p => (
            <div key={p.id} className="row" style={{ borderBottom: '1px solid #1c2030', padding: '6px 4px' }}>
              <button onClick={() => loadIntoDraft(p)} style={{ flex: 1, textAlign: 'left' }}>
                <strong>{p.name}</strong>
                <div className="label" style={{ marginTop: 2 }}>{parseTags(p.tags).join(' · ') || 'no tags'}</div>
              </button>
              <button onClick={() => remove(p.id)} title="delete">×</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
        <label className="label">Name</label>
        <input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="e.g. Code review" />
        <label className="label" style={{ marginTop: 8 }}>Tags (comma-separated)</label>
        <input value={draft.tags} onChange={e => setDraft(d => ({ ...d, tags: e.target.value }))} placeholder="review, dev" />
        <label className="label" style={{ marginTop: 8 }}>Template (use {'{{var}}'} placeholders)</label>
        <textarea
          value={draft.template}
          onChange={e => setDraft(d => ({ ...d, template: e.target.value }))}
          rows={10}
          placeholder="Review the following {{language}} code and suggest improvements:\n\n{{code}}"
          style={{ fontFamily: 'monospace' }}
        />

        {detected.length > 0 && (
          <>
            <label className="label" style={{ marginTop: 12 }}>Variables</label>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr', gap: 6, alignItems: 'center' }}>
              <div className="label">name</div>
              <div className="label">default (saved with prompt)</div>
              <div className="label">value (this run only)</div>
              {detected.map(v => (
                <React.Fragment key={v}>
                  <code>{v}</code>
                  <input
                    value={draft.defaults[v] ?? ''}
                    onChange={e => setDraft(d => ({ ...d, defaults: { ...d.defaults, [v]: e.target.value } }))}
                  />
                  <input value={vars[v] ?? ''} onChange={e => setVars(s => ({ ...s, [v]: e.target.value }))} />
                </React.Fragment>
              ))}
            </div>
          </>
        )}

        <label className="label" style={{ marginTop: 12 }}>Preview</label>
        <pre style={{ background: '#0c0f17', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap', minHeight: 80 }}>{preview || <span className="label">(empty)</span>}</pre>

        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={save} disabled={!draft.name.trim() || !draft.template.trim()}>{draft.id ? 'Save changes' : 'Save new prompt'}</button>
          <button onClick={useInChat} disabled={!preview.trim()}>Use in Chat →</button>
        </div>
      </div>
    </div>
  );
}
