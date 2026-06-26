import { describe, it, expect } from 'vitest';
import { canEmit, isReasoningHeavy, assetGuidance, AGENT_ASSET_CAPS, BINARY_GENERATORS, rankEditors, builderScore } from '../electron/council/capabilities';

const A = (id: string, model: string, canEdit = true): any => ({ id, displayName: id, transport: 'ollama-cloud', model, capabilities: { canEdit, canRunTools: false, costTier: 'cheap' } });

describe('capability library (probe-seeded)', () => {
  it('every roster key can emit core text assets (SVG, GDScript, chiptune)', () => {
    for (const k of Object.keys(AGENT_ASSET_CAPS) as (keyof typeof AGENT_ASSET_CAPS)[]) {
      expect(canEmit(k, 'svg')).toBe(true);
      expect(canEmit(k, 'gdscript')).toBe(true);
      expect(canEmit(k, 'chiptune')).toBe(true);
    }
  });

  it('flags reasoning-heavy models (need think:false / large budget to emit)', () => {
    expect(isReasoningHeavy('qwen35')).toBe(true);
    expect(isReasoningHeavy('deepseek')).toBe(true);
    expect(isReasoningHeavy('kimi')).toBe(true);
    expect(isReasoningHeavy('qwen-coder')).toBe(false);   // clean emitter in the probe
    expect(isReasoningHeavy('nemotron')).toBe(false);
  });

  it('gemini is marked unreliable for sfx/shader emission (would not honor think:false)', () => {
    expect(canEmit('gemini-hot', 'svg')).toBe(true);
    expect(canEmit('gemini-hot', 'sfx')).toBe(false);
  });

  it('an unknown key falls back to the conservative default', () => {
    expect(canEmit('unknown' as any, 'svg')).toBe(true);
    expect(isReasoningHeavy('unknown' as any)).toBe(true);
  });

  it('binary assets route to generators, not text agents', () => {
    expect(Object.keys(BINARY_GENERATORS).sort()).toEqual(['audioFile', 'model3d', 'rasterImage']);
    expect(BINARY_GENERATORS.rasterImage).toMatch(/z-image|picsart|higgsfield/i);
  });

  it('assetGuidance forbids claiming binary assets and points to the text forms', () => {
    const g = assetGuidance().toLowerCase();
    expect(g).toMatch(/cannot output binary/);
    expect(g).toMatch(/svg|set_pixel/);
    expect(g).toMatch(/sfxr|synthesis|mml/);
    expect(g).toMatch(/todo\(asset\)/);
  });
});

describe('builder ranking — never default a build to a weak/incapable agent', () => {
  it('prefers clean emitters over reasoning-heavy ones, and excludes non-editors', () => {
    const roster = [A('kimi', 'kimi-k2.7-code:cloud'), A('qc', 'qwen3-coder:480b-cloud'), A('viewer', 'qwen3.5:397b-cloud', false)];
    const ranked = rankEditors(roster);
    expect(ranked[0].id).toBe('qc');                              // qwen-coder (not reasoning-heavy) wins
    expect(ranked.find((a) => a.id === 'viewer')).toBeUndefined(); // non-edit-capable excluded
  });

  it('live probe evidence boosts a model above its prior', () => {
    const kimi = A('kimi', 'kimi-k2.7-code:cloud');
    const probed = { 'kimi-k2.7-code:cloud': { svg: 'pass', gdscript: 'pass', sfx: 'pass', chiptune: 'pass' } };
    expect(builderScore(kimi, probed)).toBeGreaterThan(builderScore(kimi));
  });
});
