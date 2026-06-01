import React, { useState } from 'react';
import {
  findingFingerprint, effectiveSummary, ignoredCount, effectiveSeverity,
  RuleOverride, RuleOverrides
} from '../lib/scanReview';
import { RULE_INFO } from '../lib/ruleInfo';

/**
 * Renders an AuditReport from the static scanner (electron/lib/scanner).
 * Shared by the Library audit modal, the Skills scan modal, and the Security
 * tab's folder-scan panel.
 *
 *  - `allowlist` + `onToggleIgnore` (+ `scope`): per-package Ignore of a finding.
 *  - `overrides` + `onSetOverride`: global per-rule severity override (downgrade
 *    or disable a noisy rule) with a saved justification.
 *  Headline counts and the install-block decision use the *effective* severities.
 */

export function severityBadge(sev: string): string {
  if (sev === 'critical' || sev === 'high') return 'badge bad';
  if (sev === 'medium') return 'badge warn';
  return 'badge';
}

export default function DeepScanReport({ report, showAll, onToggleShowAll, allowlist, onToggleIgnore, scope = '', overrides, onSetOverride }: {
  report: any;
  showAll: boolean;
  onToggleShowAll: () => void;
  allowlist?: ReadonlySet<string>;
  onToggleIgnore?: (fp: string) => void;
  scope?: string;
  overrides?: RuleOverrides;
  onSetOverride?: (rule: string, ov: RuleOverride | null) => void;
}) {
  if (!report.ok) {
    return <div className="banner warn">Scan failed: {report.error ?? 'unknown error'}</div>;
  }
  const findings: any[] = report.findings ?? [];
  const al = allowlist ?? new Set<string>();
  const ov = overrides ?? {};
  const summary = allowlist ? effectiveSummary(scope, findings, al, ov) : (report.summary ?? {});
  const ignored = allowlist ? ignoredCount(scope, findings, al) : 0;
  const visible = showAll ? findings : findings.slice(0, 25);
  const worst = ['critical', 'high', 'medium', 'low', 'info'].find(s => (summary[s] ?? 0) > 0);

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="badge ok">{report.fileCount} files</span>
        <span className="badge">{Math.round((report.bytesScanned ?? 0) / 1024)} KB scanned</span>
        <span className="badge">{report.durationMs} ms</span>
        {summary.critical > 0 && <span className="badge bad">{summary.critical} critical</span>}
        {summary.high > 0 && <span className="badge bad">{summary.high} high</span>}
        {summary.medium > 0 && <span className="badge warn">{summary.medium} medium</span>}
        {summary.low > 0 && <span className="badge">{summary.low} low</span>}
        {summary.info > 0 && <span className="badge">{summary.info} info</span>}
        {ignored > 0 && <span className="badge" title="Allowlisted findings excluded from the counts above">{ignored} ignored</span>}
        {findings.length === 0 && <span className="badge ok">no risky patterns matched</span>}
      </div>

      {report.manifest && (
        <div className="col" style={{ gap: 2, padding: 8, background: 'var(--panel-2)', borderRadius: 4 }}>
          <div className="label"><strong>{report.manifest.name ?? '(unnamed)'}</strong> v{report.manifest.version ?? '?'} · {report.manifest.license ?? 'no license'}</div>
          <div className="label" style={{ fontSize: 10, wordBreak: 'break-all' }}>{report.manifest.hash}</div>
          {report.manifest.scripts && Object.keys(report.manifest.scripts).length > 0 && (
            <div className="label">
              Scripts: {Object.keys(report.manifest.scripts).join(', ')}
              {(report.manifest.scripts.preinstall || report.manifest.scripts.install || report.manifest.scripts.postinstall) &&
                <span className="badge warn" style={{ marginLeft: 6 }}>lifecycle hook present</span>}
            </div>
          )}
          {report.manifest.dependencies && (
            <div className="label">{Object.keys(report.manifest.dependencies).length} runtime deps</div>
          )}
        </div>
      )}

      {findings.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <div className="label" style={{ color: 'var(--muted)' }}>
            Findings (worst first; {showAll ? 'showing all' : `showing first ${visible.length} of ${findings.length}`})
          </div>
          {visible.map((f, i) => (
            <FindingRow
              key={i}
              f={f}
              fp={findingFingerprint(scope, f)}
              isIgnored={al.has(findingFingerprint(scope, f))}
              overrides={ov}
              onToggleIgnore={onToggleIgnore}
              onSetOverride={onSetOverride}
            />
          ))}
          {findings.length > visible.length && (
            <button onClick={onToggleShowAll} style={{ alignSelf: 'flex-start' }}>Show all {findings.length}</button>
          )}
          {showAll && findings.length > 25 && (
            <button onClick={onToggleShowAll} style={{ alignSelf: 'flex-start' }}>Collapse</button>
          )}
        </div>
      )}

      {findings.length === 0 && worst === undefined && (
        <div className="label" style={{ color: 'var(--ok)' }}>
          ✓ No matches for the built-in rule set. This is NOT proof the code is safe — only that the static checks didn't fire.
        </div>
      )}
    </div>
  );
}

