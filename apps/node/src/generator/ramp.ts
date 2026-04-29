// Pure ramp-up math. Kept free of side effects so it's trivially testable.

export interface VUPlan {
  vuId: number;
  delayMs: number;
}

export function vuStartDelays(totalVUs: number, rampUpMs: number): number[] {
  if (totalVUs < 0) throw new Error(`totalVUs must be >= 0, got ${totalVUs}`);
  if (rampUpMs < 0) throw new Error(`rampUpMs must be >= 0, got ${rampUpMs}`);
  if (totalVUs === 0) return [];
  if (rampUpMs === 0) return Array.from({ length: totalVUs }, () => 0);

  const step = rampUpMs / totalVUs;
  return Array.from({ length: totalVUs }, (_, i) => Math.round(i * step));
}

export function assignVUsToThreads(
  totalVUs: number,
  threadCount: number,
  rampUpMs: number,
): VUPlan[][] {
  if (threadCount <= 0) throw new Error(`threadCount must be > 0, got ${threadCount}`);

  const delays = vuStartDelays(totalVUs, rampUpMs);
  const buckets: VUPlan[][] = Array.from({ length: threadCount }, () => []);

  for (let i = 0; i < totalVUs; i++) {
    const thread = i % threadCount;
    buckets[thread]!.push({ vuId: i, delayMs: delays[i]! });
  }

  return buckets;
}

export function validateCapacity(params: {
  totalVUs: number;
  threadCount: number;
  maxVUsPerThread: number;
}): void {
  const ceiling = params.threadCount * params.maxVUsPerThread;
  if (params.totalVUs > ceiling) {
    throw new Error(
      `Requested ${params.totalVUs} VUs exceeds capacity ` +
        `(${params.threadCount} threads × ${params.maxVUsPerThread} VUs/thread = ${ceiling}). ` +
        `Add more generators or raise maxVUsPerThread.`,
    );
  }
}
