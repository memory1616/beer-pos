const { createApp } = require('./app');
const { config, assertProductionSafety } = require('./config');
const { migrate } = require('./database/migrator');
const { closeDb } = require('./database/connection');
const WorkerService = require('./services/WorkerService');
const logger = require('./logger');

async function main() {
  const problems = assertProductionSafety();
  if (problems.length && !config.isTest) {
    logger.error('[BOOT] Cau hinh khong hop le', { problems });
    process.exit(1);
  }

  // Dam bao schema co san (khong thay the lenh `npm run migrate`).
  try {
    migrate();
  } catch (e) {
    logger.error('[BOOT] Khong migrate duoc', { error: e.message });
    process.exit(1);
  }

  const app = createApp();

  // Worker nen.
  let worker = null;
  if (config.worker.enabled) {
    worker = new WorkerService({
      intervalMs: config.worker.pollIntervalMs,
      batchSize: config.worker.batchSize,
      leaseMs: config.worker.leaseMs,
      concurrency: config.worker.concurrency,
    });
    worker.start();
  }
  app.locals.worker = worker;

  const server = app.listen(config.port, () => {
    logger.info('[BOOT] BeerPOS Zalo Gateway da chay', {
      port: config.port,
      env: config.env,
      provider: config.provider.name,
      worker: config.worker.enabled,
      db: config.database.path,
    });
    // eslint-disable-next-line no-console
    console.log(
      `\n  BeerPOS Notification Gateway\n  → http://localhost:${config.port}\n  → Health: http://localhost:${config.port}/health\n`
    );
  });

  const shutdown = (signal) => {
    logger.info('[SHUTDOWN] Nhan tin hieu', { signal });
    if (worker) worker.stop();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Khong treo process qua 5s.
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((e) => {
    logger.error('[BOOT] Loi khong mong doi', { error: e.message, stack: e.stack });
    process.exit(1);
  });
}

module.exports = { main };
