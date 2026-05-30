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
