import type { Scenario } from './scenario.js';

export interface RawEvent {
  stepName: string;
  statusCode: number;
  latencyMs: number;
  responseBytes: number;
  timestamp: number;
  generatorId: string;
  threadId: number;
  vuId: number;
}

export type GenMsg =
  | { type: 'register'; generatorId: string; cores: number; maxVUs: number }
  | { type: 'metrics'; testId: string; batch: RawEvent[]; droppedEvents?: number }
  | { type: 'done'; testId: string; stats: { totalEvents: number; errors: number } }
  | { type: 'error'; testId: string; message: string }
  | { type: 'pong' };

export type CtlMsg =
  | {
      type: 'start';
      testId: string;
      scenario: Scenario;
      vus: number;
      rampUpMs: number;
      durationMs: number;
    }
  | { type: 'stop'; testId: string }
  | { type: 'ping' };
