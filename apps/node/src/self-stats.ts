import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { logger } from './logger.js';

export interface SelfStatsOptions {
  // Per-process identity included in every log line. For generators this is
  // the generatorId; for the controller, a fixed string.
  component: string;
  // How often to emit. CLAUDE.md calls for per-minute logging.
  intervalMs?: number;
  // Extra fields appended to each log line (e.g. aggregator bucket count,
  // writer stats). Evaluated at tick time so the values are always fresh.
  extra?: () => Record<string, unknown>;
}

export interface SelfStatsSnapshot {
  windowSec: number;
  events: number;
  rps: number;
  dropped: number;
  loopLagP50Ms: number;
  loopLagP99Ms: number;
  loopLagMaxMs: number;
  cpuUserPct: number;
  cpuSysPct: number;
  rssMb: number;
  heapUsedMb: number;
}

// monitorEventLoopDelay returns nanoseconds; normalise to fractional ms.
const NS_PER_MS = 1e6;

// Per-process sampler. One instance owned by whichever long-lived surface
// wants to expose self-stats (controller start, generator ws-client). Keep
// the implementation dependency-free — we already get pino via `logger`.
export class SelfStats {
  private readonly component: string;
  private readonly intervalMs: number;
  private readonly extra?: () => Record<string, unknown>;
  private readonly histogram: IntervalHistogram;
  private timer: NodeJS.Timeout | null = null;
  private events = 0;
  private dropped = 0;
  private windowStart = performance.now();
  private prevCpu = process.cpuUsage();

  constructor(opts: SelfStatsOptions) {
    this.component = opts.component;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.extra = opts.extra;
    // resolution=20ms gives ~50 samples/sec — plenty for p99 across a minute
    // without much overhead. Enable only after `start()` so an idle process
    // doesn't carry sampling cost.
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
  }

  start(): void {
    if (this.timer) return;
    this.histogram.enable();
    this.prevCpu = process.cpuUsage();
    this.windowStart = performance.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Don't hold the event loop open — self-stats is observational, never
    // load-bearing. Process exit shouldn't wait on another tick.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.histogram.disable();
  }

  // Call once per observed event on the path we care about. Cheap — just a
  // counter increment, safe to call from hot paths (metrics batch handler,
  // event sink, etc).
  recordEvents(n: number): void {
    if (n > 0) this.events += n;
  }

  recordDropped(n: number): void {
    if (n > 0) this.dropped += n;
  }

  // Emit-and-reset. Exposed so a caller can flush a tail snapshot at end-of-test
  // — short tests would otherwise never cross the per-minute timer boundary.
  flush(): SelfStatsSnapshot {
    return this.tick();
  }

  private tick(): SelfStatsSnapshot {
    const now = performance.now();
    const windowMs = Math.max(1, now - this.windowStart);
    const windowSec = windowMs / 1000;

    const cpu = process.cpuUsage(this.prevCpu);
    // cpuUsage returns microseconds of CPU time consumed since `prevCpu`.
    // Normalising by wall-clock window gives utilization as a % of one core.
    const cpuUserPct = (cpu.user / 1000 / windowMs) * 100;
    const cpuSysPct = (cpu.system / 1000 / windowMs) * 100;

    const mem = process.memoryUsage();

    const snapshot: SelfStatsSnapshot = {
      windowSec: Number(windowSec.toFixed(2)),
      events: this.events,
      rps: Number((this.events / windowSec).toFixed(1)),
      dropped: this.dropped,
      loopLagP50Ms: Number((this.histogram.percentile(50) / NS_PER_MS).toFixed(2)),
      loopLagP99Ms: Number((this.histogram.percentile(99) / NS_PER_MS).toFixed(2)),
      loopLagMaxMs: Number((this.histogram.max / NS_PER_MS).toFixed(2)),
      cpuUserPct: Number(cpuUserPct.toFixed(1)),
      cpuSysPct: Number(cpuSysPct.toFixed(1)),
      rssMb: Number((mem.rss / 1024 / 1024).toFixed(1)),
      heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
    };

    const extra = this.extra?.() ?? {};
    logger.info({ component: this.component, ...snapshot, ...extra }, 'self-stats');

    // Reset counters and the histogram so the next window is independent.
    this.events = 0;
    this.dropped = 0;
    this.histogram.reset();
    this.prevCpu = process.cpuUsage();
    this.windowStart = now;

    return snapshot;
  }
}
