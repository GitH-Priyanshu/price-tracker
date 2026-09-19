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

// 5. Central error handler (never leaks stack traces to the client)
app.use((err, req, res, next) => {
  console.error('[API Error]:', err.message);
  const status = err.status || (err.name === 'ValidationError' ? 400 : 500);
  const code = err.code || (status === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_SERVER_ERROR');
  res.status(status).json({
    error: {
      code,
      message: err.message || 'An unexpected error occurred'
    }
  });
});

import { fileURLToPath } from 'url';
import path from 'path';

// Start listener ONLY when executed directly (not when imported in tests)
const isDirectRun = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  process.argv[1].endsWith('src' + path.sep + 'index.js') ||
  process.argv[1].endsWith('src/index.js')
);

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  app.listen(config.port, () => {
    console.log(`[Server] Price Tracker API running on port ${config.port}`);
    console.log(`[Config] Environment: ${config.nodeEnv}`);
    console.log(`[Config] Mock Store Base URL: ${config.storeBaseUrl}`);
    console.log(`[Config] Request Timeout: ${config.requestTimeoutMs}ms | Concurrency: ${config.scrapeConcurrency}`);
    console.log(`[Health] Endpoint ready at GET http://localhost:${config.port}/api/health`);
  });
}

export default app;
