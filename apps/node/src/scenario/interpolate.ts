// {{var}} interpolation applied to string values in path, headers, and body.
// Variable names may contain letters, digits, underscores, and dots.
// A reference to a missing variable throws InterpolationError so the engine can
// treat it as a step failure and apply the onError policy.

const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

export class InterpolationError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`Missing variable "${variable}" in interpolation`);
    this.variable = variable;
    this.name = 'InterpolationError';
  }
}

export function interpolate(str: string, vars: Record<string, unknown>): string {
  return str.replace(VAR_RE, (_match, name: string) => {
    const value = resolve(vars, name);
    if (value === undefined || value === null) throw new InterpolationError(name);
    return String(value);
  });
}

export function interpolateHeaders(
  headers: Record<string, string> | undefined,
  vars: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = interpolate(v, vars);
  }
  return out;
}

// Walks a body value and interpolates every string leaf. Objects and arrays are
// cloned so the caller can mutate freely. Non-string primitives pass through.
export function interpolateBody(body: unknown, vars: Record<string, unknown>): unknown {
  if (body === undefined || body === null) return body;
  if (typeof body === 'string') return interpolate(body, vars);
  if (Array.isArray(body)) return body.map((v) => interpolateBody(v, vars));
  if (typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = interpolateBody(v, vars);
    }
    return out;
  }
  return body;
}

function resolve(vars: Record<string, unknown>, name: string): unknown {
  // Dotted paths walk nested objects: {{user.id}} reads vars.user.id.
  if (!name.includes('.')) return vars[name];
  let current: unknown = vars;
  for (const part of name.split('.')) {
    if (current === undefined || current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
