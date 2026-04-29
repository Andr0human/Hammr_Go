import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { env } from '../env.js';

let _client: ClickHouseClient | null = null;

export function getClickHouse(): ClickHouseClient {
  if (_client) return _client;
  _client = createClient({
    url: env.clickhouseUrl,
    username: env.clickhouseUser,
    password: env.clickhousePassword,
    database: env.clickhouseDatabase,
  });
  return _client;
}
