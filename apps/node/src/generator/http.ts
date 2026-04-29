import { Agent } from 'undici';

export function createAgent(maxVUs: number): Agent {
  const connections = Math.max(1, maxVUs);
  return new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
    connections,
    pipelining: 0,
  });
}
