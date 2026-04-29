import { env } from './env.js';
import { logger } from './logger.js';

async function main() {
  logger.info({ role: env.role }, 'Hammr starting');

  switch (env.role) {
    case 'controller':
      await (await import('./controller/start.js')).startController();
      break;
    case 'generator':
      await (await import('./generator/start.js')).startGenerator();
      break;
    case 'standalone':
      await (await import('./controller/start.js')).startController();
      await (await import('./generator/start.js')).startGenerator();
      break;
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error on startup');
  process.exit(1);
});
