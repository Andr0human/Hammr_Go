'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import { COMPARE_MAX_RUNS, COMPARE_MIN_RUNS } from '@hammr/shared';
import { api, type TestListItem, ApiError } from '../lib/api';
import { formatDuration, formatRelative, statusColor } from '../lib/format';

// Only completed tests can be compared — server rejects running/queued anyway,
// but disabling selection here prevents the confusing round-trip.
const COMPARABLE: TestListItem['status'][] = ['completed'];

export default function TestListPage() {
  const router = useRouter();
  const [items, setItems] = useState<TestListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listTests(50, 0);
      setItems(res.tests);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while there's an active test so a running row flips to a
  // terminal status without a manual refresh. 3s feels live enough without
  // spamming the controller during idle periods.
  const hasActive = items?.some((t) => t.status === 'running' || t.status === 'queued') ?? false;
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => {
      void load();
    }, 3000);
    return () => clearInterval(id);
  }, [hasActive, load]);

  const selectedCount = selected.size;
  const selectionHint = useMemo(() => {
    if (selectedCount === 0) return 'Select 2+ completed tests to compare.';
    if (selectedCount < COMPARE_MIN_RUNS) return `Select at least ${COMPARE_MIN_RUNS} tests.`;
    if (selectedCount > COMPARE_MAX_RUNS) return `Too many selected (max ${COMPARE_MAX_RUNS}).`;
    return `${selectedCount} selected.`;
  }, [selectedCount]);
  const canCompare = selectedCount >= COMPARE_MIN_RUNS && selectedCount <= COMPARE_MAX_RUNS;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function compare() {
    if (!canCompare) return;
    const ids = [...selected].join(',');
    router.push(`/compare?ids=${ids}`);
  }

  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography variant="h1">Tests</Typography>
        <Box sx={{ flex: 1 }} />
        <Typography variant="body2" color="text.secondary">{selectionHint}</Typography>
        <Button
          variant="outlined"
          startIcon={<CompareArrowsIcon />}
          disabled={!canCompare}
          onClick={compare}
        >
          Compare
        </Button>
        <Tooltip title="Refresh">
          <IconButton onClick={load} disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
        <Button component={Link} href="/tests/new" variant="contained">
          New test
        </Button>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      <Paper variant="outlined">
        {items === null ? (
          <Box sx={{ p: 6, display: 'flex', justifyContent: 'center' }}>
            <CircularProgress />
          </Box>
        ) : items.length === 0 ? (
          <Box sx={{ p: 6, textAlign: 'center' }}>
            <Typography color="text.secondary">No tests yet.</Typography>
            <Button component={Link} href="/tests/new" variant="outlined" sx={{ mt: 2 }}>
              Run your first test
            </Button>
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" />
                  <TableCell>Name</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell width={48} />
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((t) => {
                  const dur =
                    t.startedAt && t.endedAt
                      ? t.endedAt - t.startedAt
                      : t.startedAt && t.status === 'running'
                        ? Date.now() - t.startedAt
                        : null;
                  const canSelect = COMPARABLE.includes(t.status);
                  const isSelected = selected.has(t.id);
                  return (
                    <TableRow key={t.id} hover selected={isSelected}>
                      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                        <Tooltip title={canSelect ? '' : 'Only completed tests can be compared'}>
                          <span>
                            <Checkbox
                              checked={isSelected}
                              disabled={!canSelect}
                              onChange={() => toggle(t.id)}
                            />
                          </span>
                        </Tooltip>
                      </TableCell>
                      <TableCell sx={{ color: 'text.primary', cursor: 'pointer' }} onClick={() => router.push(`/results/${t.id}`)}>
                        <Typography sx={{ fontWeight: 500 }}>{t.name}</Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {t.id}
                        </Typography>
                      </TableCell>
                      <TableCell onClick={() => router.push(`/results/${t.id}`)} sx={{ cursor: 'pointer' }}>
                        <Chip label={t.status} color={statusColor(t.status)} size="small" variant="outlined" />
                      </TableCell>
                      <TableCell sx={{ color: 'text.secondary', cursor: 'pointer' }} onClick={() => router.push(`/results/${t.id}`)}>{formatRelative(t.createdAt)}</TableCell>
                      <TableCell sx={{ color: 'text.secondary', cursor: 'pointer' }} onClick={() => router.push(`/results/${t.id}`)}>{formatDuration(dur)}</TableCell>
                      <TableCell onClick={() => router.push(`/results/${t.id}`)} sx={{ cursor: 'pointer' }}>
                        <OpenInNewIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>
    </Stack>
  );
}
