'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
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
import { ApiError, api, type CompareResponse, type CompareRun } from '../../lib/api';
import { AnalysisCard } from '../../components/AnalysisCard';
import { colourFor } from '../../lib/format';

export default function ComparePage() {
  const searchParams = useSearchParams();
  const idsParam = searchParams.get('ids') ?? '';
  const ids = useMemo(
    () => idsParam.split(',').map((s) => s.trim()).filter(Boolean),
    [idsParam],
  );
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<{ message: string; body: unknown } | null>(null);

  useEffect(() => {
    if (ids.length === 0) {
      setError({ message: 'No test ids in URL. Pick tests from the list and click Compare.', body: null });
      return;
    }
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const res = await api.compareTests(ids);
        if (!cancelled) setData(res);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError({ message: explainError(err), body: err.body });
        } else {
          setError({ message: String(err), body: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ids]);

  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Box>
          <Typography variant="h1">Compare runs</Typography>
          <Typography variant="body2" color="text.secondary">
            {ids.length === 0
              ? 'No runs selected.'
              : `${ids.length} runs${data ? ` varying ${dimensionLabel(data.dimension)}` : ''}.`}
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="outlined"
          startIcon={<DownloadIcon />}
          onClick={() => data && downloadCompareCsv(data)}
          disabled={!data}
        >
          Export CSV
        </Button>
      </Box>

      {error && <Alert severity="error">{error.message}</Alert>}

      {!error && !data && (
        <Paper variant="outlined" sx={{ p: 6, display: 'flex', justifyContent: 'center' }}>
          <CircularProgress />
        </Paper>
      )}

      {data && (
        <>
          <AnalysisCard findings={data.comparison} />
          <SummaryTable data={data} />
          <OverlayChart data={data} field="p95" title="p95 latency (ms)" unit="ms" />
          <OverlayChart data={data} field="rps" title="Requests per second" unit="rps" />
        </>
      )}
    </Stack>
  );
}

function dimensionLabel(d: CompareResponse['dimension']): string {
  return d === 'vu_count' ? 'VU count' : 'target URL';
}

function explainError(err: ApiError): string {
  if (err.status !== 400) return `${err.message} (HTTP ${err.status})`;
  const body = err.body as { error?: string; differingFields?: string[]; ids?: string[] } | null;
  const code = body?.error ?? err.message;
  switch (code) {
    case 'incomparable_selection':
      return `These runs differ on multiple dimensions (${(body?.differingFields ?? []).join(', ')}). Pick runs that vary on exactly one of: VU count, or baseUrl.`;
    case 'no_varying_dimension':
      return 'Selected runs have identical configs — nothing is varying, so there is nothing to compare.';
    case 'too_few_runs':
      return 'Select at least 2 runs to compare.';
    case 'too_many_runs':
      return 'Too many runs — max 10 per comparison.';
    case 'not_found':
      return `Some runs were not found: ${(body?.ids ?? []).join(', ')}.`;
    case 'test_not_complete':
      return `Some selected runs are still running or queued: ${(body?.ids ?? []).join(', ')}. Wait for them to finish.`;
    default:
      return `${code} (HTTP ${err.status})`;
  }
}

function SummaryTable({ data }: { data: CompareResponse }) {
  return (
    <Paper variant="outlined">
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>VUs</TableCell>
              <TableCell>Target</TableCell>
              <TableCell align="right">steady p95 (ms)</TableCell>
              <TableCell align="right">steady rps</TableCell>
              <TableCell align="right">error %</TableCell>
              <TableCell>Shape</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.runs.map((r, i) => (
              <TableRow key={r.testId} hover>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: colourFor(i) }} />
                    <Box
                      component={Link}
                      href={`/results/${r.testId}`}
                      sx={{ color: 'text.primary', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
                    >
                      {r.name}
                    </Box>
                  </Box>
                </TableCell>
                <TableCell>{r.summary.vus}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.summary.targetUrl}</TableCell>
                <TableCell align="right">{r.summary.steadyStateP95.toFixed(0)}</TableCell>
                <TableCell align="right">{r.summary.steadyStateRps.toFixed(1)}</TableCell>
                <TableCell align="right">{(r.summary.errorRate * 100).toFixed(2)}</TableCell>
                <TableCell>
                  <Chip label={r.summary.shape} size="small" variant="outlined" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

interface OverlayRow {
  second: number;
  [testId: string]: number;
}

// Build overlay data: pivot all runs onto one shared relative-second axis.
// Each run's metrics are collapsed across steps (weighted by rps for p95)
// then normalised to "seconds since the run's first bucket" so short tests
// line up at 0 regardless of absolute clock time.
function buildOverlay(runs: CompareRun[], field: 'p95' | 'rps'): OverlayRow[] {
  const bySecond = new Map<number, OverlayRow>();
  for (const run of runs) {
    const perSecond = collapseSteps(run.metrics, field);
    if (perSecond.length === 0) continue;
    const base = perSecond[0]!.second;
    for (const b of perSecond) {
      const rel = b.second - base;
      let row = bySecond.get(rel);
      if (!row) {
        row = { second: rel };
        bySecond.set(rel, row);
      }
      row[run.testId] = field === 'p95' ? Math.round(b.value) : Number(b.value.toFixed(1));
    }
  }
  return [...bySecond.values()].sort((a, b) => a.second - b.second);
}

function collapseSteps(metrics: PerSecondMetric[], field: 'p95' | 'rps'): Array<{ second: number; value: number }> {
  const bySecond = new Map<number, PerSecondMetric[]>();
  for (const m of metrics) {
    const list = bySecond.get(m.second);
    if (list) list.push(m);
    else bySecond.set(m.second, [m]);
  }
  const out: Array<{ second: number; value: number }> = [];
  for (const second of [...bySecond.keys()].sort((a, b) => a - b)) {
    const rows = bySecond.get(second)!;
    if (field === 'rps') {
      out.push({ second, value: rows.reduce((s, r) => s + r.rps, 0) });
    } else {
      const totalRps = rows.reduce((s, r) => s + r.rps, 0);
      const value = totalRps > 0
        ? rows.reduce((s, r) => s + r.p95 * r.rps, 0) / totalRps
        : rows.reduce((s, r) => s + r.p95, 0) / rows.length;
      out.push({ second, value });
    }
  }
  return out;
}

function OverlayChart({
  data,
  field,
  title,
  unit,
}: {
  data: CompareResponse;
  field: 'p95' | 'rps';
  title: string;
  unit: string;
}) {
  const rows = useMemo(() => buildOverlay(data.runs, field), [data, field]);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="overline" color="text.secondary">{title}</Typography>
      <Box sx={{ width: '100%', height: 280, mt: 1 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
            <XAxis dataKey="second" tick={{ fontSize: 11 }} label={{ value: 'seconds', position: 'insideBottom', offset: -2, fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}${unit === 'ms' ? '' : ''}`} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }}
              formatter={(v: number) => `${v} ${unit}`}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {data.runs.map((r, i) => (
              <Line
                key={r.testId}
                type="monotone"
                dataKey={r.testId}
                name={legendLabel(r, data.dimension)}
                stroke={colourFor(i)}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Box>
    </Paper>
  );
}

function legendLabel(r: CompareRun, dim: CompareResponse['dimension']): string {
  if (dim === 'vu_count') return `${r.summary.vus} VU`;
  return r.summary.targetUrl;
}

// Long-format CSV: same columns as the single-run export, prefixed with
// run identity so all selected runs fit one file. Pivot externally in Excel /
// pandas by testId or vus.
const CSV_COLUMNS = [
  'testId',
  'name',
  'vus',
  'targetUrl',
  'second',
  'stepName',
  'p50',
  'p95',
  'p99',
  'rps',
  'errorRate',
  'bytesPerSec',
] as const;

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCompareCsv(data: CompareResponse): void {
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const run of data.runs) {
    for (const m of run.metrics) {
      lines.push(
        [
          run.testId,
          run.name,
          run.summary.vus,
          run.summary.targetUrl,
          m.second,
          m.stepName,
          m.p50,
          m.p95,
          m.p99,
          m.rps,
          m.errorRate,
          m.bytesPerSec,
        ]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hammr-compare-${data.dimension}-${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
