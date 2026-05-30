import { describe, it, expect } from 'vitest';
import { parsePlan, extractPlanJson, repairJsonish } from '../src/lib/planner';

describe('planner robustness', () => {
  it('treats prose-only replies as explanation, not malformed', () => {
    const r = parsePlan('To install qwen, open the Library tab and click Install.');
    expect(r.ok).toBe(false);
    expect(r.intent).toBe('explanation');
    expect(r.error).toBeUndefined();
  });

  it('flags responses that attempted JSON but failed as malformed', () => {
    const r = parsePlan('Here\'s the plan:\n```json\n{this is not json\n```');
    expect(r.ok).toBe(false);
    expect(r.intent).toBe('malformed');
  });

  it('strips <think> blocks before parsing', () => {
    const text = '<think>let me think about it... maybe pullModel</think>\n```json\n{"summary":"go","steps":[]}\n```';
    const r = parsePlan(text);
    expect(r.ok).toBe(true);
    expect(r.plan!.summary).toBe('go');
  });

  it('strips <thinking> blocks too', () => {
    const text = '<thinking>reasoning</thinking>{"summary":"x","steps":[]}';
    expect(parsePlan(text).ok).toBe(true);
  });

  it('repairs trailing commas', () => {
    const broken = '{"summary":"x","steps":[{"type":"note","text":"hi",},],}';
    expect(parsePlan(broken).ok).toBe(true);
  });

  it('repairs single-quoted JSON', () => {
    const broken = "{'summary':'x','steps':[]}";
    expect(parsePlan(broken).ok).toBe(true);
  });

  it('repairs smart quotes', () => {
    const broken = '{\u201csummary\u201d:\u201cx\u201d,\u201csteps\u201d:[]}';
    expect(parsePlan(broken).ok).toBe(true);
  });

  it('repairs bareword keys', () => {
    const broken = '{summary:"x",steps:[]}';
    expect(parsePlan(broken).ok).toBe(true);
  });

  it('strips // comments', () => {
    const text = '```json\n{"summary":"x", // a note\n"steps":[]}\n```';
    expect(parsePlan(text).ok).toBe(true);
  });

  it('repairJsonish leaves valid JSON intact', () => {
    const good = '{"summary":"x","steps":[{"type":"note","text":"hi"}]}';
    expect(JSON.parse(repairJsonish(good)).steps[0].text).toBe('hi');
  });

  it('still rejects garbage that only resembles an attempt by having {', () => {
    // No keys we recognise, no fence, no "steps":/"summary":, no balanced parse target.
    const r = parsePlan('I think { you should know');
    expect(r.ok).toBe(false);
    // No fence, no "steps":, no JSON \u2014 prose, so should be 'explanation'.
    expect(r.intent).toBe('explanation');
  });

  it('detects intent=malformed when "steps:" appears unfenced', () => {
    const r = parsePlan('Here is my plan, steps: do x then y');
    expect(r.ok).toBe(false);
    expect(r.intent).toBe('malformed');
  });

  it('extractPlanJson ignores JSON inside <think> blocks', () => {
    const text = '<think>{"summary":"draft","steps":[]}</think>I need more info.';
    const r = extractPlanJson(text);
    expect(r.json).toBeNull();
  });
});
