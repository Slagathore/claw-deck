import { describe, it, expect } from 'vitest';
import { assessRisk } from '../electron/selfUpgrade/risk';

describe('risk.assessRisk', () => {
  it('flags untouched, additive test files as low risk', () => {
    const r = assessRisk({
      id: 'x', rationale: '',
      files: [{ path: 'tests/newThing.test.ts', mode: 'create', contents: 'import {it,expect} from "vitest"; it("a",()=>expect(1).toBe(1));' }]
    });
    expect(r.level).toBe('low');
  });

  it('flags edits to electron/main.ts as high risk', () => {
    const r = assessRisk({
      id: 'x', rationale: '',
      files: [{ path: 'electron/main.ts', mode: 'replace', contents: 'console.log("hello");' }]
    });
    expect(r.level).toBe('high');
    expect(r.reasons.some(x => x.includes('critical file'))).toBe(true);
  });

  it('flags eval introduction as high risk even in a benign file', () => {
    const r = assessRisk({
      id: 'x', rationale: '',
      files: [{ path: 'src/utils/whatever.ts', mode: 'replace', contents: 'export const x = eval("1+1");' }]
    });
    expect(r.level).toBe('high');
    expect(r.reasons.some(x => /eval/.test(x))).toBe(true);
  });

  it('flags child_process introduction', () => {
    const r = assessRisk({
      id: 'x', rationale: '',
      files: [{ path: 'src/lib/x.ts', mode: 'replace', contents: 'import * as cp from "child_process";' }]
    });
    expect(['medium', 'high']).toContain(r.level);
  });

  it('rates package.json edits as high', () => {
    const r = assessRisk({
      id: 'x', rationale: '',
      files: [{ path: 'package.json', mode: 'replace', contents: '{"name":"claw-deck"}' }]
    });
    expect(r.level).toBe('high');
  });

  it('rates a src/lib file change as medium', () => {
    const r = assessRisk({
      id: 'x', rationale: '',
      files: [{ path: 'src/lib/helper.ts', mode: 'replace', contents: 'export const greet = (n: string) => `hi ${n}`;' }]
    });
    expect(['low', 'medium']).toContain(r.level);
  });
});