function FindingRow({ f, fp, isIgnored, overrides, onToggleIgnore, onSetOverride }: {
  f: any;
  fp: string;
  isIgnored: boolean;
  overrides: RuleOverrides;
  onToggleIgnore?: (fp: string) => void;
  onSetOverride?: (rule: string, ov: RuleOverride | null) => void;
}) {
  const [whyShown, setWhyShown] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const current = overrides[f.rule];
  const eff = effectiveSeverity(f, overrides);          // may be 'off'
  const overridden = !!current;
  const isOff = eff === 'off';
  const why = RULE_INFO[f.rule];
  const dimmed = isIgnored || isOff;

  const [sevDraft, setSevDraft] = useState<string>(current?.severity ?? 'keep');
  const [noteDraft, setNoteDraft] = useState<string>(current?.note ?? '');

  const accent = dimmed ? 'var(--muted)'
    : (eff === 'critical' || eff === 'high') ? 'var(--bad)'
    : eff === 'medium' ? '#d4a017' : 'var(--muted)';

  return (
    <div className="col" style={{ padding: 6, borderLeft: `3px solid ${accent}`, paddingLeft: 8, background: 'var(--panel-2)', gap: 2, opacity: dimmed ? 0.55 : 1 }}>
      <div className="row">
        {isOff
          ? <span className="badge" title={`Rule disabled globally (was ${f.severity})`}>rule off</span>
          : <span className={severityBadge(eff)}>{eff}{overridden ? '*' : ''}</span>}
        {overridden && !isOff && <span className="label" style={{ fontSize: 10 }} title={current?.note || `overridden from ${f.severity}`}>(was {f.severity})</span>}
        <code style={{ fontSize: 11 }}>{f.rule}</code>
        <span className="label" style={{ fontSize: 11 }}>{f.file}:{f.line}</span>
        {isIgnored && <span className="badge" title="On your allowlist for this package — excluded from counts">ignored</span>}
        <div style={{ flex: 1 }} />
        {onSetOverride && (
          <button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEditorOpen(o => !o)} title="Globally downgrade or disable this rule (with a note)">
            rule {editorOpen ? '▴' : '▾'}
          </button>
        )}
        {onToggleIgnore && (
          <button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => onToggleIgnore(fp)}
            title={isIgnored ? 'Stop ignoring (this package only)' : 'Mark as a trusted false-positive for this package only (persists; other packages still flag it)'}>
            {isIgnored ? 'Un-ignore' : 'Ignore'}
          </button>
        )}
      </div>

      <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text)', textDecoration: dimmed ? 'line-through' : 'none' }}>{f.snippet}</code>

      <div className="label" style={{ fontSize: 11 }}>
        {f.reason}
        {why && <> <a href="#" onClick={e => { e.preventDefault(); setWhyShown(v => !v); }} style={{ whiteSpace: 'nowrap' }}>{whyShown ? 'why? ▴' : 'why? ▾'}</a></>}
      </div>
      {why && whyShown && (
        <div className="label" style={{ fontSize: 11, background: 'var(--bg)', borderRadius: 4, padding: 6, lineHeight: 1.45 }}>{why}</div>
      )}

      {editorOpen && onSetOverride && (
        <div className="col" style={{ gap: 6, background: 'var(--bg)', borderRadius: 4, padding: 8 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="label">Globally treat <code>{f.rule}</code> as:</span>
            <select value={sevDraft} onChange={e => setSevDraft(e.target.value)}>
              <option value="keep">keep ({f.severity})</option>
              <option value="info">info</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="critical">critical</option>
              <option value="off">off (disable rule)</option>
            </select>
          </div>
          <input placeholder="justification (optional, saved with the override)" value={noteDraft} onChange={e => setNoteDraft(e.target.value)} />
          <div className="row">
            <button className="primary" onClick={() => {
              onSetOverride(f.rule, sevDraft === 'keep' ? null : { severity: sevDraft as RuleOverride['severity'], note: noteDraft.trim() || undefined });
              setEditorOpen(false);
            }}>Apply</button>
            {overridden && <button onClick={() => { onSetOverride(f.rule, null); setSevDraft('keep'); setEditorOpen(false); }}>Reset to default</button>}
            <button onClick={() => setEditorOpen(false)}>Cancel</button>
            <span className="label">Applies to <code>{f.rule}</code> in every scan, not just this one.</span>
          </div>
        </div>
      )}
    </div>
  );
}
