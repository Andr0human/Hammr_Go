// Applies all .sql files in apps/node/migrations/clickhouse/ in lexical order.
// Idempotent: every migration uses IF NOT EXISTS.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@clickhouse/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations', 'clickhouse');

const url = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const database = process.env.CLICKHOUSE_DATABASE ?? 'hammr';
const username = process.env.CLICKHOUSE_USER ?? 'default';
const password = process.env.CLICKHOUSE_PASSWORD ?? '';

const bootstrap = createClient({ url, username, password });
await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
await bootstrap.close();

const client = createClient({ url, username, password, database });

const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
if (files.length === 0) {
  console.log('No migrations found.');
  process.exit(0);
}

for (const file of files) {
  const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
  process.stdout.write(`applying ${file}... `);
  for (const stmt of splitStatements(sql)) {
    await client.command({ query: stmt });
  }
  console.log('ok');
}

// ClickHouse HTTP interface runs one statement per request. Strip `--` line
// comments and split on `;` so migrations can hold DROP + CREATE pairs.
function splitStatements(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
await client.close();
console.log(`Applied ${files.length} migration(s) to database "${database}".`);
