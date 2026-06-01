import React from 'react';
import { worstSeverity, SeverityCounts } from '../lib/scanReview';

/**
 * Compact at-a-glance verdict from the last security scan of an item, so risk is
 * visible on a Library/Skills row without opening the scan modal. Reads a cached
 * effective summary (post allowlist + rule overrides, as of the last scan).
 */
export default function RiskBadge({ entry }: { entry?: { counts: SeverityCounts; ignored: number; at: number } }) {
  if (!entry) return null;
  const c = entry.counts;
  const worst = worstSeverity(c);
  const total = c.critical + c.high + c.medium + c.low + c.info;
  const cls = worst === 'critical' || worst === 'high' ? 'badge bad' : worst === 'medium' ? 'badge warn' : 'badge';
  const when = new Date(entry.at).toLocaleString();
  const label = worst === 'clean'
    ? '🛡 clean'
    : `🛡 ${c[worst as keyof SeverityCounts]} ${worst}`;
  const title = `Last scan ${when}: ${total} finding${total === 1 ? '' : 's'}` +
    (entry.ignored ? `, ${entry.ignored} ignored` : '') + ` (worst: ${worst})`;
  return (
    <span className={cls} title={title}>
      {label}{entry.ignored ? ` · ${entry.ignored} ignored` : ''}
    </span>
  );
}
