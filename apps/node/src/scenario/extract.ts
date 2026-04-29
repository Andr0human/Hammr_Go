import { JSONPath } from 'jsonpath-plus';

export class ExtractError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`extract "${path}" failed: ${reason}`);
    this.path = path;
    this.name = 'ExtractError';
  }
}

// Applies a JSONPath expression to a JSON-parseable value and returns the first
// match. Throws ExtractError when the path yields zero matches.
export function extractPath(json: unknown, path: string): unknown {
  if (json === undefined || json === null) {
    throw new ExtractError(path, 'response body was not JSON');
  }
  const result = JSONPath({ path, json, wrap: true }) as unknown[];
  if (!Array.isArray(result) || result.length === 0) {
    throw new ExtractError(path, 'no match');
  }
  return result[0];
}
