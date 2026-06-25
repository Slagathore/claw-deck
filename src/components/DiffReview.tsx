import React, { useState } from 'react';

type SandboxResult = import('../../electron/selfUpgrade/sandbox').SandboxResult;

export interface Proposal { runId: string; plan: string; diff: string }

/**
 * Renders the two mandated artifacts (CHANGE_PLAN.md + changes.diff) with a
 * Validate → Approve / Reject flow (BOOTSTRAP §3 Phase 2). Approve merges onto
 * the live tree; Reject discards the worktree. Used standalone now and wired
 * into the Council tab in Phase 4.
 */
export default function DiffReview({ proposal, onResolved }: { proposal: Proposal; onResolved?: (action: 'approved' | 'rejected') => void }) {
  const [validation, setValidation] = useState<SandboxResult | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState<'approved' | 'rejected' | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);

  async function validate() {
    setBusy('Validating (npm ci + npm test in sandbox)…'); setErr('');
    const r = await window.api.exec.validate(proposal.runId);
    setBusy('');
    if (!r.ok) { setErr(r.error ?? 'validate failed'); return; }
    setValidation(r.result ?? null);
  }
  async function approve() {
    setBusy('Applying to live tree…'); setErr('');
    const r = await window.api.exec.approve(proposal.runId);
    setBusy('');
    if (!r.ok) { setErr(r.error ?? 'approve failed'); return; }
    setSnapshotId(r.snapshotId ?? null);
    setDone('approved');
  }
  async function reject() {
    setBusy('Discarding worktree…'); setErr('');
    const r = await window.api.exec.reject(proposal.runId);
    setBusy('');
    if (!r.ok) { setErr(r.error ?? 'reject failed'); return; }
    setDone('rejected'); onResolved?.('rejected');
  }
  async function rollback() {
    if (!snapshotId) return;
    setBusy('Rolling back snapshot…'); setErr('');
    const r = await window.api.exec.rollback(snapshotId);
    setBusy('');
    if (!r.ok) setErr(r.error ?? 'rollback failed');
    else setDone('rejected');
  }

  const lines = (proposal.diff || '(no changes)').split('\n');
  const colorOf = (l: string) => l.startsWith('+') && !l.startsWith('+++') ? 'var(--good)'
    : l.startsWith('-') && !l.startsWith('---') ? 'var(--bad)'
    : l.startsWith('@@') ? 'var(--accent)' : l.startsWith('diff ') || l.startsWith('index ') ? 'var(--muted)' : 'var(--text)';

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="card col" style={{ gap: 6 }}>
        <strong>CHANGE_PLAN.md</strong>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{proposal.plan || '(no plan provided)'}</pre>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}><strong>changes.diff</strong> <span style={{ color: 'var(--muted)', fontSize: 11 }}>({lines.length} lines)</span></div>
        <pre style={{ margin: 0, padding: 12, overflow: 'auto', maxHeight: 360, fontSize: 12, lineHeight: 1.4 }}>
          {lines.map((l, i) => <div key={i} style={{ color: colorOf(l), whiteSpace: 'pre' }}>{l || ' '}</div>)}
        </pre>
      </div>

      {validation && (
        <div className="card col" style={{ gap: 4 }}>
          <div className="row">
            <strong>Validation</strong>
            <span className={`badge ${validation.ok ? 'ok' : 'bad'}`}>{validation.ok ? 'tests passed' : 'failed'}</span>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>{validation.mode}{validation.reason ? ` · ${validation.reason}` : ''} · {validation.durationMs}ms</span>
          </div>
          {validation.testOutput && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 160, overflow: 'auto', color: 'var(--muted)' }}>{validation.testOutput.slice(-4000)}</pre>}
        </div>
      )}

      {err && <div className="card" style={{ color: 'var(--bad)', fontSize: 12 }}>{err}</div>}
      {busy && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{busy}</div>}

      {done ? (
        <div className="row">
          <div className={`badge ${done === 'approved' ? 'ok' : 'bad'}`}>{done === 'approved' ? '✓ merged onto live tree' : '✗ rejected — worktree discarded'}</div>
          {snapshotId && <button onClick={rollback} disabled={!!busy} title={`Restore ${snapshotId}`}>Rollback snapshot</button>}
        </div>
      ) : (
        <div className="row">
          <button onClick={validate} disabled={!!busy}>Validate</button>
          <button onClick={approve} disabled={!!busy || validation?.ok !== true} title={validation?.ok ? 'Create rollback snapshot and apply to live tree' : 'Run validation first'} style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>Approve &amp; merge</button>
          <button onClick={reject} disabled={!!busy} style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>Reject</button>
        </div>
      )}
    </div>
  );
}
