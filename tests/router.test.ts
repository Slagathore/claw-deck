import { describe, it, expect } from 'vitest';
import { routeRequest } from '../src/lib/router';

const S = { chatModel: 'cm', reasoningModel: 'rm', visionModel: 'vm' };

describe('router.routeRequest', () => {
  it('routes to vision when an image is attached', () => {
    const r = routeRequest({ prompt: 'what is this', imageCount: 1, settings: S });
    expect(r.backend).toBe('vision');
    expect(r.model).toBe('vm');
  });

  it('forces vision on /vision regardless of image count', () => {
    const r = routeRequest({ prompt: '/vision describe', imageCount: 0, settings: S });
    expect(r.backend).toBe('vision');
    expect(r.cleanedPrompt).toBe('describe');
    expect(r.reason).toMatch(/forced/);
  });

  it('forces reasoning on /reason', () => {
    const r = routeRequest({ prompt: '/reason 2+2', imageCount: 0, settings: S });
    expect(r.backend).toBe('reasoning');
    expect(r.model).toBe('rm');
    expect(r.cleanedPrompt).toBe('2+2');
  });

  it('forces chat on /chat even with reasoning-sounding prompt', () => {
    const r = routeRequest({ prompt: '/chat explain why the sky is blue', imageCount: 0, settings: S });
    expect(r.backend).toBe('chat');
  });

  it('routes to reasoning on heuristic keywords', () => {
    const r = routeRequest({ prompt: 'Step-by-step, derive the result', imageCount: 0, settings: S });
    expect(r.backend).toBe('reasoning');
    expect(r.model).toBe('rm');
  });

  it('falls back to chat by default', () => {
    const r = routeRequest({ prompt: 'hello there', imageCount: 0, settings: S });
    expect(r.backend).toBe('chat');
    expect(r.model).toBe('cm');
    expect(r.reason).toBe('default chat');
  });

  it('image still wins when no slash and no reasoning hints', () => {
    const r = routeRequest({ prompt: 'caption please', imageCount: 2, settings: S });
    expect(r.backend).toBe('vision');
  });

  it('handles empty prompt safely', () => {
    const r = routeRequest({ prompt: '', imageCount: 0, settings: S });
    expect(r.backend).toBe('chat');
    expect(r.cleanedPrompt).toBe('');
  });
});
