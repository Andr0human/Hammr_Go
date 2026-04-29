'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { ZodError } from 'zod';
import { parseScenario, type ParsedScenario } from '@hammr/shared';
import { ApiError, api } from '../../../lib/api';

const EXAMPLE = JSON.stringify(
  {
    name: 'Demo - Echo Smoke',
    baseUrl: 'http://localhost:4000',
    config: { users: 50, rampUp: '5s', duration: '20s', thinkTime: { min: 50, max: 200 } },
    scenario: [
      {
        name: 'Login',
        method: 'POST',
        path: '/api/auth/login',
        body: { email: 'test@test.com', password: 'test123' },
        extract: { authToken: '$.token' },
      },
      {
        name: 'Search Jobs',
        method: 'GET',
        path: '/api/jobs?q=engineer',
        headers: { Authorization: 'Bearer {{authToken}}' },
      },
    ],
  },
  null,
  2,
);

interface ParseResult {
  ok: boolean;
  parsed?: ParsedScenario;
  issues?: Array<{ path: string; message: string }>;
  fatal?: string;
}

function parseInput(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, fatal: `Invalid JSON: ${(err as Error).message}` };
  }
  try {
    const parsed = parseScenario(raw);
    return { ok: true, parsed };
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        ok: false,
        issues: err.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
      };
    }
    return { ok: false, fatal: (err as Error).message };
  }
}

export default function NewTestPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const cloneFrom = searchParams.get('cloneFrom');
  const [text, setText] = useState(EXAMPLE);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [cloneNotice, setCloneNotice] = useState<string | null>(null);

  // Clone prefill: fetch the source test's config and replace the textarea.
  // Runs only once per cloneFrom id — user is free to edit afterward, and
  // re-navigating with the same id would clobber those edits which is fine.
  useEffect(() => {
    if (!cloneFrom) return;
    let cancelled = false;
    (async () => {
      try {
        const d = await api.getTest(cloneFrom);
        if (cancelled) return;
        setText(JSON.stringify(d.config, null, 2));
        setCloneNotice(`Cloned from ${d.name} (${cloneFrom}). Edit any field and run.`);
      } catch (err) {
        if (!cancelled) {
          setCloneNotice(
            `Could not load source test ${cloneFrom}: ${err instanceof ApiError ? err.message : String(err)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cloneFrom]);

  // Re-validate on every keystroke. The schema lives in @hammr/shared so this
  // matches the controller's POST /api/tests validation byte-for-byte.
  const result = useMemo(() => parseInput(text), [text]);

  async function submit() {
    if (!result.ok || !result.parsed) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const { testId } = await api.createTest(result.parsed.scenario);
      router.push(`/results/${testId}`);
    } catch (err) {
      if (err instanceof ApiError) {
        const issues =
          typeof err.body === 'object' &&
          err.body !== null &&
          'issues' in err.body &&
          Array.isArray((err.body as { issues: unknown[] }).issues)
            ? (err.body as { issues: Array<{ path: string; message: string }> }).issues
            : null;
        if (err.status === 409) {
          const active =
            typeof err.body === 'object' && err.body !== null && 'activeTestId' in err.body
              ? (err.body as { activeTestId?: string }).activeTestId
              : null;
          setServerError(
            active
              ? `Controller is busy running test ${active}. Stop it first to start a new one.`
              : 'Controller is busy.',
          );
        } else if (issues) {
          setServerError(`Server rejected scenario: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
        } else {
          setServerError(`${err.message} (HTTP ${err.status})`);
        }
      } else {
        setServerError(String(err));
      }
      setSubmitting(false);
    }
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h1">New test</Typography>
      <Typography variant="body2" color="text.secondary">
        Paste a scenario JSON. It&rsquo;s validated against the same schema the controller uses, so what passes here will be accepted server-side.
      </Typography>
      {cloneNotice && <Alert severity="info">{cloneNotice}</Alert>}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 360px' }, gap: 3 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <TextField
            multiline
            fullWidth
            minRows={24}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            slotProps={{
              input: {
                sx: { fontFamily: 'ui-monospace, "Cascadia Mono", "Fira Code", monospace', fontSize: 13 },
              },
            }}
          />
        </Paper>

        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h2" sx={{ mb: 2 }}>
              Validation
            </Typography>
            {result.ok ? (
              <Stack spacing={1.5}>
                <Chip label="Valid" color="success" variant="outlined" sx={{ alignSelf: 'flex-start' }} />
                <Typography variant="body2" color="text.secondary">
                  {result.parsed?.scenario.config.users} VUs · ramp {result.parsed?.scenario.config.rampUp} · for{' '}
                  {result.parsed?.scenario.config.duration}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {result.parsed?.scenario.scenario.length} step
                  {result.parsed && result.parsed.scenario.scenario.length === 1 ? '' : 's'}:{' '}
                  {result.parsed?.scenario.scenario.map((s) => s.name).join(' → ')}
                </Typography>
              </Stack>
            ) : (
              <Stack spacing={1}>
                {result.fatal && <Alert severity="error">{result.fatal}</Alert>}
                {result.issues?.map((i, idx) => (
                  <Alert key={idx} severity="error" sx={{ alignItems: 'flex-start' }}>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {i.path}
                    </Typography>
                    <Typography variant="body2">{i.message}</Typography>
                  </Alert>
                ))}
              </Stack>
            )}
          </Paper>

          {serverError && <Alert severity="error">{serverError}</Alert>}

          <Button
            variant="contained"
            size="large"
            startIcon={<PlayArrowIcon />}
            disabled={!result.ok || submitting}
            onClick={submit}
          >
            {submitting ? 'Starting…' : 'Run test'}
          </Button>
        </Stack>
      </Box>
    </Stack>
  );
}
