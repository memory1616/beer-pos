const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const { config } = require('./config');
const { createRouter } = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const logger = require('./logger');

/**
 * Tao Express app cho Gateway.
 * @param {object} opts { repos }
 */
function createApp(opts = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(compression());

  // CORS - chi cho phep origin trong danh sach.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.cors.origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  // Body parser - CSV raw body can text/csv.
  app.use(
    express.json({
      limit: '1mb',
      type: ['application/json', 'application/*+json'],
    })
  );
  app.use(
    express.text({
      limit: '5mb',
      type: ['text/csv', 'text/plain'],
    })
  );

  // Request log (khong ghi API key).
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path === '/health') return;
      logger.info('[HTTP]', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    next();
  });

  app.use(createRouter(opts.repos));

  // UI tinh (Binance Dark).
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { index: 'index.html', maxAge: 0 }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
