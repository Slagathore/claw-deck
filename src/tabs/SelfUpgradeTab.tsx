import React from 'react';
import UpgradesTab from './UpgradesTab';

export default function SelfUpgradeTab() {
  return (
    <div className="col">
      <div className="card">
        <b>Self-Upgrade</b> — tracks updates Claw Deck itself applies. Uses the same allowlist + hash + scan gate as the OpenClaw tab.
      </div>
      <UpgradesTab kind="self" title="Claw Deck Self-Upgrade" />
    </div>
  );
}
