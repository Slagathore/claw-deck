import { describe, it, expect } from 'vitest';
import {
  MODEL_CATALOG, MCP_CATALOG, TOOL_CATALOG, OPENCLAW_PLUGIN_CATALOG,
  searchModels, searchMcp, searchTools, searchOpenClawPlugins, openclawInstallRef
} from '../src/lib/catalog';

describe('catalog', () => {
  it('has at least the expected counts', () => {
    expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(15);
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(15);
    expect(TOOL_CATALOG.length).toBeGreaterThanOrEqual(8);
  });

  it('every model entry has required fields', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.name).toMatch(/^[a-z0-9.\-_:]+$/i);
      expect(m.sizeGb).toBeGreaterThan(0);
      expect(m.paramsB).toBeGreaterThan(0);
      expect(m.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('every MCP preset has a valid runtime, command, and args', () => {
    for (const p of MCP_CATALOG) {
      expect(['node', 'python']).toContain(p.runtime);
      expect(p.command).toBe(p.runtime === 'python' ? 'uvx' : 'npx');
      expect(Array.isArray(p.args)).toBe(true);
      expect(p.args.length).toBeGreaterThan(0);
    }
  });

  it('node MCP presets carry a scannable npm ref; python ones do not', () => {
    for (const p of MCP_CATALOG) {
      if (p.runtime === 'node') {
        expect(p.pkg?.kind).toBe('npm');
        expect(p.pkg?.ref && p.pkg.ref.length).toBeTruthy();
      } else {
        expect(p.pkg).toBeUndefined();
      }
    }
  });

  it('MCP needsArg keys are well-formed', () => {
    for (const p of MCP_CATALOG) {
      if (!p.needsArg) continue;
      expect(['path', 'arg', 'token']).toContain(p.needsArg.key);
      if (p.needsArg.key === 'token') expect(p.needsArg.env, `${p.name} token needs an env name`).toBeTruthy();
    }
  });

  it('MCP preset names are unique', () => {
    const names = MCP_CATALOG.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool preset has a manual URL', () => {
    for (const p of TOOL_CATALOG) {
      expect(p.install.manualUrl).toMatch(/^https?:\/\//);
    }
  });

  it('searchModels with empty query returns full list (copy)', () => {
    const r = searchModels('');
    expect(r.length).toBe(MODEL_CATALOG.length);
    expect(r).not.toBe(MODEL_CATALOG);
  });

  it('searchModels filters by name', () => {
    const r = searchModels('qwen');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every(m => m.family === 'qwen' || m.name.includes('qwen'))).toBe(true);
  });

  it('searchModels filters by capability token', () => {
    const r = searchModels('vision');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every(m => m.capabilities.includes('vision') || m.description.toLowerCase().includes('vision'))).toBe(true);
  });

  it('searchModels is case-insensitive', () => {
    expect(searchModels('LLAMA').length).toBe(searchModels('llama').length);
  });

  it('searchMcp matches description', () => {
    const r = searchMcp('browser');
    expect(r.some(p => p.name === 'puppeteer' || p.name === 'playwright')).toBe(true);
  });

  it('searchTools matches name', () => {
    const r = searchTools('git');
    expect(r.some(p => p.name === 'Git')).toBe(true);
    expect(r.some(p => p.name === 'GitHub CLI')).toBe(true);
  });

  it('ships uv so uvx MCP servers can run', () => {
    expect(TOOL_CATALOG.some(t => t.installCheck.startsWith('uv '))).toBe(true);
  });

  it('OpenClaw plugin entries are well-formed with unique ids', () => {
    expect(OPENCLAW_PLUGIN_CATALOG.length).toBeGreaterThanOrEqual(8);
    const ids = OPENCLAW_PLUGIN_CATALOG.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of OPENCLAW_PLUGIN_CATALOG) {
      expect(['plugin', 'skill', 'tool', 'distro']).toContain(e.type);
      expect(['github', 'npm', 'clawhub']).toContain(e.source.kind);
      expect(e.description.length).toBeGreaterThan(10);
      expect(e.homepage).toMatch(/^https?:\/\//);
      if (e.source.kind === 'github') expect(e.source.ref).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
  });

  it('openclawInstallRef builds the correct CLI source prefix', () => {
    expect(openclawInstallRef({ kind: 'github', ref: 'openclaw/lobster' })).toBe('git:github.com/openclaw/lobster');
    expect(openclawInstallRef({ kind: 'npm', ref: 'some-plugin' })).toBe('npm:some-plugin');
    expect(openclawInstallRef({ kind: 'clawhub', ref: 'voice-call' })).toBe('clawhub:voice-call');
  });

  it('searchOpenClawPlugins filters by type and name', () => {
    expect(searchOpenClawPlugins('plugin').every(e => e.type === 'plugin' || e.name.toLowerCase().includes('plugin') || e.description.toLowerCase().includes('plugin'))).toBe(true);
    expect(searchOpenClawPlugins('').length).toBe(OPENCLAW_PLUGIN_CATALOG.length);
  });
});
