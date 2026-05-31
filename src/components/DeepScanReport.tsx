import React from 'react';

/**
 * Renders an AuditReport from the static scanner (electron/lib/scanner).
 * Shared by the Library security-audit modal and the Security tab's
 * folder-scan panel so there's one canonical findings UI.
 */

export function severityBadge(sev: string): string {
  if (sev === 'critical') return 'badge bad';
  if (sev === 'high') return 'badge bad';
  if (sev === 'medium') return 'badge warn';
  if (sev === 'low') return 'badge';
  return 'badge';
}

export default function DeepScanReport({ report, showAll, onToggleShowAll }: {
  report: any;
  showAll: boolean;
  onToggleShowAll: () => void;
}) {
  if (!report.ok) {
    return <div className="banner warn">Scan failed: {report.error ?? 'unknown error'}</div>;
  }
  const findings: any[] = report.findings ?? [];
  const summary = report.summary ?? {};
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
            <div key={i} className="col" style={{ padding: 6, borderLeft: `3px solid ${f.severity === 'critical' || f.severity === 'high' ? 'var(--bad)' : f.severity === 'medium' ? '#d4a017' : 'var(--muted)'}`, paddingLeft: 8, background: 'var(--panel-2)', gap: 2 }}>
              <div className="row">
                <span className={severityBadge(f.severity)}>{f.severity}</span>
                <code style={{ fontSize: 11 }}>{f.rule}</code>
                <span className="label" style={{ fontSize: 11 }}>{f.file}:{f.line}</span>
              </div>
              <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text)' }}>{f.snippet}</code>
              <div className="label" style={{ fontSize: 11 }}>{f.reason}</div>
            </div>
          ))}
          {findings.length > visible.length && (
            <button onClick={onToggleShowAll} style={{ alignSelf: 'flex-start' }}>
              Show all {findings.length}
            </button>
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
