import express from 'express';
import cors from 'cors';
import config, { validateConfig } from './config/index.js';
import healthRouter from './routes/health.js';

// Validate baseline configuration at startup
validateConfig();

const app = express();

// Security and CORS
app.use(cors({
  origin: config.frontendOrigin === '*' ? '*' : config.frontendOrigin,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-cron-secret']
}));

app.use(express.json());

// Routes
app.use('/api/health', healthRouter);

// Central 404 handler for undefined API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found`
    }
  });
});

// Central error handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]:', err.message);
  res.status(err.status || 500).json({
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: config.nodeEnv === 'production' ? 'An unexpected error occurred' : err.message
    }
  });
});

// Start listener when executed directly
if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, () => {
    console.log(`[Server] Price Tracker API running on port ${config.port}`);
    console.log(`[Config] Environment: ${config.nodeEnv}`);
    console.log(`[Config] Mock Store Base URL: ${config.storeBaseUrl}`);
    console.log(`[Config] Request Timeout: ${config.requestTimeoutMs}ms | Concurrency: ${config.scrapeConcurrency}`);
    console.log(`[Health] Endpoint ready at GET http://localhost:${config.port}/api/health`);
  });
}

export default app;
