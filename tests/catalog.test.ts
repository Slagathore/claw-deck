import { describe, it, expect } from 'vitest';
import {
  MODEL_CATALOG, MCP_CATALOG, TOOL_CATALOG,
  searchModels, searchMcp, searchTools
} from '../src/lib/catalog';

describe('catalog', () => {
  it('has at least the expected counts', () => {
    expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(15);
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(7);
    expect(TOOL_CATALOG.length).toBeGreaterThanOrEqual(6);
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
});
