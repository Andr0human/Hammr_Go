import 'dotenv/config';

export type Role = 'controller' | 'generator' | 'standalone';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} is not a number: ${raw}`);
  return n;
}

const roleRaw = (process.env.HAMMR_ROLE ?? 'standalone') as Role;
if (!['controller', 'generator', 'standalone'].includes(roleRaw)) {
  throw new Error(`Invalid HAMMR_ROLE: ${roleRaw}`);
}

export const env = {
  role: roleRaw,
  publicPort: int('HAMMR_PUBLIC_PORT', 3000),
  genPort: int('HAMMR_GEN_PORT', 3001),
  controllerUrl: process.env.CONTROLLER_URL ?? 'ws://localhost:3001/gen',
  clickhouseUrl: required('CLICKHOUSE_URL', 'http://localhost:8123'),
  clickhouseDatabase: required('CLICKHOUSE_DATABASE', 'hammr'),
  clickhouseUser: process.env.CLICKHOUSE_USER ?? 'default',
  clickhousePassword: process.env.CLICKHOUSE_PASSWORD ?? '',
  sqlitePath: process.env.SQLITE_PATH ?? './data/hammr.db',
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
