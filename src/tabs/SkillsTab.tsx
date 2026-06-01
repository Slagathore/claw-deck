import React, { useEffect, useRef, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { useConsole } from '../store/console';
import { buildSkillMd, slugify } from '../lib/skills';
import { isRisky, toggleAllowlist } from '../lib/scanReview';
import DeepScanReport from '../components/DeepScanReport';

/**
 * OpenClaw skills pipeline:
 *  - Local: create (scaffold a real SKILL.md), organize, edit, delete skills in
 *    your workspace's ./skills folder.
 *  - ClawHub: search the registry, install by slug, and publish — all by driving
 *    the real `clawhub` CLI (npm i -g clawhub) in the workspace, output inline.
 */

interface LocalSkill {
  slug: string; name: string; description: string;
  dir: string; skillMd: string; hasScripts: boolean;
}

// Shape of an item from `clawhub explore --json`.
interface RegistryItem {
  slug: string;
  displayName?: string;
  summary?: string;
  tags?: { latest?: string };
  stats?: { downloads?: number; installsAllTime?: number; stars?: number; versions?: number };
  latestVersion?: { version?: string; license?: string | null; changelog?: string };
  updatedAt?: number;
}

interface InspectInfo { files?: string[]; license?: string | null; error?: string; }

const SORTS = ['trending', 'newest', 'downloads', 'installs', 'rating'] as const;
type Sort = typeof SORTS[number];

export default function SkillsTab() {
  const { data: s, save } = useSettings();
  const workspace: string = s.skillsDir || '';

  const [skills, setSkills] = useState<LocalSkill[]>([]);
  const [listErr, setListErr] = useState('');
  const [clawhubOk, setClawhubOk] = useState<boolean | null>(null);

  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const [editing, setEditing] = useState<LocalSkill | null>(null);
  const [editContent, setEditContent] = useState('');
  const [dirty, setDirty] = useState(false);

  const [cliBusy, setCliBusy] = useState(false);
  const [cliOutput, setCliOutput] = useState('');
  const cliOff = useRef<null | (() => void)>(null);
  const cliBottom = useRef<HTMLDivElement>(null);

  // ClawHub registry browse (structured, via `explore --json`).
  const [regItems, setRegItems] = useState<RegistryItem[]>([]);
  const [regFilter, setRegFilter] = useState('');
  const [sort, setSort] = useState<Sort>('trending');
  const [browsing, setBrowsing] = useState(false);
  const [browseErr, setBrowseErr] = useState('');
  const [inspecting, setInspecting] = useState<Record<string, InspectInfo>>({});
  const [q, setQ] = useState('');             // semantic (vector) search query
  const [installSlug, setInstallSlug] = useState('');

  // Security: scan-before-install policy comes from Settings (shared with plugins).
  const scanBeforeInstall = s.scanBeforeInstall !== false;
  const blockRisky = s.blockRiskyInstalls !== false;
  const allowlist = new Set<string>(s.scanAllowlist ?? []);
  const toggleIgnore = (fp: string) => save({ scanAllowlist: toggleAllowlist(s.scanAllowlist ?? [], fp) });
  const [scanningSlug, setScanningSlug] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<{ slug: string; name: string; report: any } | null>(null);
  const [scanShowAll, setScanShowAll] = useState(false);

  async function reloadLocal() {
    if (!workspace) { setSkills([]); return; }
    const r = await window.api.skills.list(workspace);
    if (r.ok) { setSkills(r.skills ?? []); setListErr(''); }
    else { setSkills([]); setListErr(r.reason || 'failed to read skills'); }
  }
  useEffect(() => { reloadLocal(); /* eslint-disable-next-line */ }, [workspace]);

  // Probe whether the clawhub CLI is on PATH.
  useEffect(() => {
    let done = false;
    (async () => {
      try {
        const { id } = await window.api.runner.start({ backend: 'shell', binary: s.clawhubPath || 'clawhub', args: ['--version'] });
        const off = window.api.runner.onEvent((ev: any) => {
          if (ev.id !== id) return;
          if (ev.kind === 'exit') { if (!done) { done = true; setClawhubOk(ev.data === 0); off(); } }
          if (ev.kind === 'error') { if (!done) { done = true; setClawhubOk(false); off(); } }
        });
        setTimeout(() => { if (!done) { done = true; setClawhubOk(false); off(); } }, 5000);
      } catch { setClawhubOk(false); }
    })();
  }, [s.clawhubPath]);

  useEffect(() => { cliBottom.current?.scrollIntoView({ block: 'end' }); }, [cliOutput]);
  useEffect(() => () => { cliOff.current?.(); }, []);

  async function runClawhub(args: string[]) {
    const binary = s.clawhubPath || 'clawhub';
    setCliBusy(true);
    setCliOutput(`$ clawhub ${args.join(' ')}\n`);
    cliOff.current?.();
    try {
      const { id } = await window.api.runner.start({ backend: 'shell', binary, args, cwd: workspace || undefined });
      const off = window.api.runner.onEvent((ev: any) => {
        if (ev.id !== id) return;
        if (ev.kind === 'stdout' || ev.kind === 'stderr') setCliOutput(o => o + ev.data);
        if (ev.kind === 'error') { setCliOutput(o => o + `\n[error] ${ev.data}\n`); setCliBusy(false); off(); }
        if (ev.kind === 'exit') { setCliOutput(o => o + `\n[exit ${ev.data}]\n`); setCliBusy(false); off(); reloadLocal(); }
      });
      cliOff.current = off;
    } catch (e: any) {
      setCliOutput(o => o + `failed to start clawhub: ${e.message}\n`);
      setCliBusy(false);
    }
  }

  // Run clawhub and resolve with the full captured stdout (for --json commands).
  function runClawhubCapture(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const binary = s.clawhubPath || 'clawhub';
    return new Promise(resolve => {
      window.api.runner.start({ backend: 'shell', binary, args, cwd: workspace || undefined }).then(({ id }) => {
        let out = ''; let err = '';
        const off = window.api.runner.onEvent((ev: any) => {
          if (ev.id !== id) return;
          if (ev.kind === 'stdout') out += ev.data;
          else if (ev.kind === 'stderr') err += ev.data;
          else if (ev.kind === 'exit') { off(); resolve({ ok: ev.data === 0, stdout: out, stderr: err }); }
          else if (ev.kind === 'error') { off(); resolve({ ok: false, stdout: out, stderr: err + ev.data }); }
        });
      }).catch(e => resolve({ ok: false, stdout: '', stderr: e.message }));
    });
  }

  // Parse the first JSON value out of CLI stdout (clawhub prefixes a progress line).
  function parseJson(stdout: string): any {
    const i = stdout.indexOf('{');
    if (i < 0) throw new Error('no JSON in output');
    return JSON.parse(stdout.slice(i));
  }

  async function browse() {
    setBrowsing(true); setBrowseErr('');
    try {
      const r = await runClawhubCapture(['explore', '--json', '--sort', sort, '--limit', '60']);
      if (!r.ok) { setBrowseErr(r.stderr.trim() || 'clawhub explore failed (is clawhub installed?)'); return; }
      const json = parseJson(r.stdout);
      setRegItems(Array.isArray(json.items) ? json.items : []);
    } catch (e: any) {
      setBrowseErr(`could not read registry: ${e.message}`);
    } finally {
      setBrowsing(false);
    }
  }

  async function inspectSkill(slug: string) {
    setInspecting(prev => ({ ...prev, [slug]: {} }));
    try {
      const r = await runClawhubCapture(['inspect', slug, '--json', '--files']);
      if (!r.ok) { setInspecting(prev => ({ ...prev, [slug]: { error: r.stderr.trim() || 'inspect failed' } })); return; }
      const json = parseJson(r.stdout);
      const files: string[] = (json.files ?? json.version?.files ?? []).map((f: any) => typeof f === 'string' ? f : f.path).filter(Boolean);
      const license = json.latestVersion?.license ?? json.version?.license ?? json.license ?? null;
      setInspecting(prev => ({ ...prev, [slug]: { files, license } }));
    } catch (e: any) {
      setInspecting(prev => ({ ...prev, [slug]: { error: e.message } }));
    }
  }

  // Security-scan a registry skill (install to quarantine + scan); opens the modal.
  async function scanSkill(slug: string, name: string) {
    setScanningSlug(slug);
    setScanShowAll(false);
    try {
      const r = await window.api.skills.scanRegistry(slug, s.clawhubPath || 'clawhub');
      setScanResult({ slug, name, report: r.ok ? r.report : { ok: false, error: r.reason } });
    } catch (e: any) {
      setScanResult({ slug, name, report: { ok: false, error: e?.message ?? String(e) } });
    } finally {
      setScanningSlug(null);
    }
  }

  // Install honoring the scan-before-install toggle.
  function installFromCard(it: RegistryItem) {
    if (scanBeforeInstall) scanSkill(it.slug, it.displayName || it.slug);
    else runClawhub(['install', it.slug]);
  }

  const visibleReg = regItems.filter(it => {
    if (!regFilter.trim()) return true;
    const q2 = regFilter.toLowerCase();
    return it.slug.toLowerCase().includes(q2) || (it.displayName ?? '').toLowerCase().includes(q2) || (it.summary ?? '').toLowerCase().includes(q2);
  });

  async function pickWorkspace() {
    const p = await window.api.app.pickPath({ properties: ['openDirectory'] });
    if (p) await save({ skillsDir: p });
  }

  async function createSkill() {
    if (!workspace) { alert('Pick a skills workspace first.'); return; }
    if (!newName.trim() || !newDesc.trim()) return;
    const slug = slugify(newName);
    const content = buildSkillMd(newName, newDesc);
    const r = await window.api.skills.create(workspace, slug, content);
    if (!r.ok) { alert(`Create failed: ${r.reason}`); return; }
    setNewName(''); setNewDesc('');
    await reloadLocal();
    openEditor({ slug, name: newName.trim(), description: newDesc.trim(), dir: r.dir!, skillMd: r.skillMd!, hasScripts: false });
  }

  async function openEditor(sk: LocalSkill) {
    const r = await window.api.skills.read(sk.skillMd);
    setEditing(sk); setEditContent(r.content ?? ''); setDirty(false);
  }
  async function saveEditor() {
    if (!editing) return;
    const r = await window.api.skills.write(editing.skillMd, editContent);
    if (!r.ok) { alert(`Save failed: ${r.reason}`); return; }
    setDirty(false); reloadLocal();
  }
  async function deleteSkill(sk: LocalSkill) {
    if (!confirm(`Delete skill "${sk.slug}" and its folder? This removes ${sk.dir}.`)) return;
    await window.api.skills.delete(sk.dir);
    if (editing?.slug === sk.slug) setEditing(null);
    reloadLocal();
  }
  function publishSkill(sk: LocalSkill) {
    const version = prompt(`Publish "${sk.slug}" to ClawHub (needs \`clawhub login\`). Version:`, '0.1.0');
    if (!version) return;
    runClawhub(['skill', 'publish', sk.dir, '--slug', sk.slug, '--name', sk.name || sk.slug, '--version', version]);
  }

  function installClawhubCli() {
    const npm = navigator.platform.startsWith('Win') ? 'npm.cmd' : 'npm';
    window.api.runner.start({ backend: 'shell', binary: npm, args: ['install', '-g', 'clawhub'] }).then(({ id }) => {
      useConsole.getState().add({
        id, kind: 'tool', label: 'install clawhub', detail: 'npm install -g clawhub',
        startedAt: Date.now(), supportsInput: false, output: '[install clawhub] npm install -g clawhub\n'
      });
      useUI.getState().setTab('console');
    });
  }

  return (
    <div className="col" style={{ height: '100%', overflow: 'auto' }}>
      <div className="card col">
        <div className="row">
          <h2 style={{ margin: 0 }}>Skills</h2>
          {clawhubOk === true && <span className="badge ok">clawhub ready</span>}
          {clawhubOk === false && <span className="badge bad">clawhub not found</span>}
        </div>
        <div className="label">
          OpenClaw skills are <code>SKILL.md</code> bundles (name + description + instructions) under your
          workspace's <code>skills/</code> folder. Create them here, organize what's installed, and search /
          install / publish via the real <a href="https://clawhub.ai" target="_blank" rel="noreferrer">ClawHub</a> registry.
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="label">Workspace:</span>
          <code className="label" style={{ flex: 1, minWidth: 200 }}>{workspace ? `${workspace}\\skills` : '(not set — pick a folder)'}</code>
          <button onClick={pickWorkspace}>{workspace ? 'Change' : 'Pick workspace'}</button>
          {workspace && <button onClick={() => window.api.skills.open(workspace + '\\skills')} title="Open the skills folder">📂 Open</button>}
          <button onClick={reloadLocal} title="Reload local skills">🔄</button>
        </div>
        {clawhubOk === false && (
          <div className="banner warn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}>The <code>clawhub</code> CLI isn't on PATH. Search / install / publish need it.</span>
            <button onClick={installClawhubCli}>npm i -g clawhub</button>
          </div>
        )}
      </div>

      {/* Create */}
      <div className="card col">
        <h3 style={{ margin: 0 }}>Create a skill</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input placeholder="Name (e.g. Postgres Backups)" value={newName} onChange={e => setNewName(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          {newName && <span className="label">slug: <code>{slugify(newName)}</code></span>}
        </div>
        <textarea
          placeholder="Description — what it does and WHEN OpenClaw should use it (this is what the agent reads to decide)."
          value={newDesc}
          onChange={e => setNewDesc(e.target.value)}
          rows={2}
        />
        <div className="row">
          <button className="primary" onClick={createSkill} disabled={!workspace || !newName.trim() || !newDesc.trim()}>
            ＋ Scaffold SKILL.md
          </button>
          <span className="label">Writes <code>skills/{newName ? slugify(newName) : '<slug>'}/SKILL.md</code> and opens it for editing.</span>
        </div>
      </div>

      {/* ClawHub registry */}
      <div className="card col">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>ClawHub registry</h3>
          <span className="label">sort</span>
          <select value={sort} onChange={e => setSort(e.target.value as Sort)}>
            {SORTS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <button className="primary" onClick={browse} disabled={browsing}>
            {browsing ? 'Loading…' : (regItems.length ? '↻ Refresh' : '↧ Browse registry')}
          </button>
          <input placeholder="filter loaded results…" value={regFilter} onChange={e => setRegFilter(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <button onClick={() => runClawhub(['list'])} disabled={cliBusy} title="What's installed locally (clawhub list)">Installed</button>
          <button onClick={() => runClawhub(['update', '--all'])} disabled={cliBusy} title="Update all installed skills">Update all</button>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          title="Before installing, fetch the skill into a throwaway quarantine dir and run the security scanner over its files (eval / child_process / secret reads / exfil heuristics). Nothing runs.">
          <input type="checkbox" checked={scanBeforeInstall} onChange={e => save({ scanBeforeInstall: e.target.checked })} />
          <span className="label">🛡 Security-scan skills before installing</span>
        </label>
        {scanBeforeInstall && <span className="label">{blockRisky ? 'Critical/high findings block install.' : 'Findings warn only.'} (Settings → Install Security)</span>}

        {browseErr && <div className="banner">{browseErr}</div>}

        {regItems.length > 0 && (
          <div className="col" style={{ maxHeight: 340, overflow: 'auto', gap: 0 }}>
            <div className="label">{visibleReg.length} of {regItems.length} skills (sorted by {sort})</div>
            {visibleReg.map(it => {
              const ins = inspecting[it.slug];
              return (
                <div key={it.slug} className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 8, alignItems: 'flex-start' }}>
                  <div className="col" style={{ flex: 1, gap: 2 }}>
                    <div className="row">
                      <strong>{it.displayName || it.slug}</strong>
                      <code className="label">{it.slug}</code>
                      {it.tags?.latest && <span className="badge">v{it.tags.latest}</span>}
                      {it.latestVersion?.license && <span className="label">{it.latestVersion.license}</span>}
                    </div>
                    {it.summary && <div className="label" style={{ color: 'var(--text)' }}>{it.summary}</div>}
                    <div className="label">
                      {typeof it.stats?.installsAllTime === 'number' && `⬇ ${it.stats.installsAllTime.toLocaleString()} installs · `}
                      {typeof it.stats?.downloads === 'number' && `${it.stats.downloads.toLocaleString()} downloads · `}
                      {typeof it.stats?.stars === 'number' && `★ ${it.stats.stars}`}
                    </div>
                    {ins && (ins.error
                      ? <div className="label" style={{ color: 'var(--bad)' }}>inspect: {ins.error}</div>
                      : ins.files
                        ? <div className="label">files: <code>{ins.files.slice(0, 12).join('  ')}</code>{ins.files.length > 12 ? ` …(+${ins.files.length - 12})` : ''}</div>
                        : <div className="label">inspecting…</div>)}
                  </div>
                  <div className="col" style={{ gap: 6, width: 150 }}>
                    <button className="primary" onClick={() => installFromCard(it)} disabled={cliBusy || scanningSlug === it.slug}
                      title={scanBeforeInstall ? `Scan, then clawhub install ${it.slug}` : `clawhub install ${it.slug}`}>
                      {scanningSlug === it.slug ? 'Scanning…' : (scanBeforeInstall ? '🛡 Scan & install' : '⬇ Install')}
                    </button>
                    <div className="row" style={{ gap: 6 }}>
                      <button onClick={() => scanSkill(it.slug, it.displayName || it.slug)} disabled={scanningSlug === it.slug} title="Security-scan only (no install)">🛡</button>
                      <button onClick={() => inspectSkill(it.slug)} disabled={!!ins && !ins.error && !ins.files} style={{ flex: 1 }}>🔎 Inspect</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          <input placeholder='semantic search (clawhub vector search), e.g. "postgres backups"' value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && q.trim()) runClawhub(['search', q.trim()]); }} style={{ flex: 1, minWidth: 200 }} />
          <button onClick={() => q.trim() && runClawhub(['search', q.trim()])} disabled={cliBusy} title="Vector search (text results appear below)">🔍 Search</button>
          <input placeholder="install by slug…" value={installSlug} onChange={e => setInstallSlug(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && installSlug.trim()) runClawhub(['install', installSlug.trim()]); }} style={{ width: 180 }} />
          <button onClick={() => installSlug.trim() && runClawhub(['install', installSlug.trim()])} disabled={cliBusy || !installSlug.trim()}>⬇</button>
        </div>

        {cliOutput && (
          <pre style={{
            background: 'var(--panel-2)', borderRadius: 6, padding: 10, margin: 0, maxHeight: 240, overflow: 'auto',
            fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
          }}>
            {cliOutput}{cliBusy && ' …'}
            <div ref={cliBottom} />
          </pre>
        )}
      </div>

      {/* Local skills */}
      <div className="card col" style={{ flex: 1, minHeight: 0 }}>
        <div className="row">
          <h3 style={{ margin: 0, flex: 1 }}>Installed skills ({skills.length})</h3>
        </div>
        {!workspace && <div className="label">Pick a workspace folder above to see and manage skills.</div>}
        {listErr && <div className="banner">{listErr}</div>}
        {workspace && skills.length === 0 && !listErr && <div className="label">No skills yet. Create one above or install from ClawHub.</div>}
        {skills.map(sk => (
          <div key={sk.slug} className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 8, alignItems: 'flex-start' }}>
            <div className="col" style={{ flex: 1, gap: 2 }}>
              <div className="row">
                <strong>{sk.name}</strong>
                <code className="label">{sk.slug}</code>
                {sk.hasScripts && <span className="badge" title="Has supporting files">+files</span>}
              </div>
              <div className="label" style={{ color: 'var(--text)' }}>{sk.description || <em>(no description)</em>}</div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button onClick={() => openEditor(sk)}>Edit</button>
              <button onClick={() => window.api.skills.open(sk.dir)} title="Open folder">📂</button>
              <button onClick={() => publishSkill(sk)} disabled={cliBusy} title="Publish to ClawHub">Publish</button>
              <button onClick={() => deleteSkill(sk)} style={{ color: 'var(--bad)' }} title="Delete skill folder">×</button>
            </div>
          </div>
        ))}

        {editing && (
          <div className="col" style={{ marginTop: 12, borderTop: '2px solid var(--accent)', paddingTop: 10, gap: 6 }}>
            <div className="row">
              <strong>Editing <code>{editing.slug}/SKILL.md</code></strong>
              <div style={{ flex: 1 }} />
              <button className="primary" onClick={saveEditor} disabled={!dirty}>Save</button>
              <button onClick={() => window.api.skills.open(editing.dir)}>📂 Folder</button>
              <button onClick={() => setEditing(null)}>Close</button>
            </div>
            <textarea
              value={editContent}
              onChange={e => { setEditContent(e.target.value); setDirty(true); }}
              rows={16}
              style={{ fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12 }}
            />
            <span className="label">Tip: keep the <code>description</code> frontmatter sharp — it's what OpenClaw reads to decide when to use the skill.</span>
          </div>
        )}
      </div>

      {scanResult && (() => {
        const scope = `skill:${scanResult.slug}`;
        const risky = isRisky(scope, scanResult.report?.findings ?? [], allowlist);
        const blocked = risky && blockRisky;
        return (
          <div className="wizard-backdrop" onClick={() => setScanResult(null)} role="dialog" aria-modal="true" aria-label={`Security scan of ${scanResult.name}`}>
            <div className="wizard" onClick={e => e.stopPropagation()} style={{ maxWidth: 820, maxHeight: '85vh', overflowY: 'auto' }}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="col" style={{ flex: 1, gap: 2 }}>
                  <h2 style={{ margin: 0 }}>🛡 Security scan — {scanResult.name}</h2>
                  <div className="label">Installed into a throwaway quarantine dir, scanned, then discarded — nothing ran on your machine.</div>
                </div>
                <button onClick={() => setScanResult(null)} title="Close">×</button>
              </div>
              <div style={{ marginTop: 12 }}>
                <DeepScanReport report={scanResult.report} showAll={scanShowAll} onToggleShowAll={() => setScanShowAll(v => !v)} allowlist={allowlist} onToggleIgnore={toggleIgnore} scope={scope} />
              </div>
              <div className="row" style={{ marginTop: 16, alignItems: 'center', gap: 8 }}>
                {blocked && <span className="label" style={{ color: 'var(--bad)', flex: 1 }}>Blocked by policy: critical/high findings. Disable "Block installs" in Settings → Install Security to override.</span>}
                <div style={{ flex: blocked ? 0 : 1 }} />
                <button onClick={() => setScanResult(null)}>Cancel</button>
                <button
                  className="primary"
                  disabled={blocked}
                  style={risky && !blocked ? { background: 'var(--bad)' } : undefined}
                  onClick={() => { const slug = scanResult.slug; setScanResult(null); runClawhub(['install', slug]); }}
                  title={blocked ? 'Blocked by Install Security policy' : `clawhub install ${scanResult.slug}`}
                >
                  {blocked ? '🚫 Blocked' : risky ? '⚠ Install anyway' : `⬇ Install ${scanResult.slug}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
