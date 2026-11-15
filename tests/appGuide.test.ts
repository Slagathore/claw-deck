import { describe, it, expect } from 'vitest';
import { appGuide, buildChatSystem, formatRecall } from '../src/lib/appGuide';
import { TABS } from '../src/lib/tabs';
import { PLANNER_SYSTEM_PROMPT, parsePlan, describeStep, isDestructive } from '../src/lib/planner';

const hit = (text: string, title = 'Docker networking') => ({ threadId: 't_1', threadTitle: title, role: 'user', ts: Date.UTC(2026, 9, 2), text });

describe('app guide', () => {
  it('covers every tab the sidebar shows', () => {
    const guide = appGuide();
    for (const [key, , label] of TABS) {
      expect(guide).toContain(`${label} (${key})`);
    }
  });

  it('explains persistence, New chat, and history', () => {
    const guide = appGuide();
    expect(guide).toContain('New chat');
    expect(guide).toMatch(/saved automatically/);
    expect(guide).toMatch(/restarting the PC/);
    expect(guide).toContain('Agent mode');
  });

  it('system prompt carries live state and the right search instructions', () => {
    const withTools = buildChatSystem({ version: '1.0.4', activeModel: 'qwen3.5:4b', chatModel: 'qwen3.5:4b', installedModels: ['qwen3.5:4b', 'gemma3:12b'], canSearchHistory: true });
    expect(withTools).toContain('Claw Deck version: 1.0.4');
    expect(withTools).toContain('You are running as: qwen3.5:4b');
    expect(withTools).toContain('gemma3:12b');
    expect(withTools).toContain('search_history');
    expect(withTools).not.toContain('RECALLED CONTEXT (');

    const noTools = buildChatSystem({ canSearchHistory: false }, [hit('put both services on one network')]);
    expect(noTools).toContain('cannot search history on demand');
    expect(noTools).toContain('RECALLED CONTEXT (');
    expect(noTools).toContain('put both services on one network');
    expect(noTools).toContain('"Docker networking"');
    expect(noTools).toContain('2026-10-02');
  });

  it('recall block is bounded', () => {
    const hits = Array.from({ length: 20 }, (_, i) => hit('x'.repeat(2000), `Thread ${i}`));
    const block = formatRecall(hits, 3200);
    expect(block.length).toBeLessThan(4200);
    expect(block).toContain('Thread 0');
    expect(block).not.toContain('Thread 19');
    expect(formatRecall([])).toBe('');
  });
});

describe('planner: history and the full tab list', () => {
  it('knows every tab and the searchHistory step', () => {
    for (const [key] of TABS) expect(PLANNER_SYSTEM_PROMPT).toContain(key);
    expect(PLANNER_SYSTEM_PROMPT).toContain('searchHistory');
  });

  it('parses and describes a searchHistory step as read-only', () => {
    const p = parsePlan('```json\n{"summary":"look it up","steps":[{"type":"searchHistory","query":"docker dns fix"}]}\n```');
    expect(p.ok).toBe(true);
    const step = p.plan!.steps[0];
    expect(describeStep(step)).toBe('Search saved conversations: docker dns fix');
    expect(isDestructive(step)).toBe(false);
    expect(parsePlan('```json\n{"summary":"x","steps":[{"type":"searchHistory"}]}\n```').ok).toBe(false);
  });
});
