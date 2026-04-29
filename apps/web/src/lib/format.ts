import type { TestStatus } from '@hammr/shared';

export function formatRelative(unixMs: number | null | undefined, now = Date.now()): string {
  if (!unixMs) return '—';
  const diff = now - unixMs;
  const sec = Math.round(diff / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${min}m ${rem}s`;
}

export function formatBytes(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

export function statusColor(s: TestStatus): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  switch (s) {
    case 'queued':
      return 'default';
    case 'running':
      return 'primary';
    case 'completed':
      return 'success';
    case 'aborted':
      return 'warning';
    case 'failed':
      return 'error';
  }
}

// Stable colour ramp keyed by step index. Avoids the rainbow-vomit look of
// random per-step colours: same step → same colour wherever it shows up.
const STEP_COLOURS = [
  '#5eead4',
  '#fbbf24',
  '#a78bfa',
  '#f472b6',
  '#34d399',
  '#60a5fa',
  '#fb923c',
  '#f87171',
];

export function colourFor(index: number): string {
  return STEP_COLOURS[index % STEP_COLOURS.length]!;
}
