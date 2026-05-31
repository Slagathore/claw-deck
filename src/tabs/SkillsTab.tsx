import React, { useEffect, useRef, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { useConsole } from '../store/console';
import { buildSkillMd, slugify } from '../lib/skills';

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

  const [q, setQ] = useState('');
  const [installSlug, setInstallSlug] = useState('');
  const [cliBusy, setCliBusy] = useState(false);
  const [cliOutput, setCliOutput] = useState('');
  const cliOff = useRef<null | (() => void)>(null);
  const cliBottom = useRef<HTMLDivElement>(null);

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
        <h3 style={{ margin: 0 }}>ClawHub registry</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input placeholder='Search skills, e.g. "postgres backups"' value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && q.trim()) runClawhub(['search', q.trim()]); }} style={{ flex: 1, minWidth: 200 }} />
          <button onClick={() => q.trim() && runClawhub(['search', q.trim()])} disabled={cliBusy}>🔍 Search</button>
          <button onClick={() => runClawhub(['list'])} disabled={cliBusy} title="What clawhub has installed">Installed</button>
          <button onClick={() => runClawhub(['update', '--all'])} disabled={cliBusy} title="Update all installed skills">Update all</button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input placeholder="install by slug…" value={installSlug} onChange={e => setInstallSlug(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && installSlug.trim()) runClawhub(['install', installSlug.trim()]); }} style={{ flex: 1, minWidth: 160 }} />
          <button className="primary" onClick={() => installSlug.trim() && runClawhub(['install', installSlug.trim()])} disabled={cliBusy || !installSlug.trim()}>
            ⬇ Install
          </button>
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
    </div>
  );
}
