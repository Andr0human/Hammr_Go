// Even VU split across N generators with a remainder distributed by index.
// Returns the same length as `genIds` so callers can zip directly. The first
// (totalVUs % n) generators take ceil(totalVUs / n), the rest take floor.
//
// We split evenly rather than weight by `cores` because the portfolio target
// is a homogeneous fleet (same Fargate task definition); CLAUDE.md leaves the
// "weight by capacity" door open as V2 work.
export function splitVUs(totalVUs: number, genIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (genIds.length === 0) return out;
  const base = Math.floor(totalVUs / genIds.length);
  const extra = totalVUs % genIds.length;
  for (let i = 0; i < genIds.length; i++) {
    out.set(genIds[i]!, base + (i < extra ? 1 : 0));
  }
  return out;
}
