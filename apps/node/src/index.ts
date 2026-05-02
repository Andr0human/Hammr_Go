import './env.js';
import { logger } from './logger.js';
import { startController } from './controller/start.js';

async function main() {
  logger.info('Hammr controller starting');
  await startController();
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error on startup');
  process.exit(1);
});
