import type { Metadata } from 'next';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v14-appRouter';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { theme } from '../theme';
import { AppShell } from '../components/AppShell';

export const metadata: Metadata = {
  title: 'Hammr',
  description: 'Distributed HTTP load testing dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppRouterCacheProvider options={{ key: 'mui' }}>
          <ThemeProvider theme={theme}>
            <CssBaseline />
            <AppShell>{children}</AppShell>
          </ThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
