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
