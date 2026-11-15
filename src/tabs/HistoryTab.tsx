import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { useChat } from '../store/chat';
import type { MessageRow, ThreadKind, ThreadRow } from '../../electron/memory/store';

type KindFilter = 'all' | ThreadKind;
type IndexStatus = Awaited<ReturnType<typeof window.api.threads.indexStatus>>;

const when = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

/**
 * History: every saved thread with its full transcript. Search covers message
 * text by keyword and, once an embedding model is pulled, by meaning. A thread
 * can be reopened in Chat to continue it, or branched from any message.
 */
export default function HistoryTab() {
  const { data: s } = useSettings();
  const setTab = useUI(u => u.setTab);
  const reusePrompt = useUI(u => u.branchFromHistory);
  const activeThreadId = useChat(c => c.threadId);

  const [rows, setRows] = useState<ThreadRow[]>([]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [selId, setSelId] = useState<string | null>(activeThreadId);
  const [detail, setDetail] = useState<{ thread: ThreadRow; messages: MessageRow[] } | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const searchSeq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++searchSeq.current;
    setLoading(true);
    try {
      const list = await window.api.threads.list({ search: q.trim() || undefined, kind: kind === 'all' ? undefined : kind, limit: 300 });
      if (mine === searchSeq.current) setRows(list);
    } finally {
      if (mine === searchSeq.current) setLoading(false);
    }
  }, [q, kind]);

  // Search as you type (debounced); an empty box lists everything, newest first.
  useEffect(() => {
    const t = setTimeout(refresh, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [refresh, q]);

  const loadStatus = useCallback(() => { window.api.threads.indexStatus().then(setStatus).catch(() => { /* ignore */ }); }, []);
  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 4000);
    return () => clearInterval(t);
  }, [loadStatus]);

  // Default to the first thread once the list arrives.
  useEffect(() => {
    if (!selId && rows.length) setSelId(rows[0].id);
  }, [rows, selId]);

  useEffect(() => {
    let cancelled = false;
    if (!selId) { setDetail(null); return; }
    window.api.threads.get(selId).then(d => { if (!cancelled) setDetail(d); });
    return () => { cancelled = true; };
  }, [selId]);

  async function openInChat(id: string) {
    if (await useChat.getState().openThread(id)) setTab('chat');
  }

  async function branch(id: string, uptoSeq?: number) {
    const t = await window.api.threads.branch(id, uptoSeq);
    if (t) await openInChat(t.id);
  }

  async function remove(id: string) {
    await window.api.threads.delete(id);
    useChat.getState().forgetThread(id);
    if (selId === id) setSelId(null);
    refresh();
    loadStatus();
  }

  async function clearAll() {
    if (!window.confirm('Delete every saved thread? This removes all chat, agent, and console history and cannot be undone.')) return;
    await window.api.threads.clear();
    useChat.getState().forgetThread();
    setSelId(null);
    refresh();
    loadStatus();
  }

  async function saveTitle() {
    if (!detail || renaming == null) return;
    const title = renaming.trim() || 'Untitled chat';
    await window.api.threads.update(detail.thread.id, { title });
    setDetail({ ...detail, thread: { ...detail.thread, title } });
    setRows(rs => rs.map(r => r.id === detail.thread.id ? { ...r, title } : r));
    if (activeThreadId === detail.thread.id) useChat.setState({ title });
    setRenaming(null);
  }

  const pending = status ? status.chunks - status.embedded : 0;

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="row">
        <input placeholder="Search every conversation (keywords or meaning)…" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1 }} />
        <select value={kind} onChange={e => setKind(e.target.value as KindFilter)} title="Which kind of thread to list">
          <option value="all">All threads</option>
          <option value="chat">Chats and agent runs</option>
          <option value="console">Console sessions</option>
        </select>
        <button onClick={clearAll} disabled={!rows.length && !q}>Clear all</button>
      </div>

      <div className="history" style={{ flex: 1 }}>
        <div className="card threads">
          {rows.length === 0 && (
            <div className="label" style={{ padding: 8 }}>
              {loading ? 'Searching…' : q ? 'Nothing matched that search.' : 'No saved threads yet. Anything you send in Chat is saved here automatically.'}
            </div>
          )}
          {rows.map(r => (
            <button key={r.id} className={`thread-item ${selId === r.id ? 'sel' : ''}`} onClick={() => { setSelId(r.id); setRenaming(null); }}>
              <span className="t-title">{r.title || 'Untitled chat'}</span>
              <span className="t-sub">
                <span>{when(r.updated)}</span>
                {r.kind === 'console' ? <span className="badge">console</span> : r.agent ? <span className="badge ok">agent</span> : null}
                {r.id === activeThreadId && <span className="badge ok">open in Chat</span>}
                <span>{r.messageCount ?? 0} msg</span>
              </span>
              {(r.snippet || r.preview) && <span className="t-snip">{r.snippet || r.preview}</span>}
            </button>
          ))}
        </div>

        <div className="card transcript">
          {!detail && <div className="label">Pick a thread on the left to read it.</div>}
          {detail && (
            <>
              <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
                {renaming != null ? (
                  <>
                    <input autoFocus value={renaming} onChange={e => setRenaming(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setRenaming(null); }} style={{ flex: 1, minWidth: 200 }} />
                    <button className="primary" onClick={saveTitle}>Save</button>
                    <button onClick={() => setRenaming(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <strong style={{ flex: 1, minWidth: 200 }}>{detail.thread.title || 'Untitled chat'}</strong>
                    {detail.thread.kind === 'chat' && (
                      <button className="primary" onClick={() => openInChat(detail.thread.id)} title="Open this thread in Chat and keep going where it left off">
                        ▶ Continue in Chat
                      </button>
                    )}
                    {detail.thread.kind === 'chat' && (
                      <button onClick={() => branch(detail.thread.id)} title="Copy the whole thread into a new one and open it in Chat">⑂ Branch</button>
                    )}
                    <button onClick={() => setRenaming(detail.thread.title)}>Rename</button>
                    <button onClick={() => remove(detail.thread.id)} title="Delete this thread">Delete</button>
                  </>
                )}
              </div>
              <div className="label" style={{ marginBottom: 10 }}>
                Started {new Date(detail.thread.created).toLocaleString()} · last activity {new Date(detail.thread.updated).toLocaleString()}
                {detail.thread.model ? ` · ${detail.thread.model}` : ''} · {detail.messages.length} messages
              </div>
              {detail.messages.map(m => (
                <div key={m.id} className="turn">
                  <div className={`msg ${m.role}`}>
                    <div className="label" style={{ marginBottom: 4 }}>
                      {m.role}{m.meta?.model ? ` · ${m.meta.model}` : ''} · {new Date(m.ts).toLocaleString()}
                    </div>
                    {m.content}
                    {m.images.length > 0 && (
                      <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                        {m.images.map((u, j) => <img key={j} src={u} className="thumb" />)}
                      </div>
                    )}
                  </div>
                  {s.showThinking && m.thinking && <div className="thinking"><b>thinking:</b> {m.thinking}</div>}
                  {detail.thread.kind === 'chat' && (
                    <div className="msg-tools">
                      {m.role === 'user' && !m.content.startsWith('[plan-results]') && (
                        <button onClick={() => reusePrompt(m.content)} title="Put this prompt in the Chat box">↳ Reuse prompt</button>
                      )}
                      <button onClick={() => branch(detail.thread.id, m.seq)} title="New thread containing everything up to and including this message">⑂ Branch from here</button>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {status && (
        <div className="row label" style={{ flexWrap: 'wrap' }}>
          <span>{status.threads} threads · {status.messages} messages</span>
          <span title="Passages with an embedding, out of all indexed passages. Keyword search covers everything either way.">
            semantic index: {status.embedded}/{status.chunks} passages ({status.model})
          </span>
          {status.running && <span className="badge warn">indexing…</span>}
          {!status.running && pending > 0 && <button onClick={() => { window.api.threads.reindex(); setTimeout(loadStatus, 800); }}>Index now</button>}
          {status.available === false && <span style={{ color: 'var(--warn)' }}>{status.lastError || 'Embedding model unavailable; search is keyword only.'}</span>}
        </div>
      )}
    </div>
  );
}
