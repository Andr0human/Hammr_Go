import { z } from 'zod';
import type { Scenario } from './scenario.js';
import { parseDuration } from './duration.js';

const thinkTimeSchema = z.union([
  z.number().int().nonnegative(),
  z
    .object({
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
    })
    .refine((v) => v.min <= v.max, { message: 'thinkTime.min must be <= thinkTime.max' }),
]);

const stepSchema = z.object({
  name: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  extract: z.record(z.string().min(1)).optional(),
  thinkTime: thinkTimeSchema.optional(),
  onError: z.enum(['abort', 'continue']).optional(),
});

const configSchema = z.object({
  users: z.number().int().positive(),
  rampUp: z.string().min(1),
  duration: z.string().min(1),
  thinkTime: thinkTimeSchema.optional(),
});

export const scenarioSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().regex(/^https?:\/\//i, 'baseUrl must start with http:// or https://'),
  config: configSchema,
  scenario: z.array(stepSchema).min(1, 'scenario must have at least one step'),
});

export interface ParsedScenario {
  scenario: Scenario;
  rampUpMs: number;
  durationMs: number;
}

export function parseScenario(raw: unknown): ParsedScenario {
  const parsed = scenarioSchema.parse(raw) as Scenario;
  const rampUpMs = parseDuration(parsed.config.rampUp);
  const durationMs = parseDuration(parsed.config.duration);

  if (durationMs <= rampUpMs) {
    throw new Error(
      `duration (${parsed.config.duration}) must be greater than rampUp (${parsed.config.rampUp})`,
    );
  }

  const names = new Set<string>();
  for (const step of parsed.scenario) {
    if (names.has(step.name)) {
      throw new Error(`duplicate step name: ${step.name}`);
    }
    names.add(step.name);
  }

  return { scenario: parsed, rampUpMs, durationMs };
}
