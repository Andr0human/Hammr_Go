// If you edit this file, also update apps/go-generator/internal/scenario/parse.go
// and apps/go-generator/internal/scenario/types.go so the Go generator
// validates and decodes scenarios identically. The Stage 1/2 tests on the
// Go side will catch shape drift; semantic drift (new validation rules,
// new fields) won't — keep the two ports in sync by hand.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ThinkTime = number | { min: number; max: number };

export type OnErrorPolicy = 'abort' | 'continue';

export interface ScenarioStep {
  name: string;
  method: HttpMethod;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  extract?: Record<string, string>;
  thinkTime?: ThinkTime;
  onError?: OnErrorPolicy;
}

export interface ScenarioConfig {
  users: number;
  rampUp: string;
  duration: string;
  thinkTime?: ThinkTime;
}

export interface Scenario {
  name: string;
  baseUrl: string;
  config: ScenarioConfig;
  scenario: ScenarioStep[];
}
