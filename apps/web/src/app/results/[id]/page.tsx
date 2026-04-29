'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import StopIcon from '@mui/icons-material/Stop';
import CircleIcon from '@mui/icons-material/Circle';
import DownloadIcon from '@mui/icons-material/Download';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { Finding, PerSecondMetric, TestStatus } from '@hammr/shared';
import { ApiError, api, type TestDetail } from '../../../lib/api';
import { useLiveTest } from '../../../hooks/useLiveTest';
import { MetricsCharts } from '../../../components/MetricsCharts';
import { StepBreakdown } from '../../../components/StepBreakdown';
import { AnalysisCard } from '../../../components/AnalysisCard';
import { formatDuration, formatRelative, statusColor } from '../../../lib/format';

interface PageProps {
  params: { id: string };
}

const TERMINAL: TestStatus[] = ['completed', 'failed', 'aborted'];

export default function ResultsPage({ params }: PageProps) {
  const testId = params.id;
  const router = useRouter();
  const live = useLiveTest(testId);
  const [detail, setDetail] = useState<TestDetail | null>(null);
  const [historical, setHistorical] = useState<PerSecondMetric[] | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  // Initial load: get the test detail. If the test is already terminal, load
  // historical metrics straight away. The live socket stream is harmless when
  // there's nothing to receive (and useful if the user re-runs from another tab).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await api.getTest(testId);
        if (cancelled) return;
        setDetail(d);
        if (TERMINAL.includes(d.status)) {
          const [m, a] = await Promise.all([api.getMetrics(testId), api.getAnalysis(testId)]);
          if (!cancelled) {
            setHistorical(m.metrics);
            setFindings(a.findings);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [testId]);

  // When the live stream tells us the test settled, switch the page to the
  // historical view. The orchestrator drains its writer + emits test:settled
  // in that order, so by the time we get here the cold-path MV is queryable.
  useEffect(() => {
    if (!live.settled || live.settled.testId !== testId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [d, m, a] = await Promise.all([
          api.getTest(testId),
          api.getMetrics(testId),
          api.getAnalysis(testId),
        ]);
        if (cancelled) return;
        setDetail(d);
        setHistorical(m.metrics);
        setFindings(a.findings);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [live.settled, testId]);

  const showHistorical = historical !== null;
  const metrics = showHistorical ? historical : live.metrics;

  // Anchor the X-axis to the first second we have, so a 30s test renders as
  // 0..30 instead of an unreadable absolute timestamp range.
  const baseSecond = useMemo(() => (metrics.length > 0 ? metrics[0]!.second : undefined), [metrics]);

  const status: TestStatus = detail?.status ?? (live.liveActive ? 'running' : 'queued');
  const isRunning = status === 'running';

  async function stop() {
    setStopping(true);
    try {
      await api.stopTest(testId);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : String(err));
      setStopping(false);
    }
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
          {testId}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
          <Typography variant="h1">{detail?.name ?? 'Loading…'}</Typography>
          <Chip label={status} color={statusColor(status)} variant="outlined" />
          {isRunning && (
            <Chip
              icon={<CircleIcon sx={{ fontSize: '10px !important', color: live.connected ? 'success.main' : 'error.main' }} />}
              label={live.connected ? 'live · 2s lag' : 'reconnecting…'}
              size="small"
              variant="outlined"
            />
          )}
          <Box sx={{ flex: 1 }} />
          <Button
            variant="outlined"
            startIcon={<ContentCopyIcon />}
            onClick={() => router.push(`/tests/new?cloneFrom=${testId}`)}
            disabled={!detail}
          >
            Clone
          </Button>
          <Button
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={() => downloadMetricsCsv(testId, metrics)}
            disabled={metrics.length === 0}
          >
            Export CSV
          </Button>
          {isRunning && (
            <Button color="error" variant="outlined" startIcon={<StopIcon />} onClick={stop} disabled={stopping}>
              {stopping ? 'Stopping…' : 'Stop test'}
            </Button>
          )}
        </Box>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      {detail && <SummaryStrip detail={detail} settled={live.settled} historicalCount={historical?.length ?? null} />}

      {!detail ? (
        <Paper variant="outlined" sx={{ p: 6, display: 'flex', justifyContent: 'center' }}>
          <CircularProgress />
        </Paper>
      ) : (
        <>
          {showHistorical && (
            <AnalysisCard findings={findings} loading={findings === null} />
          )}
          <MetricsCharts metrics={metrics} baseSecond={baseSecond} />
          <StepBreakdown metrics={metrics} />
        </>
      )}
    </Stack>
  );
}

const CSV_COLUMNS: (keyof PerSecondMetric)[] = [
  'second',
  'stepName',
  'p50',
  'p95',
  'p99',
  'rps',
  'errorRate',
  'bytesPerSec',
];

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadMetricsCsv(testId: string, metrics: PerSecondMetric[]) {
  if (metrics.length === 0) return;
  const lines = [CSV_COLUMNS.join(',')];
  for (const m of metrics) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape(m[c])).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hammr-${testId}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function SummaryStrip({
  detail,
  settled,
  historicalCount,
}: {
  detail: TestDetail;
  settled: ReturnType<typeof useLiveTest>['settled'];
  historicalCount: number | null;
}) {
  const cfg = detail.config.config;
  const summary = detail.summary;
  const dur =
    detail.startedAt && detail.endedAt
      ? detail.endedAt - detail.startedAt
      : detail.startedAt
        ? Date.now() - detail.startedAt
        : null;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(6, 1fr)' }, gap: 2 }}>
        <Stat label="VUs" value={String(cfg.users)} />
        <Stat label="Ramp" value={cfg.rampUp} />
        <Stat label="Duration" value={cfg.duration} />
        <Stat label="Started" value={formatRelative(detail.startedAt)} />
        <Stat
          label="Total events"
          value={(summary?.totalEvents ?? settled?.totalEvents ?? 0).toLocaleString()}
        />
        <Stat
          label="Errors"
          value={(summary?.errors ?? settled?.errors ?? 0).toLocaleString()}
          accent={(summary?.errors ?? settled?.errors ?? 0) > 0 ? 'warning' : undefined}
        />
        <Stat label="Elapsed" value={formatDuration(dur)} />
        <Stat label="Steps" value={String(detail.config.scenario.length)} />
        <Stat label="Base URL" value={detail.config.baseUrl} mono />
        <Stat
          label="Dropped"
          value={String(summary?.droppedEvents ?? settled?.droppedEvents ?? 0)}
          accent={(summary?.droppedEvents ?? settled?.droppedEvents ?? 0) > 0 ? 'warning' : undefined}
        />
        {historicalCount !== null && (
          <Stat label="Historical buckets" value={String(historicalCount)} />
        )}
        {detail.error && <Stat label="Error" value={detail.error} accent="error" />}
      </Box>
    </Paper>
  );
}

function Stat({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: 'warning' | 'error';
}) {
  const color = accent === 'error' ? 'error.main' : accent === 'warning' ? 'warning.main' : 'text.primary';
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ textTransform: 'uppercase', fontSize: 11, letterSpacing: 0.5 }}>
        {label}
      </Typography>
      <Typography
        sx={{
          color,
          fontWeight: 500,
          fontFamily: mono ? 'ui-monospace, "Cascadia Mono", monospace' : undefined,
          fontSize: mono ? 13 : undefined,
          wordBreak: mono ? 'break-all' : undefined,
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}
