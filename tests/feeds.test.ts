import { describe, it, expect } from 'vitest';
import { normalizeRepoSpec, normalizeGitHubRelease, fetchGitHubLatest } from '../electron/ipc/feeds';

describe('feeds.normalizeRepoSpec', () => {
  it('accepts owner/repo', () => {
    expect(normalizeRepoSpec('foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
  });
  it('accepts github.com URL', () => {
    expect(normalizeRepoSpec('https://github.com/foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
  });
  it('rejects non-github hosts', () => {
    expect(normalizeRepoSpec('https://example.com/foo/bar')).toBeNull();
  });
  it('rejects empty / malformed', () => {
    expect(normalizeRepoSpec('')).toBeNull();
    expect(normalizeRepoSpec('not a repo')).toBeNull();
  });
});

describe('feeds.normalizeGitHubRelease', () => {
  it('strips leading v from tag for version', () => {
    const c = normalizeGitHubRelease('o/r', { tag_name: 'v1.2.3', assets: [] })!;
    expect(c.version).toBe('1.2.3');
    expect(c.rawTag).toBe('v1.2.3');
  });
  it('preserves tags that do not start with v+digit', () => {
    const c = normalizeGitHubRelease('o/r', { tag_name: 'release-2024-01', assets: [] })!;
    expect(c.version).toBe('release-2024-01');
  });
  it('maps assets', () => {
    const c = normalizeGitHubRelease('o/r', {
      tag_name: 'v1', assets: [
        { name: 'app.exe', browser_download_url: 'https://example.com/app.exe', size: 100, content_type: 'application/octet-stream' },
        { name: 'noisy', /* no url */ }
      ]
    })!;
    expect(c.assets).toHaveLength(1);
    expect(c.assets[0].url).toBe('https://example.com/app.exe');
  });
  it('returns null on garbage', () => {
    expect(normalizeGitHubRelease('o/r', null)).toBeNull();
    expect(normalizeGitHubRelease('o/r', {})).toBeNull();
  });
  it('parses published_at as epoch ms', () => {
    const c = normalizeGitHubRelease('o/r', { tag_name: 'v1', published_at: '2024-01-02T03:04:05Z', assets: [] })!;
    expect(c.publishedAt).toBe(Date.parse('2024-01-02T03:04:05Z'));
  });
});

describe('feeds.fetchGitHubLatest (injected fetch)', () => {
  it('returns null when fetch is not ok', async () => {
    const fake = async () => new Response('nope', { status: 404 });
    expect(await fetchGitHubLatest('foo/bar', { fetcher: fake })).toBeNull();
  });
  it('returns a normalized candidate on ok', async () => {
    const fake = async () => new Response(JSON.stringify({
      tag_name: 'v2.0', body: 'notes', html_url: 'https://example.com/r',
      assets: [{ name: 'a.bin', browser_download_url: 'https://example.com/a.bin' }]
    }), { status: 200 });
    const c = (await fetchGitHubLatest('foo/bar', { fetcher: fake }))!;
    expect(c.version).toBe('2.0');
    expect(c.assets[0].name).toBe('a.bin');
    expect(c.source).toBe('github:foo/bar');
  });
  it('swallows network errors and returns null', async () => {
    const fake = async () => { throw new Error('boom'); };
    expect(await fetchGitHubLatest('foo/bar', { fetcher: fake })).toBeNull();
  });
});
