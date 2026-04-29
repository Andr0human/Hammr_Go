import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenario } from './parse.js';

const validRaw = {
  name: 'Demo',
  baseUrl: 'http://localhost:4000',
  config: { users: 10, rampUp: '5s', duration: '30s' },
  scenario: [{ name: 'Ping', method: 'GET', path: '/' }],
};

describe('parseScenario', () => {
  it('accepts a minimal valid scenario and resolves durations', () => {
    const p = parseScenario(validRaw);
    assert.equal(p.rampUpMs, 5_000);
    assert.equal(p.durationMs, 30_000);
    assert.equal(p.scenario.name, 'Demo');
    assert.equal(p.scenario.scenario.length, 1);
  });

  it('rejects duration <= rampUp', () => {
    assert.throws(
      () =>
        parseScenario({
          ...validRaw,
          config: { users: 10, rampUp: '30s', duration: '30s' },
        }),
      /duration.*greater than rampUp/,
    );
  });

  it('rejects a baseUrl without http(s) scheme', () => {
    assert.throws(() => parseScenario({ ...validRaw, baseUrl: 'localhost:4000' }));
  });

  it('rejects scenarios with no steps', () => {
    assert.throws(() => parseScenario({ ...validRaw, scenario: [] }));
  });

  it('rejects duplicate step names', () => {
    assert.throws(
      () =>
        parseScenario({
          ...validRaw,
          scenario: [
            { name: 'Ping', method: 'GET', path: '/' },
            { name: 'Ping', method: 'GET', path: '/again' },
          ],
        }),
      /duplicate step name/,
    );
  });

  it('rejects users <= 0', () => {
    assert.throws(() =>
      parseScenario({
        ...validRaw,
        config: { ...validRaw.config, users: 0 },
      }),
    );
  });

  it('accepts thinkTime as number or {min,max}', () => {
    const a = parseScenario({
      ...validRaw,
      config: { ...validRaw.config, thinkTime: 500 },
    });
    assert.equal(a.scenario.config.thinkTime, 500);

    const b = parseScenario({
      ...validRaw,
      config: { ...validRaw.config, thinkTime: { min: 100, max: 300 } },
    });
    assert.deepEqual(b.scenario.config.thinkTime, { min: 100, max: 300 });
  });

  it('rejects thinkTime where min > max', () => {
    assert.throws(() =>
      parseScenario({
        ...validRaw,
        config: { ...validRaw.config, thinkTime: { min: 500, max: 100 } },
      }),
    );
  });

  it('rejects unknown HTTP methods', () => {
    assert.throws(() =>
      parseScenario({
        ...validRaw,
        scenario: [{ name: 'Bad', method: 'TRACE', path: '/' }],
      }),
    );
  });

  it('accepts extract, onError, per-step thinkTime, and body', () => {
    const p = parseScenario({
      ...validRaw,
      scenario: [
        {
          name: 'Login',
          method: 'POST',
          path: '/login',
          body: { user: 'x' },
          extract: { token: '$.token' },
          onError: 'abort',
          thinkTime: { min: 0, max: 50 },
        },
      ],
    });
    const step = p.scenario.scenario[0]!;
    assert.equal(step.onError, 'abort');
    assert.deepEqual(step.extract, { token: '$.token' });
    assert.deepEqual(step.body, { user: 'x' });
  });
});
