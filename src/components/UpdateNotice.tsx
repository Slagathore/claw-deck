import React, { useEffect, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { evaluateUpdate, type UpdateEvaluation, type UpdatePrefs } from '../lib/autoUpdate';

/**
 * On-load update visibility. Checks the self-update feed once after settings
 * load and, if a newer release exists, shows a banner — unless the user has
 * silenced it ("Later" = snooze until a newer version; "Don't remind me" =
 * mute forever). An EMERGENCY release (marked in its notes) overrides both and
 * shows a blocking message. See src/lib/autoUpdate.ts for the marker format.
 */
export default function UpdateNotice() {
  const setTab = useUI((u) => u.setTab);
  const { data: s, loaded, save } = useSettings();
  const [result, setResult] = useState<UpdateEvaluation | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    (async () => {
      try {
        if (s.airgapped) return; // respect air-gapped mode — no outbound polling
        const [verInfo, check] = await Promise.all([
          window.api.app.version(),
          window.api.upgrades.check('self'),
        ]);
        if (cancelled) return;
        const current = (typeof verInfo === 'string' ? verInfo : verInfo?.version) || '0.0.0';
        const prefs: UpdatePrefs = s.updatePrefs ?? {};
        setResult(evaluateUpdate(check?.candidates ?? [], current, prefs));
      } catch {
        /* offline / no feed configured — stay quiet */
      }
    })();
    return () => { cancelled = true; };
    // Run once per launch after settings load.
  }, [loaded]);

  if (!result || dismissed) return null;
  const { show, latest, emergency } = result;
  if (show === 'none' || !latest) return null;

  const persist = (patch: UpdatePrefs) =>
    save({ updatePrefs: { ...(s.updatePrefs ?? {}), ...patch } });

  if (show === 'emergency') {
    return (
      <div className="wizard-backdrop">
        <div className="wizard update-emergency">
          <h2>⚠️ Important update — v{latest.version}</h2>
          <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{emergency?.message}</p>
          <div className="wizard-foot">
            <button className="primary" onClick={() => { setTab('self'); setDismissed(true); }}>
              Update now
            </button>
            <span className="spacer" />
            <button onClick={() => setDismissed(true)}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="update-banner">
      <span>
        🔄 <strong>Update available</strong> — v{latest.version}
        {latest.name ? ` · ${latest.name}` : ''}
      </span>
      <span className="spacer" />
      <button className="primary" onClick={() => { setTab('self'); setDismissed(true); }}>View</button>
      <button title="Remind me when a newer version ships"
        onClick={() => { persist({ snoozedVersion: latest.version }); setDismissed(true); }}>
        Later
      </button>
      <button title="Never show update notices again"
        onClick={() => { persist({ muteForever: true }); setDismissed(true); }}>
        Don't remind me
      </button>
    </div>
  );
}
