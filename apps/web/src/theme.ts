'use client';
import { createTheme } from '@mui/material/styles';

// Dark, monochrome-leaning theme — the dashboard is a tool, not a marketing site.
// One accent (teal) for primary actions; charts get their own colour ramp in
// the chart components themselves so step-name → colour stays stable across
// pages.
export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#5eead4' },
    background: { default: '#0b0f14', paper: '#111820' },
    success: { main: '#34d399' },
    warning: { main: '#fbbf24' },
    error: { main: '#f87171' },
  },
  typography: {
    fontFamily:
      '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    h1: { fontSize: '1.75rem', fontWeight: 600 },
    h2: { fontSize: '1.25rem', fontWeight: 600 },
    body2: { color: 'rgba(255,255,255,0.7)' },
  },
  shape: { borderRadius: 8 },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
  },
});
