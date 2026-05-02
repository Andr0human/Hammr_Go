import 'dotenv/config';

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

const role = process.env.HAMMR_ROLE;
if (role !== undefined && role !== 'controller') {
  throw new Error(
    `HAMMR_ROLE='${role}' is no longer supported in this fork. ` +
      `The generator is now a separate Go binary — see apps/go-generator/. ` +
      `Unset HAMMR_ROLE (or set HAMMR_ROLE=controller) to start the controller.`,
  );
}

export const env = {
  publicPort: int('HAMMR_PUBLIC_PORT', 3000),
  genPort: int('HAMMR_GEN_PORT', 3001),
  clickhouseUrl: required('CLICKHOUSE_URL', 'http://localhost:8123'),
  clickhouseDatabase: required('CLICKHOUSE_DATABASE', 'hammr'),
  clickhouseUser: process.env.CLICKHOUSE_USER ?? 'default',
  clickhousePassword: process.env.CLICKHOUSE_PASSWORD ?? '',
  sqlitePath: process.env.SQLITE_PATH ?? './data/hammr.db',
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
