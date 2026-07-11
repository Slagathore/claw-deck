/**
 * Helpers for choosing the right Claw Deck release asset for the current
 * platform/architecture. Used by the SelfUpgradeTab "Auto-install" path.
 *
 * We intentionally avoid renderer-side fetching here — the candidate list
 * comes from the upgrades:check IPC, which already passed allowlist/policy
 * checks. These helpers just pick the right asset URL.
 */

export type Platform = 'win32' | 'darwin' | 'linux';
export type Arch = 'x64' | 'arm64' | 'ia32';

export interface ReleaseAsset {
  name: string;
  url: string;
  sha256?: string;
  signature?: string;
  size?: number;
}

export interface ReleaseCandidate {
  tag: string;
  version: string;
  name?: string;
  body?: string;
  publishedAt?: string;
  assets: ReleaseAsset[];
}

const PLATFORM_HINTS: Record<Platform, RegExp[]> = {
  win32: [/\.exe$/i, /windows/i, /win\b/i, /win32/i],
  darwin: [/\.dmg$/i, /\.zip$/i, /mac\b/i, /darwin/i, /osx/i],
  linux: [/\.AppImage$/i, /\.deb$/i, /\.rpm$/i, /linux/i]
};

const ARCH_HINTS: Record<Arch, RegExp[]> = {
  x64: [/x64/i, /amd64/i, /win64/i],
  arm64: [/arm64/i, /aarch64/i],
  ia32: [/ia32/i, /x86\b/i, /win32(?!_)/i]
};

const INSTALLER_PRIORITY = [/setup.*\.exe$/i, /\.exe$/i, /portable.*\.exe$/i, /\.dmg$/i, /\.zip$/i, /\.AppImage$/i, /\.deb$/i, /\.rpm$/i];

function scoreAsset(asset: ReleaseAsset, platform: Platform, arch: Arch): number {
  let score = 0;
  for (const re of PLATFORM_HINTS[platform]) if (re.test(asset.name)) score += 10;
  for (const re of ARCH_HINTS[arch]) if (re.test(asset.name)) score += 5;
  for (let i = 0; i < INSTALLER_PRIORITY.length; i++) {
    if (INSTALLER_PRIORITY[i].test(asset.name)) { score += (INSTALLER_PRIORITY.length - i); break; }
  }
  return score;
}

export function pickAssetFor(release: ReleaseCandidate, platform: Platform, arch: Arch): ReleaseAsset | undefined {
  if (!release.assets || release.assets.length === 0) return undefined;
  const scored = release.assets
    .map(a => ({ a, s: scoreAsset(a, platform, arch) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored[0]?.a;
}

export function compareSemver(a: string, b: string): number {
  const split = (v: string) => {
    const clean = v.replace(/^v/, '');
    const [core, ...preParts] = clean.split('-');
    const nums = core.split('.').map(p => /^\d+$/.test(p) ? parseInt(p, 10) : p);
    return { nums, pre: preParts.join('-') };
  };
  const pa = split(a);
  const pb = split(b);
  const n = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < n; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs !== ys) return xs < ys ? -1 : 1;
    }
  }
  // Per semver: a version without a prerelease tag is greater than the same version with one.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre !== pb.pre) return pa.pre < pb.pre ? -1 : 1;
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

// ---------------------------------------------------------------------------
// Update visibility + emergency override
//
// On load the app checks the self-update feed and surfaces an "update available"
// banner. The user can silence it two ways (persisted in settings.updatePrefs):
//   - "Later"          → snooze until a *newer* version than the one shown ships
//   - "Don't remind me" → mute forever
// An EMERGENCY release overrides both: it shows a blocking, urgent message no
// matter what the user silenced. A release marks itself an emergency by carrying
// a marker in its GitHub release notes (body):
//
//   <!-- clawdeck:emergency: Fixes a critical RCE — please update now. -->
//
// The HTML comment is invisible in GitHub's rendered notes but machine-readable
// here. A visible fallback form is also accepted:  [!EMERGENCY] <message>
// ---------------------------------------------------------------------------

export interface EmergencyInfo { message: string; }

export interface UpdatePrefs {
  /** Never show non-emergency update notices. */
  muteForever?: boolean;
  /** Suppress the banner while the latest version is <= this (snooze-until-next). */
  snoozedVersion?: string | null;
}

export interface UpdateEvaluation {
  current: string;
  latest?: ReleaseCandidate;
  isUpdate: boolean;
  emergency: EmergencyInfo | null;
  /** What the UI should render given the release + the user's silence prefs. */
  show: 'none' | 'banner' | 'emergency';
}

const DEFAULT_EMERGENCY = 'A critical update is available. Please update as soon as possible.';

/** Extract an emergency marker + message from a release body, if present. */
export function parseEmergency(body?: string): EmergencyInfo | null {
  if (!body) return null;
  const comment = /<!--\s*clawdeck:emergency:?\s*([\s\S]*?)-->/i.exec(body);
  if (comment) return { message: comment[1].trim() || DEFAULT_EMERGENCY };
  const line = /^\s*\[!?\s*emergency\s*\]:?\s*(.+)$/im.exec(body);
  if (line) return { message: line[1].trim() || DEFAULT_EMERGENCY };
  return null;
}

/** Newest release by semver (handles unsorted feeds). */
export function pickLatestRelease(candidates: ReleaseCandidate[]): ReleaseCandidate | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => compareSemver(b.version, a.version))[0];
}

/** Decide whether/how to surface an update, honoring silence prefs but letting emergencies win. */
export function evaluateUpdate(
  candidates: ReleaseCandidate[],
  current: string,
  prefs: UpdatePrefs = {}
): UpdateEvaluation {
  const latest = pickLatestRelease(candidates);
  const isUpdate = !!latest && isNewer(latest.version, current);
  const emergency = isUpdate ? parseEmergency(latest!.body) : null;

  let show: UpdateEvaluation['show'] = 'none';
  if (isUpdate) {
    if (emergency) {
      show = 'emergency'; // always wins over mute/snooze
    } else if (prefs.muteForever) {
      show = 'none';
    } else if (prefs.snoozedVersion && compareSemver(latest!.version, prefs.snoozedVersion) <= 0) {
      show = 'none';
    } else {
      show = 'banner';
    }
  }
  return { current, latest, isUpdate, emergency, show };
}
