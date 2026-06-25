import { describe, it, expect } from 'vitest';
import { runAutoloop, oscillates, AutoloopDeps } from '../electron/council/autoloop';
import { RunResult } from '../electron/council/run';

const fakeResult = (): RunResult => ({ status: 'completed', phasesRun: [], transcript: [], artifact: '', verdicts: [], approved: true });

function base(overrides: Partial<AutoloopDeps>): AutoloopDeps {
  return {
    goal: 'make it green',
    runIteration: async () => fakeResult(),
    checkGoal: async () => ({ met: false, reason: 'not yet' }),
    checkpoint: async (iter) => ({ signature: `sig-${iter}` }),
    maxIterations: 3,
    ...overrides,
  };
}

describe('oscillates', () => {
  it('trips on an A,B,A,B flip-flop only', () => {
    expect(oscillates(['A', 'B', 'A', 'B'])).toBe(true);
    expect(oscillates(['x', 'A', 'B', 'A', 'B'])).toBe(true);
    expect(oscillates(['A', 'B', 'C', 'D'])).toBe(false);
    expect(oscillates(['A', 'A', 'A', 'A'])).toBe(false); // not a flip-flop (a===b)
    expect(oscillates(['A', 'B', 'A'])).toBe(false);       // too short
  });
});

describe('runAutoloop', () => {
  it('halts on the iteration cap when never met', async () => {
    const r = await runAutoloop(base({ maxIterations: 3 }));
    expect(r.status).toBe('cap');
    expect(r.iterations).toBe(3);
  });

  it('stops as soon as the goal is met', async () => {
    let n = 0;
    const r = await runAutoloop(base({ checkGoal: async () => (++n >= 2 ? { met: true, reason: 'done' } : { met: false, reason: 'no' }) }));
    expect(r.status).toBe('met');
    expect(r.iterations).toBe(2);
  });

  it('trips the oscillation detector on a stubbed flip-flop', async () => {
    // checkpoint signatures alternate A,B,A,B across iterations
    const sigs = ['A', 'B', 'A', 'B'];
    const r = await runAutoloop(base({ maxIterations: 10, checkpoint: async (iter) => ({ signature: sigs[(iter - 1) % sigs.length] }) }));
    expect(r.status).toBe('oscillation');
    expect(r.iterations).toBe(4);
  });

  it('halts on the cost ceiling', async () => {
    let spent = 0;
    const r = await runAutoloop(base({ maxIterations: 10, costCeiling: 100, costSoFar: () => (spent += 60) }));
    expect(r.status).toBe('cost');
  });

  it('respects a human checkpoint that declines to continue', async () => {
    const r = await runAutoloop(base({ maxIterations: 10, humanCheckpointEvery: 1, onHumanCheckpoint: async () => false }));
    expect(r.status).toBe('halted');
    expect(r.iterations).toBe(1);
  });
});
