'use client';
import { Box, Paper, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import InfoIcon from '@mui/icons-material/Info';
import WarningIcon from '@mui/icons-material/Warning';
import ErrorIcon from '@mui/icons-material/Error';
import type { Finding, FindingSeverity } from '@hammr/shared';

interface Props {
  findings: Finding[] | null;
  loading?: boolean;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  warn: 1,
  info: 2,
  ok: 3,
};

function severityIcon(sev: FindingSeverity) {
  switch (sev) {
    case 'critical':
      return <ErrorIcon fontSize="small" sx={{ color: 'error.main' }} />;
    case 'warn':
      return <WarningIcon fontSize="small" sx={{ color: 'warning.main' }} />;
    case 'info':
      return <InfoIcon fontSize="small" sx={{ color: 'info.main' }} />;
    case 'ok':
      return <CheckCircleIcon fontSize="small" sx={{ color: 'success.main' }} />;
  }
}

export function AnalysisCard({ findings, loading }: Props) {
  const sorted = findings
    ? [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    : null;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="overline" color="text.secondary">
        Analysis
      </Typography>
      {loading && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Running rules…
        </Typography>
      )}
      {!loading && sorted && sorted.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          No findings.
        </Typography>
      )}
      {!loading && sorted && sorted.length > 0 && (
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {sorted.map((f, i) => (
            <Box key={`${f.rule}-${i}`} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
              <Box sx={{ mt: '2px' }}>{severityIcon(f.severity)}</Box>
              <Box sx={{ flex: 1 }}>
                <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{f.headline}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {f.detail}
                </Typography>
              </Box>
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
