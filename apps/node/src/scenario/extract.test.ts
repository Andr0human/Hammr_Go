import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPath, ExtractError } from './extract.js';

describe('extractPath', () => {
  it('reads a top-level property with $.name', () => {
    assert.equal(extractPath({ token: 'abc' }, '$.token'), 'abc');
  });

  it('reads a nested property', () => {
    assert.equal(extractPath({ user: { id: 42 } }, '$.user.id'), 42);
  });

  it('reads the first element of an array', () => {
    assert.equal(
      extractPath({ items: [{ id: 1 }, { id: 2 }] }, '$.items[0].id'),
      1,
    );
  });

  it('returns the first match when the path resolves to multiple', () => {
    assert.equal(extractPath({ items: [{ id: 1 }, { id: 2 }] }, '$.items[*].id'), 1);
  });

  it('throws ExtractError when the path has no match', () => {
    assert.throws(
      () => extractPath({ a: 1 }, '$.missing'),
      ExtractError,
    );
  });

  it('throws ExtractError when given null/undefined input', () => {
    assert.throws(() => extractPath(null, '$.x'), ExtractError);
    assert.throws(() => extractPath(undefined, '$.x'), ExtractError);
  });
});
