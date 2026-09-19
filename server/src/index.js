import express from 'express';
import cors from 'cors';
import config, { validateConfig } from './config/index.js';
import healthRouter from './routes/health.js';
import searchRouter from './routes/search.js';
import productsRouter from './routes/products.js';
import cronRouter from './routes/cron.js';
import { requestLogger } from './middleware/requestLogger.js';

// Validate baseline configuration at startup
validateConfig();

const app = express();

// Trust reverse proxy (Render, Railway) so req.ip is correctly derived from client
app.set('trust proxy', 1);

// 1. HTTP Request Logging
app.use(requestLogger);

// 2. Security and CORS (restricted to FRONTEND_ORIGIN)
app.use(cors({
  origin: config.frontendOrigin === '*' ? '*' : config.frontendOrigin,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-cron-secret']
}));

app.use(express.json());

// 3. API Routes
app.use('/api/health', healthRouter);
app.use('/api/search', searchRouter);
app.use('/api/products', productsRouter);
app.use('/api/cron', cronRouter);

// 4. Central 404 handler for undefined API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found`
    }
  });
});

import { getActiveRunId } from './services/scrapeRunner.js';

// 5. Central error handler (never leaks stack traces to the client, returns clean JSON)
app.use((err, req, res, next) => {
  console.error('[API Error]:', err.stack || err.message);
  if (res.headersSent) {
    return next(err);
  }
  const isValidation = err.name === 'ValidationError';
  const isQueueFull = err.name === 'QueueFullError' || err.code === 'QUEUE_FULL';
  const isUnauthorized = err.code === 'UNAUTHORIZED' || err.status === 401;
  const isNotFound = err.code === 'NOT_FOUND' || err.status === 404;

  const status = err.status || (isValidation ? 400 : (isUnauthorized ? 401 : (isNotFound ? 404 : (isQueueFull ? 429 : 500))));
  const code = err.code || (isValidation ? 'VALIDATION_ERROR' : (isQueueFull ? 'QUEUE_FULL' : (isUnauthorized ? 'UNAUTHORIZED' : (isNotFound ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR'))));

  res.status(status).json({
    error: {
      code,
      message: err.message || 'An unexpected error occurred'
    }
  });
});

// Process-level safety: loud logging with active run_id so scheduled scrapes and server never crash silently
process.on('unhandledRejection', (reason) => {
  const runId = reason?.runId || reason?.run_id || getActiveRunId() || 'N/A';
  console.error(`[FATAL UNHANDLED REJECTION] [Run ID: ${runId}]:`, reason?.stack || reason);
});

process.on('uncaughtException', (err) => {
  const runId = err?.runId || err?.run_id || getActiveRunId() || 'N/A';
  console.error(`[FATAL UNCAUGHT EXCEPTION] [Run ID: ${runId}]:`, err?.stack || err);
});

import { fileURLToPath } from 'url';
import path from 'path';

// Start listener ONLY when executed directly (not when imported in tests)
const isDirectRun = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  process.argv[1].endsWith('src' + path.sep + 'index.js') ||
  process.argv[1].endsWith('src/index.js')
);

let server = null;
if (isDirectRun && process.env.NODE_ENV !== 'test') {
  server = app.listen(config.port, () => {
    console.log(`[Server] Price Tracker API running on port ${config.port}`);
    console.log(`[Config] Environment: ${config.nodeEnv}`);
    console.log(`[Config] Mock Store Base URL: ${config.storeBaseUrl}`);
    console.log(`[Config] Request Timeout: ${config.requestTimeoutMs}ms | Concurrency: ${config.scrapeConcurrency}`);
    console.log(`[Health] Endpoint ready at GET http://localhost:${config.port}/api/health`);
  });

  const handleShutdown = async (signal) => {
    console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);
    if (server) {
      server.close(async () => {
        console.log('[Server] HTTP listener closed.');
        try {
          const { closeBrowser } = await import('./services/browserScraper.js');
          await closeBrowser();
          console.log('[Server] Shared Chromium browser closed.');
        } catch (e) {
          console.error('[Server] Error closing browser during shutdown:', e.message);
        }
        process.exit(0);
      });

      setTimeout(() => {
        console.error('[Server] Graceful shutdown timed out after 10s. Forcing exit.');
        process.exit(1);
      }, 10000).unref();
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

export default app;
