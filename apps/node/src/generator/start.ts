import { logger } from '../logger.js';
import { env } from '../env.js';
import { startGeneratorClient } from './ws-client.js';

export async function startGenerator(): Promise<void> {
  logger.info({ controllerUrl: env.controllerUrl }, 'Starting generator client');
  const client = startGeneratorClient({ controllerUrl: env.controllerUrl });

  // Bind SIGINT/SIGTERM so Ctrl-C in the foreground (and Docker stop) trigger
  // a graceful shutdown that drains any in-flight test before exiting.
  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'shutting down generator');
    try {
      await client.stop();
    } catch (err) {
      logger.error({ err }, 'shutdown error');
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Block on the long-lived client. In standalone mode this keeps the parent
  // process alive too, which is what we want.
  await client.whenStopped;
}
