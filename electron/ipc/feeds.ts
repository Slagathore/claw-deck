/**
 * Release-feed pollers. Currently supports GitHub Releases.
 *
 * Pure helpers (normalize / parse) are exported separately so they can be
 * unit-tested without network. The IPC layer wraps `fetchSources` which
 * performs the actual HTTPS calls.
 */

export interface FeedSource {
  /** "owner/repo" or full https URL to a GitHub repo */
  repo: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;       // browser_download_url
  size?: number;
  contentType?: string;
}

export interface ReleaseCandidate {
  source: string;            // "github:owner/repo"
  name: string;              // repo name
  version: string;           // release tag_name (sans leading v if present)
  rawTag: string;            // tag_name as-is
  publishedAt?: number;      // unix ms
  notes?: string;            // release body / changelog
  htmlUrl?: string;          // release page
  assets: ReleaseAsset[];
}

const GH_TAG_PREFIX = /^v(?=\d)/;

export function normalizeRepoSpec(spec: string): { owner: string; repo: string } | null {
  if (!spec) return null;
  const s = spec.trim();
  // accept "owner/repo" or full URL
  const m1 = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m1) return { owner: m1[1], repo: m1[2] };
  try {
    const u = new URL(s);
    if (u.hostname !== 'github.com') return null;
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

export function normalizeGitHubRelease(repoSpec: string, payload: any): ReleaseCandidate | null {
  if (!payload || typeof payload !== 'object') return null;
  const tag: string | undefined = payload.tag_name;
  if (!tag) return null;
  const assets: ReleaseAsset[] = Array.isArray(payload.assets)
    ? payload.assets
        .filter((a: any) => a && typeof a.browser_download_url === 'string')
        .map((a: any) => ({
          name: String(a.name ?? ''),
          url: String(a.browser_download_url),
          size: typeof a.size === 'number' ? a.size : undefined,
          contentType: typeof a.content_type === 'string' ? a.content_type : undefined
        }))
    : [];
  const publishedAt = payload.published_at ? Date.parse(payload.published_at) : undefined;
  return {
    source: `github:${repoSpec}`,
    name: repoSpec.split('/').pop() ?? repoSpec,
    version: tag.replace(GH_TAG_PREFIX, ''),
    rawTag: tag,
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : undefined,
    notes: typeof payload.body === 'string' ? payload.body : undefined,
    htmlUrl: typeof payload.html_url === 'string' ? payload.html_url : undefined,
    assets
  };
}

export interface FetchOpts {
  /** allows tests to inject a fake fetch */
  fetcher?: typeof fetch;
  /** GitHub PAT, optional; raises rate limit */
  githubToken?: string;
  /** abort after this many ms per call */
  timeoutMs?: number;
}

export async function fetchGitHubLatest(repoSpec: string, opts: FetchOpts = {}): Promise<ReleaseCandidate | null> {
  const parsed = normalizeRepoSpec(repoSpec);
  if (!parsed) return null;
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases/latest`;
  const f = opts.fetcher ?? fetch;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'claw-deck'
  };
  if (opts.githubToken) headers['Authorization'] = `Bearer ${opts.githubToken}`;
  const ctrl = new AbortController();
  const t = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
  try {
    const r = await f(url, { headers, signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return normalizeGitHubRelease(`${parsed.owner}/${parsed.repo}`, j);
  } catch {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

export async function fetchSources(sources: FeedSource[], opts: FetchOpts = {}): Promise<ReleaseCandidate[]> {
  const out: ReleaseCandidate[] = [];
  await Promise.all(sources.map(async s => {
    const c = await fetchGitHubLatest(s.repo, opts);
    if (c) out.push(c);
  }));
  // newest first
  return out.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
}
