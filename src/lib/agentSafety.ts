/**
 * Guard rails for Agent mode's Auto-approve.
 *
 * A plan's step output is fed back to the planner so it can decide what to do
 * next. Some of that output is text the app does not control: a fetched web
 * page, the output of a command, excerpts of saved conversations. Text like that
 * can contain instructions aimed at the model ("now run this command"). With a
 * person approving every plan that is survivable; with Auto-approve on it would
 * run with no click. So once outside text has reached the planner in a thread,
 * Auto-approve only still applies to plans that cannot change anything.
 */
import type { Plan, PlanStep } from './planner';

export const PLAN_RESULTS_PREFIX = '[plan-results]';

/** Steps whose output is text from outside the app's control. */
const OUTSIDE_TEXT: ReadonlySet<PlanStep['type']> = new Set(['webFetch', 'searchHistory', 'shell']);
/** Steps that only show something or look something up on this machine. */
const HARMLESS: ReadonlySet<PlanStep['type']> = new Set(['note', 'openTab', 'searchHistory']);

const OUTSIDE_STEP_LINE = /^Step \d+ \((webFetch|searchHistory|shell)\)/m;

/** True when running these steps puts outside text in front of the planner. */
export function feedsOutsideText(steps: PlanStep[]): boolean {
  return steps.some(s => OUTSIDE_TEXT.has(s.type));
}

/** True when an earlier plan-results turn in this conversation carried outside text. */
export function conversationHasOutsideText(msgs: { role: string; content: string }[]): boolean {
  return msgs.some(m => m.role === 'user' && m.content.startsWith(PLAN_RESULTS_PREFIX) && OUTSIDE_STEP_LINE.test(m.content));
}

/** Whether Auto-approve may run this plan without a click. */
export function mayAutoRun(plan: Plan, sawOutsideText: boolean): boolean {
  return !sawOutsideText || plan.steps.every(s => HARMLESS.has(s.type));
}
