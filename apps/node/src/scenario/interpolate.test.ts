import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpolate,
  interpolateBody,
  interpolateHeaders,
  InterpolationError,
} from './interpolate.js';

describe('interpolate', () => {
  it('replaces {{var}} with the variable value', () => {
    assert.equal(interpolate('hello {{name}}', { name: 'world' }), 'hello world');
  });

  it('handles multiple variables in one string', () => {
    assert.equal(
      interpolate('{{greet}}, {{name}}!', { greet: 'hi', name: 'ada' }),
      'hi, ada!',
    );
  });

  it('leaves a plain string with no placeholders untouched', () => {
    assert.equal(interpolate('plain', {}), 'plain');
  });

  it('tolerates whitespace inside {{ name }}', () => {
    assert.equal(interpolate('{{ name }}', { name: 'x' }), 'x');
  });

  it('coerces non-string values to strings', () => {
    assert.equal(interpolate('id={{id}}', { id: 42 }), 'id=42');
    assert.equal(interpolate('ok={{flag}}', { flag: true }), 'ok=true');
  });

  it('supports dotted paths to nested objects', () => {
    assert.equal(
      interpolate('user={{user.id}}', { user: { id: 7 } }),
      'user=7',
    );
  });

  it('throws InterpolationError for missing variables', () => {
    assert.throws(() => interpolate('hi {{nope}}', {}), InterpolationError);
  });

  it('throws InterpolationError when a nested path misses', () => {
    assert.throws(
      () => interpolate('{{user.missing}}', { user: {} }),
      InterpolationError,
    );
  });

  it('throws InterpolationError for null/undefined values', () => {
    assert.throws(() => interpolate('{{x}}', { x: null }), InterpolationError);
    assert.throws(() => interpolate('{{x}}', { x: undefined }), InterpolationError);
  });
});

describe('interpolateHeaders', () => {
  it('returns undefined when headers is undefined', () => {
    assert.equal(interpolateHeaders(undefined, {}), undefined);
  });

  it('interpolates every header value', () => {
    const out = interpolateHeaders(
      { Authorization: 'Bearer {{token}}', 'X-User': '{{uid}}' },
      { token: 'abc', uid: 7 },
    );
    assert.deepEqual(out, { Authorization: 'Bearer abc', 'X-User': '7' });
  });
});

describe('interpolateBody', () => {
  it('passes undefined and null through', () => {
    assert.equal(interpolateBody(undefined, {}), undefined);
    assert.equal(interpolateBody(null, {}), null);
  });

  it('interpolates string leaves', () => {
    assert.equal(interpolateBody('hi {{name}}', { name: 'x' }), 'hi x');
  });

  it('recurses into objects and arrays', () => {
    const out = interpolateBody(
      { a: 'u={{u}}', b: [{ c: 'tok={{t}}' }, 'plain'] },
      { u: 'x', t: 'y' },
    );
    assert.deepEqual(out, { a: 'u=x', b: [{ c: 'tok=y' }, 'plain'] });
  });

  it('passes non-string primitives through unchanged', () => {
    assert.equal(interpolateBody(42, {}), 42);
    assert.equal(interpolateBody(true, {}), true);
  });

  it('does not mutate the input object', () => {
    const input = { a: 'v={{v}}' };
    interpolateBody(input, { v: 'x' });
    assert.equal(input.a, 'v={{v}}');
  });
});
