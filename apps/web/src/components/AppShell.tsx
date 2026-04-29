'use client';
import Link from 'next/link';
import { AppBar, Box, Button, Container, Toolbar, Typography } from '@mui/material';
import BoltIcon from '@mui/icons-material/Bolt';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="sticky" elevation={0} sx={{ bgcolor: 'background.paper', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <Toolbar sx={{ gap: 2 }}>
          <Link href="/" style={{ color: 'inherit', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
            <BoltIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h2" component="span" sx={{ fontWeight: 700, letterSpacing: 0.5 }}>
              Hammr
            </Typography>
          </Link>
          <Box sx={{ flex: 1 }} />
          <Button component={Link} href="/" color="inherit">
            Tests
          </Button>
          <Button component={Link} href="/tests/new" variant="contained" color="primary">
            New test
          </Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 4, flex: 1 }}>
        {children}
      </Container>
    </Box>
  );
}
