'use client';
import { useMemo } from 'react';
import {
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { PerSecondMetric } from '@hammr/shared';
import { colourFor } from '../lib/format';

interface Row {
  stepName: string;
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  // Roll-up percentiles are computed from per-second percentile *means* (live)
  // or per-second percentile *merges* (historical). For the live view this is
  // a slight approximation — the cold-path query does the proper merge — but
  // the dashboard already shows the ground-truth per-second time series above,
  // so this table is a quick-glance summary, not a forensic source.
  latP95Avg: number;
  latP99Max: number;
  bytesTotal: number;
}

function rollup(metrics: PerSecondMetric[]): Row[] {
  const acc = new Map<
    string,
    { reqs: number; errs: number; p95Sum: number; p95Count: number; p99Max: number; bytes: number }
  >();
  for (const m of metrics) {
    let row = acc.get(m.stepName);
    if (!row) {
      row = { reqs: 0, errs: 0, p95Sum: 0, p95Count: 0, p99Max: 0, bytes: 0 };
      acc.set(m.stepName, row);
    }
    row.reqs += m.rps;
    row.errs += Math.round(m.rps * m.errorRate);
    row.p95Sum += m.p95;
    row.p95Count += 1;
    row.p99Max = Math.max(row.p99Max, m.p99);
    row.bytes += m.bytesPerSec;
  }
  return Array.from(acc.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stepName, r]) => ({
      stepName,
      totalRequests: r.reqs,
      totalErrors: r.errs,
      errorRate: r.reqs === 0 ? 0 : r.errs / r.reqs,
      latP95Avg: r.p95Count === 0 ? 0 : Math.round(r.p95Sum / r.p95Count),
      latP99Max: r.p99Max,
      bytesTotal: r.bytes,
    }));
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function StepBreakdown({ metrics }: { metrics: PerSecondMetric[] }) {
  const rows = useMemo(() => rollup(metrics), [metrics]);

  return (
    <Paper variant="outlined">
      <Box sx={{ p: 2, pb: 0 }}>
        <Typography variant="h2">Per-step breakdown</Typography>
      </Box>
      <Table size="small" sx={{ mt: 1 }}>
        <TableHead>
          <TableRow>
            <TableCell>Step</TableCell>
            <TableCell align="right">Requests</TableCell>
            <TableCell align="right">Errors</TableCell>
            <TableCell align="right">Error rate</TableCell>
            <TableCell align="right">avg p95 (ms)</TableCell>
            <TableCell align="right">max p99 (ms)</TableCell>
            <TableCell align="right">Bytes</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} sx={{ color: 'text.secondary', textAlign: 'center', py: 4 }}>
                no data yet
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r, i) => (
              <TableRow key={r.stepName}>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: colourFor(i) }} />
                    {r.stepName}
                  </Box>
                </TableCell>
                <TableCell align="right">{r.totalRequests.toLocaleString()}</TableCell>
                <TableCell align="right">{r.totalErrors.toLocaleString()}</TableCell>
                <TableCell align="right">{(r.errorRate * 100).toFixed(2)}%</TableCell>
                <TableCell align="right">{r.latP95Avg}</TableCell>
                <TableCell align="right">{r.latP99Max}</TableCell>
                <TableCell align="right">{formatBytes(r.bytesTotal)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Paper>
  );
}
