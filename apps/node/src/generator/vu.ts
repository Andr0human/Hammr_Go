import type { Dispatcher } from 'undici';
import type { Scenario } from '@hammr/shared';
import { runIteration } from '../scenario/engine.js';

export type { EventSink } from '../scenario/engine.js';
import type { EventSink } from '../scenario/engine.js';

export interface VUContext {
  vuId: number;
  threadId: number;
  generatorId: string;
  scenario: Scenario;
  // Absolute deadline in performance.now() units. The VU stops when we pass it.
  endAt: number;
}

// A single virtual user. Re-runs the scenario from the top until the thread's
// deadline passes or the abort signal fires. Each iteration starts with a fresh
// variable context (isolation between VUs is guaranteed by this call being
// invoked independently per VU in the caller).
export async function runVU(
  ctx: VUContext,
  agent: Dispatcher,
  sink: EventSink,
  signal: AbortSignal,
): Promise<void> {
  const identity = {
    generatorId: ctx.generatorId,
    threadId: ctx.threadId,
    vuId: ctx.vuId,
  };
  while (!signal.aborted && performance.now() < ctx.endAt) {
    await runIteration(ctx.scenario, agent, sink, signal, identity);
  }
}
