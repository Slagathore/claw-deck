import { describe, it, expect } from 'vitest';
import {
  MODEL_CATALOG, MCP_CATALOG, TOOL_CATALOG, OPENCLAW_LIB_CATALOG, OPENCLAW_LIB_CATALOG_FULL,
  searchModels, searchMcp, searchTools, searchOpenClawLibs, riskSummary
} from '../src/lib/catalog';

describe('catalog', () => {
  it('has at least the expected counts', () => {
    expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(15);
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(7);
    expect(TOOL_CATALOG.length).toBeGreaterThanOrEqual(6);
    expect(OPENCLAW_LIB_CATALOG.length).toBeGreaterThanOrEqual(8);
    expect(OPENCLAW_LIB_CATALOG_FULL.length).toBeGreaterThanOrEqual(100);
  });

  it('full catalog ids are unique', () => {
    const ids = OPENCLAW_LIB_CATALOG_FULL.map(l => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every model entry has required fields', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.name).toMatch(/^[a-z0-9.\-_:]+$/i);
      expect(m.sizeGb).toBeGreaterThan(0);
      expect(m.paramsB).toBeGreaterThan(0);
      expect(m.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('every MCP preset has command + args', () => {
    for (const p of MCP_CATALOG) {
      expect(p.command).toBeTruthy();
      expect(Array.isArray(p.args)).toBe(true);
    }
  });

  it('every tool preset has a manual URL', () => {
    for (const p of TOOL_CATALOG) {
      expect(p.install.manualUrl).toMatch(/^https?:\/\//);
    }
  });

  it('searchModels with empty query returns full list (copy)', () => {
    const r = searchModels('');
    expect(r.length).toBe(MODEL_CATALOG.length);
    expect(r).not.toBe(MODEL_CATALOG); // returned a copy
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
    expect(r.some(p => p.name === 'puppeteer')).toBe(true);
  });

  it('searchTools matches name', () => {
    const r = searchTools('git');
    expect(r.some(p => p.name === 'Git')).toBe(true);
    expect(r.some(p => p.name === 'GitHub CLI')).toBe(true);
  });

  it('MCP preset names are unique', () => {
    const names = MCP_CATALOG.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every OpenClaw lib entry has required audit fields', () => {
    for (const lib of OPENCLAW_LIB_CATALOG) {
      expect(lib.id).toMatch(/^[a-z0-9-]+$/);
      expect(lib.name.length).toBeGreaterThan(0);
      expect(lib.description.length).toBeGreaterThan(10);
      expect(['skills', 'prompts', 'tools', 'agents', 'integrations']).toContain(lib.category);
      expect(['npm', 'github', 'local']).toContain(lib.source.kind);
      expect(lib.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(lib.audit.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(['low', 'medium', 'high', 'unknown']).toContain(lib.audit.risk);
      expect(lib.audit.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(lib.audit.depCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(lib.audit.cves)).toBe(true);
      expect(Array.isArray(lib.audit.notes)).toBe(true);
      expect(['none', 'outbound', 'inbound', 'both']).toContain(lib.audit.permissions.network);
      expect(['none', 'read', 'write', 'both']).toContain(lib.audit.permissions.filesystem);
      expect(typeof lib.audit.permissions.shell).toBe('boolean');
      expect(typeof lib.audit.permissions.secrets).toBe('boolean');
    }
  });

  it('OpenClaw lib ids are unique', () => {
    const ids = OPENCLAW_LIB_CATALOG.map(l => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('searchOpenClawLibs filters by category', () => {
    const r = searchOpenClawLibs('skills');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every(x => x.category === 'skills' || x.description.toLowerCase().includes('skills') || x.name.toLowerCase().includes('skills'))).toBe(true);
  });

  it('searchOpenClawLibs empty query returns all', () => {
    expect(searchOpenClawLibs('').length).toBe(OPENCLAW_LIB_CATALOG_FULL.length);
  });

  it('riskSummary flags network + shell + secrets', () => {
    const s = riskSummary({
      risk: 'high', hash: 'sha256:' + 'a'.repeat(64), reviewedAt: '2026-01-01',
      reviewer: 'x', license: 'MIT', maintainer: 'x', depCount: 0, cves: [],
      permissions: { network: 'outbound', filesystem: 'write', shell: true, secrets: true },
      notes: []
    });
    expect(s).toContain('net');
    expect(s).toContain('shell');
    expect(s).toContain('secrets');
    expect(s).toContain('fs:write');
  });

  it('riskSummary returns "sandboxed" when nothing is requested', () => {
    const s = riskSummary({
      risk: 'low', hash: 'sha256:' + 'a'.repeat(64), reviewedAt: '2026-01-01',
      reviewer: 'x', license: 'MIT', maintainer: 'x', depCount: 0, cves: [],
      permissions: { network: 'none', filesystem: 'none', shell: false, secrets: false },
      notes: []
    });
    expect(s).toBe('sandboxed');
  });

  it('riskSummary surfaces CVE count', () => {
    const s = riskSummary({
      risk: 'high', hash: 'sha256:' + 'a'.repeat(64), reviewedAt: '2026-01-01',
      reviewer: 'x', license: 'MIT', maintainer: 'x', depCount: 0,
      cves: ['CVE-2025-1234', 'CVE-2025-5678'],
      permissions: { network: 'none', filesystem: 'none', shell: false, secrets: false },
      notes: []
    });
    expect(s).toContain('2 CVE');
  });
});
