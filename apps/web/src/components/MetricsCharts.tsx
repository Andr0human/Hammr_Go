'use client';
import { useMemo } from 'react';
import { Box, Paper, Stack, Typography } from '@mui/material';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PerSecondMetric } from '@hammr/shared';
import { colourFor } from '../lib/format';

interface ChartProps {
  metrics: PerSecondMetric[];
  // When set, the X-axis renders as relative-from-this-second instead of
  // absolute clock time. Easier to read on short tests; a 13s test as
  // "0..13" beats "23:14:42..23:14:55".
  baseSecond?: number;
}

interface PivotedRow {
  second: number;
  // step → metric value, populated per chart below.
  [series: string]: number;
}

// Pivot the long-format PerSecondMetric stream into wide rows keyed by second.
// Each step becomes one column; missing data points come out undefined which
// Recharts renders as a gap (or a continuous line if `connectNulls` is true).
function pivot(
  metrics: PerSecondMetric[],
  field: keyof Pick<PerSecondMetric, 'rps' | 'p95' | 'errorRate' | 'bytesPerSec'>,
): { rows: PivotedRow[]; steps: string[] } {
  const stepSet = new Set<string>();
  const bySecond = new Map<number, PivotedRow>();
  for (const m of metrics) {
    stepSet.add(m.stepName);
    let row = bySecond.get(m.second);
    if (!row) {
      row = { second: m.second };
      bySecond.set(m.second, row);
    }
    const v = m[field];
    row[m.stepName] = field === 'errorRate' ? Number((v * 100).toFixed(2)) : Number(v);
  }
  const rows = Array.from(bySecond.values()).sort((a, b) => a.second - b.second);
  return { rows, steps: Array.from(stepSet).sort() };
}

interface PanelProps extends ChartProps {
  title: string;
  field: 'rps' | 'p95' | 'errorRate' | 'bytesPerSec';
  yAxisFormatter?: (v: number) => string;
  unit?: string;
}

function Panel({ metrics, baseSecond, title, field, yAxisFormatter, unit }: PanelProps) {
  const { rows, steps } = useMemo(() => pivot(metrics, field), [metrics, field]);

  // Recharts complains about a 0-row dataset — render an empty placeholder so
  // the layout doesn't jump when data starts arriving.
  const empty = rows.length === 0;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h2" sx={{ mb: 1 }}>
        {title}
        {unit && (
          <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
            {unit}
          </Typography>
        )}
      </Typography>
      <Box sx={{ height: 220 }}>
        {empty ? (
          <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography color="text.secondary" variant="body2">
              waiting for data…
            </Typography>
          </Box>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="second"
                stroke="rgba(255,255,255,0.4)"
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => (baseSecond ? String(v - baseSecond) : new Date(v * 1000).toLocaleTimeString())}
              />
              <YAxis
                stroke="rgba(255,255,255,0.4)"
                tick={{ fontSize: 11 }}
                tickFormatter={yAxisFormatter}
                width={56}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#111820',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(v) =>
                  baseSecond ? `T+${(v as number) - baseSecond}s` : new Date((v as number) * 1000).toLocaleTimeString()
                }
                formatter={(value: number) => (yAxisFormatter ? yAxisFormatter(value) : value)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {steps.map((step, i) => (
                <Line
                  key={step}
                  type="monotone"
                  dataKey={step}
                  stroke={colourFor(i)}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </Box>
    </Paper>
  );
}

export function MetricsCharts({ metrics, baseSecond }: ChartProps) {
  return (
    <Stack spacing={2}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2 }}>
        <Panel
          metrics={metrics}
          baseSecond={baseSecond}
          title="Requests / s"
          field="rps"
          yAxisFormatter={(v) => `${v}`}
        />
        <Panel
          metrics={metrics}
          baseSecond={baseSecond}
          title="p95 latency"
          unit="ms"
          field="p95"
          yAxisFormatter={(v) => `${v}`}
        />
        <Panel
          metrics={metrics}
          baseSecond={baseSecond}
          title="Error rate"
          unit="%"
          field="errorRate"
          yAxisFormatter={(v) => `${v}%`}
        />
        <Panel
          metrics={metrics}
          baseSecond={baseSecond}
          title="Throughput"
          unit="MB/s"
          field="bytesPerSec"
          yAxisFormatter={(v) => `${(v / (1024 * 1024)).toFixed(2)}`}
        />
      </Box>
    </Stack>
  );
}
